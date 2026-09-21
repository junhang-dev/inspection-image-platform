import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { planPointIds } from "./relations.mjs";

export const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3307),
  user: process.env.MYSQL_USER || "inspection",
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "inspection",
  connectionLimit: 8,
  timezone: "Z",
});
export async function initializeStore() {
  await pool.query(`CREATE TABLE IF NOT EXISTS entities (
    kind VARCHAR(32) NOT NULL, id CHAR(36) NOT NULL, data JSON NOT NULL,
    created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY(kind, id), INDEX entity_created(kind, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS history (
    id CHAR(36) PRIMARY KEY, entity_id CHAR(36) NOT NULL, data JSON NOT NULL,
    created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3), INDEX history_entity(entity_id, created_at)
  )`);
  // A process restart must not leave a job permanently in progress.
  await pool.query(`UPDATE entities SET data = JSON_SET(data, '$.status', 'pending')
    WHERE kind = 'inspection' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) = 'processing'`);
}
const decode = (value) =>
  typeof value === "string" ? JSON.parse(value) : value;
export function decodeEntity(value, kind) {
  const data = decode(value);
  return {
    ...data,
    editVersion: data.editVersion ?? 0,
    recordPurpose: data.recordPurpose ?? "inspection",
    ...(kind === "plan" ? { pointIds: planPointIds(data) } : {}),
    ...(kind === "inspection"
      ? {
          planId: data.planId ?? null,
          recordPurpose: data.recordPurpose ?? "inspection",
          visibility: data.visibility ?? "visible",
          hiddenAt: data.hiddenAt ?? null,
          hiddenBy: data.hiddenBy ?? null,
          hiddenReason: data.hiddenReason ?? null,
        }
      : {}),
    ...(kind === "point"
      ? {
          rackId: data.rackId ?? null,
          virtualPosition: data.virtualPosition ?? null,
          locationSource: data.locationSource ?? "unconfirmed",
        }
      : {}),
  };
}
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function list(kind, filters = {}) {
  const where = ["kind = ?"];
  const values = [kind];
  if (["point", "plan"].includes(kind) && filters.recordPurpose !== "all") {
    where.push(
      "COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.recordPurpose')), 'null'), 'inspection') = ?",
    );
    values.push(filters.recordPurpose || "inspection");
  }
  if (kind === "inspection" && Object.hasOwn(filters, "planId")) {
    where.push(
      "COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.planId')), 'null'), '') = ?",
    );
    values.push(filters.planId || "");
  }
  const [rows] = await pool.execute(
    `SELECT data FROM entities WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 1000`,
    values,
  );
  return rows.map((row) => decodeEntity(row.data, kind));
}
export async function get(kind, id, connection = pool) {
  const [rows] = await connection.execute(
    "SELECT data FROM entities WHERE kind = ? AND id = ?",
    [kind, id],
  );
  return rows[0] ? decodeEntity(rows[0].data, kind) : null;
}
export async function nextInspection() {
  const staleBefore = new Date(Date.now() - 180000).toISOString();
  const [rows] = await pool.execute(
    `SELECT data FROM entities WHERE kind = 'inspection'
    AND (JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) = 'pending'
      OR (JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) = 'processing'
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(data, '$.updatedAt')),
        JSON_UNQUOTE(JSON_EXTRACT(data, '$.createdAt'))) < ?))
    ORDER BY created_at ASC LIMIT 1`,
    [staleBefore],
  );
  return rows[0] ? decodeEntity(rows[0].data, "inspection") : null;
}
export async function events(id) {
  const [rows] = await pool.execute(
    "SELECT data FROM history WHERE entity_id = ? ORDER BY created_at DESC",
    [id],
  );
  return rows.map((row) => decode(row.data));
}
async function append(connection, id, action, before, after, actor, reason) {
  const event = {
    id: randomUUID(),
    entityId: id,
    action,
    before,
    after,
    actor,
    reason,
    at: new Date().toISOString(),
  };
  await connection.execute(
    "INSERT INTO history(id, entity_id, data) VALUES (?, ?, ?)",
    [event.id, id, JSON.stringify(event)],
  );
}
// The upload session supplies its already persisted inspection ID. Its caller
// owns the transaction that also marks the session completed.
export async function insertEntity(connection, kind, data, actor, reason) {
  await connection.execute(
    "INSERT INTO entities(kind, id, data) VALUES (?, ?, ?)",
    [kind, data.id, JSON.stringify(data)],
  );
  await append(connection, data.id, "등록", null, data, actor, reason);
}
export async function insert(
  kind,
  input,
  actor = "현업 엔지니어",
  reason = "새 항목 등록",
) {
  return (await insertBatch(kind, [input], actor, reason))[0];
}
export async function insertBatch(kind, inputs, actor, reason) {
  const items = inputs.map((input) => ({
    ...input,
    editVersion: 0,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }));
  const connection = await pool.getConnection();
  let commitAttempted = false;
  try {
    await connection.beginTransaction();
    for (const data of items) {
      await insertEntity(connection, kind, data, actor, reason);
    }
    commitAttempted = true;
    await connection.commit();
    return items;
  } catch (error) {
    error.commitUncertain = commitAttempted;
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
export async function update(
  kind,
  id,
  patch,
  actor,
  reason,
  { expectedVersion, inference = false } = {},
) {
  if ("editVersion" in patch || "expectedVersion" in patch)
    throw fail(422, "수정 버전은 직접 변경할 수 없습니다.");
  // Only explicit server calls may update inference fields without a human edit.
  // Never infer this privilege from the user-supplied actor name.
  if (inference) {
    if (
      kind !== "inspection" ||
      Object.keys(patch).some((key) => !["status", "ai", "error"].includes(key))
    )
      throw fail(422, "판독 처리로 업무 판단을 변경할 수 없습니다.");
  } else if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 ||
    expectedVersion >= Number.MAX_SAFE_INTEGER
  ) {
    throw fail(
      422,
      "화면 정보가 오래되었거나 올바르지 않습니다. 입력 내용을 별도로 보관한 뒤 새로고침하고 다시 시도하세요.",
    );
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT data FROM entities WHERE kind = ? AND id = ? FOR UPDATE",
      [kind, id],
    );
    if (!rows[0]) {
      await connection.rollback();
      return null;
    }
    const before = decodeEntity(rows[0].data, kind);
    if (!inference && before.editVersion !== expectedVersion)
      throw fail(
        409,
        "다른 화면에서 이 항목을 수정하여 저장하지 못했습니다. 입력 내용은 유지됩니다. 필요한 내용을 복사한 뒤 창을 닫고 새로고침하여 최신 내용을 확인해 주세요.",
      );
    const after = {
      ...before,
      ...patch,
      id: before.id,
      editVersion: inference ? before.editVersion : before.editVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    await connection.execute(
      "UPDATE entities SET data = ? WHERE kind = ? AND id = ?",
      [JSON.stringify(after), kind, id],
    );
    await append(connection, id, "수정", before, after, actor, reason);
    await connection.commit();
    return after;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
