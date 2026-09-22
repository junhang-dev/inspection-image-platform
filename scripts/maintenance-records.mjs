import assert from "node:assert/strict";
// Full-purpose records, including items removed from the worklist. Reject a
// changing page set instead of treating a partial read as a preservation proof.
export async function allMaintenanceRecords(read) {
  const result = [],
    ids = new Set();
  let total = null,
    pages = null;
  for (let page = 1; page < 1000001; page++) {
    const data = await read(
      `/maintenance/query?recordPurpose=all&inWorklist=all&pageSize=100&page=${page}`,
    );
    assert.ok(Number.isSafeInteger(data.total) && data.total >= 0);
    assert.ok(
      Number.isSafeInteger(data.pages) &&
        data.pages >= 1 &&
        data.pages <= 1000000,
    );
    assert.ok(Array.isArray(data.items));
    assert.equal(
      data.page,
      page,
      "보수 페이지가 바뀌어 전체 집합을 확인할 수 없습니다.",
    );
    if (total === null) {
      total = data.total;
      pages = data.pages;
    }
    assert.equal(data.total, total);
    assert.equal(data.pages, pages);
    for (const item of data.items) {
      assert.ok(!ids.has(item.id), "중복 보수 ID");
      ids.add(item.id);
      result.push(item);
    }
    if (page === pages) {
      assert.equal(result.length, total);
      return result.sort((a, b) => a.id.localeCompare(b.id));
    }
  }
  throw new Error("보수 페이지 한도를 넘어 전체 조회를 확인할 수 없습니다.");
}
