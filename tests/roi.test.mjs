import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyAnalysisResult, ROI_POLICY } from "../server/roi-domain.mjs";
import { registerRoiRoutes } from "../server/roi-routes.mjs";
import { pool } from "../server/store.mjs";

const model = { model_version: "synthetic-contract", preprocessing_version: "test-only", checkpoint_sha256: "f".repeat(64) };
const request = { id: "job", photoId: "photo", sourceId: "photo", originalSha256: "a".repeat(64), roiId: null, roiVersion: null, roi: null, kind: "explain", expectedModel: model, targetGrade: null };
function resultFor(job, residual = 0, tolerance = 2) {
  const result = { schemaVersion: "roi-shap-v1", sourceId: job.sourceId, originalSha256: job.originalSha256, roiId: job.roiId, roiPolicyVersion: ROI_POLICY, ...model, grade: 4, orientedWidth: 100, orientedHeight: 80, bbox: [0, 0, 100, 80] };
  if (job.kind === "explain") {
    const map = Array.from({ length: 224 }, () => Array(224).fill(0)); map[0][0] = 2;
    const passed = Math.abs(residual) <= tolerance;
    Object.assign(result, { cacheKey: "synthetic-only", cacheable: passed, explanation: { method: "shap.GradientExplainer", approximation: "expected_gradients", outputSpace: "logit", targetGrade: 4, mapAggregation: "signed-channel-sum", map, mapScale: 2, baseValue: 5, outputValue: 7 + residual, attributionSum: 2, additivityResidual: residual, residualTolerance: tolerance, qualityStatus: passed ? "passed" : "residual_high", backgroundId: "synthetic", shapVersion: "test", nsamples: 1, seed: 0 } });
  }
  return result;
}
test("SHAP 품질은 양·음 잔차와 경계값을 동일하게 판정한다", () => {
  for (const residual of [-2.01, -2, 0, 2, 2.01]) {
    const result = resultFor(request, residual);
    assert.equal(verifyAnalysisResult(result, request).cacheable, Math.abs(residual) <= 2);
  }
  for (const residual of [-3, 3]) {
    const result = resultFor(request, residual); result.cacheable = true; result.explanation.qualityStatus = "passed";
    assert.throws(() => verifyAnalysisResult(result, request), /정밀도/);
  }
});
test("거짓 잔차·지도합·scale 및 비정상 cacheable/tolerance 응답은 저장하지 않는다", () => {
  const mutations = [
    (r) => { r.explanation.additivityResidual = 0.5; },
    (r) => { r.explanation.map[0][0] = 3; },
    (r) => { r.explanation.mapScale = -1; },
    (r) => { r.explanation.residualTolerance = -1; },
    (r) => { r.cacheable = "false"; },
    (r) => { r.cacheable = false; },
  ];
  for (const mutate of mutations) { const result = resultFor(request); mutate(result); assert.throws(() => verifyAnalysisResult(result, request)); }
});

async function workerFixture(t, mode) {
  const bytes = await readFile(new URL("../image/demo/demo-01.jpg", import.meta.url));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const directory = await mkdtemp(join(tmpdir(), "roi-worker-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const photo = { id: "photo", sha256: sha, size: bytes.length, objectKey: "approved-demo", mime: "image/jpeg", visibility: "visible", editVersion: 7, humanGrade: 3, ai: { grade: 4, ...model } };
  const job = { ...request, kind: "predict", originalSha256: sha, status: "queued", editVersion: 0 };
  const roi = { id: "roi", photoId: photo.id, originalSha256: sha, visibility: "visible", editVersion: 0 };
  if (mode === "roi-change") Object.assign(job, { roiId: roi.id, roiVersion: 0, roi: { x: 0, y: 0, w: 1, h: 1 } });
  let state = new Map([["inspection/photo", photo], ["analysis_job/job", job], ["roi/roi", roi]]), modelCalls = 0, failWrite = mode === "write-failure";
  const logs = [];
  const select = (sql, values = [], data = state) => {
    if (sql.includes("JSON_EXTRACT(data, '$.status')")) return [[...data.values()].filter((row) => row.id === "job" && row.status === (sql.includes("= 'running'") ? "running" : "queued")).map((row) => ({ data: structuredClone(row) }))];
    const row = data.get(`${values[0]}/${values[1]}`); return [[...(row ? [{ data: structuredClone(row) }] : [])]];
  };
  t.mock.method(pool, "execute", async (sql, values) => { assert.match(sql, /^SELECT/); return select(sql, values); });
  t.mock.method(pool, "getConnection", async () => {
    let tx;
    return {
      query: async () => {}, beginTransaction: async () => { tx = structuredClone(state); },
      execute: async (sql, values) => {
        if (sql.startsWith("SELECT")) return select(sql, values, tx);
        if (sql.startsWith("UPDATE entities")) {
          const value = JSON.parse(values[0]);
          if (failWrite && value.status === "completed") { failWrite = false; throw new Error("injected final write failure"); }
          tx.set(`${values[1]}/${values[2]}`, value);
        } else if (sql.startsWith("INSERT INTO history")) logs.push(JSON.parse(values[2]));
        else assert.fail(`Unexpected SQL ${sql}`);
        return [{ affectedRows: 1 }];
      },
      commit: async () => { state = tx; }, rollback: async () => { tx = null; }, release: () => {},
    };
  });
  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/health")) return Response.json({ ...model, ready: true });
    assert.equal(url, "http://127.0.0.1:9999/v1/roi/predict");
    for await (const unused of options.body) { void unused; }
    modelCalls++;
    if (mode === "roi-change") state.set("roi/roi", { ...state.get("roi/roi"), editVersion: 1 });
    if (mode === "cancel") state.set("analysis_job/job", { ...state.get("analysis_job/job"), status: "cancelled", editVersion: 2 });
    return Response.json(resultFor(job));
  });
  const app = { get() {}, post() {}, patch() {} };
  const service = registerRoiRoutes(app, { objects: { getObject: async () => Readable.from([bytes]) }, bucket: "test-only", directory, dataset: { policy: { identity: () => ({ allowed: true }) }, freeze: model }, modelUrl: "http://127.0.0.1:9999" });
  return { service, job: () => state.get("analysis_job/job"), photo: () => state.get("inspection/photo"), originalPhoto: structuredClone(photo), modelCalls: () => modelCalls, logs };
}
test("최종 DB 쓰기 1회 실패는 재시작·재추론 없이 다음 worker 실행에서 종료된다", async (t) => {
  const x = await workerFixture(t, "write-failure");
  await x.service.runOnce(); assert.equal(x.job().status, "running");
  await x.service.runOnce(); assert.equal(x.job().status, "failed");
  assert.match(x.job().error, /저장/); assert.equal(x.modelCalls(), 1);
  assert.deepEqual(x.photo(), x.originalPhoto);
  assert.ok(x.logs.some((event) => event.reason === "중단된 분석 복구"));
});
test("계산 중 ROI 수정과 취소 뒤 도착한 결과는 현재 결과를 덮지 않는다", async (t) => {
  for (const [mode, status] of [["roi-change", "stale"], ["cancel", "cancelled"]]) await t.test(mode, async (sub) => {
    const x = await workerFixture(sub, mode); await x.service.runOnce();
    assert.equal(x.job().status, status); assert.equal(x.modelCalls(), 1); assert.deepEqual(x.photo(), x.originalPhoto);
    if (mode === "cancel") assert.equal(x.job().result, undefined);
  });
});
