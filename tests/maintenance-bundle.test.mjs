import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMaintenanceBundleMember,
  maintenanceBundleStatusCounts,
  normalizeMaintenanceBundleInput,
} from "../server/maintenance-bundle-domain.mjs";
import { createMaintenanceBundleSchema } from "../server/maintenance-bundle-routes.mjs";

const id = (value) =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const a = id(1),
  b = id(2),
  c = id(3);
const input = (patch = {}) => ({
  name: "  정유2팀 파이프랙 보수  ",
  maintenanceIds: [a, b],
  expectedVersions: { [a]: 0, [b]: 3 },
  ...patch,
});

test("TA 작업 묶음은 이름, 여러 개의 서로 다른 사진, 각 사진의 최신 버전이 필요하다", () => {
  assert.deepEqual(normalizeMaintenanceBundleInput(input()), {
    name: "정유2팀 파이프랙 보수",
    maintenanceIds: [a, b],
    expectedVersions: { [a]: 0, [b]: 3 },
  });
  for (const bad of [
    input({ name: "   " }),
    input({ maintenanceIds: [a] }),
    input({ maintenanceIds: [a, a], expectedVersions: { [a]: 0 } }),
    input({ expectedVersions: { [a]: 0 } }),
    input({ expectedVersions: { [a]: -1, [b]: 0 } }),
  ])
    assert.throws(() => normalizeMaintenanceBundleInput(bad), { status: 422 });
});

test("묶음 생성 API는 UUID 키와 사진별 수정 버전을 엄격히 확인한다", () => {
  const parsed = createMaintenanceBundleSchema.parse({
    ...input(),
    actor: "현업 엔지니어",
    reason: "TA 작업 묶음 구성",
  });
  assert.equal(parsed.name, "정유2팀 파이프랙 보수");
  assert.equal(
    createMaintenanceBundleSchema.safeParse({
      ...input(),
      actor: "",
      reason: "",
    }).success,
    false,
  );
  assert.equal(
    createMaintenanceBundleSchema.safeParse({
      ...input(),
      maintenanceIds: [a],
      actor: "담당자",
      reason: "구성",
    }).success,
    false,
  );
});

test("묶음에는 저장된 검사 사진별 TA 보수 항목만 들어간다", () => {
  const item = {
    id: a,
    targetType: "photo",
    persisted: true,
    recordPurpose: "inspection",
    visibility: "visible",
    photoVisibility: "visible",
    inWorklist: true,
    ta: true,
    repairStatus: "review",
  };
  assert.equal(assertMaintenanceBundleMember(item), item);
  for (const patch of [
    { persisted: false },
    { targetType: "point" },
    { recordPurpose: "verification" },
    { visibility: "hidden" },
    { photoVisibility: "hidden" },
    { inWorklist: false },
    { ta: false },
  ])
    assert.throws(
      () => assertMaintenanceBundleMember({ ...item, ...patch }),
      (error) => [409, 422].includes(error.status),
    );
});

test("묶음 상태 요약은 사진별 상태 수를 정확히 합산한다", () => {
  assert.deepEqual(
    maintenanceBundleStatusCounts([
      { repairStatus: "review" },
      { repairStatus: "planned" },
      { repairStatus: "progress" },
      { repairStatus: "done" },
      { repairStatus: "done" },
      { repairStatus: "none" },
      { repairStatus: "unexpected" },
    ]),
    { review: 1, planned: 1, progress: 1, done: 2, none: 2 },
  );
});
