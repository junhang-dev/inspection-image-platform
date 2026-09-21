import { createHash } from "node:crypto";
import { fail } from "./upload-files.mjs";

const decode = (data) => (typeof data === "string" ? JSON.parse(data) : data);

export async function initializeUploads(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS upload_sessions (
    id CHAR(36) PRIMARY KEY, data JSON NOT NULL,
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX upload_activity(updated_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS upload_chunks (
    upload_id CHAR(36) NOT NULL, byte_offset BIGINT UNSIGNED NOT NULL,
    byte_length INT UNSIGNED NOT NULL, sha256 CHAR(64) NOT NULL,
    PRIMARY KEY(upload_id, byte_offset)
  )`);
}

export async function readUpload(connection, id) {
  const [rows] = await connection.execute(
    "SELECT data FROM upload_sessions WHERE id = ?",
    [id],
  );
  return rows[0] ? decode(rows[0].data) : null;
}

export async function writeUpload(connection, upload) {
  const updated = { ...upload, updatedAt: new Date().toISOString() };
  await connection.execute(
    "UPDATE upload_sessions SET data = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
    [JSON.stringify(updated), updated.id],
  );
  return updated;
}

// One API process owns each temporary directory. This in-process mutex remains
// held until file I/O ends even if the advisory-lock connection is lost.
export function uploadLock(pool) {
  const pending = new Map();
  const namespace = createHash("sha256")
    .update(process.env.MYSQL_DATABASE || "inspection")
    .digest("hex")
    .slice(0, 12);
  return async (id, callback) => {
    const previous = pending.get(id) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    pending.set(id, current);
    await previous;
    let connection;
    let acquired = false;
    const name = `upl-${namespace}-${id}`;
    try {
      connection = await pool.getConnection();
      const [rows] = await connection.execute(
        "SELECT GET_LOCK(?, 5) AS acquired",
        [name],
      );
      acquired = rows[0]?.acquired === 1;
      if (!acquired)
        throw fail(
          409,
          "이 파일의 저장 상태를 확인 중입니다. 잠시 뒤 다시 시도하세요.",
        );
      return await callback(connection);
    } finally {
      if (acquired)
        await connection
          .execute("SELECT RELEASE_LOCK(?)", [name])
          .catch(() => {});
      connection?.release();
      release();
      if (pending.get(id) === current) pending.delete(id);
    }
  };
}

export async function commitChunk(connection, upload, chunk) {
  try {
    await connection.beginTransaction();
    await connection.execute(
      "INSERT INTO upload_chunks(upload_id, byte_offset, byte_length, sha256) VALUES (?, ?, ?, ?)",
      [upload.id, upload.offset, chunk.length, chunk.sha256],
    );
    const result = await writeUpload(connection, {
      ...upload,
      offset: upload.offset + chunk.length,
      error: null,
    });
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    // The file is deliberately not truncated here: COMMIT may have succeeded.
    // The next locked request re-reads the committed offset before recovering.
    throw error;
  }
}

export async function findChunk(connection, id, offset) {
  const [rows] = await connection.execute(
    "SELECT byte_length, sha256 FROM upload_chunks WHERE upload_id = ? AND byte_offset = ?",
    [id, offset],
  );
  return rows[0] || null;
}
