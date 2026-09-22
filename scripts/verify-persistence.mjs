import "dotenv/config";
import { Client } from "minio";
import { allPhotoRecords } from "./photo-records.mjs";
import { allMaintenanceRecords } from "./maintenance-records.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const base = process.env.TEST_API_URL || "http://127.0.0.1:4000/api";
const read = async (path) => {
  const response = await fetch(base + path);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const metadataOnly = process.argv.includes("--metadata-only");
const objects = process.env.PERSISTENCE_MINIO_ENDPOINT
  ? new Client({
      endPoint: process.env.PERSISTENCE_MINIO_ENDPOINT,
      port: Number(process.env.PERSISTENCE_MINIO_PORT || 9000),
      useSSL: process.env.PERSISTENCE_MINIO_SSL === "1",
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
    })
  : null;
const state = {
  verification: metadataOnly
    ? "metadata-and-history-only"
    : "metadata-history-originals",
};
for (const kind of ["inspections", "points", "plans", "maintenance"]) {
  state[kind] =
    kind === "inspections"
      ? await allPhotoRecords(read)
      : kind === "maintenance"
        ? await allMaintenanceRecords(read)
        : (await read(`/${kind}?recordPurpose=all`)).sort((a, b) =>
            a.id.localeCompare(b.id),
          );
  if (["points", "plans"].includes(kind))
    assert.ok(
      state[kind].length < 1000,
      `${kind}: 기존 조회 한도에 도달하여 전체 보존을 확인할 수 없습니다.`,
    );
  for (const item of state[kind]) {
    state[`history:${kind}:${item.id}`] = (
      await read(`/${kind}/${item.id}/history`)
    ).sort((a, b) => a.id.localeCompare(b.id));
    if (kind === "inspections" && !metadataOnly) {
      const response = await fetch(`${base}/inspections/${item.id}/image`);
      const digest = createHash("sha256");
      if (item.visibility === "hidden") {
        assert.equal(
          response.status,
          404,
          "숨긴 원본은 직접 URL에서 제외되어야 합니다.",
        );
        assert.ok(
          objects,
          "숨긴 사진 원본 검증에는 해당 환경의 PERSISTENCE_MINIO_ENDPOINT/PORT를 명시하세요. 메타데이터만 확인하려면 --metadata-only를 사용하세요.",
        );
        const stream = await objects.getObject(
          process.env.MINIO_BUCKET || "inspection-images",
          item.objectKey,
        );
        for await (const chunk of stream) digest.update(chunk);
      } else {
        assert.ok(response.ok);
        for await (const chunk of response.body) digest.update(chunk);
      }
      const hash = digest.digest("hex");
      assert.equal(hash, item.sha256);
      state[`object:${item.id}`] = hash;
    }
  }
}
const file =
  process.env.PERSISTENCE_REPORT || "records/platform-persistence.local.json";
if (process.argv.includes("--capture")) {
  await writeFile(file, JSON.stringify(state, null, 2));
  console.log(
    metadataOnly
      ? "재시작 전 전체 메타데이터·이력 저장 완료 (원본 바이트 검사 제외)"
      : "재시작 전 사진·포인트·계획·전체 이력·원본 해시 저장 완료",
  );
} else {
  const before = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(state, before);
  console.log(
    JSON.stringify({
      preserved: true,
      originalsVerified: !metadataOnly,
      photos: state.inspections.length,
      points: state.points.length,
      plans: state.plans.length,
      maintenance: state.maintenance.length,
      comparisons: Object.keys(state).length,
    }),
  );
}
