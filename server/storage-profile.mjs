const decode = (value) =>
  typeof value === "string" ? JSON.parse(value) : value;
const key = "__storage_profile.json";
export function privateGrantsAllowed(grants, database) {
  // MySQL grants treat _ and % as schema wildcards unless escaped. Require
  // literal scope, and never allow a user to delegate its privileges.
  const literal = database.replace(/[\\_%]/g, (character) => `\\${character}`);
  return (
    grants.length > 0 &&
    grants.every(
      (grant) =>
        !grant.includes("WITH GRANT OPTION") &&
        (grant.startsWith("GRANT USAGE ON *.* TO ") ||
          grant.startsWith(`GRANT ALL PRIVILEGES ON \`${literal}\`.* TO `)),
    )
  );
}
const expected = (profile, dataset, env) => ({
  version: 1,
  scope: profile.scope,
  database: env.MYSQL_DATABASE,
  user: env.MYSQL_USER,
  bucket: env.MINIO_BUCKET,
  manifestSha256: dataset.manifestSha256,
});
const same = (a, b) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => b[k] === v);
async function objectIdentity(objects, bucket) {
  const stream = await objects.getObject(bucket, key);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 4096) {
      stream.destroy();
      throw new Error("저장소 표식 크기가 다릅니다.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function assertPrivateCredentials(
  pool,
  objects,
  profile,
  env = process.env,
) {
  if (profile.scope !== "local-private") return;
  const [identity] = await pool.query(
    "SELECT DATABASE() AS db, CURRENT_USER() AS user",
  );
  if (
    identity[0].db !== env.MYSQL_DATABASE ||
    identity[0].user.split("@")[0] !== env.MYSQL_USER
  )
    throw new Error("전용 DB 자격이 아닙니다.");
  const [grants] = await pool.query("SHOW GRANTS");
  if (
    !privateGrantsAllowed(
      grants.map((row) => Object.values(row)[0]),
      env.MYSQL_DATABASE,
    )
  )
    throw new Error("DB 사용자 권한이 전용 schema 범위를 벗어났습니다.");
  // MinIO can return a filtered bucket list for a bucket-scoped user. Listing
  // only the allowed bucket is valid; a known separate probe must be denied.
  const buckets = await objects.listBuckets().catch((error) => {
    if (error.code === "AccessDenied" || error.statusCode === 403) return [];
    throw error;
  });
  if (buckets.some((bucket) => bucket.name !== env.MINIO_BUCKET))
    throw new Error("사진 저장소 사용자에게 다른 버킷 조회 권한이 있습니다.");
  try {
    const stream = await objects.getObject(
      `${env.MINIO_BUCKET}-scope-check`,
      "scope-check",
    );
    stream.destroy();
  } catch (error) {
    if (error.code === "AccessDenied" || error.statusCode === 403) return;
    throw error;
  }
  throw new Error("사진 저장소 사용자에게 다른 버킷 읽기 권한이 있습니다.");
}
export async function verifyStorageProfile(
  pool,
  objects,
  profile,
  dataset,
  env = process.env,
) {
  const identity = expected(profile, dataset, env);
  const [rows] = await pool.query(
    "SELECT data FROM storage_profile WHERE id=1",
  );
  if (
    rows.length !== 1 ||
    !same(decode(rows[0].data), identity) ||
    !same(await objectIdentity(objects, env.MINIO_BUCKET), identity)
  )
    throw new Error(
      "DB·버킷의 실행 범위가 설정과 다릅니다. 시작을 중단했습니다.",
    );
  await assertPrivateCredentials(pool, objects, profile, env);
}
export async function bootstrapStorageProfile(
  pool,
  objects,
  profile,
  dataset,
  env = process.env,
) {
  await assertPrivateCredentials(pool, objects, profile, env);
  const identity = expected(profile, dataset, env);
  const [tables] = await pool.query("SHOW TABLES LIKE 'entities'");
  if (tables.length) {
    const [rows] = await pool.query("SELECT COUNT(*) AS n FROM entities");
    const [markers] = await pool.query("SHOW TABLES LIKE 'storage_profile'");
    if (profile.scope === "local-private" && rows[0].n > 0 && !markers.length)
      throw new Error(
        "기존 자료가 있는 DB를 비공개 저장소로 덮어 지정하지 않습니다.",
      );
    if (profile.scope === "shared") {
      const [privateRows] = await pool.query(
        "SELECT COUNT(*) AS n FROM entities WHERE JSON_EXTRACT(data,'$.datasetManifestSha256') IS NOT NULL",
      );
      if (privateRows[0].n)
        throw new Error(
          "비공개 원본 기록이 있는 DB를 공유 범위로 지정할 수 없습니다.",
        );
    }
  }
  await pool.query(
    "CREATE TABLE IF NOT EXISTS storage_profile (id TINYINT PRIMARY KEY, data JSON NOT NULL)",
  );
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT data FROM storage_profile WHERE id=1 FOR UPDATE",
    );
    if (rows.length && !same(decode(rows[0].data), identity))
      throw new Error("기존 DB 실행 범위 표식을 보존했습니다.");
    try {
      if (!same(await objectIdentity(objects, env.MINIO_BUCKET), identity))
        throw new Error("기존 버킷 실행 범위 표식을 보존했습니다.");
    } catch (error) {
      if (!["NoSuchKey", "NotFound", "NoSuchObject"].includes(error.code))
        throw error;
      const bytes = Buffer.from(JSON.stringify(identity));
      await objects.putObject(env.MINIO_BUCKET, key, bytes, bytes.length, {
        "Content-Type": "application/json",
      });
    }
    if (!rows.length)
      await connection.execute("INSERT INTO storage_profile VALUES(1,?)", [
        JSON.stringify(identity),
      ]);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
  await verifyStorageProfile(pool, objects, profile, dataset, env);
}
