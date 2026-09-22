import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { parse } from "dotenv";

test("v3 isolated recovery: legacy transfer and concurrent plan close/finalize", { skip: process.env.PRODUCT_V3_RECOVERY !== "1", timeout: 60000 }, async () => {
  assert.equal(process.env.TEST_API_URL, "http://127.0.0.1:4501/api");
  const base = process.env.TEST_API_URL, folder = new URL("../local/private-v3-b/", import.meta.url);
  const env = parse(await readFile(new URL("api.env", folder)));
  assert.equal(env.MYSQL_PORT, "13311"); assert.equal(env.DATA_SCOPE, "local-private");
  const db = await mysql.createConnection({ host: "127.0.0.1", port: 13311, database: env.MYSQL_DATABASE, user: env.MYSQL_USER, password: env.MYSQL_PASSWORD });
  const audit = { actor: "v3 복구 검증", reason: "격리 후보의 기존 전송·동시 종료 복구 검사" };
  const call = async (path, method = "GET", body) => {
    const response = await fetch(base + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (...args) => { const result = await call(...args); assert.ok([200, 201].includes(result.status), JSON.stringify(result)); return result.body; };
  let plan = await ok("/plans", "POST", { title: "v3 동시 종료·기존 전송 검증", date: "2026-09-22", teamId: "team-2", rackIds: ["team-2-rack-30"] });
  const bytes = await readFile(new URL("../image/demo/demo-01.jpg", import.meta.url)), sha256 = createHash("sha256").update(bytes).digest("hex");
  const begin = async () => {
    const session = await ok("/upload-sessions", "POST", { id: randomUUID(), batchId: randomUUID(), name: "approved-recovery-demo.jpg", size: bytes.length, sha256, planId: plan.id, pointId: null, rackId: "team-2-rack-30" });
    for (let offset = 0; offset < bytes.length; offset += session.chunkBytes) {
      const part = bytes.subarray(offset, offset + session.chunkBytes);
      const response = await fetch(`${base}/upload-sessions/${session.id}/chunks?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": createHash("sha256").update(part).digest("hex") }, body: part });
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
    return session;
  };
  try {
    const legacy = await begin();
    // Only this newly created test session is rewritten to its pre-v3 shape.
    const [rows] = await db.execute("SELECT data FROM upload_sessions WHERE id = ?", [legacy.id]);
    const old = rows[0].data; assert.equal(old.status, "receiving"); assert.equal(old.inspectionId, legacy.inspectionId);
    for (const key of ["contractVersion", "rackId", "teamId", "batchId"]) delete old[key];
    old.planId = null;
    await db.execute("UPDATE upload_sessions SET data = ? WHERE id = ?", [JSON.stringify(old), legacy.id]);
    const resumed = await ok("/upload-sessions", "POST", { id: old.id, name: old.name, size: old.size, sha256: old.sha256, pointId: null, planId: null });
    assert.equal(resumed.inspectionId, legacy.inspectionId); assert.equal(resumed.offset, bytes.length);
    const completed = await ok(`/upload-sessions/${old.id}/complete`, "POST");
    assert.equal(completed.photo.id, legacy.inspectionId); assert.equal(completed.photo.planId, null); assert.equal(completed.photo.pointId, null); assert.equal(completed.photo.rackId ?? null, null);
    const duplicate = await Promise.all(Array.from({ length: 12 }, () => ok(`/upload-sessions/${old.id}/complete`, "POST")));
    assert.ok(duplicate.every((result) => result.photo.id === legacy.inspectionId));
    const race = await begin();
    const [finalize, closing] = await Promise.all([
      call(`/upload-sessions/${race.id}/complete`, "POST"),
      call(`/plans/${plan.id}`, "PATCH", { ...audit, expectedVersion: plan.editVersion, status: "done" }),
    ]);
    assert.equal(closing.status, 200); plan = closing.body;
    assert.ok([200, 409].includes(finalize.status), JSON.stringify(finalize));
    const held = await ok(`/upload-sessions/${race.id}`); assert.equal(held.inspectionId, race.inspectionId); assert.equal(held.offset, bytes.length);
    plan = await ok(`/plans/${plan.id}`, "PATCH", { ...audit, expectedVersion: plan.editVersion, status: "planned" });
    assert.equal((await ok(`/upload-sessions/${race.id}/complete`, "POST")).photo.id, race.inspectionId);
    for (const photoId of [legacy.inspectionId, race.inspectionId]) {
      const history = await ok(`/inspections/${photoId}/history`);
      assert.equal(history.filter((event) => event.action === "등록").length, 1);
      const response = await fetch(`${base}/inspections/${photoId}/image`); assert.equal(response.status, 200);
      assert.equal(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex"), sha256);
    }
    const receipt = { at: new Date().toISOString(), planId: plan.id, legacyPhotoId: legacy.inspectionId, racePhotoId: race.inspectionId, duplicateRetryCount: 12, concurrentFinalizeStatus: finalize.status, closingStatus: closing.status, originalSha256: sha256, legacyLocationUnconfirmed: true, passed: true };
    await writeFile(new URL("recovery-http.local.json", folder), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  } finally { await db.end(); }
});
