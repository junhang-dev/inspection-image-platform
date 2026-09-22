import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { CHUNK_BYTES, requireFreeSpace } from "./upload-files.mjs";

// Raw multipart and thumbnail scratch files never share assembled-upload paths.
export async function diskInput(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const active = new Set();
  async function receive(stream) {
    const path = join(root, `${randomUUID()}.part`);
    active.add(path);
    let size = 0;
    let nextCheck = 0;
    const check = new Transform({
      transform(bytes, encoding, callback) {
        size += bytes.length;
        if (size >= nextCheck) {
          nextCheck = size + CHUNK_BYTES;
          requireFreeSpace(root, CHUNK_BYTES).then(
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
      return {
        path,
        size,
        filename: path.split("/").at(-1),
        destination: root,
      };
    } catch (error) {
      await remove(path);
      throw error;
    }
  }
  async function remove(path) {
    try {
      await rm(path, { force: true });
    } finally {
      active.delete(path);
    }
  }
  async function cleanup(ttl) {
    for (const name of await readdir(root)) {
      if (!/^[a-f0-9-]{36}\.part$/.test(name)) continue;
      const path = join(root, name);
      if (active.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (info && Date.now() - info.mtimeMs > ttl)
        await rm(path, { force: true });
    }
  }
  const storage = {
    _handleFile(req, file, callback) {
      receive(file.stream).then((result) => callback(null, result), callback);
    },
    _removeFile(req, file, callback) {
      remove(file.path).then(() => callback(null), callback);
    },
  };
  return { storage, receive, remove, cleanup };
}
