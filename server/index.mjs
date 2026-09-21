import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import { Client } from "minio";
import { randomUUID, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diskInput } from "./disk-input.mjs";
import { createUploadService, SESSION_TTL_MS } from "./uploads.mjs";
import { inspectImage, sha256File } from "./upload-files.mjs";
import { predictStream } from "./model-input.mjs";
import { z } from "zod";
import {
  initializeStore,
  list,
  get,
  insert,
  nextInspection,
  update,
  events,
  pool,
  decodeEntity,
} from "./store.mjs";
import { photoQuerySchema, queryPhotos } from "./photo-query.mjs";
import { registerMaintenanceRoutes } from "./maintenance-routes.mjs";
import { locations, planPointIds, pointLocation } from "./relations.mjs";
import { runtimeProfile, privateRequestAllowed } from "./runtime-profile.mjs";
import { loadDatasetContract } from "./dataset-contract.mjs";
import {
  withVerifiedModelInput,
  assertFrozenIdentity,
  cleanupModelScratch,
} from "./verified-model-input.mjs";
import { verifyStorageProfile } from "./storage-profile.mjs";

const profile = runtimeProfile();
const dataset = await loadDatasetContract(profile);
const app = express();
const demoMode = process.env.PUBLIC_DEMO_ONLY === "1";
const publicUploadsAllowed = process.env.PUBLIC_UPLOADS_ALLOWED === "1";
const demoFiles = JSON.parse(
  await readFile(
    new URL("../src/lib/demo-allowlist.json", import.meta.url),
    "utf8",
  ),
);
const allowedHashes = new Set(demoFiles.map((file) => file.sha256));
app.disable("x-powered-by");
const origins = (
  process.env.CORS_ORIGINS || "http://localhost:3000,http://127.0.0.1:3000"
).split(",");
app.use((req, res, next) => {
  if (!privateRequestAllowed(profile, req.headers))
    return res
      .status(403)
      .json({ error: "이 저장소는 전용 로컬 화면에서만 접근할 수 있습니다." });
  if (req.headers.origin && !origins.includes(req.headers.origin))
    return res.status(403).json({ error: "허용되지 않은 화면 주소입니다." });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(cors({ origin: origins }));
app.use(express.json({ limit: "100kb" }));
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT || "127.0.0.1",
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
const bucket = process.env.MINIO_BUCKET || "inspection-images";
await verifyStorageProfile(pool, objects, profile, dataset);
const uploadRoot = resolve(process.env.UPLOAD_TEMP_DIR || "uploads/incoming");
const multipartRoot = join(uploadRoot, "multipart");
const multipartFiles = await diskInput(multipartRoot);
const thumbnailFiles = await diskInput(join(uploadRoot, "thumbnails"));
let uploads;
const upload = multer({
  storage: multipartFiles.storage,
  limits: { fields: 5, fieldSize: 100 * 1024 },
});
const field = z.string().trim().max(120);
const actor = z.string().trim().min(1, "수정자를 입력하세요.").max(60);
const reason = z.string().trim().min(1, "변경 사유를 입력하세요.").max(1000);
const versionMessage =
  "화면 정보가 오래되었거나 올바르지 않습니다. 입력 내용을 별도로 보관한 뒤 새로고침하고 다시 시도하세요.";
const expectedVersion = z
  .number({ error: versionMessage })
  .int({ error: versionMessage })
  .min(0, { error: versionMessage })
  .max(Number.MAX_SAFE_INTEGER - 1, { error: versionMessage });
const recordPurpose = z.enum(["inspection", "presentation", "verification"]);
const purposeScope = z
  .enum(["inspection", "presentation", "verification", "all"])
  .default("inspection");
const pointSchema = z.object({
  recordPurpose: recordPurpose.default("inspection"),
  equipment: field.default(""),
  rack: field.default(""),
  rackId: z.string().nullable().default(null),
  name: field.default(""),
});
const pointPatch = z
  .object({
    equipment: field.optional(),
    rack: field.optional(),
    rackId: z.string().nullable().optional(),
    name: field.optional(),
    expectedVersion,
    actor,
    reason,
  })
  .strict();
const inspectionPatch = z
  .object({
    pointId: z.string().uuid().nullable().optional(),
    planId: z.string().uuid().nullable().optional(),
    humanGrade: z.number().int().min(1).max(5).nullable().optional(),
    retake: z.boolean().optional(),
    retakeReason: z.string().trim().max(1000).optional(),
    labeling: z.boolean().optional(),
    expectedVersion,
    actor,
    reason,
  })
  .strict();
const predictionSchema = z.object({
  grade: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  model_version: z.string().min(1),
  preprocessing_version: z.string().min(1),
});
const fail = (status, message) => Object.assign(new Error(message), { status });
async function validatePhotoRelation(planId, pointId, connection = pool) {
  if (pointId && !(await get("point", pointId, connection)))
    throw fail(422, "연결할 포인트를 찾을 수 없습니다. 다시 선택하세요.");
  if (!planId) return;
  const plan = await get("plan", planId, connection);
  if (!plan) throw fail(422, "검사 계획을 찾을 수 없습니다. 다시 선택하세요.");
  if (!pointId || !planPointIds(plan).includes(pointId))
    throw fail(422, "검사 계획에 연결된 포인트를 선택하세요.");
}
async function validatePlanPoints(ids) {
  for (const id of ids)
    if (!(await get("point", id)))
      throw fail(422, "연결할 포인트를 다시 선택하세요.");
}

app.get("/api/health", async (req, res) => {
  const dependencies = await Promise.allSettled([
    pool.query("SELECT 1"),
    objects.bucketExists(bucket),
  ]);
  let model = { ready: false, message: "모델 서비스를 기다리는 중" };
  try {
    const response = await fetch(
      `${process.env.MODEL_API_URL || "http://127.0.0.1:8001"}/health`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (response.ok) {
      model = await response.json();
      model.message = model.ready
        ? "모델 서비스 연결됨"
        : "모델 서비스를 기다리는 중";
    }
  } catch {
    /* Model failure is visible and does not stop metadata access. */
  }
  res.json({
    ready:
      dependencies[0].status === "fulfilled" &&
      dependencies[1].status === "fulfilled" &&
      dependencies[1].value === true,
    storage: "MySQL · MinIO",
    model,
    demoMode,
    publicUploadsAllowed,
    dataScope: profile.scope,
  });
});
app.get("/api/demo/:name", async (req, res) => {
  const file = demoFiles.find((item) => item.name === req.params.name);
  if (!file) throw fail(404, "제공된 시연 사진이 아닙니다.");
  const bytes = await readFile(
    new URL(`../image/demo/${file.name}`, import.meta.url),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256)
    throw fail(500, "시연 사진 해시가 변경되었습니다.");
  res.type(file.name.endsWith(".png") ? "image/png" : "image/jpeg").send(bytes);
});
app.get("/api/locations", (req, res) => res.json(locations));
app.get("/api/points", async (req, res) =>
  res.json(
    await list("point", {
      recordPurpose: purposeScope.parse(req.query.recordPurpose),
    }),
  ),
);
app.post("/api/points", async (req, res) => {
  const input = pointSchema.parse(req.body);
  const location = pointLocation(input.rackId, randomUUID(), input.rack);
  const existing = (await list("point", { recordPurpose: "all" })).find(
    (p) =>
      p.recordPurpose === input.recordPurpose &&
      p.equipment === input.equipment &&
      p.rackId === location.rackId &&
      p.rack === location.rack &&
      p.name === input.name,
  );
  if (existing) return res.json(existing);
  res.status(201).json(
    await insert(
      "point",
      {
        ...input,
        ...location,
        maintenanceSchemaVersion: 1,
        repairStatus: "none",
        managed: false,
        ta: false,
      },
      "현업 엔지니어",
      "포인트 등록",
    ),
  );
});
app.patch("/api/points/:id", async (req, res) => {
  if (
    req.body &&
    ["repairStatus", "repairMethod", "managed", "ta"].some((key) =>
      Object.hasOwn(req.body, key),
    )
  )
    throw fail(
      422,
      "보수 기록 저장 방식이 바뀌었습니다. 입력을 보관한 뒤 새로고침하고 계획·포인트의 보수 검토에서 저장하세요.",
    );
  const { actor, reason, expectedVersion, ...patch } = pointPatch.parse(
    req.body,
  );
  const current = await get("point", req.params.id);
  if (!current) throw fail(404, "포인트를 찾을 수 없습니다.");
  if (Object.hasOwn(patch, "rackId") && patch.rackId !== current.rackId)
    Object.assign(
      patch,
      pointLocation(patch.rackId, current.id, patch.rack ?? current.rack),
    );
  else if (
    current.rackId &&
    Object.hasOwn(patch, "rack") &&
    patch.rack !== current.rack
  )
    throw fail(422, "팀에 속한 파이프랙은 이름만 변경할 수 없습니다.");
  const result = await update("point", req.params.id, patch, actor, reason, {
    expectedVersion,
  });
  if (!result) throw fail(404, "포인트를 찾을 수 없습니다.");
  res.json(result);
});
app.get("/api/points/:id/history", async (req, res) =>
  res.json(await events(req.params.id)),
);
app.get("/api/inspections/query", async (req, res) => {
  const query = photoQuerySchema.parse(req.query);
  res.json(await queryPhotos(pool, decodeEntity, query));
});
// Compatibility endpoint. New screens use the paged query with an explicit total.
app.get("/api/inspections", async (req, res) => {
  const query = photoQuerySchema.parse({
    ...req.query,
    pageSize: req.query.pageSize ?? 100,
  });
  const result = await queryPhotos(pool, decodeEntity, {
    ...query,
    pageSize: req.query.pageSize === undefined ? 1000 : query.pageSize,
  });
  res.setHeader("X-Total-Count", String(result.total));
  res.json(result.items);
});
app.get("/api/inspections/:id", async (req, res) => {
  const item = await get("inspection", z.string().uuid().parse(req.params.id));
  if (!item) throw fail(404, "사진이 없습니다.");
  res.json(item);
});
app.patch("/api/inspections/:id/visibility", async (req, res) => {
  const input = z
    .object({
      visibility: z.enum(["visible", "hidden"]),
      expectedVersion,
      actor,
      reason,
    })
    .strict()
    .parse(req.body);
  const hidden = input.visibility === "hidden";
  const result = await update(
    "inspection",
    req.params.id,
    {
      visibility: input.visibility,
      hiddenAt: hidden ? new Date().toISOString() : null,
      hiddenBy: hidden ? input.actor : null,
      hiddenReason: hidden ? input.reason : null,
    },
    input.actor,
    input.reason,
    { expectedVersion: input.expectedVersion },
  );
  if (!result) throw fail(404, "사진이 없습니다.");
  res.json(result);
});
app.patch("/api/inspections/:id/purpose", async (req, res) => {
  const input = z
    .object({
      recordPurpose: z.enum(["inspection", "presentation", "verification"]),
      expectedVersion,
      actor,
      reason,
    })
    .strict()
    .parse(req.body);
  const result = await update(
    "inspection",
    req.params.id,
    { recordPurpose: input.recordPurpose },
    input.actor,
    input.reason,
    { expectedVersion: input.expectedVersion },
  );
  if (!result) throw fail(404, "사진이 없습니다.");
  res.json(result);
});
async function withDemoLock(callback) {
  const connection = await pool.getConnection();
  const name = `${process.env.MYSQL_DATABASE || "inspection"}:demo-upload`;
  let locked = false;
  try {
    const [rows] = await connection.execute(
      "SELECT GET_LOCK(?, 0) AS acquired",
      [name],
    );
    locked = rows[0].acquired === 1;
    if (!locked)
      throw fail(
        409,
        "다른 시연 사진 요청을 처리 중입니다. 잠시 후 다시 눌러 주세요.",
      );
    return await callback();
  } finally {
    try {
      if (locked) await connection.execute("SELECT RELEASE_LOCK(?)", [name]);
      connection.release();
    } catch {
      connection.destroy();
    }
  }
}
async function saveUploads(
  files,
  pointId,
  reuseDemo,
  planId = null,
  purpose = "inspection",
) {
  const byHash = new Map();
  if (reuseDemo) {
    const [rows] = await pool.execute(
      `SELECT data FROM entities WHERE kind = 'inspection'
      AND COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.pointId')), 'null'), '') = ?
      AND COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.planId')), 'null'), '') = ?
      ORDER BY created_at ASC`,
      [pointId || "", planId || ""],
    );
    for (const row of rows) {
      const photo = decodeEntity(row.data, "inspection");
      if (photo.recordPurpose === purpose && !byHash.has(photo.sha256))
        byHash.set(photo.sha256, photo);
    }
  }
  const results = [];
  for (const file of files) {
    const existing = reuseDemo ? byHash.get(file.hash) : null;
    if (existing) {
      results.push({ ...existing, uploadOutcome: "existing" });
      continue;
    }
    const result = await uploads.importFile(
      {
        id: file.uploadId || randomUUID(),
        name: file.originalname.slice(0, 200),
        size: file.size,
        sha256: file.hash,
        pointId,
        planId,
        recordPurpose: purpose,
      },
      file.path,
    );
    byHash.set(file.hash, result.photo);
    results.push({ ...result.photo, uploadOutcome: result.uploadOutcome });
  }
  return results;
}
async function validateImages(files, demoRequest) {
  for (const file of files) file.hash = await sha256File(file.path);
  for (const file of files) dataset.policy.assertUpload({ sha256: file.hash });
  if (demoRequest && files.some((file) => !allowedHashes.has(file.hash)))
    throw fail(
      422,
      "시연 사진 불러오기는 제공된 시연 사진만 사용할 수 있습니다.",
    );
  for (const file of files) {
    const image = await inspectImage(file.path);
    file.mime = image.mime;
    file.size = image.size;
  }
}
app.post("/api/demo-inspections", async (req, res) => {
  const { pointId, planId } = z
    .object({
      pointId: z.string().uuid().nullable().default(null),
      planId: z.string().uuid().nullable().default(null),
    })
    .strict()
    .parse(req.body);
  await validatePhotoRelation(planId, pointId);
  const files = await Promise.all(
    demoFiles.map(async (file) => {
      const path = fileURLToPath(
        new URL(`../image/demo/${file.name}`, import.meta.url),
      );
      return { path, size: (await stat(path)).size, originalname: file.name };
    }),
  );
  await validateImages(files, true);
  const result = await withDemoLock(() =>
    saveUploads(files, pointId, true, planId),
  );
  res
    .status(
      result.some((photo) => photo.uploadOutcome === "created") ? 201 : 200,
    )
    .json(result);
});
app.post("/api/inspections", upload.array("images"), async (req, res) => {
  try {
    if (!req.files?.length)
      throw fail(400, "사진이 없습니다. JPG 또는 PNG 사진을 선택하세요.");
    const demoRequest = demoMode || req.body.demo === "1";
    const purpose = recordPurpose
      .default("inspection")
      .parse(req.body.recordPurpose);
    const { pointId, planId } = z
      .object({
        pointId: z.string().uuid().nullable(),
        planId: z.string().uuid().nullable(),
      })
      .parse({
        pointId: req.body.pointId || null,
        planId: req.body.planId || null,
      });
    await validatePhotoRelation(planId, pointId);
    let ids = null;
    if (req.body.uploadIds) {
      let supplied;
      try {
        supplied = JSON.parse(req.body.uploadIds);
      } catch {
        throw fail(422, "사진별 전송 식별자 형식을 확인하세요.");
      }
      ids = z.array(z.string().uuid()).parse(supplied);
    }
    if (!ids && !demoRequest)
      throw fail(
        422,
        "사진별 전송 식별자가 필요합니다. 화면을 새로고침한 뒤 파일별 업로드를 이용하세요.",
      );
    if (
      ids &&
      (ids.length !== req.files.length || new Set(ids).size !== ids.length)
    )
      throw fail(422, "사진별 전송 식별자를 확인하세요.");
    for (const [i, file] of req.files.entries()) {
      file.uploadId = ids?.[i];
      file.originalname = Buffer.from(file.originalname, "latin1").toString(
        "utf8",
      );
    }
    await validateImages(req.files, demoRequest);
    const save = () =>
      saveUploads(req.files, pointId, demoRequest, planId, purpose);
    const result = demoRequest ? await withDemoLock(save) : await save();
    res
      .status(
        result.some((photo) => photo.uploadOutcome === "created") ? 201 : 200,
      )
      .json(result);
  } finally {
    await Promise.allSettled(
      (req.files || []).map((file) => multipartFiles.remove(file.path)),
    );
  }
});
const sessionId = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
app.post("/api/upload-sessions", async (req, res) => {
  const input = z
    .object({
      id: sessionId,
      recordPurpose: recordPurpose.default("inspection"),
      name: z.string().min(1).max(200),
      size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      sha256,
      pointId: sessionId.nullable(),
      planId: sessionId.nullable(),
    })
    .strict()
    .parse(req.body);
  res.json(await uploads.initialize(input));
});
app.get("/api/upload-sessions/:id", async (req, res) =>
  res.json(await uploads.status(sessionId.parse(req.params.id))),
);
app.put("/api/upload-sessions/:id/chunks", async (req, res) => {
  const id = sessionId.parse(req.params.id);
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .parse(req.query.offset);
  const hash = sha256.parse(req.headers["x-chunk-sha256"]);
  if (req.headers["content-type"] !== "application/octet-stream")
    throw fail(415, "사진 조각의 전송 형식을 확인하세요.");
  res.json(await uploads.chunk(id, offset, hash, req));
});
app.post("/api/upload-sessions/:id/complete", async (req, res) =>
  res.json(await uploads.finish(sessionId.parse(req.params.id))),
);
app.post("/api/upload-sessions/:id/restart", async (req, res) => {
  const input = z.object({ sha256 }).strict().parse(req.body);
  res.json(await uploads.restart(sessionId.parse(req.params.id), input.sha256));
});
const thumbnails = new Map();
app.get("/api/inspections/:id/thumbnail", async (req, res) => {
  const item = await get("inspection", req.params.id);
  if (!item || item.visibility === "hidden")
    throw fail(404, "사진이 없습니다.");
  let thumbnail = thumbnails.get(item.sha256);
  if (!thumbnail) {
    thumbnail = (async () => {
      const stream = await objects.getObject(bucket, item.objectKey);
      const input = await thumbnailFiles.receive(stream);
      try {
        return await sharp(input.path, { limitInputPixels: 40_000_000 })
          .rotate()
          .resize(320, 200, { fit: "inside", withoutEnlargement: true })
          .webp({ quality: 75 })
          .toBuffer();
      } finally {
        await thumbnailFiles.remove(input.path);
      }
    })();
    thumbnails.set(item.sha256, thumbnail);
    thumbnail.catch(() => thumbnails.delete(item.sha256));
    if (thumbnails.size > 128)
      thumbnails.delete(thumbnails.keys().next().value);
  }
  const bytes = await thumbnail;
  res.setHeader("Cache-Control", "private, no-store");
  res.type("image/webp").send(bytes);
});
app.get("/api/inspections/:id/image", async (req, res) => {
  const item = await get("inspection", req.params.id);
  if (!item || item.visibility === "hidden")
    throw fail(404, "사진이 없습니다.");
  const stream = await objects.getObject(bucket, item.objectKey);
  res.type(item.mime);
  stream.on("error", () => {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  });
  stream.pipe(res);
});
app.get("/api/inspections/:id/history", async (req, res) =>
  res.json(await events(req.params.id)),
);
app.patch("/api/inspections/:id", async (req, res) => {
  const { actor, reason, expectedVersion, ...patch } = inspectionPatch.parse(
    req.body,
  );
  const current = await get("inspection", req.params.id);
  if (!current) throw fail(404, "사진을 찾을 수 없습니다.");
  await validatePhotoRelation(
    Object.hasOwn(patch, "planId") ? patch.planId : current.planId,
    Object.hasOwn(patch, "pointId") ? patch.pointId : current.pointId,
  );
  if (
    (patch.retake ?? current.retake) &&
    !(patch.retakeReason ?? current.retakeReason).trim()
  )
    throw fail(422, "재촬영 사유를 입력하세요.");
  res.json(
    await update("inspection", req.params.id, patch, actor, reason, {
      expectedVersion,
    }),
  );
});
app.post("/api/inspections/:id/retry", async (req, res) => {
  const current = await get("inspection", req.params.id);
  if (!current) throw fail(404, "사진이 없습니다.");
  const decision = dataset.policy.queue(current);
  if (!decision.allowed) throw fail(409, decision.message);
  if (!["error", "pending"].includes(current.status))
    throw fail(409, "실패하거나 대기 중인 사진만 다시 요청할 수 있습니다.");
  res.json(
    await update(
      "inspection",
      current.id,
      { status: "pending", error: null },
      "현업 엔지니어",
      "AI 판독 재요청",
      { inference: true },
    ),
  );
});
app.get("/api/plans", async (req, res) =>
  res.json(
    await list("plan", {
      recordPurpose: purposeScope.parse(req.query.recordPurpose),
    }),
  ),
);
app.get("/api/plans/:id", async (req, res) => {
  const plan = await get("plan", req.params.id);
  if (!plan) throw fail(404, "계획이 없습니다.");
  res.json(plan);
});
app.get("/api/plans/:id/history", async (req, res) =>
  res.json(await events(req.params.id)),
);
for (const [path, kind] of [
  ["points", "point"],
  ["plans", "plan"],
]) {
  app.patch(`/api/${path}/:id/purpose`, async (req, res) => {
    const input = z
      .object({ recordPurpose, expectedVersion, actor, reason })
      .strict()
      .parse(req.body);
    const result = await update(
      kind,
      req.params.id,
      { recordPurpose: input.recordPurpose },
      input.actor,
      input.reason,
      { expectedVersion: input.expectedVersion },
    );
    if (!result) throw fail(404, "기록을 찾을 수 없습니다.");
    res.json(result);
  });
}
app.post("/api/plans", async (req, res) => {
  const input = z
    .object({
      recordPurpose: recordPurpose.default("inspection"),
      title: z.string().trim().min(1).max(120),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      pointId: z.string().uuid().nullable().default(null),
      pointIds: z.array(z.string().uuid()).optional(),
      note: z.string().max(1000).default(""),
    })
    .parse(req.body);
  if (
    Number.isNaN(Date.parse(input.date)) ||
    new Date(input.date).toISOString().slice(0, 10) !== input.date
  )
    throw fail(422, "올바른 날짜를 선택하세요.");
  const pointIds = planPointIds(input);
  if (input.pointId && !pointIds.includes(input.pointId))
    throw fail(422, "계획의 포인트 선택이 서로 다릅니다. 다시 선택하세요.");
  await validatePlanPoints(pointIds);
  res
    .status(201)
    .json(
      await insert(
        "plan",
        { ...input, pointIds, pointId: pointIds[0] || null, status: "planned" },
        "현업 엔지니어",
        "검사 계획 등록",
      ),
    );
});
app.patch("/api/plans/:id", async (req, res) => {
  const input = z
    .object({
      status: z.enum(["planned", "done", "cancelled"]).optional(),
      pointIds: z.array(z.string().uuid()).optional(),
      expectedVersion,
      actor,
      reason,
    })
    .strict()
    .refine(
      (input) => input.status !== undefined || input.pointIds !== undefined,
      "변경할 내용을 선택하세요.",
    )
    .parse(req.body);
  const current = await get("plan", req.params.id);
  if (!current) throw fail(404, "계획이 없습니다.");
  if (current.editVersion !== input.expectedVersion)
    throw fail(
      409,
      "다른 화면에서 검사 계획을 수정하여 저장하지 못했습니다. 입력은 유지됩니다. 최신 계획에서 포인트 연결 여부를 확인해 주세요.",
    );
  const patch = input.status === undefined ? {} : { status: input.status };
  if (input.pointIds !== undefined) {
    const pointIds = [...new Set(input.pointIds)];
    if (planPointIds(current).some((id) => !pointIds.includes(id)))
      throw fail(422, "기존 검사 포인트의 연결은 유지해야 합니다.");
    await validatePlanPoints(pointIds);
    Object.assign(patch, { pointIds, pointId: pointIds[0] || null });
  }
  const result = await update(
    "plan",
    req.params.id,
    patch,
    input.actor,
    input.reason,
    { expectedVersion: input.expectedVersion },
  );
  if (!result) throw fail(404, "계획이 없습니다.");
  res.json(result);
});
registerMaintenanceRoutes(app);
app.use((error, req, res, next) => {
  if (error instanceof z.ZodError)
    return res
      .status(422)
      .json({ error: error.issues[0]?.message || "입력을 확인하세요." });
  if (error instanceof multer.MulterError)
    return res.status(422).json({
      error: "사진 전송 형식을 확인하고 해당 파일을 다시 시도하세요.",
    });
  if (["ENOSPC", "EIO", "EACCES", "EMFILE"].includes(error.code))
    return res.status(503).json({
      error:
        "사진 임시 저장소를 사용할 수 없습니다. 공간과 연결을 확인한 뒤 해당 파일을 다시 시도하세요.",
    });
  const status = error.status || 500;
  if (status >= 500)
    console.error("API request failed:", error.code || error.message);
  res.status(status).json({
    error:
      status >= 500 && !error.status
        ? "저장소 연결에 문제가 있습니다. 잠시 후 다시 시도하세요."
        : error.message,
  });
});

let busy = false;
async function processNext() {
  if (busy) return;
  busy = true;
  try {
    const next = await nextInspection(dataset.policy);
    if (!next) return;
    const modelUrl = process.env.MODEL_API_URL || "http://127.0.0.1:8001";
    try {
      const health = await fetch(`${modelUrl}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!health.ok) return;
      const identity = await health.json();
      if (!identity.ready) return;
      assertFrozenIdentity(identity, dataset.freeze);
    } catch {
      return;
    }
    await update(
      "inspection",
      next.id,
      { status: "processing" },
      "AI 서비스",
      "백그라운드 판독 시작",
      { inference: true },
    );
    try {
      const result = predictionSchema.parse(
        await withVerifiedModelInput(
          {
            objects,
            bucket,
            photo: next,
            directory: uploadRoot,
            decide: dataset.policy.queue,
          },
          (stream) => predictStream(modelUrl, stream, next),
        ),
      );
      assertFrozenIdentity(result, dataset.freeze, { checkpoint: false });
      await update(
        "inspection",
        next.id,
        { status: "done", ai: result, error: null },
        "AI 서비스",
        "실제 이미지 모델 판독 완료",
        { inference: true },
      );
    } catch (error) {
      await update(
        "inspection",
        next.id,
        {
          status: error.inferenceBlocked ? "unread" : "error",
          error: error.inferenceBlocked
            ? error.message
            : error instanceof z.ZodError
              ? "모델 응답 형식이 올바르지 않습니다."
              : "모델 판독에 실패했습니다. 모델 연결을 확인하고 다시 요청하세요.",
        },
        "AI 서비스",
        "실제 판독 실패",
        { inference: true },
      );
    }
  } catch (error) {
    console.error("Worker:", error.code || error.message);
  } finally {
    busy = false;
  }
}
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    await initializeStore(dataset.policy);
    if (!(await objects.bucketExists(bucket))) {
      if (profile.scope === "local-private")
        throw new Error("전용 비공개 버킷을 먼저 준비하세요.");
      await objects.makeBucket(bucket);
    }
    if (demoMode) {
      const [rows] = await pool.query(
        "SELECT data FROM entities WHERE kind = 'inspection'",
      );
      if (
        rows.some(
          (row) =>
            !allowedHashes.has(
              (typeof row.data === "string" ? JSON.parse(row.data) : row.data)
                .sha256,
            ),
        )
      ) {
        throw new Error(
          "공개 데모 시작 중단: 승인되지 않은 사진이 저장소에 있습니다.",
        );
      }
    }
    uploads = await createUploadService({
      pool,
      objects,
      bucket,
      directory: uploadRoot,
      validateRelation: validatePhotoRelation,
      demoOnly: demoMode,
      allowedHashes,
      inferencePolicy: dataset.policy,
    });
    await uploads.cleanup();
    await multipartFiles.cleanup(SESSION_TTL_MS);
    await thumbnailFiles.cleanup(SESSION_TTL_MS);
    await cleanupModelScratch(uploadRoot);
    break;
  } catch (error) {
    if (attempt === 29) throw error;
    console.log(`저장소 연결 대기 ${attempt + 1}/30`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
const host = process.env.API_HOST || "127.0.0.1";
const port = Number(process.env.API_PORT || 4000);
app.listen(port, host, () => console.log(`검사 API http://${host}:${port}`));
setInterval(processNext, 1500);
setInterval(
  async () => {
    try {
      await uploads.cleanup();
      await multipartFiles.cleanup(SESSION_TTL_MS);
      await thumbnailFiles.cleanup(SESSION_TTL_MS);
      await cleanupModelScratch(uploadRoot);
    } catch (error) {
      console.error("Upload cleanup:", error.code || error.message);
    }
  },
  60 * 60 * 1000,
).unref();
