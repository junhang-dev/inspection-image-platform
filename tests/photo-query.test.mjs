import test from "node:test";
import assert from "node:assert/strict";
import { photoQuerySchema, photoWhere, summarizePlanStatusRows } from "../server/photo-query.mjs";
import { allPhotoRecords } from "../scripts/photo-records.mjs";

test("조회는 잘못된 범위·팀랙 조합·과도한 페이지를 거절한다", () => {
  for (const query of [
    { page: 0 },
    { pageSize: 101 },
    { page: 1.5 },
    { planId: "guess-from-name" },
    { teamId: "team-1", rackId: "team-2-rack-1" },
    { visibility: "deleted" },
    { recordPurpose: ["inspection", "verification"] },
    { rawSql: "1=1" },
  ]) {
    assert.equal(photoQuerySchema.safeParse(query).success, false);
  }
  assert.equal(
    photoQuerySchema.parse({ page: "11", pageSize: "100" }).page,
    11,
  );
});

test("사진 조회는 여러 검사계획을 선택하고 명시적 전체 해제를 구분한다", () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const all = photoQuerySchema.parse({});
  const none = photoQuerySchema.parse({ planIds: "" });
  const selected = photoQuerySchema.parse({ planIds: `${first},${second},${first}` });

  assert.equal(all.planIds, undefined);
  assert.deepEqual(none.planIds, []);
  assert.deepEqual(selected.planIds, [first, second]);

  const allWhere = photoWhere(all);
  const noneWhere = photoWhere(none);
  const selectedWhere = photoWhere(selected);
  assert.doesNotMatch(allWhere.sql, /1 = 0|\.planId.* IN/);
  assert.match(noneWhere.sql, /1 = 0/);
  assert.match(selectedWhere.sql, /\.planId.* IN \(\?,\?\)/);
  assert.deepEqual(selectedWhere.values.slice(0, 2), [first, second]);
});

test("AI 판독 상태와 업무 분류 필터를 독립적으로 적용한다", () => {
  const query = photoQuerySchema.parse({ aiStatus: "processing", workClassification: "repair" });
  const where = photoWhere(query);
  const summary = photoWhere(query, { classification: false, aiStatus: false, workClassification: false });

  assert.match(where.sql, /status.*processing/);
  assert.match(where.sql, /humanGrade.*BETWEEN 3 AND 5/);
  assert.match(where.sql, /retake.*<> 'true'/);
  assert.doesNotMatch(summary.sql, /status.*processing|humanGrade.*>= 3/);
  assert.equal(photoQuerySchema.safeParse({ aiStatus: "repair" }).success, false);
});

test("계획별 판독 집계는 페이지와 무관한 상태별 건수를 보존한다", () => {
  const { planCounts, planStatusCounts } = summarizePlanStatusRows([
    { planId: "plan-a", status: "done", total: "8" },
    { planId: "plan-a", status: "pending", total: "2" },
    { planId: "plan-a", status: "processing", total: "1" },
    { planId: "plan-a", status: "error", total: "1" },
    { planId: null, status: "done", total: "4" },
    { planId: "plan-b", status: "unknown", total: "3" },
  ]);

  assert.deepEqual(planCounts, { "plan-a": 12, "plan-b": 3 });
  assert.deepEqual(planStatusCounts["plan-a"], {
    total: 12,
    pending: 2,
    processing: 1,
    done: 8,
    error: 1,
    unread: 0,
  });
  assert.deepEqual(planStatusCounts["plan-b"], {
    total: 3,
    pending: 0,
    processing: 0,
    done: 0,
    error: 0,
    unread: 3,
  });
});

test("전체 검증 조회는 페이지 중복·수량변동·잘림을 성공으로 표시하지 않는다", async () => {
  for (const pages of [
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
    await assert.rejects(allPhotoRecords(async () => pages.shift()));
  let page = 0;
  const rows = await allPhotoRecords(async (path) => {
    assert.match(path, /recordPurpose=all/);
    assert.match(path, /visibility=all/);
    page += 1;
    return {
      page,
      pages: 2,
      total: 2,
      items: [{ id: page === 1 ? "b" : "a" }],
    };
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["a", "b"],
  );
});
