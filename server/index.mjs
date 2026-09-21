import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import { Client } from "minio";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  initializeStore,
  list,
  get,
  insert,
  insertBatch,
  update,
  events,
  pool,
  decodeEntity,
} from "./store.mjs";

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
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10, fields: 5 },
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
const pointSchema = z.object({
  equipment: field.default(""),
  rack: field.default(""),
  name: field.default(""),
});
const pointPatch = z
  .object({
    equipment: field.optional(),
    rack: field.optional(),
    name: field.optional(),
    repairStatus: z.enum(["none", "review", "progress", "done"]).optional(),
    managed: z.boolean().optional(),
    ta: z.boolean().optional(),
    expectedVersion,
    actor,
    reason,
  })
  .strict();
const inspectionPatch = z
  .object({
    pointId: z.string().uuid().nullable().optional(),
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
app.get("/api/points", async (req, res) => res.json(await list("point")));
app.post("/api/points", async (req, res) => {
  const input = pointSchema.parse(req.body);
  const existing = (await list("point")).find(
    (p) =>
      p.equipment === input.equipment &&
      p.rack === input.rack &&
      p.name === input.name,
  );
  if (existing) return res.json(existing);
  res
    .status(201)
    .json(
      await insert(
        "point",
        { ...input, repairStatus: "none", managed: false, ta: false },
        "현업 엔지니어",
        "포인트 등록",
      ),
    );
});
app.patch("/api/points/:id", async (req, res) => {
  const { actor, reason, expectedVersion, ...patch } = pointPatch.parse(
    req.body,
  );
  const result = await update("point", req.params.id, patch, actor, reason, {
    expectedVersion,
  });
  if (!result) throw fail(404, "포인트를 찾을 수 없습니다.");
  res.json(result);
});
app.get("/api/points/:id/history", async (req, res) =>
  res.json(await events(req.params.id)),
);
app.get("/api/inspections", async (req, res) =>
  res.json(await list("inspection")),
);
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
async function saveUploads(files, pointId, reuseDemo) {
  const byHash = new Map();
  if (reuseDemo) {
    const [rows] = await pool.execute(
      `SELECT data FROM entities WHERE kind = 'inspection'
      AND COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(data, '$.pointId')), 'null'), '') = ?
      ORDER BY created_at ASC`,
      [pointId || ""],
    );
    for (const row of rows) {
      const photo = decodeEntity(row.data);
      if (!byHash.has(photo.sha256)) byHash.set(photo.sha256, photo);
    }
  }
  const unique = new Set();
  const toSave = files.filter((file) => {
    if (!reuseDemo) return true;
    if (byHash.has(file.hash) || unique.has(file.hash)) return false;
    unique.add(file.hash);
    return true;
  });
  const objectsWritten = [];
  const inputs = [];
  let created = [];
  try {
    for (const file of toSave) {
      const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
      await objects.putObject(bucket, key, file.buffer, file.size, {
        "Content-Type": file.mime,
      });
      objectsWritten.push(key);
      inputs.push({
        name: Buffer.from(file.originalname, "latin1")
          .toString("utf8")
          .slice(0, 200),
        objectKey: key,
        sha256: file.hash,
        size: file.size,
        mime: file.mime,
        pointId,
        status: "pending",
        ai: null,
        humanGrade: null,
        retake: false,
        retakeReason: "",
        labeling: false,
        error: null,
      });
    }
    if (inputs.length)
      created = await insertBatch(
        "inspection",
        inputs,
        "현업 엔지니어",
        "사진 업로드",
      );
  } catch (error) {
    if (!error.commitUncertain)
      await Promise.allSettled(
        objectsWritten.map((key) => objects.removeObject(bucket, key)),
      );
    else
      console.error(
        "업로드 COMMIT 결과 불확실: 원본 객체를 보존했습니다. 목록과 저장소를 확인하세요.",
      );
    throw error;
  }
  if (!reuseDemo)
    return created.map((photo) => ({ ...photo, uploadOutcome: "created" }));
  const newIds = new Set(created.map((photo) => photo.id));
  for (const photo of created) byHash.set(photo.sha256, photo);
  return files.map((file) => {
    const photo = byHash.get(file.hash);
    const wasCreated = newIds.delete(photo.id);
    return { ...photo, uploadOutcome: wasCreated ? "created" : "existing" };
  });
}
async function validateImages(files, demoRequest) {
  for (const file of files)
    file.hash = createHash("sha256").update(file.buffer).digest("hex");
  if (demoRequest && files.some((file) => !allowedHashes.has(file.hash))) {
    throw fail(
      422,
      "시연 사진 불러오기는 제공된 시연 사진만 사용할 수 있습니다.",
    );
  }
  for (const file of files) {
    try {
      const meta = await sharp(file.buffer, {
        limitInputPixels: 40_000_000,
      }).metadata();
      if (!["jpeg", "png"].includes(meta.format)) throw new Error();
      file.mime = meta.format === "png" ? "image/png" : "image/jpeg";
      await sharp(file.buffer, { limitInputPixels: 40_000_000 }).stats();
    } catch {
      throw fail(
        422,
        "잘못된 이미지입니다. 열 수 있는 JPG 또는 PNG를 다시 선택하세요.",
      );
    }
  }
}
app.post("/api/demo-inspections", async (req, res) => {
  const { pointId } = z
    .object({ pointId: z.string().uuid().nullable().default(null) })
    .strict()
    .parse(req.body);
  if (pointId && !(await get("point", pointId)))
    throw fail(422, "연결할 포인트가 없습니다. 다시 선택하세요.");
  const files = await Promise.all(
    demoFiles.map(async (file) => {
      const buffer = await readFile(
        new URL(`../image/demo/${file.name}`, import.meta.url),
      );
      return { buffer, size: buffer.length, originalname: file.name };
    }),
  );
  await validateImages(files, true);
  const result = await withDemoLock(() => saveUploads(files, pointId, true));
  res
    .status(
      result.some((photo) => photo.uploadOutcome === "created") ? 201 : 200,
    )
    .json(result);
});
app.post("/api/inspections", upload.array("images", 10), async (req, res) => {
  if (!req.files?.length)
    throw fail(400, "사진이 없습니다. JPG 또는 PNG 사진을 선택하세요.");
  const demoRequest = demoMode || req.body.demo === "1";
  const pointId = req.body.pointId || null;
  if (pointId && !(await get("point", pointId)))
    throw fail(422, "연결할 포인트가 없습니다. 다시 선택하세요.");
  await validateImages(req.files, demoRequest);
  const save = () => saveUploads(req.files, pointId, demoRequest);
  const result = demoRequest ? await withDemoLock(save) : await save();
  res
    .status(
      result.some((photo) => photo.uploadOutcome === "created") ? 201 : 200,
    )
    .json(result);
});
const thumbnails = new Map();
app.get("/api/inspections/:id/thumbnail", async (req, res) => {
  const item = await get("inspection", req.params.id);
  if (!item) throw fail(404, "사진이 없습니다.");
  let thumbnail = thumbnails.get(item.sha256);
  if (!thumbnail) {
    thumbnail = (async () => {
      const stream = await objects.getObject(bucket, item.objectKey);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      return sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 })
        .rotate()
        .resize(320, 200, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
    })();
    thumbnails.set(item.sha256, thumbnail);
    thumbnail.catch(() => thumbnails.delete(item.sha256));
    if (thumbnails.size > 128)
      thumbnails.delete(thumbnails.keys().next().value);
  }
  const bytes = await thumbnail;
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.type("image/webp").send(bytes);
});
app.get("/api/inspections/:id/image", async (req, res) => {
  const item = await get("inspection", req.params.id);
  if (!item) throw fail(404, "사진이 없습니다.");
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
  if (patch.pointId && !(await get("point", patch.pointId)))
    throw fail(422, "연결할 포인트를 찾을 수 없습니다.");
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
app.get("/api/plans", async (req, res) => res.json(await list("plan")));
app.get("/api/plans/:id/history", async (req, res) =>
  res.json(await events(req.params.id)),
);
app.post("/api/plans", async (req, res) => {
  const input = z
    .object({
      title: z.string().trim().min(1).max(120),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      pointId: z.string().uuid().nullable(),
      note: z.string().max(1000).default(""),
    })
    .parse(req.body);
  if (
    Number.isNaN(Date.parse(input.date)) ||
    new Date(input.date).toISOString().slice(0, 10) !== input.date
  )
    throw fail(422, "올바른 날짜를 선택하세요.");
  if (input.pointId && !(await get("point", input.pointId)))
    throw fail(422, "포인트를 다시 선택하세요.");
  res
    .status(201)
    .json(
      await insert(
        "plan",
        { ...input, status: "planned" },
        "현업 엔지니어",
        "검사 계획 등록",
      ),
    );
});
app.patch("/api/plans/:id", async (req, res) => {
  const input = z
    .object({
      status: z.enum(["planned", "done", "cancelled"]),
      expectedVersion,
      actor,
      reason,
    })
    .strict()
    .parse(req.body);
  const result = await update(
    "plan",
    req.params.id,
    { status: input.status },
    input.actor,
    input.reason,
    { expectedVersion: input.expectedVersion },
  );
  if (!result) throw fail(404, "계획이 없습니다.");
  res.json(result);
});
app.use((error, req, res, next) => {
  if (error instanceof z.ZodError)
    return res
      .status(422)
      .json({ error: error.issues[0]?.message || "입력을 확인하세요." });
  if (error instanceof multer.MulterError)
    return res.status(413).json({
      error: "한 번에 최대 10장, 사진당 20MB까지 업로드할 수 있습니다.",
    });
  const status = error.status || 500;
  if (status >= 500)
    console.error("API request failed:", error.code || error.message);
  res.status(status).json({
    error:
      status >= 500
        ? "저장소 연결에 문제가 있습니다. 잠시 후 다시 시도하세요."
        : error.message,
  });
});

let busy = false;
async function processNext() {
  if (busy) return;
  busy = true;
  try {
    const next = (await list("inspection"))
      .reverse()
      .find(
        (photo) =>
          photo.status === "pending" ||
          (photo.status === "processing" &&
            Date.now() - Date.parse(photo.updatedAt || photo.createdAt) >
              180000),
      );
    if (!next) return;
    const modelUrl = process.env.MODEL_API_URL || "http://127.0.0.1:8001";
    try {
      const health = await fetch(`${modelUrl}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (!health.ok || !(await health.json()).ready) return;
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
      const stream = await objects.getObject(bucket, next.objectKey);
      const parts = [];
      for await (const part of stream) parts.push(part);
      const data = new FormData();
      data.append(
        "image",
        new Blob([Buffer.concat(parts)], { type: next.mime }),
        "inspection-image",
      );
      const response = await fetch(`${modelUrl}/predict`, {
        method: "POST",
        body: data,
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) throw new Error(`모델 응답 오류 (${response.status})`);
      const result = predictionSchema.parse(await response.json());
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
          status: "error",
          error:
            error instanceof z.ZodError
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
    await initializeStore();
    if (!(await objects.bucketExists(bucket))) await objects.makeBucket(bucket);
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
