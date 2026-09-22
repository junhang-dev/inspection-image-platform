import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

test("v3 isolated HTTP: point-free multi-batch uploads, lifecycle recovery, automatic work and audit", {
  skip: process.env.PRODUCT_V3_INTEGRATION !== "1", timeout: 120000,
}, async () => {
  const base = process.env.TEST_API_URL;
  assert.ok(["http://127.0.0.1:4500/api", "http://127.0.0.1:4501/api"].includes(base), "isolated candidates only");
  const evidenceDirectory = base.includes(":4501/") ? "private-v3-b" : "private-v3";
  const trace = [], audit = { actor: "v3 API 계약 검증", reason: "격리 후보의 저장·상태 계약 검사" };
  const request = async (path, method = "GET", data, expected = 200) => {
    const response = await fetch(base + path, { method, headers: data ? { "Content-Type": "application/json" } : {}, body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000) });
    const result = await response.json(); trace.push({ path, method, status: response.status });
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`); return result;
  };
  assert.equal((await request("/health")).dataScope, "local-private");
  const locations = await request("/locations"); assert.equal(locations.racks.length, 120);
  let plan = await request("/plans", "POST", { title: "v3 API 계약 검사", date: "2026-09-22", teamId: "team-1", rackIds: ["team-1-rack-1", "team-1-rack-30"], note: "독립 후보의 승인 샘플 검사" }, 201);
  assert.deepEqual(plan.pointIds, []);
  const changePlan = async (patch, expected = 200) => {
    const result = await request(`/plans/${plan.id}`, "PATCH", { ...audit, expectedVersion: plan.editVersion, ...patch }, expected);
    if (expected === 200) plan = result; return result;
  };
  const bytes = await readFile(new URL("../image/demo/demo-01.jpg", import.meta.url));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const makeSession = async (rackId = "team-1-rack-1") => request("/upload-sessions", "POST", { id: randomUUID(), batchId: randomUUID(), name: "approved-demo.jpg", size: bytes.length, sha256, pointId: null, planId: plan.id, rackId });
  const transfer = async (session) => {
    for (let offset = 0; offset < bytes.length; offset += session.chunkBytes) {
      const part = bytes.subarray(offset, offset + session.chunkBytes);
      const response = await fetch(`${base}/upload-sessions/${session.id}/chunks?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": createHash("sha256").update(part).digest("hex") }, body: part });
      assert.equal(response.status, 200); await response.arrayBuffer();
    }
  };
  const first = await makeSession(); await transfer(first);
  await changePlan({ status: "done" });
  await request(`/upload-sessions/${first.id}/complete`, "POST", undefined, 409);
  const held = await request(`/upload-sessions/${first.id}`);
  assert.equal(held.inspectionId, first.inspectionId); assert.equal(held.offset, bytes.length);
  await changePlan({ status: "planned" });
  let a = (await request(`/upload-sessions/${first.id}/complete`, "POST")).photo;
  assert.equal(a.id, first.inspectionId); assert.equal(a.pointId, null); assert.equal(a.teamId, "team-1"); assert.equal(a.rackId, "team-1-rack-1");
  await changePlan({ status: "done" });
  assert.equal((await request(`/upload-sessions/${first.id}/complete`, "POST")).photo.id, a.id);
  await changePlan({ status: "planned" });
  const second = await makeSession(); await transfer(second);
  const b = (await request(`/upload-sessions/${second.id}/complete`, "POST")).photo;
  assert.notEqual(a.id, b.id); assert.notEqual(a.batchId, b.batchId);
  const unfinished = await makeSession("team-1-rack-30");
  const blocked = await changePlan({ rackIds: ["team-1-rack-1"] }, 409); assert.equal(blocked.details.sessions, 1);
  const oldVersion = plan.editVersion; await changePlan({ title: "v3 API 계약 검사 수정" });
  await request(`/plans/${plan.id}`, "PATCH", { ...audit, expectedVersion: oldVersion, note: "오래된 폼" }, 409);
  for (let attempt = 0; attempt < 40; attempt++) { a = await request(`/inspections/${a.id}`); if (a.status === "done") break; await new Promise((resolve) => setTimeout(resolve, 500)); }
  assert.equal(a.status, "done", "actual frozen model inference"); assert.ok(a.ai.model_version);
  const originalAI = structuredClone(a.ai);
  const changePhoto = async (patch) => { a = await request(`/inspections/${a.id}`, "PATCH", { ...audit, expectedVersion: a.editVersion, ...patch }); return a; };
  await changePhoto({ humanGrade: 5 });
  let target = await request(`/maintenance/target?photoId=${a.id}`);
  assert.equal(target.inWorklist, true); assert.equal(target.targetType, "photo"); assert.equal(target.targetId, a.id);
  let saved = await request("/maintenance", "POST", { ...audit, expectedVersion: null, planId: plan.id, pointId: null, targetType: "photo", targetId: a.id, photoIds: [a.id], repairStatus: "done", repairMethod: "paint", ta: true, inclusionMode: "auto", acknowledgedEvidence: target.evidenceVersions }, 201);
  await changePhoto({ humanGrade: 2 });
  target = await request(`/maintenance/target?photoId=${a.id}`); assert.equal(target.inWorklist, false); assert.equal(target.repairStatus, "done");
  await changePhoto({ humanGrade: 4 });
  target = await request(`/maintenance/target?photoId=${a.id}`); assert.equal(target.id, saved.id); assert.equal(target.inWorklist, true); assert.equal(target.newEvidenceCount, 1);
  saved = await request(`/maintenance/${saved.id}`, "PATCH", { ...audit, expectedVersion: saved.editVersion, repairStatus: "done", ta: false, inclusionMode: "auto" });
  target = await request(`/maintenance/target?photoId=${a.id}`); assert.equal(target.newEvidenceCount, 1, "TA save must not acknowledge unseen evidence");
  saved = await request(`/maintenance/${saved.id}`, "PATCH", { ...audit, expectedVersion: saved.editVersion, inclusionMode: "exclude" });
  await changePhoto({ humanGrade: null });
  target = await request(`/maintenance/target?photoId=${a.id}`); assert.equal(target.inWorklist, false); assert.equal(target.inclusionMode, "exclude"); assert.deepEqual(a.ai, originalAI);
  saved = await request(`/maintenance/${saved.id}`, "PATCH", { ...audit, expectedVersion: saved.editVersion, visibility: "hidden" });
  saved = await request(`/maintenance/${saved.id}`, "PATCH", { ...audit, expectedVersion: saved.editVersion, visibility: "visible", inclusionMode: "auto" });
  await changePlan({ status: "done" }); await changePlan({ visibility: "hidden" });
  assert.equal((await request(`/inspections/${a.id}`)).visibility, "visible");
  await changePlan({ visibility: "visible" }); assert.equal(plan.status, "done");
  await changePlan({ status: "planned" });
  const query = await request(`/inspections/query?planId=${plan.id}&teamId=team-1&rackId=team-1-rack-1&pageSize=1`);
  assert.equal(query.total, 2); assert.equal(query.rackCounts["team-1-rack-1"], 2); assert.equal(query.pages, 2);
  const image = await fetch(`${base}/inspections/${a.id}/image`); assert.equal(image.status, 200);
  assert.equal(createHash("sha256").update(Buffer.from(await image.arrayBuffer())).digest("hex"), sha256);
  const photoHistory = await request(`/inspections/${a.id}/history`), planHistory = await request(`/plans/${plan.id}/history`), maintenanceHistory = await request(`/maintenance/${saved.id}/history`);
  assert.ok(photoHistory.length >= 7 && planHistory.length >= 9 && maintenanceHistory.length >= 5);
  await writeFile(new URL(`../local/${evidenceDirectory}/core-http.local.json`, import.meta.url), JSON.stringify({ at: new Date().toISOString(), planId: plan.id, photoIds: [a.id, b.id], unfinishedSessionId: unfinished.id, sha256, actualModel: originalAI.model_version, actualInferencePhotos: 2, trace, historyCounts: { photo: photoHistory.length, plan: planHistory.length, maintenance: maintenanceHistory.length }, passed: true }, null, 2), { mode: 0o600 });
});
