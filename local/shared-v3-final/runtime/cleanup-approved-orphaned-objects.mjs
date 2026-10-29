import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { parse } from "dotenv";
import mysql from "mysql2/promise";
import { Client } from "minio";

const root = "local/shared-v3-final";
const backups = `${root}/runtime/demo-data-backups`;
const planPath = `${backups}/approved-orphan-cleanup.local.json`;
const api = parse(await readFile(`${root}/api.env`, "utf8"));
const infra = parse(await readFile(`${root}/infra.env`, "utf8"));
const applied = JSON.parse(
  await readFile(`${backups}/curated-business-data-applied.json`, "utf8"),
);
const manifest = JSON.parse(
  await readFile(`${backups}/shared-objects/manifest.json`, "utf8"),
);
const container = "inspection-submission-v3-minio-1";
const markerKey = "__storage_profile.json";

if (
  api.DATA_SCOPE !== "shared" ||
  api.MINIO_BUCKET !== manifest.bucket ||
  manifest.objectCount !== manifest.entries.length ||
  manifest.entries.some((entry) => entry.sha256 !== entry.verifiedSha256)
)
  throw new Error("공유 버킷 또는 검증 백업이 일치하지 않습니다.");

const labels = JSON.parse(
  execFileSync(
    "docker",
    ["inspect", "--format", "{{json .Config.Labels}}", container],
    { encoding: "utf8" },
  ),
);
const containerEnv = JSON.parse(
  execFileSync(
    "docker",
    ["inspect", "--format", "{{json .Config.Env}}", container],
    { encoding: "utf8" },
  ),
);
const minioEnv = Object.fromEntries(
  containerEnv.map((item) => {
    const separator = item.indexOf("=");
    return [item.slice(0, separator), item.slice(separator + 1)];
  }),
);
if (
  labels["com.docker.compose.project"] !== "inspection-submission-v3" ||
  labels["com.docker.compose.service"] !== "minio" ||
  minioEnv.MINIO_ROOT_USER !== infra.PRIVATE_MINIO_ROOT_USER ||
  minioEnv.MINIO_ROOT_PASSWORD !== infra.PRIVATE_MINIO_ROOT_PASSWORD
)
  throw new Error("공유 MinIO 관리자 자격과 컨테이너가 일치하지 않습니다.");

const pool = mysql.createPool({
  host: api.MYSQL_HOST,
  port: Number(api.MYSQL_PORT),
  user: api.MYSQL_USER,
  password: api.MYSQL_PASSWORD,
  database: api.MYSQL_DATABASE,
  connectionLimit: 1,
});
const objects = new Client({
  endPoint: api.MINIO_ENDPOINT,
  port: Number(api.MINIO_PORT),
  useSSL: false,
  accessKey: infra.PRIVATE_MINIO_ROOT_USER,
  secretKey: infra.PRIVATE_MINIO_ROOT_PASSWORD,
});

const decode = (data) => (typeof data === "string" ? JSON.parse(data) : data);
const stable = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(stable)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
    : value;
const same = (left, right) =>
  JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const equalSets = (left, right) =>
  left.size === right.size && [...left].every((value) => right.has(value));
const hashStream = async (stream) => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
};
const hashFile = async (path) => hashStream(createReadStream(path));

async function inspectCurrent() {
  const connection = await pool.getConnection();
  let records;
  let history;
  let sessions;
  let profiles;
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.beginTransaction();
    [records] = await connection.query("SELECT kind,id,data FROM entities");
    [history] = await connection.query("SELECT data FROM history");
    [sessions] = await connection.query("SELECT data FROM upload_sessions");
    [profiles] = await connection.query(
      "SELECT data FROM storage_profile WHERE id=1",
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }

  const idsByKind = new Map();
  const referenced = new Set();
  for (const row of records) {
    idsByKind.set(row.kind, [...(idsByKind.get(row.kind) ?? []), row.id]);
    const data = decode(row.data);
    if (row.kind === "inspection" && data.objectKey)
      referenced.add(data.objectKey);
  }
  const expectedIds = new Map(Object.entries(applied.entityIds));
  const extraKinds = [...idsByKind.keys()].filter((kind) => !expectedIds.has(kind));
  if (
    extraKinds.some((kind) => kind !== "analysis_job") ||
    [...expectedIds].some(([kind, ids]) => {
      const current = idsByKind.get(kind) ?? [];
      return current.length !== ids.length || ids.some((id) => !current.includes(id));
    })
  )
    throw new Error("공유 DB가 승인된 재구성 상태와 달라 중단했습니다.");
  const kept = new Set(applied.keptObjectKeys);
  if (!equalSets(referenced, kept))
    throw new Error("DB의 사진 참조가 승인된 저장 키와 달라 중단했습니다.");
  if (profiles.length !== 1 || decode(profiles[0].data).scope !== "shared")
    throw new Error("공유 DB 저장소 표식을 확인하지 못했습니다.");

  const live = [];
  for await (const object of objects.listObjectsV2(api.MINIO_BUCKET, "", true))
    if (object.name) live.push(object.name);
  const versioning = await objects.getBucketVersioning(api.MINIO_BUCKET);
  const versioningStatus = versioning.Status ?? "Disabled";
  if (versioningStatus !== "Disabled")
    throw new Error("버킷 버전 관리가 꺼져 있지 않아 중단했습니다.");
  const marker = await objects.statObject(api.MINIO_BUCKET, markerKey);
  if (!marker) throw new Error("MinIO 저장소 표식이 없어 중단했습니다.");
  const markerStream = await objects.getObject(api.MINIO_BUCKET, markerKey);
  const markerBytes = [];
  for await (const chunk of markerStream) markerBytes.push(chunk);
  const markerProfile = JSON.parse(Buffer.concat(markerBytes).toString("utf8"));
  if (!same(markerProfile, decode(profiles[0].data)))
    throw new Error("DB와 MinIO의 공유 저장소 표식이 달라 중단했습니다.");

  const backupByKey = new Map(
    manifest.entries.map((entry) => [entry.objectKey, entry]),
  );
  const backupKeys = new Set(backupByKey.keys());
  const liveKeys = new Set(live.filter((key) => key !== markerKey));
  if (!equalSets(liveKeys, backupKeys))
    throw new Error("실제 객체 목록이 검증된 백업 목록과 달라 중단했습니다.");
  const targetKeys = [...liveKeys].filter((key) => !referenced.has(key)).sort();
  if (
    targetKeys.length !== 89 ||
    !equalSets(new Set(targetKeys), new Set(applied.removedObjectKeys))
  )
    throw new Error("미참조 사진이 승인된 89개 목록과 달라 중단했습니다.");
  const currentPhotoIds = new Set(
    records.filter((row) => row.kind === "inspection").map((row) => row.id),
  );
  const analysisJobs = records
    .filter((row) => row.kind === "analysis_job")
    .map((row) => decode(row.data));
  if (analysisJobs.some((job) => !currentPhotoIds.has(job.photoId)))
    throw new Error("추가 판독 기록이 현재 사진과 연결되지 않아 중단했습니다.");
  const otherJson = [
    ...records.map((row) => decode(row.data)),
    ...history.map((row) => decode(row.data)),
    ...sessions.map((row) => decode(row.data)),
  ];
  if (
    targetKeys.some((key) =>
      otherJson.some((record) => JSON.stringify(record).includes(key)),
    )
  )
    throw new Error("삭제 후보가 다른 DB 기록에서 참조되어 중단했습니다.");

  return {
    idsByKind,
    referenced,
    liveKeys,
    targetKeys,
    backupByKey,
    markerProfile,
    versioningStatus,
    analysisJobCount: analysisJobs.length,
  };
}

try {
  const mode = process.argv[2] ?? "audit";
  const current = await inspectCurrent();
  const targetDigest = createHash("sha256")
    .update(current.targetKeys.join("\n"))
    .digest("hex");

  for (const key of current.targetKeys) {
    const entry = current.backupByKey.get(key);
    const saved = await hashFile(`${backups}/shared-objects/${entry.fileName}`);
    const live = await hashStream(await objects.getObject(api.MINIO_BUCKET, key));
    if (
      saved.size !== entry.size ||
      saved.sha256 !== entry.sha256 ||
      live.size !== entry.size ||
      live.sha256 !== entry.sha256
    )
      throw new Error("삭제 후보 원본이 백업·목록과 일치하지 않아 중단했습니다.");
  }

  if (mode === "audit") {
    const plan = {
      auditedAt: new Date().toISOString(),
      bucket: api.MINIO_BUCKET,
      targetKeys: current.targetKeys.map((objectKey) => {
        const { sha256, size } = current.backupByKey.get(objectKey);
        return { objectKey, sha256, size };
      }),
      targetKeysSha256: targetDigest,
      targetCount: current.targetKeys.length,
      referencedObjectCount: current.referenced.size,
      backupObjectCount: manifest.objectCount,
      sourceBackupRetained: true,
      bucketVersioning: current.versioningStatus,
    };
    await writeFile(planPath, JSON.stringify(plan, null, 2), {
      mode: 0o600,
    });
    await chmod(planPath, 0o600);
    console.log(
      JSON.stringify({
        audited: true,
        targetCount: plan.targetCount,
        referencedObjectCount: plan.referencedObjectCount,
        backupObjectCount: plan.backupObjectCount,
        allTargetBackupsVerified: true,
        liveMatchesBackup: true,
        preservedAnalysisJobCount: current.analysisJobCount,
        permissionPolicyChanged: false,
        planPath,
      }),
    );
  } else if (mode === "apply") {
    const plan = JSON.parse(await readFile(planPath, "utf8"));
    const plannedKeys = plan.targetKeys.map((entry) => entry.objectKey);
    if (
      plan.bucket !== api.MINIO_BUCKET ||
      plan.targetCount !== 89 ||
      plan.targetKeysSha256 !== targetDigest ||
      !equalSets(new Set(plannedKeys), new Set(current.targetKeys)) ||
      plan.bucketVersioning !== "Disabled"
    )
      throw new Error("삭제 계획이 현재 목록과 달라 중단했습니다.");

    const errors = [];
    for (const key of current.targetKeys) {
      try {
        await objects.removeObject(api.MINIO_BUCKET, key);
      } catch {
        errors.push(true);
      }
    }
    const after = [];
    for await (const object of objects.listObjectsV2(api.MINIO_BUCKET, "", true))
      if (object.name) after.push(object.name);
    const afterKeys = new Set(after.filter((key) => key !== markerKey));
    const expectedRemaining = new Set(current.referenced);
    if (!equalSets(afterKeys, expectedRemaining) || after.includes(markerKey) === false)
      throw new Error("삭제 후 저장 객체가 DB 참조와 일치하지 않습니다.");
    const afterMarker = await objects.getObject(api.MINIO_BUCKET, markerKey);
    const markerBytes = [];
    for await (const chunk of afterMarker) markerBytes.push(chunk);
    const afterProfile = JSON.parse(Buffer.concat(markerBytes).toString("utf8"));
    if (!same(afterProfile, current.markerProfile))
      throw new Error("삭제 후 MinIO 저장소 표식이 바뀌었습니다.");
    if (errors.length)
      throw new Error("일부 삭제 요청은 오류를 반환했지만 남은 객체 집합을 확인했습니다.");
    plan.completedAt = new Date().toISOString();
    plan.removedCount = current.targetKeys.length;
    plan.remainingReferencedObjectCount = afterKeys.size;
    plan.markerPreserved = true;
    plan.allRemainingPhotoObjectsReferenced = true;
    plan.permissionPolicyChanged = false;
    await writeFile(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
    await chmod(planPath, 0o600);
    console.log(
      JSON.stringify({
        removedCount: plan.removedCount,
        remainingReferencedObjectCount: plan.remainingReferencedObjectCount,
        markerPreserved: true,
        allRemainingPhotoObjectsReferenced: true,
        sourceBackupRetained: true,
        preservedAnalysisJobCount: current.analysisJobCount,
        permissionPolicyChanged: false,
      }),
    );
  } else {
    throw new Error("사용법: audit | apply");
  }
} finally {
  await pool.end();
  objects.destroy?.();
}
