import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

export const CHUNK_BYTES = 4 * 1024 * 1024;
const RESERVE_BYTES = 32 * 1024 * 1024;
export const fail = (status, message) =>
  Object.assign(new Error(message), { status });

export async function ensureUploadDirectory(directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const probe = join(root, `${randomUUID()}.probe`);
  const handle = await open(probe, "wx", 0o600);
  try {
    await handle.writeFile("ready");
  } finally {
    await handle.close();
    await rm(probe);
  }
  return root;
}

export async function requireFreeSpace(root, additional) {
  const disk = await statfs(root);
  if (disk.bavail * disk.bsize < additional + RESERVE_BYTES)
    throw fail(
      503,
      "사진을 임시 저장할 공간이 부족합니다. 공간을 확보한 뒤 해당 파일을 다시 시도하세요.",
    );
}

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}

export async function inspectImage(path) {
  try {
    const meta = await sharp(path, { limitInputPixels: 40_000_000 }).metadata();
    if (!["jpeg", "png"].includes(meta.format)) throw new Error("unsupported");
    await sharp(path, { limitInputPixels: 40_000_000 }).stats();
    const info = await stat(path);
    return {
      mime: meta.format === "png" ? "image/png" : "image/jpeg",
      size: info.size,
      sha256: await sha256File(path),
    };
  } catch (error) {
    if (["ENOSPC", "EIO", "EACCES", "EMFILE"].includes(error.code)) throw error;
    throw fail(
      422,
      "열 수 있는 JPG 또는 PNG 사진을 선택하세요. 이 파일은 저장되지 않았습니다.",
    );
  }
}

// Receive one bounded chunk completely before changing the assembled file.
export async function receiveChunk(
  stream,
  root,
  expectedLength,
  expectedHash,
  uploadId,
) {
  const path = join(root, `${uploadId}.${randomUUID()}.chunk`);
  const hash = createHash("sha256");
  let length = 0;
  let checkedSpace = false;
  const check = new Transform({
    transform(bytes, encoding, callback) {
      length += bytes.length;
      if (length > expectedLength)
        return callback(
          fail(
            422,
            "사진 조각의 크기가 다릅니다. 저장 상태를 확인한 뒤 다시 시도하세요.",
          ),
        );
      hash.update(bytes);
      if (!checkedSpace) {
        checkedSpace = true;
        requireFreeSpace(root, expectedLength * 2).then(
          () => callback(null, bytes),
          callback,
        );
      } else callback(null, bytes);
    },
  });
  try {
    await pipeline(
      stream,
      check,
      createWriteStream(path, { flags: "wx", mode: 0o600 }),
    );
    const sha256 = hash.digest("hex");
    if (length !== expectedLength || sha256 !== expectedHash)
      throw fail(
        422,
        "전송한 사진 조각의 내용이 다릅니다. 해당 파일을 다시 시도하세요.",
      );
    return { path, length, sha256 };
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
}

export async function appendChunk(target, chunk) {
  const handle = await open(target, "a", 0o600);
  try {
    for await (const bytes of createReadStream(chunk)) {
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.write(bytes, offset, bytes.length - offset);
        if (!result.bytesWritten)
          throw new Error("Temporary file write made no progress");
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function reconcileFile(path, committedOffset) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (committedOffset)
      throw fail(
        409,
        "전송 중이던 임시 파일을 찾을 수 없습니다. 같은 파일로 전송을 다시 시작하세요.",
      );
    const handle = await open(path, "wx", 0o600);
    await handle.close();
    return;
  }
  if (info.size < committedOffset)
    throw fail(
      409,
      "임시 파일의 길이가 저장 상태와 다릅니다. 같은 파일로 전송을 다시 시작하세요.",
    );
  if (info.size > committedOffset) {
    const handle = await open(path, "r+");
    try {
      await handle.truncate(committedOffset);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
