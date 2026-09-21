import mysql from "mysql2/promise";
import { randomUUID } from "node:crypto";

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
export async function list(kind) {
  const [rows] = await pool.execute(
    "SELECT data FROM entities WHERE kind = ? ORDER BY created_at DESC LIMIT 1000",
    [kind],
  );
  return rows.map((row) => decode(row.data));
}
export async function get(kind, id) {
  const [rows] = await pool.execute(
    "SELECT data FROM entities WHERE kind = ? AND id = ?",
    [kind, id],
  );
  return rows[0] ? decode(rows[0].data) : null;
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
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  }));
  const connection = await pool.getConnection();
  let commitAttempted = false;
  try {
    await connection.beginTransaction();
    for (const data of items) {
      await connection.execute(
        "INSERT INTO entities(kind, id, data) VALUES (?, ?, ?)",
        [kind, data.id, JSON.stringify(data)],
      );
      await append(connection, data.id, "등록", null, data, actor, reason);
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
export async function update(kind, id, patch, actor, reason, action = "수정") {
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
    const before = decode(rows[0].data);
    const after = {
      ...before,
      ...patch,
      id: before.id,
      updatedAt: new Date().toISOString(),
    };
    await connection.execute(
      "UPDATE entities SET data = ? WHERE kind = ? AND id = ?",
      [JSON.stringify(after), kind, id],
    );
    await append(connection, id, action, before, after, actor, reason);
    await connection.commit();
    return after;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
