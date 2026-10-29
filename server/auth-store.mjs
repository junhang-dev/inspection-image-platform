import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const hashOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const authError = (status, message) =>
  Object.assign(new Error(message), { status });
let hashing = 0;

async function passwordKey(password, salt) {
  if (hashing >= 3)
    throw authError(429, "로그인 요청이 많습니다. 잠시 후 다시 시도하세요.");
  hashing++;
  try {
    return await derive(password, salt, 64, hashOptions);
  } finally {
    hashing--;
  }
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const key = await passwordKey(password, Buffer.from(salt, "base64url"));
  return `scrypt$32768$8$3$${salt}$${key.toString("base64url")}`;
}

async function verifyPassword(password, encoded) {
  const [algorithm, n, r, p, salt, key, extra] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    n !== "32768" ||
    r !== "8" ||
    p !== "3" ||
    extra ||
    !/^[A-Za-z0-9_-]{22}$/.test(salt ?? "") ||
    !/^[A-Za-z0-9_-]{86}$/.test(key ?? "")
  )
    return false;
  const actual = await passwordKey(password, Buffer.from(salt, "base64url"));
  return timingSafeEqual(actual, Buffer.from(key, "base64url"));
}

const iso = (date) => new Date(date).toISOString();
const publicUser = (row) => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  active: Boolean(row.active),
  createdAt: iso(row.created_at),
});
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const SESSION_MS = 8 * 60 * 60 * 1000;

export function createAuthStore(pool) {
  let dummyHash;
  const attempts = new Map();
  const windowMs = 15 * 60 * 1000;

  function throttle(key) {
    const now = Date.now();
    for (const [id, value] of attempts)
      if (value.until <= now) attempts.delete(id);
    if (attempts.size >= 1000 && !attempts.has(key))
      throw authError(429, "로그인 요청이 많습니다. 잠시 후 다시 시도하세요.");
    for (const [id, limit] of [
      ["global", 120],
      [key, 12],
    ]) {
      const value = attempts.get(id) ?? { count: 0, until: now + windowMs };
      if (value.count >= limit)
        throw authError(
          429,
          "로그인 시도가 많습니다. 15분 후 다시 시도하세요.",
        );
      value.count++;
      attempts.set(id, value);
    }
  }

  async function initialize() {
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_state (
      id TINYINT NOT NULL PRIMARY KEY, initialized BOOLEAN NOT NULL DEFAULT FALSE
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_users (
      id CHAR(36) NOT NULL PRIMARY KEY,
      username VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
      display_name VARCHAR(40) NOT NULL, password_hash VARCHAR(255) NOT NULL,
      role ENUM('admin','editor','viewer') NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      session_version INT UNSIGNED NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash CHAR(64) NOT NULL PRIMARY KEY, user_id CHAR(36) NOT NULL,
      user_version INT UNSIGNED NOT NULL, csrf_token CHAR(43) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
      INDEX auth_session_user(user_id), INDEX auth_session_expiry(expires_at)
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auth_audit (
      id CHAR(36) NOT NULL PRIMARY KEY, actor_id CHAR(36) NOT NULL,
      target_id CHAR(36) NOT NULL, action VARCHAR(40) NOT NULL,
      details JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    await pool.query(
      "INSERT IGNORE INTO auth_state(id, initialized) VALUES (1, FALSE)",
    );
    await pool.query(
      "UPDATE auth_state SET initialized = TRUE WHERE id = 1 AND EXISTS (SELECT 1 FROM auth_users)",
    );
    await pool.query(
      "DELETE FROM auth_sessions WHERE expires_at <= UTC_TIMESTAMP(3)",
    );
    dummyHash = await hashPassword(randomBytes(32).toString("base64url"));
  }

  async function transaction(callback) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      // Serializes first setup and account changes, including last-admin checks.
      const [state] = await connection.query(
        "SELECT initialized FROM auth_state WHERE id = 1 FOR UPDATE",
      );
      const result = await callback(connection, Boolean(state[0]?.initialized));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      if (error.code === "ER_DUP_ENTRY")
        throw authError(409, "이미 사용 중인 로그인 아이디입니다.");
      throw error;
    } finally {
      connection.release();
    }
  }

  async function audit(connection, actorId, targetId, action, details = null) {
    await connection.execute(
      "INSERT INTO auth_audit(id, actor_id, target_id, action, details) VALUES (?, ?, ?, ?, ?)",
      [
        randomUUID(),
        actorId,
        targetId,
        action,
        details ? JSON.stringify(details) : null,
      ],
    );
  }

  async function issue(connection, row) {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_MS);
    await connection.execute(
      "INSERT INTO auth_sessions(token_hash, user_id, user_version, csrf_token, expires_at) VALUES (?, ?, ?, ?, ?)",
      [tokenHash(token), row.id, row.session_version, csrfToken, expiresAt],
    );
    return {
      token,
      user: publicUser(row),
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async function readSession(token) {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const [rows] = await pool.execute(
      `SELECT u.*, s.csrf_token, s.expires_at
      FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)
      AND u.active = TRUE AND u.session_version = s.user_version`,
      [tokenHash(token)],
    );
    return rows[0]
      ? {
          user: publicUser(rows[0]),
          csrfToken: rows[0].csrf_token,
          expiresAt: iso(rows[0].expires_at),
        }
      : null;
  }

  async function bootstrapRequired() {
    const [rows] = await pool.query(
      "SELECT initialized FROM auth_state WHERE id = 1",
    );
    return !rows[0]?.initialized;
  }

  async function bootstrap(input) {
    if (!(await bootstrapRequired()))
      throw authError(409, "첫 관리자 설정이 이미 완료됐습니다. 로그인하세요.");
    throttle("bootstrap");
    const passwordHash = await hashPassword(input.password);
    return transaction(async (connection, initialized) => {
      if (initialized)
        throw authError(
          409,
          "첫 관리자 설정이 이미 완료됐습니다. 로그인하세요.",
        );
      const id = randomUUID();
      await connection.execute(
        "INSERT INTO auth_users(id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, 'admin')",
        [id, input.username, input.displayName, passwordHash],
      );
      await connection.query(
        "UPDATE auth_state SET initialized = TRUE WHERE id = 1",
      );
      await audit(connection, id, id, "bootstrap");
      const [rows] = await connection.execute(
        "SELECT * FROM auth_users WHERE id = ?",
        [id],
      );
      return issue(connection, rows[0]);
    });
  }

  async function login(input) {
    throttle(`login:${input.username}`);
    const [rows] = await pool.execute(
      "SELECT * FROM auth_users WHERE username = ?",
      [input.username],
    );
    const row = rows[0];
    const verified = await verifyPassword(
      input.password,
      row?.password_hash ?? dummyHash,
    );
    if (!verified || !row?.active)
      throw authError(401, "아이디 또는 비밀번호를 확인하세요.");
    return transaction(async (connection) => {
      const [current] = await connection.execute(
        "SELECT * FROM auth_users WHERE id = ? FOR UPDATE",
        [row.id],
      );
      if (
        !current[0]?.active ||
        current[0].session_version !== row.session_version
      )
        throw authError(401, "계정 정보가 변경됐습니다. 다시 로그인하세요.");
      await connection.query(
        "DELETE FROM auth_sessions WHERE expires_at <= UTC_TIMESTAMP(3)",
      );
      await audit(connection, row.id, row.id, "login");
      return issue(connection, current[0]);
    });
  }

  async function logout(token) {
    if (token)
      await pool.execute("DELETE FROM auth_sessions WHERE token_hash = ?", [
        tokenHash(token),
      ]);
  }

  async function listUsers() {
    const [rows] = await pool.query(
      "SELECT id, username, display_name, role, active, created_at FROM auth_users ORDER BY created_at, id LIMIT 500",
    );
    return rows.map(publicUser);
  }

  async function createUser(input, actor) {
    const passwordHash = await hashPassword(input.password);
    return transaction(async (connection) => {
      await requireCurrentAdmin(connection, actor);
      const [count] = await connection.query(
        "SELECT COUNT(*) AS total FROM auth_users",
      );
      if (count[0].total >= 500)
        throw authError(409, "개발 계정은 최대 500개까지 등록할 수 있습니다.");
      const id = randomUUID();
      await connection.execute(
        "INSERT INTO auth_users(id, username, display_name, password_hash, role) VALUES (?, ?, ?, ?, ?)",
        [id, input.username, input.displayName, passwordHash, input.role],
      );
      await audit(connection, actor.id, id, "create_user", {
        role: input.role,
        active: true,
      });
      const [rows] = await connection.execute(
        "SELECT * FROM auth_users WHERE id = ?",
        [id],
      );
      return publicUser(rows[0]);
    });
  }

  async function requireCurrentAdmin(connection, actor) {
    const [rows] = await connection.execute(
      "SELECT role, active FROM auth_users WHERE id = ? FOR UPDATE",
      [actor.id],
    );
    if (!rows[0]?.active || rows[0].role !== "admin")
      throw authError(403, "계정 관리 권한이 없습니다.");
  }

  async function patchUser(id, changes, actor) {
    const passwordHash = changes.password
      ? await hashPassword(changes.password)
      : null;
    return transaction(async (connection) => {
      await requireCurrentAdmin(connection, actor);
      const [rows] = await connection.execute(
        "SELECT * FROM auth_users WHERE id = ? FOR UPDATE",
        [id],
      );
      const row = rows[0];
      if (!row) throw authError(404, "계정을 찾을 수 없습니다.");
      const role = changes.role ?? row.role;
      const active = changes.active ?? Boolean(row.active);
      const securityChanged =
        Boolean(passwordHash) ||
        role !== row.role ||
        active !== Boolean(row.active);
      if (id === actor.id && (!active || role !== "admin"))
        throw authError(
          409,
          "자기 계정의 관리자 권한이나 사용 상태는 낮출 수 없습니다.",
        );
      if (row.role === "admin" && row.active && (role !== "admin" || !active)) {
        const [admins] = await connection.query(
          "SELECT COUNT(*) AS total FROM auth_users WHERE role = 'admin' AND active = TRUE",
        );
        if (admins[0].total <= 1)
          throw authError(409, "최소 한 명의 활성 관리자가 필요합니다.");
      }
      await connection.execute(
        `UPDATE auth_users SET display_name = ?, role = ?, active = ?, password_hash = ?,
        session_version = session_version + ? WHERE id = ?`,
        [
          changes.displayName ?? row.display_name,
          role,
          active,
          passwordHash ?? row.password_hash,
          securityChanged ? 1 : 0,
          id,
        ],
      );
      if (securityChanged)
        await connection.execute(
          "DELETE FROM auth_sessions WHERE user_id = ?",
          [id],
        );
      await audit(
        connection,
        actor.id,
        id,
        passwordHash ? "reset_password" : "update_user",
        {
          before: {
            displayName: row.display_name,
            role: row.role,
            active: Boolean(row.active),
          },
          after: {
            displayName: changes.displayName ?? row.display_name,
            role,
            active,
          },
        },
      );
      const [updated] = await connection.execute(
        "SELECT * FROM auth_users WHERE id = ?",
        [id],
      );
      return publicUser(updated[0]);
    });
  }

  async function changePassword(input, user) {
    throttle(`password:${user.id}`);
    const [rows] = await pool.execute("SELECT * FROM auth_users WHERE id = ?", [
      user.id,
    ]);
    const row = rows[0];
    if (!row?.active) throw authError(401, "로그인이 필요합니다.");
    if (!(await verifyPassword(input.currentPassword, row.password_hash)))
      throw authError(422, "현재 비밀번호를 확인하세요.");
    const passwordHash = await hashPassword(input.newPassword);
    return transaction(async (connection) => {
      const [current] = await connection.execute(
        "SELECT * FROM auth_users WHERE id = ? FOR UPDATE",
        [user.id],
      );
      if (
        !current[0]?.active ||
        current[0].session_version !== row.session_version
      )
        throw authError(401, "계정 정보가 변경됐습니다. 다시 로그인하세요.");
      await connection.execute(
        "UPDATE auth_users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?",
        [passwordHash, user.id],
      );
      await connection.execute("DELETE FROM auth_sessions WHERE user_id = ?", [
        user.id,
      ]);
      await audit(connection, user.id, user.id, "change_password");
      return issue(connection, {
        ...current[0],
        session_version: current[0].session_version + 1,
      });
    });
  }

  return {
    initialize,
    readSession,
    bootstrapRequired,
    bootstrap,
    login,
    logout,
    listUsers,
    createUser,
    patchUser,
    changePassword,
  };
}
