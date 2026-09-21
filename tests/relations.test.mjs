import test from "node:test";
import assert from "node:assert/strict";
import {
  locations,
  planPointIds,
  pointLocation,
} from "../server/relations.mjs";
import { decodeEntity, list, pool } from "../server/store.mjs";

test("기존 단일 포인트 계획은 같은 ID의 관계로 읽고 사진 계획을 추측하지 않는다", () => {
  const legacy = { id: "plan", pointId: "point-a" };
  assert.deepEqual(planPointIds(legacy), ["point-a"]);
  assert.deepEqual(
    planPointIds({ pointIds: ["point-a", "point-a", "point-b"] }),
    ["point-a", "point-b"],
  );
  assert.deepEqual(decodeEntity(legacy, "plan").pointIds, ["point-a"]);
  const photo = decodeEntity({ id: "photo", pointId: "point-a" }, "inspection");
  assert.equal(photo.planId, null);
  const point = decodeEntity({ id: "point-a", rack: "1" }, "point");
  assert.equal(point.rackId, null);
  assert.equal(point.virtualPosition, null);
  assert.equal(point.locationSource, "unconfirmed");
});

test("가상 랙은 표시 이름이 같아도 팀별 ID가 다르고 위치는 안정적이다", () => {
  assert.equal(locations.teams.length, 4);
  assert.equal(
    new Set(locations.racks.map((r) => r.id)).size,
    locations.racks.length,
  );
  const first = pointLocation("team-1-rack-1", "stable-id");
  const second = pointLocation("team-2-rack-1", "stable-id");
  assert.equal(first.rack, second.rack);
  assert.notEqual(first.rackId, second.rackId);
  assert.notDeepEqual(first.virtualPosition, second.virtualPosition);
  assert.deepEqual(first, pointLocation("team-1-rack-1", "stable-id"));
  assert.equal(first.locationSource, "virtual");
  assert.equal(
    pointLocation(null, "stable-id", "확인 전").virtualPosition,
    null,
  );
  assert.throws(
    () => pointLocation("missing", "stable-id"),
    (e) => e.status === 422,
  );
});

test("계획별 사진 조회는 최신 제한을 적용하기 전에 SQL에서 계획을 구분한다", async () => {
  const original = pool.execute;
  const calls = [];
  pool.execute = async (sql, values) => {
    calls.push({ sql, values });
    return [[]];
  };
  try {
    await list("inspection", { planId: "plan-a" });
    await list("inspection", { planId: null });
    assert.match(calls[0].sql, /planId.*ORDER BY.*LIMIT/s);
    assert.deepEqual(calls[0].values, ["inspection", "plan-a"]);
    assert.deepEqual(calls[1].values, ["inspection", ""]);
  } finally {
    pool.execute = original;
  }
});
