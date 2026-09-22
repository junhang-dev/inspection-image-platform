import { createHash } from "node:crypto";
import { open, realpath, mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants } from "node:fs";
import { requireFreeSpace } from "./upload-files.mjs";

export async function cleanupPrivateImportScratch(
  root,
  { now = Date.now(), ttlMs = 86400000 } = {},
) {
  for (const entry of await readdir(root, { withFileTypes: true }))
    if (
      entry.isDirectory() &&
      /^import-(?:run-)?[a-zA-Z0-9]{6}$/.test(entry.name)
    ) {
      const path = join(root, entry.name);
      if (now - (await stat(path)).mtimeMs >= ttlMs)
        await rm(path, { recursive: true, force: true });
    }
}

// Byte-only copy. This does not call an image decoder or a model, including test.
export async function storePrivateOriginal(
  objects,
  bucket,
  reservation,
  entry,
  sourceRoot,
  scratchRoot,
  { signal, assertOwned = async () => {} } = {},
) {
  signal?.throwIfAborted();
  await assertOwned();
  const root = await realpath(sourceRoot);
  const sourcePath = await realpath(resolve(root, entry.relative_path));
  if (!sourcePath.startsWith(`${root}/`))
    throw new Error("원본 경로가 승인된 폴더 밖입니다.");
  await requireFreeSpace(scratchRoot, entry.size_bytes);
  const folder = await mkdtemp(join(scratchRoot, "import-"));
  const scratch = await open(join(folder, "original"), "wx+", 0o600);
  let original;
  try {
    original = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const before = await original.stat();
    if (!before.isFile() || before.size !== entry.size_bytes)
      throw new Error("원본 파일 크기가 보존 manifest와 다릅니다.");
    const hash = createHash("sha256");
    let bytes = 0;
    let header = Buffer.alloc(0);
    for await (const chunk of original.createReadStream({
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      if (bytes > entry.size_bytes)
        throw new Error("원본 파일 크기가 변경됐습니다.");
      hash.update(chunk);
      if (header.length < 8)
        header = Buffer.concat([header, chunk.subarray(0, 8 - header.length)]);
      let offset = 0;
      while (offset < chunk.length) {
        const r = await scratch.write(chunk, offset, chunk.length - offset);
        if (!r.bytesWritten) throw new Error("원본 복사 중단");
        offset += r.bytesWritten;
      }
    }
    const after = await original.stat();
    if (
      bytes !== entry.size_bytes ||
      hash.digest("hex") !== entry.sha256 ||
      before.mtimeMs !== after.mtimeMs ||
      before.ino !== after.ino
    )
      throw new Error(
        "원본 내용이 보존 manifest와 다릅니다. 복사를 중단했습니다.",
      );
    const mime = header
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : header[0] === 255 && header[1] === 216 && header[2] === 255
        ? "image/jpeg"
        : null;
    if (!mime)
      throw new Error("보존 원본의 JPG/PNG 서명을 확인할 수 없습니다.");
    let existing = false;
    try {
      const info = await objects.statObject(bucket, reservation.objectKey);
      if (info.size !== entry.size_bytes)
        throw new Error("기존 객체 크기가 다릅니다. 덮어쓰지 않습니다.");
      const digest = createHash("sha256");
      const existingStream = await objects.getObject(
        bucket,
        reservation.objectKey,
      );
      const abortExisting = () => existingStream.destroy(signal.reason);
      signal?.addEventListener("abort", abortExisting, { once: true });
      try {
        signal?.throwIfAborted();
        for await (const chunk of existingStream) digest.update(chunk);
      } finally {
        signal?.removeEventListener("abort", abortExisting);
        existingStream.destroy();
      }
      if (digest.digest("hex") !== entry.sha256)
        throw new Error("기존 객체 내용이 다릅니다. 덮어쓰지 않습니다.");
      existing = true;
    } catch (error) {
      if (!["NoSuchKey", "NotFound", "NoSuchObject"].includes(error.code))
        throw error;
    }
    if (!existing) {
      signal?.throwIfAborted();
      await assertOwned();
      await scratch.sync();
      const stream = scratch.createReadStream({
        start: 0,
        autoClose: false,
        signal,
      });
      try {
        await objects.putObject(
          bucket,
          reservation.objectKey,
          stream,
          entry.size_bytes,
          { "Content-Type": mime, sha256: entry.sha256 },
        );
      } finally {
        stream.destroy();
      }
    }
    signal?.throwIfAborted();
    return {
      mime,
      reusedObject: existing,
      sha256: entry.sha256,
      size: entry.size_bytes,
    };
  } finally {
    await Promise.allSettled([original?.close(), scratch.close()]);
    await rm(folder, { recursive: true, force: true });
  }
}
