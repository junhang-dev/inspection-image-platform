import test from "node:test";
import assert from "node:assert/strict";
import { conceptPosition, visibleMapPoints } from "../src/lib/concept-map.ts";

test("설비와 랙의 모형 위치는 새 포인트 등록이나 목록 정렬로 이동하지 않는다", () => {
  const original = { id: "point-a", equipment: "EQ-101", rack: "2" };
  const before = conceptPosition(original);
  const reordered = [
    { id: "point-new", equipment: "EQ-202", rack: "4" },
    original,
  ];
  assert.deepEqual(
    conceptPosition(visibleMapPoints(reordered, "point-a")[0]),
    before,
  );
  assert.notDeepEqual(conceptPosition({ ...original, rack: "3" }), before);
  assert.notDeepEqual(
    conceptPosition({ ...original, equipment: "EQ-102" }),
    before,
  );
});

test("기본 표시 12개 이후의 포인트도 선택하면 그 ID를 맵에 표시한다", () => {
  const points = Array.from({ length: 20 }, (_, i) => ({
    id: `point-${String(i).padStart(2, "0")}`,
    equipment: "EQ-101",
    rack: "2",
  }));
  assert.equal(visibleMapPoints(points, "").length, 12);
  assert.deepEqual(
    visibleMapPoints(points, "point-19").map((p) => p.id),
    ["point-19"],
  );
});

test("설비나 랙이 미확인이면 위치를 만들어 표시하지 않는다", () => {
  assert.equal(
    conceptPosition({ id: "unknown", equipment: "EQ-101", rack: "" }),
    null,
  );
  assert.equal(
    conceptPosition({ id: "unknown", equipment: "", rack: "2" }),
    null,
  );
});
