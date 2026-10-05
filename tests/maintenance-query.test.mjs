import test from "node:test";
import assert from "node:assert/strict";
import { maintenanceQuerySchema } from "../server/maintenance-query.mjs";
import { queryMaintenance } from "../server/maintenance-query.mjs";
import { deriveMaintenance, maintenancePage } from "../server/maintenance-view.mjs";
import { photoMaintenanceId } from "../server/maintenance-domain.mjs";
import { allMaintenanceRecords } from "../scripts/maintenance-records.mjs";
test("판독 대기 사진의 내부 후보 행은 보수 대상 수에 포함하지 않는다", () => {
  const rows = deriveMaintenance({
    photos: [{
      id: "11111111-1111-4111-8111-111111111111",
      planId: null,
      pointId: null,
      teamId: "team-3",
      rackId: "team-3-rack-20",
      recordPurpose: "inspection",
      visibility: "visible",
      ai: null,
      humanGrade: null,
      status: "pending",
    }],
    saved: [], points: [], plans: [],
  });
  const query = maintenanceQuerySchema.parse({
    recordPurpose: "inspection",
    teamId: "team-3",
    rackId: "team-3-rack-20",
    visibility: "visible",
    inWorklist: "all",
  });
  const page = maintenancePage(rows, query);
  assert.equal(page.total, 1);
  assert.equal(page.summary.worklist, 0);
  assert.equal(page.items[0].repairStatus, "none");
  assert.equal(page.items[0].persisted, false);
});
test("상태별 건수는 현재 범위 전체를 세고 선택한 상태와 페이지에 영향받지 않는다", () => {
  const planId = "11111111-1111-4111-8111-111111111111";
  const row = (id, repairStatus, overrides = {}) => ({
    id,
    planId,
    pointId: null,
    recordPurpose: "inspection",
    visibility: "visible",
    inWorklist: true,
    ta: false,
    repairStatus,
    repairMethod: "undecided",
    teamId: "team-1",
    rackId: "team-1-rack-1",
    planTitle: "계획",
    pointLabel: "대상",
    createdAt: "2026-10-01T00:00:00Z",
    ...overrides,
  });
  const rows = [
    row("review-1", "review"),
    row("review-2", "review"),
    row("planned-1", "planned"),
    row("progress-1", "progress"),
    row("done-1", "done"),
    row("none-1", "none"),
    row("other-plan", "review", { planId: "22222222-2222-4222-8222-222222222222" }),
    row("not-in-worklist", "review", { inWorklist: false }),
  ];
  const page = maintenancePage(rows, maintenanceQuerySchema.parse({ planId, repairStatus: "review", pageSize: 1 }));
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.deepEqual(page.statusCounts, { none: 1, review: 2, planned: 1, progress: 1, done: 1 });
});
test("보수 범위는 UUID 대소문자를 정규화하고 잘못된 상태·관계·페이지를 거절한다", () => {
  const id = "12345678-1234-4234-A234-123456789ABC";
  const q = maintenanceQuerySchema.parse({ planId: id, pointId: id });
  assert.equal(q.planId, id.toLowerCase());
  assert.equal(q.pointId, id.toLowerCase());
  for (const input of [
    { page: 0 },
    { pageSize: 101 },
    { ta: true },
    { repairStatus: "finished" },
    { inWorklist: "false" },
    { teamId: "team-1", rackId: "team-2-rack-1" },
    { visibility: "deleted" },
  ])
    assert.equal(maintenanceQuerySchema.safeParse(input).success, false);
  assert.equal(maintenanceQuerySchema.parse({ visibility: "all" }).visibility, "all");
  assert.equal(maintenanceQuerySchema.parse({ unbundledOnly: "true" }).unbundledOnly, "true");
  assert.equal(maintenanceQuerySchema.parse({}).unbundledOnly, "false");
  assert.equal(maintenanceQuerySchema.safeParse({ unbundledOnly: true }).success, false);
});
test("보수 보존 검사는 해제된 항목까지 읽고 중복·누락·범위 변화·잘못된 페이지를 실패 처리한다", async () => {
  for (const pages of [
    [{ page: 1, pages: 0, total: 0, items: [] }],
    [
      { page: 1, pages: 2, total: 2, items: [{ id: "a" }] },
      { page: 2, pages: 2, total: 2, items: [{ id: "a" }] },
    ],
    [
      { page: 1, pages: 2, total: 2, items: [{ id: "a" }] },
      { page: 2, pages: 2, total: 3, items: [{ id: "b" }] },
    ],
    [{ page: 1, pages: 1, total: 2, items: [] }],
  ])
    await assert.rejects(allMaintenanceRecords(async () => pages.shift()));
  let page = 0;
  const records = await allMaintenanceRecords(async (path) => {
    assert.match(path, /recordPurpose=all&inWorklist=all&visibility=all/);
    return {
      page: ++page,
      pages: 2,
      total: 2,
      items: [{ id: page === 1 ? "b" : "a" }],
    };
  });
  assert.deepEqual(
    records.map((row) => row.id),
    ["a", "b"],
  );
});
test("TA 미배정 후보에서는 수동 포함된 숨김 사진을 제외한다", async () => {
  const visibleId = "11111111-1111-4111-8111-111111111111";
  const hiddenId = "22222222-2222-4222-8222-222222222222";
  const photos = [
    { id: visibleId, visibility: "visible", grade: 3 },
    { id: hiddenId, visibility: "hidden", grade: 2 },
  ].map((photo) => ({
    kind: "inspection",
    data: {
      ...photo,
      teamId: "team-1",
      rackId: "team-1-rack-1",
      planId: null,
      pointId: null,
      recordPurpose: "inspection",
      status: "done",
      ai: { grade: photo.grade },
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  }));
  const saved = [visibleId, hiddenId].map((targetId) => ({
    kind: "maintenance",
    data: {
      id: photoMaintenanceId(targetId),
      planId: null,
      targetType: "photo",
      targetId,
      sourceInspectionId: targetId,
      recordPurpose: "inspection",
      inWorklist: true,
      inclusionMode: "include",
      visibility: "visible",
      ta: true,
      repairStatus: "review",
      repairMethod: "undecided",
      editVersion: 0,
    },
  }));
  const entities = [...photos, ...saved];
  const connection = {
    query: async () => [[], []],
    execute: async () => [entities, []],
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };
  const pool = {
    getConnection: async () => connection,
    execute: async () => [[{ maintenance_id: "unbundled" }], []],
  };
  const result = await queryMaintenance(pool, (data) => data, {
    ...maintenanceQuerySchema.parse({
      targetType: "photo",
      unbundledOnly: "true",
    }),
  });
  assert.deepEqual(result.items.map((item) => item.targetId), [visibleId]);
});
