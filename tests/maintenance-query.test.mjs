import test from "node:test";
import assert from "node:assert/strict";
import { maintenanceQuerySchema } from "../server/maintenance-query.mjs";
import { allMaintenanceRecords } from "../scripts/maintenance-records.mjs";
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
    { visibility: "all" },
  ])
    assert.equal(maintenanceQuerySchema.safeParse(input).success, false);
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
    assert.match(path, /recordPurpose=all&inWorklist=all/);
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
