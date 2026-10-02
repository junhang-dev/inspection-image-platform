import test from "node:test";
import assert from "node:assert/strict";
import { getRackGuidance } from "../src/lib/rack-guidance.ts";

const summary = { pending: 0, unread: 0, error: 0, retake: 0 };
const empty = {
  plansLoaded: true,
  dataError: false,
  plans: [],
  planPhotoCounts: {},
  planPhotosError: false,
  photoTotal: 0,
  photoSummary: summary,
  photosError: false,
  maintenanceTotal: 0,
  maintenanceReviewTotal: 0,
  maintenanceError: false,
  hasPointHistory: false,
};
const plan = (id, status = "planned") => ({ id, status });
const guidance = (changes) => getRackGuidance({ ...empty, ...changes });
const kinds = (result) => result.actions.map((action) => action.kind);

test("빈 랙과 완료 계획만 있는 랙은 같은 0/0/0이어도 다른 안내를 낸다", () => {
  const untouched = guidance({});
  const completed = guidance({ plans: [plan("p1", "done")] });

  assert.equal(untouched.tone, "attention");
  assert.deepEqual(kinds(untouched), ["create-plan"]);
  assert.equal(completed.tone, "calm");
  assert.match(completed.message, /완료된 검사계획 1개/);
  assert.match(completed.message, /등록된 사진은 없습니다/);
  assert.deepEqual(kinds(completed), ["create-plan"]);
  assert.doesNotMatch(completed.message, /검사가 완료/);
});

test("취소와 완료 계획은 섞여 있어도 진행 중 계획으로 세지 않는다", () => {
  const result = guidance({
    plans: [plan("p1", "done"), plan("p2", "cancelled")],
  });
  assert.equal(result.tone, "calm");
  assert.match(result.message, /완료 1개·취소 1개/);
  assert.deepEqual(kinds(result), ["create-plan"]);
});

test("사진 없는 진행 계획은 한 개면 바로 추가하고 여러 개면 계획을 고른다", () => {
  const one = guidance({
    plans: [plan("p1")],
    planPhotoCounts: { p1: { total: 0 } },
  });
  const many = guidance({
    plans: [plan("p1"), plan("p2")],
    planPhotoCounts: { p1: { total: 0 }, p2: { total: 25 } },
    photoTotal: 25,
  });
  assert.deepEqual(kinds(one), ["add-photo"]);
  assert.deepEqual(kinds(many), ["choose-photo-plan"]);
  assert.match(many.message, /계획 1개/);
  assert.match(many.message, /이 랙의 검사 사진/);
});

test("사진이 있고 판독·보수 검토가 끝나도 검사계획 완료를 주장하지 않는다", () => {
  const result = guidance({
    plans: [plan("p1")],
    planPhotoCounts: { p1: { total: 25 } },
    photoTotal: 25,
  });
  assert.equal(result.tone, "calm");
  assert.match(result.message, /계획은 계속 진행 중/);
  assert.doesNotMatch(result.message, /검사계획 완료/);
});

test("AI 판독 대기·미판독·보수 검토는 조용한 완료 상태로 합치지 않는다", () => {
  const active = {
    plans: [plan("p1")],
    planPhotoCounts: { p1: { total: 1 } },
    photoTotal: 1,
  };
  assert.match(
    guidance({ ...active, photoSummary: { ...summary, pending: 1 } }).message,
    /AI 판독 대기·진행 중/,
  );
  assert.match(
    guidance({ ...active, photoSummary: { ...summary, unread: 1 } }).message,
    /미판독 사진 1장/,
  );
  const review = guidance({
    ...active,
    maintenanceTotal: 1,
    maintenanceReviewTotal: 1,
  });
  assert.equal(review.tone, "attention");
  assert.deepEqual(kinds(review), ["review-maintenance"]);
});

test("재촬영과 판독 실패가 함께 있으면 사진 확인 행동은 한 번만 보여준다", () => {
  const result = guidance({
    plans: [plan("p1")],
    planPhotoCounts: { p1: { total: 2 } },
    photoTotal: 2,
    photoSummary: { ...summary, error: 1, retake: 1 },
  });
  assert.deepEqual(kinds(result), ["inspect-photos"]);
  assert.match(result.message, /판독 실패 1장 · 재촬영 표시 1장/);
});

test("완료 계획에 사진이 없어도 보수 검토가 남았다면 검토 행동을 우선한다", () => {
  const result = guidance({
    plans: [plan("p1", "done")],
    maintenanceTotal: 1,
    maintenanceReviewTotal: 1,
  });
  assert.equal(result.tone, "attention");
  assert.deepEqual(kinds(result), ["review-maintenance"]);
});

test("과거 사진이나 포인트가 있는 랙을 완전히 빈 랙으로 취급하지 않는다", () => {
  for (const changes of [
    { photoTotal: 1 },
    { hasPointHistory: true },
    { maintenanceTotal: 1 },
  ]) {
    const result = guidance(changes);
    assert.equal(result.tone, "calm");
    assert.deepEqual(kinds(result), ["create-plan"]);
  }
});

test("조회 중과 조회 실패는 0건이나 검토 완료로 표시하지 않는다", () => {
  const cases = [
    [{ plansLoaded: false }, "loading", []],
    [{ photoTotal: null }, "loading", []],
    [{ maintenanceReviewTotal: null }, "loading", []],
    [{ dataError: true }, "attention", ["retry-data"]],
    [{ photosError: true }, "attention", ["retry-photos"]],
    [{ maintenanceError: true }, "attention", ["retry-maintenance"]],
    [{ plans: [plan("p1")], planPhotoCounts: null }, "loading", []],
    [
      { plans: [plan("p1")], planPhotoCounts: null, planPhotosError: true },
      "attention",
      ["retry-plan-photos"],
    ],
    [
      { plans: [plan("p1")], planPhotoCounts: {} },
      "attention",
      ["retry-plan-photos"],
    ],
  ];
  for (const [changes, tone, actions] of cases) {
    const result = guidance(changes);
    assert.equal(result.tone, tone, JSON.stringify(changes));
    assert.deepEqual(kinds(result), actions, JSON.stringify(changes));
    assert.doesNotMatch(
      result.message,
      /항목은 없습니다|등록된 사진은 없습니다/,
    );
  }
});

test("계획·판독·보수 상태 84개 조합에서 우선 행동과 완료 표현을 지킨다", () => {
  const planCases = [
    { plans: [], counts: {} },
    { plans: [plan("a")], counts: { a: { total: 0 } } },
    { plans: [plan("a")], counts: { a: { total: 1 } } },
    {
      plans: [plan("a"), plan("b")],
      counts: { a: { total: 0 }, b: { total: 1 } },
    },
    { plans: [plan("a", "done")], counts: { a: { total: 0 } } },
    { plans: [plan("a", "cancelled")], counts: { a: { total: 0 } } },
    {
      plans: [plan("a"), plan("b", "done")],
      counts: { a: { total: 1 }, b: { total: 0 } },
    },
  ];
  const photoCases = [
    summary,
    { ...summary, pending: 1 },
    { ...summary, unread: 1 },
    { ...summary, error: 1 },
    { ...summary, retake: 1 },
    { ...summary, error: 1, retake: 1 },
  ];
  let checked = 0;
  for (const { plans, counts } of planCases) {
    for (const photoSummary of photoCases) {
      for (const review of [0, 1]) {
        const result = guidance({
          plans,
          planPhotoCounts: counts,
          photoTotal: Math.max(
            ...Object.values(counts).map((count) => count.total),
            photoSummary.pending,
            photoSummary.unread,
            photoSummary.error,
            photoSummary.retake,
            0,
          ),
          photoSummary,
          maintenanceTotal: review,
          maintenanceReviewTotal: review,
        });
        const actions = kinds(result);
        const context = JSON.stringify({ plans, photoSummary, review });
        assert.notEqual(result.tone, "loading", context);
        assert.equal(new Set(actions).size, actions.length, context);
        if (review) assert.ok(actions.includes("review-maintenance"), context);
        if (photoSummary.error || photoSummary.retake)
          assert.ok(actions.includes("inspect-photos"), context);
        if (review || photoSummary.error || photoSummary.retake)
          assert.equal(result.tone, "attention", context);
        if (!plans.some((item) => item.status === "planned")) {
          assert.ok(
            !actions.includes("add-photo") &&
              !actions.includes("choose-photo-plan"),
            context,
          );
        }
        if (plans.some((item) => item.status === "planned")) {
          assert.doesNotMatch(
            result.message,
            /검사계획 완료|검사가 완료/,
            context,
          );
        }
        checked++;
      }
    }
  }
  assert.equal(checked, 84);
});
