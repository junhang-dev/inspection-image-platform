import "dotenv/config";
import assert from "node:assert/strict";
import { Client } from "minio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../server/store.mjs";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract } from "../server/dataset-contract.mjs";
import { verifyStorageProfile } from "../server/storage-profile.mjs";

const profile = runtimeProfile();
if (profile.scope !== "local-private")
  throw new Error("전용 로컬 검증만 허용합니다.");
const name = process.argv[2];
if (!/^[a-z0-9-]+\.local\.json$/.test(name || ""))
  throw new Error("로컬 감사 파일 이름을 지정하세요.");
const compareIndex = process.argv.indexOf("--compare");
const compare = compareIndex < 0 ? null : process.argv[compareIndex + 1];
if (compare && !/^[a-z0-9-]+\.local\.json$/.test(compare))
  throw new Error("비교할 로컬 감사 파일 이름을 지정하세요.");
const dataset = await loadDatasetContract(profile);
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
const decode = (v) => (typeof v === "string" ? JSON.parse(v) : v);
try {
  await verifyStorageProfile(pool, objects, profile, dataset);
  const raw = {};
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT");
    const [tables] = await connection.query("SHOW TABLES");
    const available = new Set(tables.map((row) => Object.values(row)[0]));
    for (const table of [
      "storage_profile",
      "entities",
      "history",
      "upload_sessions",
      "upload_chunks",
      "private_import_registry",
      "private_import_parents",
      "private_import_aliases",
    ]) {
      const rows = available.has(table)
        ? (await connection.query(`SELECT * FROM ${table}`))[0]
        : [];
      raw[table] = rows.map((row) => JSON.stringify(row)).sort();
    }
    await connection.commit();
  } finally {
    connection.release();
  }
  const entities = raw.entities.map((row) => JSON.parse(row));
  const photos = entities
    .filter((row) => row.kind === "inspection")
    .map((row) => decode(row.data));
  const points = new Map(
    entities
      .filter((row) => row.kind === "point")
      .map((row) => [row.id, decode(row.data)]),
  );
  const plans = new Map(
    entities
      .filter((row) => row.kind === "plan")
      .map((row) => [row.id, decode(row.data)]),
  );
  const registry = raw.private_import_registry.map((row) =>
    decode(JSON.parse(row).data),
  );
  const source = new Map(dataset.plan.entries.map((e) => [e.sourceId, e]));
  const teams = {},
    racks = {},
    provenance = {};
  const verifiedObjects = [];
  let maxCachedConfidenceDelta = 0;
  const seen = new Set();
  for (const photo of photos) {
    const entry = source.get(photo.sourceId);
    assert.ok(entry);
    assert.equal(photo.sha256, entry.sha256);
    assert.equal(photo.size, entry.size_bytes);
    assert.equal(photo.datasetManifestSha256, dataset.manifestSha256);
    assert.equal(photo.recordPurpose, "inspection");
    assert.equal(photo.inferencePolicy.allowed, false);
    assert.ok(plans.get(photo.planId)?.pointIds.includes(photo.pointId));
    const point = points.get(photo.pointId);
    assert.equal(point.locationVerified, false);
    assert.equal(point.locationSource, "virtual");
    const rack = point.rackId,
      team = rack.slice(0, 6);
    teams[team] = (teams[team] || 0) + 1;
    racks[rack] = (racks[rack] || 0) + 1;
    provenance[photo.aiProvenance?.kind || "unread"] =
      (provenance[photo.aiProvenance?.kind || "unread"] || 0) + 1;
    if (photo.aiProvenance?.kind?.startsWith("cached_")) {
      const cached = dataset.caches.get(entry.canonicalSourceId);
      assert.ok(cached);
      for (const field of ["grade", "model_version", "preprocessing_version"])
        assert.equal(photo.ai[field], cached.ai[field]);
      // MySQL JSON's double-to-text formatter can move the last decimal by
      // one IEEE-754 unit. The hashed original report remains authoritative.
      const delta = Math.abs(photo.ai.confidence - cached.ai.confidence);
      assert.ok(delta <= Number.EPSILON);
      maxCachedConfidenceDelta = Math.max(maxCachedConfidenceDelta, delta);
      for (const [key, value] of Object.entries(cached.provenance)) {
        if (key === "sourceId") continue; // duplicate record retains its own source ID
        assert.equal(photo.aiProvenance[key], value);
      }
    }
    if (entry.canonicalSplit === "test") {
      assert.equal(photo.protectedEvaluation, true);
      const cached = dataset.caches.get(entry.canonicalSourceId);
      if (!cached) assert.equal(photo.ai, null);
      else assert.equal(photo.aiProvenance.kind, "cached_frozen_evaluation");
      assert.equal(photo.aiProvenance?.predictedAt ?? null, null);
    }
    if (seen.has(photo.objectKey)) continue;
    seen.add(photo.objectKey);
    const stream = await objects.getObject(
      process.env.MINIO_BUCKET,
      photo.objectKey,
    );
    let size = 0;
    const hash = createHash("sha256");
    for await (const bytes of stream) {
      size += bytes.length;
      hash.update(bytes);
    }
    const sha256 = hash.digest("hex");
    assert.equal(size, entry.size_bytes);
    assert.equal(sha256, entry.sha256);
    verifiedObjects.push({ key: photo.objectKey, size, sha256 });
  }
  verifiedObjects.sort((a, b) => a.key.localeCompare(b.key));
  if (process.argv.includes("--complete")) {
    assert.equal(photos.length, 300);
    assert.equal(seen.size, 299);
    assert.equal(registry.length, 300);
    assert.ok(registry.every((row) => row.state === "complete"));
    assert.equal(plans.size, 4);
    assert.equal(points.size, 12);
    assert.equal(raw.private_import_aliases.length, 5);
    assert.equal(Object.keys(teams).length, 4);
    assert.ok(Object.values(teams).every((n) => n === 75));
    assert.equal(Object.keys(racks).length, 12);
    assert.ok(Object.values(racks).every((n) => n === 25));
  }
  if (compare) {
    const before = JSON.parse(
      await readFile(join(profile.root, compare), "utf8"),
    );
    assert.equal(
      JSON.stringify(raw),
      JSON.stringify(before.raw),
      "database rows or history changed",
    );
    assert.equal(
      JSON.stringify(verifiedObjects),
      JSON.stringify(before.objects),
      "object bytes changed",
    );
  }
  const summary = {
    photos: photos.length,
    uniqueObjects: seen.size,
    plans: plans.size,
    points: points.size,
    aliases: raw.private_import_aliases.length,
    registry: registry.length,
    history: raw.history.length,
    teams,
    racks,
    provenance,
    maxCachedConfidenceDelta,
    compared: compare,
  };
  await writeFile(
    join(profile.root, name),
    JSON.stringify({
      at: new Date().toISOString(),
      summary,
      raw,
      objects: verifiedObjects,
    }),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(summary));
} finally {
  await pool.end();
}
