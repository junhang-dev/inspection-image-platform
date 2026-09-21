import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  pool,
  insert,
  insertBatch,
  update,
  get,
  events,
  decodeEntity,
} from "../server/store.mjs";
import { queryPhotos, photoQuerySchema } from "../server/photo-query.mjs";
import { pointLocation } from "../server/relations.mjs";
import { allPhotoRecords } from "./photo-records.mjs";

// This script deliberately creates metadata fixtures. Run only in the separate
// smoke Compose API container, with its model worker disconnected for the run.
assert.equal(process.env.QUERY_TEST_ENV, "isolated-inspection-platform-smoke");
assert.equal(process.env.MODEL_API_URL, "http://127.0.0.1:1");
const base = "http://127.0.0.1:4000/api";
const json = async (path, options) => {
  const response = await fetch(base + path, options);
  const body = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(body)}`);
  return body;
};
const patch = (path, input) =>
  json(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
const query = (scope = {}) =>
  json(`/inspections/query?${new URLSearchParams(scope)}`);
const [before] = await pool.query(
  "SELECT kind,id,data FROM entities ORDER BY kind,id",
);
const [beforeHistory] = await pool.query(
  "SELECT id,entity_id,data FROM history ORDER BY id",
);
const source = before
  .filter((row) => row.kind === "inspection")
  .map((row) => decodeEntity(row.data, "inspection"))
  .find(
    (photo) =>
      photo.sha256 ===
      "0510d0827704d8ec297bdecdebfd2eb7f65c44521e662fa8532036e47a610838",
  );
assert.ok(source, "승인 demo-01 객체가 필요합니다.");
const point = await insert("point", {
  name: "공통 조회 검증 포인트",
  equipment: "QUERY-101",
  ...pointLocation("team-1-rack-1", "query-fixture"),
  repairStatus: "none",
  managed: false,
  ta: false,
});
const plans = [];
for (const title of ["KPI 계약 A", "KPI 계약 B", "페이지 1001 검증"])
  plans.push(
    await insert("plan", {
      title,
      date: "2026-09-21",
      pointIds: [point.id],
      pointId: point.id,
      status: "planned",
      note: "회사 자료와 무관한 명시적 합성 메타데이터 검증",
    }),
  );
const basis = {
  name: "query-%_=literal.jpg",
  pointId: point.id,
  planId: plans[0].id,
  objectKey: source.objectKey,
  sha256: source.sha256,
  size: source.size,
  mime: source.mime,
  status: "done",
  ai: {
    grade: 1,
    confidence: 0.5,
    model_version: "synthetic-query-fixture",
    preprocessing_version: "synthetic-no-model-call",
  },
  humanGrade: null,
  retake: false,
  retakeReason: "",
  labeling: false,
  error: null,
};
const create = (patch) => ({ ...basis, ...patch });
const six = await insertBatch(
  "inspection",
  [
    create({ ai: { ...basis.ai, grade: 5 }, humanGrade: 2 }),
    create({
      ai: { ...basis.ai, grade: 2 },
      humanGrade: 4,
      retake: true,
      retakeReason: "합성 재촬영",
    }),
    create({ ai: null, humanGrade: 4, status: "pending" }),
    create({ ai: null, status: "processing" }),
    create({
      ai: null,
      status: "error",
      retake: true,
      retakeReason: "합성 판독 실패",
    }),
    create({}),
  ],
  "격리 검증",
  "공통 조회 계약 합성 6개",
);
const extras = await insertBatch(
  "inspection",
  [
    create({ planId: plans[1].id }),
    create({ planId: null }),
    create({ recordPurpose: "verification" }),
    create({ recordPurpose: "presentation" }),
    create({ visibility: "hidden", hiddenReason: "합성 숨김" }),
  ],
  "격리 검증",
  "계획 목적 숨김 분리 합성 자료",
);
const pageRows = await insertBatch(
  "inspection",
  Array.from({ length: 1001 }, (_, index) =>
    create({
      planId: plans[2].id,
      name: `page-${index}.jpg`,
      recordPurpose: "verification",
    }),
  ),
  "격리 검증",
  "1001행 페이지 검사",
);
const scope = { planId: plans[0].id };
const first = await query(scope);
assert.deepEqual(
  {
    total: first.total,
    repair: first.summary.repair,
    pending: first.summary.pending,
    retake: first.summary.retake,
  },
  { total: 6, repair: 2, pending: 2, retake: 2 },
);
assert.equal(first.pointCounts[point.id], 6);
for (const [classification, expected] of [
  ["repair", [six[1].id, six[2].id]],
  ["pending", [six[2].id, six[3].id]],
  ["retake", [six[1].id, six[4].id]],
]) {
  const result = await query({ ...scope, classification });
  assert.deepEqual(result.items.map((item) => item.id).sort(), expected.sort());
  assert.equal(result.summary.total, 6);
  assert.equal(result.total, 2);
}
assert.equal((await query({ planId: plans[1].id })).items[0].id, extras[0].id);
assert.ok(
  (await query({ planId: "unassigned", pointId: point.id })).items.every(
    (item) => item.planId === null,
  ),
);
assert.equal(
  (await query({ ...scope, recordPurpose: "all", visibility: "all" })).total,
  9,
);
assert.equal((await query({ ...scope, search: "%_=" })).total, 6);
assert.equal((await query({ ...scope, search: "%_x" })).total, 0);
assert.equal((await query({ ...scope, teamId: "team-2" })).total, 0);
const paged = await allPhotoRecords((path) => json(path), {
  planId: plans[2].id,
  recordPurpose: "verification",
});
assert.equal(paged.length, 1001);
assert.deepEqual(
  paged.map((item) => item.id).sort(),
  pageRows.map((item) => item.id).sort(),
);
const last = await query({
  planId: plans[2].id,
  recordPurpose: "verification",
  pageSize: "100",
  page: "11",
});
assert.equal(last.items.length, 1);
assert.equal(last.pointCounts[point.id], 1001);
const original = await get("inspection", six[0].id);
const imageHash = async () =>
  createHash("sha256")
    .update(
      Buffer.from(
        await (
          await fetch(`${base}/inspections/${original.id}/image`)
        ).arrayBuffer(),
      ),
    )
    .digest("hex");
assert.equal(await imageHash(), source.sha256);
assert.equal(
  (await fetch(`${base}/inspections/${original.id}/thumbnail`)).status,
  200,
);
let hidden = await patch(`/inspections/${original.id}/visibility`, {
  visibility: "hidden",
  expectedVersion: 0,
  actor: "격리 검증",
  reason: "숨김 원본 보존 검사",
});
for (const suffix of ["image", "thumbnail"])
  assert.equal(
    (await fetch(`${base}/inspections/${original.id}/${suffix}`)).status,
    404,
  );
assert.equal((await query(scope)).total, 5);
const stale = await fetch(`${base}/inspections/${original.id}/visibility`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    visibility: "visible",
    expectedVersion: 0,
    actor: "격리 검증",
    reason: "오래된 버전 거절",
  }),
});
assert.equal(stale.status, 409);
await update(
  "inspection",
  original.id,
  { status: "done", ai: original.ai },
  "AI 서비스",
  "경쟁 갱신 경로 검사 - 실제 추론 아님",
  { inference: true },
);
hidden = await get("inspection", original.id);
assert.equal(hidden.visibility, "hidden");
assert.equal(hidden.editVersion, 1);
const restored = await patch(`/inspections/${original.id}/visibility`, {
  visibility: "visible",
  expectedVersion: 1,
  actor: "격리 검증",
  reason: "원본 보존 복원",
});
for (const key of [
  "id",
  "objectKey",
  "sha256",
  "size",
  "mime",
  "ai",
  "humanGrade",
  "planId",
  "pointId",
])
  assert.deepEqual(restored[key], original[key]);
assert.equal(await imageHash(), source.sha256);
assert.equal((await query(scope)).total, 6);
const changed = await patch(`/inspections/${original.id}/purpose`, {
  recordPurpose: "verification",
  expectedVersion: 2,
  actor: "격리 검증",
  reason: "명시적 목적 분리",
});
assert.equal((await query(scope)).total, 5);
assert.ok(
  (await query({ ...scope, recordPurpose: "verification" })).items.some(
    (item) => item.id === original.id,
  ),
);
await patch(`/inspections/${original.id}/purpose`, {
  recordPurpose: "inspection",
  expectedVersion: changed.editVersion,
  actor: "격리 검증",
  reason: "KPI 브라우저 fixture 초기 목적 복원",
});
// Mutate from another connection immediately after the first aggregate read.
let intervened = false;
const wrapped = {
  getConnection: async () => {
    const connection = await pool.getConnection();
    return new Proxy(connection, {
      get(target, property) {
        if (property === "execute")
          return async (...args) => {
            const result = await target.execute(...args);
            if (
              !intervened &&
              args[0].startsWith("SELECT COUNT(*) AS total,")
            ) {
              intervened = true;
              await update(
                "inspection",
                six[5].id,
                { visibility: "hidden" },
                "격리 검증",
                "조회 스냅샷 경합",
                { expectedVersion: 0 },
              );
            }
            return result;
          };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  },
};
const snapshot = await queryPhotos(
  wrapped,
  decodeEntity,
  photoQuerySchema.parse(scope),
);
assert.equal(snapshot.summary.total, 6);
assert.equal(snapshot.total, 6);
assert.equal(snapshot.items.length, 6);
assert.equal(snapshot.pointCounts[point.id], 6);
assert.equal((await query(scope)).total, 5);
await update(
  "inspection",
  six[5].id,
  { visibility: "visible" },
  "격리 검증",
  "스냅샷 검사 복원",
  { expectedVersion: 1 },
);
// Clear human and retake decisions independently, then restore the browser fixture.
let second = await patch(`/inspections/${six[1].id}`, {
  expectedVersion: 0,
  humanGrade: null,
  retake: false,
  actor: "격리 검증",
  reason: "사람 수정 해제",
});
assert.equal((await query(scope)).summary.repair, 1);
assert.equal((await query(scope)).summary.retake, 1);
await patch(`/inspections/${six[1].id}`, {
  expectedVersion: second.editVersion,
  humanGrade: 4,
  retake: true,
  actor: "격리 검증",
  reason: "KPI fixture 복원",
});
for (const status of ["processing", "done", "error", "pending"]) {
  await update(
    "inspection",
    six[2].id,
    { status },
    "AI 서비스",
    "쿼리 상태 전환 경로 검사 - 실제 추론 아님",
    { inference: true },
  );
  assert.equal(
    (await query(scope)).summary.pending,
    ["pending", "processing"].includes(status) ? 2 : 1,
  );
}
const [after] = await pool.query(
  "SELECT kind,id,data FROM entities ORDER BY kind,id",
);
const [afterHistory] = await pool.query(
  "SELECT id,entity_id,data FROM history ORDER BY id",
);
for (const prior of before)
  assert.deepEqual(
    after.find((row) => row.kind === prior.kind && row.id === prior.id),
    prior,
  );
for (const prior of beforeHistory)
  assert.deepEqual(
    afterHistory.find((row) => row.id === prior.id),
    prior,
  );
assert.ok((await events(original.id)).length >= 6);
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    allChecksPassed: true,
    baselineEntitiesPreserved: before.length,
    baselineHistoryPreserved: beforeHistory.length,
    pointId: point.id,
    plans: plans.map((plan) => ({ id: plan.id, title: plan.title })),
    six: six.map((photo) => photo.id),
    extras: extras.map((photo) => photo.id),
    paginationRows: 1001,
    finalSummary: (await query(scope)).summary,
    note: "실제 MySQL/API/MinIO 검사. AI 값은 명시적 합성 fixture이며 실제 모델 추론/성능 검사가 아님.",
  }),
);
await pool.end();
