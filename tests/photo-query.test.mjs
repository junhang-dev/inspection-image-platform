import test from "node:test";
import assert from "node:assert/strict";
import { photoQuerySchema } from "../server/photo-query.mjs";
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
