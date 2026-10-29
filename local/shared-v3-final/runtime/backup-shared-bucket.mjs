import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { Client } from "minio";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

dotenv.config({ path: "local/shared-v3-final/api.env", override: true, quiet: true });
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3307),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 1,
});
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT || "127.0.0.1",
  port: Number(process.env.MINIO_PORT || 9000),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
const bucket = process.env.MINIO_BUCKET || "inspection-images";
const outputDir = "local/shared-v3-final/runtime/demo-data-backups/shared-objects";
await mkdir(outputDir, { recursive: true, mode: 0o700 });
await chmod(outputDir, 0o700);

const connection = await pool.getConnection();
let photos;
try {
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  await connection.beginTransaction();
  const [rows] = await connection.execute(
    "SELECT data FROM entities WHERE kind='inspection' ORDER BY id",
  );
  photos = rows.map(({ data }) => (typeof data === "string" ? JSON.parse(data) : data));
  await connection.commit();
} catch (error) {
  await connection.rollback().catch(() => {});
  throw error;
} finally {
  connection.release();
  await pool.end();
}

const byKey = new Map();
for (const photo of photos) {
  if (!photo.objectKey || !/^[a-f0-9]{64}$/.test(photo.sha256 || ""))
    throw new Error("사진 개체 연결 정보에 누락이 있습니다.");
  const current = byKey.get(photo.objectKey);
  if (current && current.sha256 !== photo.sha256)
    throw new Error("같은 저장 키에 서로 다른 사진 해시가 연결되어 있습니다.");
  if (current) current.photoCount += 1;
  else byKey.set(photo.objectKey, { objectKey: photo.objectKey, sha256: photo.sha256, photoCount: 1 });
}

const entries = [...byKey.values()].sort((a, b) => a.objectKey.localeCompare(b.objectKey));
let totalBytes = 0;
for (const [index, entry] of entries.entries()) {
  const fileName = `object-${String(index + 1).padStart(4, "0")}.bin`;
  const destination = `${outputDir}/${fileName}`;
  const hash = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    await objects.getObject(bucket, entry.objectKey),
    tap,
    createWriteStream(destination, { flags: "wx", mode: 0o600 }),
  );
  const sha256 = hash.digest("hex");
  if (sha256 !== entry.sha256) throw new Error("사진 원본 백업 해시가 일치하지 않습니다.");
  Object.assign(entry, { fileName, size: bytes, verifiedSha256: sha256 });
  totalBytes += bytes;
}

const manifest = {
  capturedAt: new Date().toISOString(),
  bucket,
  objectCount: entries.length,
  totalBytes,
  entries,
};
const manifestPath = `${outputDir}/manifest.json`;
await writeFile(manifestPath, JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
await chmod(manifestPath, 0o600);
console.log(JSON.stringify({
  objectCount: manifest.objectCount,
  totalBytes,
  allSha256Verified: true,
  manifestPath,
}));
