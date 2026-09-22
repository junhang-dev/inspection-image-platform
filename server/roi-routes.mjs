import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { pool, get, decodeEntity, append, insertEntity, events } from "./store.mjs";
import { auditFields, fail } from "./plan-domain.mjs";
import { ROI_POLICY, roiCoordinates, currentAnalysis, verifyAnalysisResult } from "./roi-domain.mjs";
import { withVerifiedModelInput, assertFrozenIdentity } from "./verified-model-input.mjs";

const uuid = z.string().uuid();
const decode = (row, kind) => row ? decodeEntity(row.data, kind) : null;
const jobKind = "analysis_job";
async function locked(connection, kind, id) {
  const [rows] = await connection.execute("SELECT data FROM entities WHERE kind = ? AND id = ? FOR UPDATE", [kind, id]);
  return decode(rows[0], kind);
}
async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit(); return result;
  } catch (error) { await connection.rollback().catch(() => {}); throw error; }
  finally { connection.release(); }
}
async function save(connection, kind, before, after, actor, reason) {
  await connection.execute("UPDATE entities SET data = ? WHERE kind = ? AND id = ?", [JSON.stringify(after), kind, after.id]);
  // Large SHAP maps are stored once on the job; audit keeps immutable identity,
  // status and cache key, not repeated tens of thousands of contributions.
  const audit = (item) => {
    if (kind !== jobKind || !item?.result) return item;
    const { result, ...meta } = item;
    return { ...meta, result: { grade: result.grade, cacheKey: result.cacheKey, model_version: result.model_version, originalSha256: result.originalSha256 } };
  };
  await append(connection, after.id, "수정", audit(before), audit(after), actor, reason);
}
const jobSummary = ({ result, ...job }) => ({ ...job, ...(result ? { resultSummary: { grade: result.grade, targetGrade: result.explanation?.targetGrade, cacheKey: result.cacheKey, qualityStatus: result.explanation?.qualityStatus } } : {}) });

export function registerRoiRoutes(app, { objects, bucket, directory, dataset, modelUrl }) {
  if (modelUrl && (new URL(modelUrl).hostname !== "127.0.0.1" || new URL(modelUrl).protocol !== "http:")) throw new Error("영역 분석 서비스는 같은 컴퓨터의 loopback 주소만 사용할 수 있습니다.");
  let busy = false, active = null;
  const assertAllowed = (photo) => {
    if (!photo || photo.visibility === "hidden") throw fail(404, "표시 중인 사진을 찾을 수 없습니다.");
    const decision = dataset.policy.identity(photo);
    if (!decision.allowed) throw fail(403, decision.message);
  };
  app.get("/api/inspections/:id/rois", async (req, res) => {
    const photo = await get("inspection", uuid.parse(req.params.id));
    if (!photo) throw fail(404, "사진을 찾을 수 없습니다.");
    const [rows] = await pool.execute("SELECT data FROM entities WHERE kind = 'roi' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.photoId')) = ? ORDER BY created_at ASC", [photo.id]);
    res.json({ enabled: Boolean(modelUrl), allowed: photo.visibility !== "hidden" && dataset.policy.identity(photo).allowed, items: rows.map((row) => decode(row, "roi")) });
  });
  app.post("/api/inspections/:id/rois", async (req, res) => {
    const input = z.object({ coordinates: roiCoordinates, name: z.string().trim().min(1).max(100).default("관심 영역"), actor: auditFields.actor, reason: auditFields.reason }).strict().parse(req.body);
    const photoId = uuid.parse(req.params.id);
    const roi = await transaction(async (connection) => {
      const photo = await locked(connection, "inspection", photoId); assertAllowed(photo);
      const roi = { id: randomUUID(), photoId, originalSha256: photo.sha256, roiPolicyVersion: ROI_POLICY, coordinates: input.coordinates, name: input.name, editVersion: 0, visibility: "visible", createdAt: new Date().toISOString() };
      await insertEntity(connection, "roi", roi, input.actor, input.reason); return roi;
    });
    res.status(201).json(roi);
  });
  app.patch("/api/rois/:id", async (req, res) => {
    const input = z.object({ coordinates: roiCoordinates.optional(), name: z.string().trim().min(1).max(100).optional(), visibility: z.enum(["visible", "hidden"]).optional(), ...auditFields }).strict().parse(req.body);
    const seed = await get("roi", uuid.parse(req.params.id));
    if (!seed) throw fail(404, "선택 영역을 찾을 수 없습니다.");
    const roi = await transaction(async (connection) => {
      const photo = await locked(connection, "inspection", seed.photoId); assertAllowed(photo);
      const before = await locked(connection, "roi", seed.id);
      if (before.editVersion !== input.expectedVersion) throw fail(409, "다른 화면에서 영역을 수정했습니다. 최신 영역을 확인하세요.");
      const { actor, reason, expectedVersion, ...patch } = input;
      const after = { ...before, ...patch, editVersion: before.editVersion + 1, updatedAt: new Date().toISOString() };
      if (patch.visibility) Object.assign(after, { hiddenReason: patch.visibility === "hidden" ? reason : null, hiddenBy: patch.visibility === "hidden" ? actor : null });
      await save(connection, "roi", before, after, actor, reason); return after;
    });
    if (active?.roiId === roi.id) active.controller.abort();
    res.json(roi);
  });
  app.get("/api/rois/:id/history", async (req, res) => res.json(await events(uuid.parse(req.params.id))));
  app.post("/api/analysis-jobs", async (req, res) => {
    if (!modelUrl) throw fail(503, "영역 분석 서비스를 준비 중입니다.");
    const input = z.object({ id: uuid, photoId: uuid, roiId: uuid.nullable().default(null), roiVersion: z.number().int().min(0).nullable(), kind: z.enum(["predict", "explain"]), targetGrade: z.number().int().min(1).max(5).nullable().default(null) }).strict().parse(req.body);
    const job = await transaction(async (connection) => {
      const photo = await locked(connection, "inspection", input.photoId); assertAllowed(photo);
      const roi = input.roiId ? await locked(connection, "roi", input.roiId) : null;
      if (input.roiId && (!roi || roi.photoId !== photo.id || roi.visibility === "hidden" || roi.originalSha256 !== photo.sha256)) throw fail(422, "이 사진의 현재 영역을 선택하세요.");
      if (input.roiVersion !== (roi?.editVersion ?? null)) throw fail(409, "영역 버전이 바뀌었습니다. 현재 영역을 다시 확인하세요.");
      const current = await locked(connection, jobKind, input.id);
      if (current) {
        if (["photoId", "roiId", "kind", "targetGrade"].some((key) => current[key] !== input[key]) || current.roiVersion !== (roi?.editVersion ?? null)) throw fail(409, "다른 영역·분석 요청의 식별자입니다. 새 분석으로 요청하세요.");
        return current;
      }
      const expectedModel = Object.fromEntries(["model_version", "preprocessing_version", "checkpoint_sha256"].map((key) => [key, dataset.freeze[key]]));
      const job = { ...input, originalSha256: photo.sha256, sourceId: photo.sourceId ?? photo.id, roiVersion: roi?.editVersion ?? null, roi: roi?.coordinates ?? null, roiPolicyVersion: ROI_POLICY, expectedModel, status: "queued", error: null, editVersion: 0, createdAt: new Date().toISOString() };
      await insertEntity(connection, jobKind, job, "현업 엔지니어", input.kind === "explain" ? "모델 SHAP 설명 요청" : "영역 판독 요청"); return job;
    });
    res.status(202).json(jobSummary(job));
  });
  app.get("/api/inspections/:id/analysis-jobs", async (req, res) => {
    const photo = await get("inspection", uuid.parse(req.params.id));
    if (!photo || photo.visibility === "hidden") throw fail(404, "사진을 찾을 수 없습니다.");
    const [rows] = await pool.execute("SELECT JSON_REMOVE(data, '$.result.explanation.map') AS data FROM entities WHERE kind = 'analysis_job' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.photoId')) = ? ORDER BY created_at DESC", [photo.id]);
    const jobs = [];
    for (const row of rows) { const job = decode(row, jobKind); jobs.push({ ...jobSummary(job), isCurrent: currentAnalysis(job, photo, job.roiId ? await get("roi", job.roiId) : null) }); }
    res.json(jobs);
  });
  app.get("/api/analysis-jobs/:id", async (req, res) => {
    const job = await get(jobKind, uuid.parse(req.params.id));
    if (!job) throw fail(404, "분석 요청을 찾을 수 없습니다.");
    const photo = await get("inspection", job.photoId); assertAllowed(photo);
    const current = currentAnalysis(job, photo, job.roiId ? await get("roi", job.roiId) : null);
    res.json({ ...(current ? job : jobSummary(job)), isCurrent: current });
  });
  app.post("/api/analysis-jobs/:id/cancel", async (req, res) => {
    const audit = z.object(auditFields).strict().parse(req.body), id = uuid.parse(req.params.id);
    const job = await transaction(async (connection) => {
      const before = await locked(connection, jobKind, id);
      if (!before) throw fail(404, "분석 요청을 찾을 수 없습니다.");
      if (before.editVersion !== audit.expectedVersion) throw fail(409, "분석 상태가 바뀌었습니다. 최신 상태를 확인하세요.");
      if (!["queued", "running"].includes(before.status)) throw fail(409, "진행 중인 분석만 취소할 수 있습니다.");
      const after = { ...before, status: "cancelled", error: "사용자가 분석을 취소했습니다.", editVersion: before.editVersion + 1, updatedAt: new Date().toISOString() };
      await save(connection, jobKind, before, after, audit.actor, audit.reason); return after;
    });
    if (active?.id === id) active.controller.abort();
    res.json(jobSummary(job));
  });
  app.get("/api/analysis-jobs/:id/history", async (req, res) => res.json(await events(uuid.parse(req.params.id))));

  async function calculate(job, photo, signal) {
    const health = await fetch(`${modelUrl}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
    if (!health.ok) throw new Error("분석 서비스에 연결하지 못했습니다.");
    const identity = await health.json(); assertFrozenIdentity(identity, job.expectedModel);
    if (!identity.ready) throw new Error("분석 서비스가 아직 준비되지 않았습니다.");
    const metadata = { sourceId: job.sourceId, originalSha256: job.originalSha256, expectedModel: job.expectedModel, roiPolicyVersion: ROI_POLICY, roiId: job.roiId, roi: job.roi, targetGrade: job.targetGrade };
    return withVerifiedModelInput({ objects, bucket, photo, directory, decide: dataset.policy.identity, signal }, async (source) => {
      const boundary = `analysis-${randomUUID()}`;
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="original"\r\nContent-Type: ${photo.mime}\r\n\r\n`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Readable.from((async function* () { yield header; for await (const chunk of source) yield chunk; yield footer; })());
      try {
        const response = await fetch(`${modelUrl}${job.kind === "explain" ? "/v1/explanations" : "/v1/roi/predict"}`, { method: "POST", body, duplex: "half", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(header.length + photo.size + footer.length) }, signal });
        if (!response.ok) throw new Error(response.status === 429 ? "다른 설명을 계산 중입니다. 잠시 후 다시 요청하세요." : `영역 분석에 실패했습니다 (${response.status}). 같은 영역으로 다시 요청하세요.`);
        return verifyAnalysisResult(await response.json(), job);
      } finally { source.destroy(); body.destroy(); }
    });
  }
  async function processNext() {
    if (busy || !modelUrl) return; busy = true;
    try {
      // Only this worker computes jobs. A running row while it is idle means
      // the previous result write failed. Recover without calling the model again.
      await recoverInterrupted();
      const [rows] = await pool.execute("SELECT data FROM entities WHERE kind = 'analysis_job' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) = 'queued' ORDER BY created_at ASC LIMIT 1");
      const job = decode(rows[0], jobKind); if (!job) return;
      const photo = await get("inspection", job.photoId), roi = job.roiId ? await get("roi", job.roiId) : null;
      let result, error;
      const controller = new AbortController(); active = { id: job.id, roiId: job.roiId, controller };
      try {
        assertAllowed(photo);
        if (!currentAnalysis(job, photo, roi)) throw new Error("선택 영역이 바뀌었습니다. 현재 영역으로 다시 요청하세요.");
        const started = await transaction(async (connection) => {
          const before = await locked(connection, jobKind, job.id);
          if (before.status !== "queued") return false;
          await save(connection, jobKind, before, { ...before, status: "running", editVersion: before.editVersion + 1, startedAt: new Date().toISOString() }, "영역 분석 서비스", "분석 시작"); return true;
        });
        if (!started) return;
        result = await calculate(job, photo, AbortSignal.any([controller.signal, AbortSignal.timeout(150000)]));
      } catch (cause) { error = cause.message; }
      await transaction(async (connection) => {
        const latestPhoto = await locked(connection, "inspection", job.photoId);
        const latestRoi = job.roiId ? await locked(connection, "roi", job.roiId) : null;
        const before = await locked(connection, jobKind, job.id);
        if (!["queued", "running"].includes(before.status)) return;
        const current = currentAnalysis(job, latestPhoto, latestRoi);
        const status = !current ? "stale" : error ? "failed" : job.kind === "explain" && !result.cacheable ? "imprecise" : "completed";
        const after = { ...before, status, editVersion: before.editVersion + 1, error: !current ? "원본 또는 영역이 바뀌어 이전 결과를 표시하지 않습니다." : error ?? (status === "imprecise" ? "설명 정밀도가 부족합니다. 전체·영역 판독은 보존됩니다." : null), ...(result ? { result } : {}), completedAt: new Date().toISOString() };
        await save(connection, jobKind, before, after, "영역 분석 서비스", "분석 결과 저장");
      });
    } catch (error) { console.error("ROI worker:", error.code || error.message); }
    finally { active = null; busy = false; }
  }
  async function recoverInterrupted() {
    const [rows] = await pool.execute("SELECT data FROM entities WHERE kind = 'analysis_job' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) = 'running'");
    for (const row of rows) await transaction(async (connection) => {
      const before = await locked(connection, jobKind, decode(row, jobKind).id);
      if (before.status === "running") await save(connection, jobKind, before, { ...before, status: "failed", editVersion: before.editVersion + 1, completedAt: new Date().toISOString(), error: "분석이 중단되었거나 결과를 저장하지 못했습니다. 같은 영역으로 다시 요청하세요." }, "영역 분석 서비스", "중단된 분석 복구");
    });
  }
  return {
    runOnce: processNext,
    async start() {
      // A terminated computation is recoverable by an explicit new request.
      await recoverInterrupted();
      setInterval(processNext, 1500).unref();
    },
  };
}
