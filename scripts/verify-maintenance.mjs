import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  pool,
  insert,
  insertBatch,
  get,
  update,
  events,
  decodeEntity,
} from "../server/store.mjs";
import { maintenanceId } from "../server/maintenance-domain.mjs";
import {
  saveMaintenance,
  migratePointMaintenance,
} from "../server/maintenance-store.mjs";
import {
  queryMaintenance,
  maintenanceQuerySchema,
} from "../server/maintenance-query.mjs";
assert.equal(
  process.env.MAINTENANCE_TEST_ENV,
  "isolated-inspection-platform-smoke",
);
assert.equal(process.env.MODEL_API_URL, "http://127.0.0.1:1");
const [before] = await pool.query(
  "SELECT kind,id,data FROM entities ORDER BY kind,id",
);
const [beforeHistory] = await pool.query(
  "SELECT id,entity_id,data FROM history ORDER BY id",
);
const audit = {
  actor: "격리 보수 검증",
  reason: "회사 원본과 무관한 합성 업무 계약 검증",
};
const created = { points: [], plans: [], photos: [], items: [] };
const point = await insert(
  "point",
  {
    name: "보수-%_= 검증",
    equipment: "MAINT-101",
    rack: "검증",
    rackId: "team-1-rack-1",
    recordPurpose: "verification",
    maintenanceSchemaVersion: 1,
  },
  audit.actor,
  audit.reason,
);
created.points.push(point.id);
const makePlan = (title) => ({
  title,
  date: "2026-09-22",
  pointIds: [point.id],
  pointId: point.id,
  status: "planned",
  recordPurpose: "verification",
  note: "합성 보수 검증",
});
const plans = await insertBatch(
  "plan",
  [makePlan("보수 검증 A"), makePlan("보수 검증 B")],
  audit.actor,
  audit.reason,
);
created.plans.push(...plans.map((p) => p.id));
const source = before
  .filter((row) => row.kind === "inspection")
  .map((row) => decodeEntity(row.data, "inspection"))
  .find(
    (p) =>
      p.sha256 ===
      "0510d0827704d8ec297bdecdebfd2eb7f65c44521e662fa8532036e47a610838",
  );
assert.ok(source);
const photos = await insertBatch(
  "inspection",
  [plans[0].id, plans[1].id, null].map((planId) => ({
    pointId: point.id,
    planId,
    recordPurpose: "verification",
    name: "보수 합성 근거 사진",
    objectKey: source.objectKey,
    sha256: source.sha256,
    size: source.size,
    mime: source.mime,
    status: "done",
    ai: null,
    humanGrade: null,
    retake: false,
    retakeReason: "",
    labeling: false,
    error: null,
    visibility: "visible",
  })),
  audit.actor,
  audit.reason,
);
created.photos.push(...photos.map((p) => p.id));
const save = (planId, patch = {}, expectedVersion = null) =>
  saveMaintenance({
    planId,
    pointId: point.id,
    recordPurpose: "verification",
    ...patch,
    expectedVersion,
    ...audit,
  });
let item = await save(plans[0].id, {
  photoIds: [photos[0].id],
  repairStatus: "review",
  repairMethod: "paint",
  ta: true,
});
created.items.push(item.id);
assert.equal(item.inWorklist, false);
for (const repairStatus of ["planned", "progress", "done", "review"]) {
  item = await save(plans[0].id, { repairStatus }, item.editVersion);
  assert.equal(item.inWorklist, false);
  assert.equal(item.repairMethod, "paint");
  assert.equal(item.ta, true);
}
for (const repairMethod of ["replace", "undecided", "paint"]) {
  item = await save(plans[0].id, { repairMethod }, item.editVersion);
  assert.equal(item.repairStatus, "review");
  assert.equal(item.inWorklist, false);
}
item = await save(plans[0].id, { inWorklist: true }, item.editVersion);
const stable = item.id;
item = await save(
  plans[0].id,
  { inWorklist: false, ta: true },
  item.editVersion,
);
assert.equal(item.inWorklist, false);
assert.equal(item.ta, true);
item = await save(
  plans[0].id,
  { inWorklist: true, ta: false },
  item.editVersion,
);
assert.equal(item.id, stable);
assert.deepEqual(item.photoIds, [photos[0].id]);
await assert.rejects(
  save(plans[0].id, { repairStatus: "done" }, 0),
  (e) => e.status === 409,
);
await assert.rejects(
  save(plans[0].id, { photoIds: [photos[1].id] }, item.editVersion),
  (e) => e.status === 422,
);
for (const [planId, photo] of [
  [plans[1].id, photos[1]],
  [null, photos[2]],
]) {
  const row = await save(planId, { photoIds: [photo.id] });
  created.items.push(row.id);
}
assert.equal(new Set(created.items).size, 3);
// A removed/verification item still protects evidence; scope is never a guard.
item = await save(plans[0].id, { inWorklist: false }, item.editVersion);
await assert.rejects(
  update(
    "inspection",
    photos[0].id,
    { planId: plans[1].id },
    audit.actor,
    audit.reason,
    { expectedVersion: 0 },
  ),
  (e) => e.status === 409,
);
assert.equal((await get("inspection", photos[0].id)).planId, plans[0].id);

const legacy = await insert(
  "point",
  {
    name: "이관 검증",
    recordPurpose: "verification",
    repairStatus: "progress",
    repairMethod: "paint",
    managed: false,
    ta: true,
  },
  audit.actor,
  audit.reason,
);
created.points.push(legacy.id);
await assert.rejects(
  saveMaintenance({
    planId: null,
    pointId: legacy.id,
    expectedVersion: null,
    ...audit,
  }),
  (e) => e.status === 409,
);
const legacyBefore = await get("point", legacy.id);
await migratePointMaintenance(legacy.id, { apply: true });
let legacyItem = await get("maintenance", maintenanceId(null, legacy.id));
created.items.push(legacyItem.id);
assert.equal(legacyItem.inWorklist, true);
assert.equal(legacyItem.ta, true);
assert.equal(legacyItem.repairStatus, "progress");
assert.equal(legacyItem.repairMethod, "paint");
const legacyAfter = await get("point", legacy.id);
const [[rawLegacy]] = await pool.execute(
  "SELECT data FROM entities WHERE kind = 'point' AND id = ?",
  [legacy.id],
);
const rawLegacyData =
  typeof rawLegacy.data === "string"
    ? JSON.parse(rawLegacy.data)
    : rawLegacy.data;
assert.deepEqual(
  Object.keys(rawLegacyData).sort(),
  [...Object.keys(legacy), "maintenanceMigrationVersion", "updatedAt"].sort(),
);

for (const [k, v] of Object.entries(legacyBefore))
  if (!["editVersion", "updatedAt"].includes(k))
    assert.deepEqual(legacyAfter[k], v);
legacyItem = await saveMaintenance({
  ...audit,
  planId: null,
  pointId: legacy.id,
  expectedVersion: legacyItem.editVersion,
  inWorklist: false,
  ta: false,
  repairStatus: "done",
});
const oldHistory = await events(legacy.id),
  oldItemHistory = await events(legacyItem.id);
await migratePointMaintenance(legacy.id, { apply: true });
assert.deepEqual(await get("maintenance", legacyItem.id), legacyItem);
assert.deepEqual(await events(legacy.id), oldHistory);
assert.deepEqual(await events(legacyItem.id), oldItemHistory);

const rollbackPoint = await insert(
  "point",
  {
    name: "이관 롤백 검증",
    recordPurpose: "verification",
    managed: true,
    ta: false,
    repairStatus: "review",
  },
  audit.actor,
  audit.reason,
);
created.points.push(rollbackPoint.id);
const poolGet = pool.getConnection.bind(pool);
pool.getConnection = async () => {
  const c = await poolGet(),
    execute = c.execute.bind(c);
  c.execute = async (sql, values) => {
    if (
      sql.startsWith("UPDATE entities") &&
      values[1] === "point" &&
      values[2] === rollbackPoint.id
    )
      throw new Error("injected migration failure");
    return execute(sql, values);
  };
  const originalRelease = c.release;
  const release = c.release.bind(c);
  c.release = () => {
    c.execute = execute;
    c.release = originalRelease;
    release();
  };
  return c;
};
try {
  await assert.rejects(
    migratePointMaintenance(rollbackPoint.id, { apply: true }),
    /injected migration failure/,
  );
} finally {
  pool.getConnection = poolGet;
}
assert.equal(
  await get("maintenance", maintenanceId(null, rollbackPoint.id)),
  null,
);
assert.equal(
  (await get("point", rollbackPoint.id)).maintenanceMigrationVersion,
  undefined,
);
assert.equal((await events(rollbackPoint.id)).length, 1);

// Deterministic transaction barriers: first writer holds the photo lock; second
// writer has attempted the same locking SELECT before the first is released.
async function race(photoId, first, second) {
  let lockedResolve, attemptResolve, releaseResolve;
  const locked = new Promise((r) => (lockedResolve = r)),
    attempt = new Promise((r) => (attemptResolve = r)),
    release = new Promise((r) => (releaseResolve = r));
  let count = 0;
  pool.getConnection = async () => {
    const c = await poolGet(),
      execute = c.execute.bind(c),
      originalRelease = c.release,
      restore = c.release.bind(c);
    c.execute = async (sql, values) => {
      const match =
        sql.endsWith("FOR UPDATE") &&
        values?.[0] === "inspection" &&
        values?.[1] === photoId;
      const n = match ? ++count : 0;
      if (n === 2) attemptResolve();
      const result = await execute(sql, values);
      if (n === 1) {
        lockedResolve();
        await release;
      }
      return result;
    };
    c.release = () => {
      c.execute = execute;
      c.release = originalRelease;
      restore();
    };
    return c;
  };
  const settled = (job) =>
    job().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  const deadline = setTimeout(() => {
    lockedResolve();
    attemptResolve();
    releaseResolve();
  }, 10000);
  try {
    const a = settled(first);
    await locked;
    const b = settled(second);
    await attempt;
    releaseResolve();
    const results = await Promise.all([a, b]);
    assert.equal(count, 2, "두 사진 잠금 시도가 필요합니다.");
    return results;
  } finally {
    clearTimeout(deadline);
    releaseResolve();
    pool.getConnection = poolGet;
  }
}
const racePlans = await insertBatch(
  "plan",
  [
    makePlan("보수 경합 먼저"),
    makePlan("사진 경합 먼저"),
    makePlan("경합 이동 대상"),
  ],
  audit.actor,
  audit.reason,
);
created.plans.push(...racePlans.map((p) => p.id));
const racePhotos = await insertBatch(
  "inspection",
  racePlans.slice(0, 2).map((plan) => ({
    ...photos[0],
    id: undefined,
    planId: plan.id,
    editVersion: 0,
  })),
  audit.actor,
  audit.reason,
);
created.photos.push(...racePhotos.map((p) => p.id));
const [mFirst, pAfter] = await race(
  racePhotos[0].id,
  () => save(racePlans[0].id, { photoIds: [racePhotos[0].id] }),
  () =>
    update(
      "inspection",
      racePhotos[0].id,
      { planId: racePlans[2].id },
      audit.actor,
      audit.reason,
      { expectedVersion: 0 },
    ),
);
assert.ok(mFirst.value);
assert.equal(pAfter.error?.status, 409);
created.items.push(mFirst.value.id);
const [pFirst, mAfter] = await race(
  racePhotos[1].id,
  () =>
    update(
      "inspection",
      racePhotos[1].id,
      { planId: racePlans[2].id },
      audit.actor,
      audit.reason,
      { expectedVersion: 0 },
    ),
  () => save(racePlans[1].id, { photoIds: [racePhotos[1].id] }),
);
assert.ok(pFirst.value);
assert.equal(mAfter.error?.status, 422);
assert.equal(
  await get("maintenance", maintenanceId(racePlans[1].id, point.id)),
  null,
);
const duplicate = await Promise.allSettled([
  save(racePlans[1].id),
  save(racePlans[1].id),
]);
assert.equal(duplicate.filter((x) => x.status === "fulfilled").length, 1);
assert.equal(duplicate.find((x) => x.status === "rejected").reason.status, 409);
created.items.push(maintenanceId(racePlans[1].id, point.id));
// Removal also locks old evidence; a queued photo move can safely follow it.
const [removed, moved] = await race(
  racePhotos[0].id,
  () => save(racePlans[0].id, { photoIds: [] }, mFirst.value.editVersion),
  () =>
    update(
      "inspection",
      racePhotos[0].id,
      { planId: racePlans[2].id },
      audit.actor,
      audit.reason,
      { expectedVersion: 0 },
    ),
);
assert.deepEqual(removed.value.photoIds, []);
assert.equal(moved.value.planId, racePlans[2].id);

// Exercise the HTTP schemas/routers as well as the transaction helpers.
const http = async (path, method = "GET", body) => {
  const response = await fetch("http://127.0.0.1:4000/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
let apiItem = await http("/maintenance", "POST", {
  planId: racePlans[2].id,
  pointId: point.id,
  photoIds: [racePhotos[1].id],
  expectedVersion: null,
  recordPurpose: "verification",
  ...audit,
});
assert.equal(apiItem.status, 201);
created.items.push(apiItem.body.id);
assert.equal(
  (
    await http(
      "/maintenance/pair?" +
        new URLSearchParams({
          planId: racePlans[2].id.toUpperCase(),
          pointId: point.id.toUpperCase(),
        }),
    )
  ).body.id,
  apiItem.body.id,
);
const apiId = apiItem.body.id;
apiItem = await http("/maintenance/" + apiId, "PATCH", {
  expectedVersion: 0,
  recordPurpose: "inspection",
  ta: true,
  ...audit,
});
assert.equal(apiItem.status, 200);
assert.equal(apiItem.body.recordPurpose, "inspection");
assert.equal(apiItem.body.inWorklist, false);
assert.equal(
  (
    await http("/maintenance/" + apiId, "PATCH", {
      expectedVersion: 0,
      repairStatus: "done",
      ...audit,
    })
  ).status,
  409,
);
assert.equal(
  (
    await http("/maintenance/" + apiId, "PATCH", {
      expectedVersion: 1,
      pointId: legacy.id,
      ...audit,
    })
  ).status,
  422,
);
assert.equal(
  (
    await http("/points/" + point.id, "PATCH", {
      expectedVersion: 0,
      managed: true,
      ...audit,
    })
  ).status,
  422,
);
assert.equal(
  (
    await http("/inspections/" + racePhotos[1].id, "PATCH", {
      expectedVersion: 1,
      planId: plans[0].id,
      ...audit,
    })
  ).status,
  409,
);
apiItem = await http("/maintenance/" + apiId, "PATCH", {
  expectedVersion: 1,
  recordPurpose: "verification",
  ...audit,
});
assert.equal(apiItem.status, 200);
assert.equal((await http("/maintenance/" + apiId + "/history")).body.length, 3);
const pages = await insertBatch(
  "plan",
  Array.from({ length: 101 }, (_, i) => makePlan(`보수 페이지 ${i + 1}`)),
  audit.actor,
  audit.reason,
);
created.plans.push(...pages.map((p) => p.id));
for (const plan of pages) {
  const row = await save(plan.id, { inWorklist: true });
  created.items.push(row.id);
}
const query = (overrides) =>
  queryMaintenance(
    pool,
    decodeEntity,
    maintenanceQuerySchema.parse({
      recordPurpose: "verification",
      pointId: point.id,
      search: "보수 페이지",
      pageSize: 100,
      ...overrides,
    }),
  );
const first = await query({}),
  last = await query({ page: 2 });
assert.equal(first.total, 101);
assert.equal(first.items.length, 100);
assert.equal(last.items.length, 1);
assert.equal(first.pointSummaries[point.id].total, 101);
assert.equal(
  new Set([...first.items, ...last.items].map((row) => row.id)).size,
  101,
);
assert.equal((await query({ pointId: point.id.toUpperCase() })).total, 101);
const mismatch = await query({ recordPurpose: "inspection" });
assert.equal(mismatch.total, 0);
const [after] = await pool.query(
  "SELECT kind,id,data FROM entities ORDER BY kind,id",
);
const [afterHistory] = await pool.query(
  "SELECT id,entity_id,data FROM history ORDER BY id",
);
assert.ok(
  before.every((row) =>
    isDeepStrictEqual(
      row,
      after.find(
        (candidate) => candidate.kind === row.kind && candidate.id === row.id,
      ),
    ),
  ),
);
assert.ok(
  beforeHistory.every((row) =>
    isDeepStrictEqual(
      row,
      afterHistory.find((candidate) => candidate.id === row.id),
    ),
  ),
);
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    passed: true,
    originalEntitiesPreserved: before.length,
    originalHistoryPreserved: beforeHistory.length,
    created,
    checks: [
      "status-method-membership-TA-independent",
      "stable-pair-CAS",
      "same-pair-evidence",
      "legacy-gate-migration-idempotence-rollback",
      "maintenance-first-race",
      "photo-first-race",
      "evidence-removal-race",
      "same-pair-duplicate",
      "HTTP-create-pair-purpose-CAS-relation-legacy-rejection",
      "101-page-count-uppercase-point",
      "all-existing-data-history-preserved",
    ],
    originalBytesRechecked: false,
    modelInferenceRun: false,
  }),
);
await pool.end();
