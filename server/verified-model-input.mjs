import { createHash } from "node:crypto";
import { mkdtemp, open, rm, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { requireFreeSpace } from "./upload-files.mjs";

const active = new Set();
export async function cleanupModelScratch(
  directory,
  maxAgeMs = 24 * 60 * 60 * 1000,
) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^model-[a-zA-Z0-9]{6}$/.test(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (active.has(path)) continue;
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > maxAgeMs)
      await rm(path, { recursive: true, force: true });
  }
}

export async function withVerifiedModelInput(
  { objects, bucket, photo, directory, decide, copyTimeoutMs = 120000, signal },
  predict,
) {
  signal?.throwIfAborted();
  await requireFreeSpace(directory, photo.size);
  const folder = await mkdtemp(join(directory, "model-"));
  const handle = await open(join(folder, "input"), "wx+", 0o600);
  active.add(folder);
  let source;
  let expired = false;
  let timer;
  let abort;
  const timeoutError = Object.assign(
    new Error("원본 확인 시간이 초과됐습니다."),
    { code: "source_timeout" },
  );
  try {
    signal?.throwIfAborted();
    const deadline = new Promise((_, reject) => {
      abort = () => {
        expired = true;
        source?.destroy(signal.reason);
        reject(signal.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        expired = true;
        source?.destroy(timeoutError);
        reject(timeoutError);
      }, copyTimeoutMs);
    });
    const acquiring = objects
      .getObject(bucket, photo.objectKey)
      .then((stream) => {
        if (expired) {
          stream.destroy();
          throw timeoutError;
        }
        return stream;
      });
    source = await Promise.race([acquiring, deadline]);
    const hash = createHash("sha256");
    let size = 0;
    for await (const bytes of source) {
      if (expired) throw timeoutError;
      size += bytes.length;
      if (size > photo.size)
        throw Object.assign(new Error("원본 크기가 저장 정보와 다릅니다."), {
          code: "object_mismatch",
        });
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!bytesWritten)
          throw new Error("원본 확인 파일을 기록할 수 없습니다.");
        offset += bytesWritten;
      }
    }
    clearTimeout(timer);
    if (expired) throw timeoutError;
    const sha256 = hash.digest("hex");
    if (size !== photo.size || sha256 !== photo.sha256)
      throw Object.assign(
        new Error("원본 해시 또는 크기가 저장 정보와 다릅니다."),
        { code: "object_mismatch" },
      );
    const decision = decide(photo, sha256);
    if (!decision.allowed)
      throw Object.assign(new Error(decision.message), {
        code: decision.code,
        inferenceBlocked: true,
      });
    await handle.sync();
    const verified = handle.createReadStream({
      start: 0,
      autoClose: false,
      signal,
    });
    // The caller may await a lease check before fetch consumes this stream.
    // An abort in that window must reject the operation, not crash the process.
    verified.on("error", () => {});
    try {
      return await predict(verified, sha256);
    } finally {
      verified.destroy();
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    source?.destroy();
    await handle.close();
    await rm(folder, { recursive: true, force: true });
    active.delete(folder);
  }
}

export function assertFrozenIdentity(
  value,
  frozen,
  { checkpoint = true } = {},
) {
  if (!frozen) return;
  const keys = checkpoint
    ? ["model_version", "preprocessing_version", "checkpoint_sha256"]
    : ["model_version", "preprocessing_version"];
  if (keys.some((key) => value?.[key] !== frozen[key]))
    throw Object.assign(
      new Error("연결된 모델이 보존된 동결 모델과 다릅니다."),
      { code: "model_identity_mismatch" },
    );
}
