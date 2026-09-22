import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { insertEntity } from "./store.mjs";
import {
  CHUNK_BYTES,
  appendChunk,
  ensureUploadDirectory,
  fail,
  inspectImage,
  receiveChunk,
  reconcileFile,
  requireFreeSpace,
  sha256File,
} from "./upload-files.mjs";
import {
  commitChunk,
  findChunk,
  initializeUploads,
  readUpload,
  uploadLock,
  writeUpload,
} from "./upload-store.mjs";

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const identityKeys = [
  "id",
  "name",
  "size",
  "sha256",
  "pointId",
  "planId",
  "rackId",
  "batchId",
  "recordPurpose",
];
const missingObject = (error) =>
  ["NoSuchKey", "NotFound", "NoSuchObject"].includes(error.code) ||
  error.statusCode === 404;

export async function createUploadService({
  pool,
  objects,
  bucket,
  directory,
  validateRelation,
  demoOnly = false,
  allowedHashes = new Set(),
  inferencePolicy,
}) {
  const root = await ensureUploadDirectory(directory);
  await initializeUploads(pool);
  const locked = uploadLock(pool);
  const filePath = (id) => join(root, `${id}.upload`);
  let finalizing = false;
  let receivingRequests = 0;

  async function known(connection, id) {
    const upload = await readUpload(connection, id);
    if (!upload)
      throw fail(404, "전송 기록을 찾을 수 없습니다. 파일을 다시 선택하세요.");
    return upload;
  }

  async function publicStatus(connection, upload) {
    let photo = null;
    if (upload.status === "completed") {
      const [rows] = await connection.execute(
        "SELECT data FROM entities WHERE kind = 'inspection' AND id = ?",
        [upload.inspectionId],
      );
      photo = rows[0]
        ? typeof rows[0].data === "string"
          ? JSON.parse(rows[0].data)
          : rows[0].data
        : null;
      if (!photo) throw fail(500, "저장된 사진 기록을 찾을 수 없습니다.");
    }
    const { objectKey, ...safe } = upload;
    return { ...safe, chunkBytes: CHUNK_BYTES, photo };
  }

  async function expire(connection, upload) {
    if (
      upload.status !== "receiving" ||
      Date.now() - Date.parse(upload.updatedAt) < SESSION_TTL_MS
    )
      return upload;
    const expired = await writeUpload(connection, {
      ...upload,
      status: "expired",
      error:
        "24시간 동안 이어지지 않은 임시 전송이 만료됐습니다. 같은 파일로 전송을 다시 시작하세요.",
    });
    await rm(filePath(upload.id), { force: true });
    return expired;
  }

  async function checkStoredObject(upload) {
    let info;
    try {
      info = await objects.statObject(bucket, upload.objectKey);
    } catch (error) {
      if (missingObject(error)) return false;
      throw error;
    }
    if (info.size !== upload.size)
      throw fail(
        409,
        "같은 전송 기록의 원본 크기가 다릅니다. 기존 원본은 보존했으며 다시 덮어쓰지 않습니다.",
      );
    const hash = createHash("sha256");
    const stream = await objects.getObject(bucket, upload.objectKey);
    for await (const bytes of stream) hash.update(bytes);
    if (hash.digest("hex") !== upload.sha256)
      throw fail(
        409,
        "같은 전송 기록의 원본 내용이 다릅니다. 기존 원본은 보존했으며 다시 덮어쓰지 않습니다.",
      );
    return true;
  }

  async function initialize(input) {
    inferencePolicy?.assertUpload(input);
    const recordPurpose = input.recordPurpose ?? "inspection";
    if (!["inspection", "presentation", "verification"].includes(recordPurpose))
      throw fail(422, "올바른 기록 목적을 선택하세요.");
    input = { ...input, recordPurpose };
    return locked(input.id, async (connection) => {
      const current = await readUpload(connection, input.id);
      if (current) {
        current.recordPurpose ??= "inspection";
        if (identityKeys.some((key) => (current[key] ?? null) !== (input[key] ?? null)))
          throw fail(
            409,
            "이 전송 기록과 선택한 사진 또는 검사 대상이 다릅니다. 새 사진은 별도로 추가하세요.",
          );
        return publicStatus(connection, await expire(connection, current));
      }
      if (demoOnly && !allowedHashes.has(input.sha256))
        throw fail(422, "이 공유 환경에서 허용된 사진만 업로드할 수 있습니다.");
      await requireFreeSpace(root, Math.min(input.size, CHUNK_BYTES) * 2);
      try {
        await connection.beginTransaction();
        const relation = await validateRelation(input.planId, input.pointId, connection, input, { lock: true, phase: "create" });
        const time = new Date().toISOString();
        const upload = {
          ...input, ...relation,
          contractVersion: "plan-rack-v3",
          inspectionId: randomUUID(),
          objectKey: `uploads/${input.id}`,
          offset: 0, status: "receiving", error: null,
          createdAt: time, updatedAt: time,
        };
        await connection.execute("INSERT INTO upload_sessions(id, data) VALUES (?, ?)", [upload.id, JSON.stringify(upload)]);
        await connection.commit();
        return publicStatus(connection, upload);
      } catch (error) {
        await connection.rollback().catch(() => {});
        // Retry/status reuses the committed identity after a lost response.
        // Never acquire a second pool connection while holding this session lock.
        throw error;
      }
    });
  }

  async function status(id) {
    return locked(id, async (connection) => {
      const upload = await expire(connection, await known(connection, id));
      if (upload.status === "receiving")
        await reconcileFile(filePath(id), upload.offset);
      return publicStatus(connection, upload);
    });
  }

  async function chunk(id, offset, sha256, stream) {
    // Reserve DB capacity for lists, health and inference during slow uploads.
    // IncomingMessage may disconnect while waiting for its session lock.
    stream.on("error", () => {});
    if (receivingRequests >= 4)
      throw fail(
        503,
        "다른 사진을 전송 중입니다. 잠시 뒤 같은 파일을 다시 시도하세요.",
      );
    receivingRequests++;
    try {
      return await locked(id, async (connection) => {
        const upload = await expire(connection, await known(connection, id));
        if (upload.status !== "receiving")
          throw fail(
            409,
            "이 파일은 수신 중이 아닙니다. 저장 상태를 확인하세요.",
          );
        if (
          offset > upload.offset ||
          offset % CHUNK_BYTES !== 0 ||
          offset >= upload.size
        )
          throw fail(
            409,
            "전송 위치가 다릅니다. 저장 상태를 확인한 뒤 다시 시도하세요.",
          );
        const expectedLength = Math.min(CHUNK_BYTES, upload.size - offset);
        const part = await receiveChunk(
          stream,
          root,
          expectedLength,
          sha256,
          id,
        );
        try {
          if (offset < upload.offset) {
            const saved = await findChunk(connection, id, offset);
            if (
              !saved ||
              Number(saved.byte_length) !== part.length ||
              saved.sha256 !== part.sha256
            )
              throw fail(
                409,
                "이미 수신한 사진 조각과 내용이 다릅니다. 이 파일의 전송 상태를 다시 확인하세요.",
              );
            return publicStatus(connection, upload);
          }
          await reconcileFile(filePath(id), upload.offset);
          await appendChunk(filePath(id), part.path);
          return publicStatus(
            connection,
            await commitChunk(connection, upload, part),
          );
        } finally {
          await rm(part.path, { force: true });
        }
      });
    } finally {
      receivingRequests--;
    }
  }

  async function finishLocked(connection, original) {
    let upload = original;
    if (upload.status === "completed") return publicStatus(connection, upload);
    if (upload.status === "expired") throw fail(410, upload.error);
    if (upload.offset !== upload.size)
      throw fail(
        409,
        "사진 전송이 아직 끝나지 않았습니다. 남은 부분을 전송한 뒤 저장하세요.",
      );
    await validateRelation(upload.planId, upload.pointId, connection, upload, { phase: "finalize" });
    if (demoOnly && !allowedHashes.has(upload.sha256))
      throw fail(422, "이 공유 환경에서 허용된 사진만 업로드할 수 있습니다.");
    const path = filePath(upload.id);
    // Reject protected aliases before Sharp can decode pixels. A supplied hash
    // is only an early check; the full received bytes are authoritative.
    inferencePolicy?.assertUpload(upload);
    if (upload.status === "receiving")
      inferencePolicy?.assertUpload(upload, await sha256File(path));
    let verifiedImage;
    if (upload.status === "receiving") {
      await reconcileFile(path, upload.offset);
      const image = (verifiedImage = await inspectImage(path));
      if (image.size !== upload.size || image.sha256 !== upload.sha256)
        throw fail(
          422,
          "받은 원본이 선택한 사진과 다릅니다. 같은 파일로 전송을 다시 시작하세요.",
        );
      upload = await writeUpload(connection, {
        ...upload,
        mime: image.mime,
        status: "finalizing",
        error: null,
      });
    }
    if (!upload.mime) throw fail(500, "사진 검증 상태를 확인할 수 없습니다.");
    // A previous request may have stored this object before losing its response.
    // Existing objects are verified and reused, never blindly overwritten.
    if (!(await checkStoredObject(upload))) {
      inferencePolicy?.assertUpload(upload, await sha256File(path));
      const image = verifiedImage || (await inspectImage(path));
      if (
        image.size !== upload.size ||
        image.sha256 !== upload.sha256 ||
        image.mime !== upload.mime
      )
        throw fail(
          422,
          "검증한 원본과 임시 파일이 다릅니다. 저장된 자료는 보존했습니다.",
        );
      await objects.putObject(
        bucket,
        upload.objectKey,
        createReadStream(path),
        upload.size,
        { "Content-Type": upload.mime, sha256: upload.sha256 },
      );
    }
    const photo = {
      id: upload.inspectionId,
      name: upload.name,
      objectKey: upload.objectKey,
      sha256: upload.sha256,
      size: upload.size,
      mime: upload.mime,
      pointId: upload.pointId,
      planId: upload.planId,
      teamId: upload.teamId ?? null,
      rackId: upload.rackId ?? null,
      batchId: upload.batchId ?? null,
      recordPurpose: upload.recordPurpose ?? "inspection",
      visibility: "visible",
      status: "pending",
      ai: null,
      humanGrade: null,
      retake: false,
      retakeReason: "",
      labeling: false,
      error: null,
      editVersion: 0,
      createdAt: new Date().toISOString(),
    };
    let completed;
    let committedConnection = connection;
    try {
      await connection.beginTransaction();
      // Plan close/scope edits take the same row lock. Recheck immediately
      // before commit, after object storage, retaining the session on conflict.
      const relation = await validateRelation(upload.planId, upload.pointId, connection, upload, { lock: true, phase: "finalize" });
      Object.assign(photo, relation);
      await insertEntity(
        connection,
        "inspection",
        photo,
        "현업 엔지니어",
        "사진 업로드",
      );
      completed = await writeUpload(connection, {
        ...upload,
        status: "completed",
        error: null,
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => {});
      // If this connection remains usable, recover a lost COMMIT response.
      // Otherwise the caller's next locked status request performs recovery.
      const current = await readUpload(connection, upload.id).catch(() => null);
      if (current?.status === "completed") {
        completed = current;
        committedConnection = connection;
      } else throw error;
    }
    await rm(path, { force: true }).catch(() => {});
    return publicStatus(committedConnection, completed);
  }

  async function finish(id) {
    return locked(id, async (connection) => {
      const upload = await expire(connection, await known(connection, id));
      if (upload.status === "completed")
        return publicStatus(connection, upload);
      if (finalizing)
        throw fail(
          503,
          "다른 사진을 저장 중입니다. 잠시 뒤 이 파일을 다시 시도하세요.",
        );
      finalizing = true;
      try {
        return await finishLocked(connection, upload);
      } finally {
        finalizing = false;
      }
    });
  }

  async function restart(id, sha256) {
    return locked(id, async (connection) => {
      const upload = await known(connection, id);
      if (upload.sha256 !== sha256)
        throw fail(409, "원래 선택한 사진과 내용이 다릅니다.");
      if (upload.status === "completed")
        return publicStatus(connection, upload);
      if (upload.status === "finalizing")
        throw fail(
          409,
          "원본 저장을 확인 중입니다. 전송을 다시 시작하지 말고 저장 확인을 다시 시도하세요.",
        );
      // Retain a recoverable marker across interruption of temporary cleanup.
      const resetting = await writeUpload(connection, {
        ...upload,
        status: "expired",
        error: "임시 전송을 다시 시작하는 중입니다.",
      });
      await rm(filePath(id), { force: true });
      try {
        await connection.beginTransaction();
        await connection.execute(
          "DELETE FROM upload_chunks WHERE upload_id = ?",
          [id],
        );
        const ready = await writeUpload(connection, {
          ...resetting,
          offset: 0,
          status: "receiving",
          error: null,
        });
        await connection.commit();
        return publicStatus(connection, ready);
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      }
    });
  }

  // Legacy multipart and approved demo use the same finalization transaction.
  async function importFile(input, path) {
    const initialized = await initialize(input);
    if (initialized.status === "completed")
      return { ...initialized, uploadOutcome: "existing" };
    await locked(input.id, async (connection) => {
      const upload = await known(connection, input.id);
      if (upload.status !== "receiving") return;
      if (upload.offset === upload.size) return;
      if (upload.offset)
        throw fail(
          409,
          "같은 파일의 부분 전송이 있습니다. 파일별 업로드에서 이어서 전송하세요.",
        );
      await requireFreeSpace(root, input.size);
      await copyFile(path, filePath(input.id));
      const handle = await open(filePath(input.id), "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await writeUpload(connection, { ...upload, offset: upload.size });
    });
    return { ...(await finish(input.id)), uploadOutcome: "created" };
  }

  async function cleanup() {
    const [rows] = await pool.query(
      "SELECT id FROM upload_sessions WHERE updated_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 24 HOUR) AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.status')) = 'receiving'",
    );
    for (const row of rows)
      await locked(row.id, async (connection) => {
        const upload = await readUpload(connection, row.id);
        if (upload) await expire(connection, upload);
      });
    for (const name of await readdir(root)) {
      const match = name.match(
        /^([a-f0-9-]{36})(?:\.[a-f0-9-]{36})?\.(upload|chunk)$/,
      );
      if (!match) continue;
      await locked(match[1], async (connection) => {
        const upload = await readUpload(connection, match[1]);
        const path = join(root, name);
        const info = await stat(path).catch(() => null);
        if (!info) return;
        // Completed/expired markers are committed before scratch deletion. A
        // crash between them is cleaned here without touching stored originals.
        if (
          match[2] === "upload" &&
          ["completed", "expired"].includes(upload?.status)
        )
          await rm(path, { force: true });
        else if (
          match[2] === "chunk" &&
          Date.now() - info.mtimeMs > SESSION_TTL_MS
        )
          await rm(path, { force: true });
      });
    }
  }
  return {
    root,
    initialize,
    status,
    chunk,
    finish,
    restart,
    importFile,
    cleanup,
  };
}
