import assert from "node:assert/strict";

// Intended for bounded verification runs. Concurrent creation/deletion fails the
// capture instead of silently presenting a partial set as the whole database.
export async function allPhotoRecords(read, scope = {}) {
  const records = [];
  let expected;
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({
      recordPurpose: "all",
      visibility: "all",
      ...scope,
      pageSize: "100",
      page: String(page),
    });
    const result = await read(`/inspections/query?${query}`);
    expected ??= result.total;
    assert.equal(
      result.total,
      expected,
      "조회 중 전체 건수가 바뀌었습니다. 변경을 멈춘 뒤 다시 검증하세요.",
    );
    assert.equal(result.page, page, "요청한 페이지와 응답이 다릅니다.");
    records.push(...result.items);
    if (page >= result.pages) break;
  }
  assert.equal(records.length, expected);
  assert.equal(
    new Set(records.map((item) => item.id)).size,
    expected,
    "페이지 간 중복 또는 누락된 사진이 있습니다.",
  );
  return records.sort((a, b) => a.id.localeCompare(b.id));
}
