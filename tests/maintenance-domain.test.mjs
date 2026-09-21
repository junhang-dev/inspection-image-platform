import assert from "node:assert/strict";
import test from "node:test";
import {
  REPAIR_STATUSES, REPAIR_METHODS, LEGACY_MIGRATION_VERSION,
  maintenanceId, validateMaintenanceItem, createMaintenanceItem,
  applyMaintenancePatch, migrateLegacyPoint,
} from "../server/maintenance-domain.mjs";

const id = (number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
const pointId = id(1), otherPointId = id(2), planId = id(10), otherPlanId = id(11);
const photoA = id(20), photoB = id(21);
const photos = [
  { id: photoA, planId, pointId },
  { id: photoB, planId, pointId },
];
const create = (patch = {}, snapshot = []) => createMaintenanceItem({ planId, pointId, ...patch }, snapshot);
const rejects = (fn, code, status = 422) => assert.throws(fn, (error) => {
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  assert.ok(error.message.length > 0);
  return true;
});
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test("pair IDs are stable UUID v5 values, including canonical UUID case", () => {
  const expected = "5100a7b0-c6d0-5726-b44a-786d89897b56"; // Independently computed with Python uuid.uuid5.
  assert.equal(maintenanceId(null, pointId), expected);
  assert.match(expected, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(maintenanceId(planId.toUpperCase(), pointId.toUpperCase()), maintenanceId(planId, pointId));
  assert.equal(maintenanceId(null, pointId).length, 36);
});

test("typed pairs cannot alias swapped pairs, different plans or unassigned plans", () => {
  const pairs = [null, ...Array.from({ length: 16 }, (_, index) => id(index + 50))]
    .flatMap((plan) => Array.from({ length: 16 }, (_, index) => [plan, id(index + 100)]));
  assert.equal(new Set(pairs.map(([plan, point]) => maintenanceId(plan, point))).size, pairs.length);
  assert.notEqual(maintenanceId(planId, pointId), maintenanceId(pointId, planId));
  assert.notEqual(maintenanceId(null, pointId), maintenanceId(planId, pointId));
  for (const invalid of [undefined, "", "null", 0, false, `${planId} `])
    rejects(() => maintenanceId(invalid, pointId), "invalid_id");
});

test("new items default to unregistered and never infer membership from status or TA", () => {
  assert.deepEqual(create(), {
    id: maintenanceId(planId, pointId), planId, pointId, photoIds: [],
    repairStatus: "none", repairMethod: "undecided", inWorklist: false, ta: false, editVersion: 0,
  });
  for (const repairStatus of REPAIR_STATUSES) {
    const item = create({ repairStatus, ta: true, repairMethod: "replace" });
    assert.equal(item.inWorklist, false);
    assert.equal(item.ta, true);
    assert.equal(item.repairStatus, repairStatus);
  }
  assert.equal(create({ inWorklist: true }).inWorklist, true);
  rejects(() => createMaintenanceItem({ pointId }), "invalid_id");
});

test("evidence snapshot can be complete or requested-only and preserves selected order", () => {
  const input = freeze({ planId, pointId, photoIds: [photoB, photoA] });
  const snapshot = freeze([...photos, { id: id(99), planId: otherPlanId, pointId: otherPointId }]);
  const actual = createMaintenanceItem(input, snapshot);
  assert.deepEqual(actual.photoIds, [photoB, photoA]);
  assert.deepEqual(actual, createMaintenanceItem(input, photos));
  actual.photoIds.push(id(88));
  assert.deepEqual(input.photoIds, [photoB, photoA]);
  assert.equal(snapshot.length, 3);
});

test("missing photos, other plans, other points and null/assigned mismatches fail", () => {
  rejects(() => create({ photoIds: [photoA] }), "photo_not_found");
  for (const bad of [
    { id: photoA, pointId, planId: otherPlanId },
    { id: photoA, pointId: otherPointId, planId },
    { id: photoA, pointId, planId: null },
    { id: photoA, pointId },
  ]) rejects(() => create({ photoIds: [photoA] }, [bad]), "photo_relation_mismatch");
  rejects(() => create({ planId: null, photoIds: [photoA] }, photos), "photo_relation_mismatch");
  assert.equal(create({ planId: null, photoIds: [photoA] }, [{ id: photoA, pointId }]).planId, null);
  assert.equal(create({ planId: null, photoIds: [photoA] }, [{ id: photoA, pointId, planId: null }]).planId, null);
});

test("duplicate evidence and ambiguous snapshots are rejected without mutation", () => {
  const selected = freeze([photoA, photoA.toUpperCase()]);
  rejects(() => create({ photoIds: selected }, photos), "duplicate_photo_id");
  rejects(() => create({ photoIds: [photoA] }, [photos[0], { ...photos[0] }]), "ambiguous_photo_snapshot");
  rejects(() => create({ photoIds: "invalid" }), "invalid_photo_ids");
  rejects(() => create({}, null), "invalid_photo_snapshot");
  assert.equal(selected.length, 2);
});

test("unknown enums, malformed booleans and invalid versions are never normalized", () => {
  for (const value of ["repair", "Review", " review ", "", null, undefined])
    rejects(() => create({ repairStatus: value }), "invalid_repair_status");
  for (const value of ["none", "replacement", "", null, undefined])
    rejects(() => create({ repairMethod: value }), "invalid_repair_method");
  for (const value of ["true", 1, null, undefined]) {
    rejects(() => create({ ta: value }), "invalid_boolean");
    rejects(() => create({ inWorklist: value }), "invalid_boolean");
  }
  for (const editVersion of [-1, 0.5, "0", undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    rejects(() => validateMaintenanceItem({ ...create(), editVersion }), "invalid_edit_version");
});

test("only explicit membership patches register/remove; state, method and TA remain independent", () => {
  for (const original of [false, true]) {
    let current = create({ inWorklist: original });
    for (const repairStatus of REPAIR_STATUSES) {
      for (const repairMethod of REPAIR_METHODS) {
        for (const ta of [false, true]) {
          current = applyMaintenancePatch(current, { repairStatus, repairMethod, ta });
          assert.equal(current.inWorklist, original);
          assert.equal(current.editVersion, 0);
        }
      }
    }
  }
  const original = { ...create({ inWorklist: true, ta: true, repairStatus: "done", repairMethod: "paint" }), editVersion: 7 };
  const removed = applyMaintenancePatch(original, { inWorklist: false });
  assert.deepEqual(removed, { ...original, inWorklist: false });
  const changed = applyMaintenancePatch(removed, { ta: false, repairStatus: "review" });
  assert.equal(changed.inWorklist, false);
  assert.equal(changed.editVersion, 7);
  const registered = applyMaintenancePatch(changed, { inWorklist: true });
  assert.deepEqual(registered, { ...changed, inWorklist: true });
});

test("patches cannot move pairs or modify server-owned version or migration fields", () => {
  for (const patch of [
    { id: id(30) }, { planId: null }, { pointId: otherPointId }, { editVersion: 1 },
    { expectedVersion: 0 }, { migratedFromPointId: pointId }, { maintenanceMigrationVersion: 1 },
    { managed: true }, { repairstatus: "review" }, { actor: "engineer" }, { reason: "reason" },
  ]) rejects(() => applyMaintenancePatch(create(), patch), "unsupported_field");
  rejects(() => create({ editVersion: 0 }), "unsupported_field");
  rejects(() => create({ migratedFromPointId: pointId }), "unsupported_field");
  rejects(() => createMaintenanceItem(null), "invalid_record");
  rejects(() => applyMaintenancePatch(create(), []), "invalid_record");
});

test("patch validates the resulting evidence, including current references against a new snapshot", () => {
  const current = create({ photoIds: [photoA] }, photos);
  rejects(() => applyMaintenancePatch(current, { repairStatus: "review" }, [{ ...photos[0], planId: otherPlanId }]), "photo_relation_mismatch");
  rejects(() => applyMaintenancePatch(current, { photoIds: [photoB] }, [photos[0]]), "photo_not_found");
  assert.deepEqual(applyMaintenancePatch(current, { photoIds: [] }).photoIds, []);
});

test("validation and patching do not mutate or alias nested input metadata", () => {
  const current = freeze({ ...create({ photoIds: [photoA] }, photos), editVersion: 3, audit: { labels: ["preserved"] }, createdAt: "2026-09-21T00:00:00Z" });
  const patch = freeze({ repairStatus: "planned", photoIds: [photoB] });
  const before = structuredClone(current);
  const next = applyMaintenancePatch(current, patch, freeze(photos));
  next.audit.labels.push("candidate only");
  next.photoIds.push(id(22));
  assert.deepEqual(current, before);
  assert.deepEqual(patch.photoIds, [photoB]);
  assert.equal(next.editVersion, 3);
  const validated = validateMaintenanceItem(current, photos);
  validated.audit.labels.push("separate validation result");
  assert.deepEqual(current, before);
});

test("legacy migration preserves status/method/TA and uses managed OR TA only once", () => {
  for (const managed of [false, true]) {
    for (const ta of [false, true]) {
      const point = freeze({ id: pointId, planId, managed, ta, repairStatus: "progress", repairMethod: "paint", editVersion: 8 });
      const result = migrateLegacyPoint(point);
      assert.deepEqual(result.item, {
        id: maintenanceId(null, pointId), planId: null, pointId, photoIds: [],
        repairStatus: "progress", repairMethod: "paint", ta,
        inWorklist: managed || ta, editVersion: 0, migratedFromPointId: pointId,
      });
      assert.equal(result.created, true);
      assert.deepEqual(result.pointPatch, { maintenanceMigrationVersion: LEGACY_MIGRATION_VERSION });
      assert.equal(point.editVersion, 8);
      assert.equal(point.planId, planId);
      assert.ok(!Object.hasOwn(point, "maintenanceMigrationVersion"));
    }
  }
});

test("only absent legacy fields get documented defaults; explicit invalid values fail", () => {
  const migrated = migrateLegacyPoint({ id: pointId }).item;
  assert.equal(migrated.repairStatus, "none");
  assert.equal(migrated.repairMethod, "undecided");
  assert.equal(migrated.inWorklist, false);
  assert.equal(migrated.ta, false);
  rejects(() => migrateLegacyPoint({ id: pointId, repairStatus: "broken" }), "invalid_repair_status");
  rejects(() => migrateLegacyPoint({ id: pointId, repairMethod: null }), "invalid_repair_method");
  rejects(() => migrateLegacyPoint({ id: pointId, managed: "true" }), "invalid_boolean");
  rejects(() => migrateLegacyPoint({ id: pointId, ta: undefined }), "invalid_boolean");
});

test("repeat migration preserves the exact existing edited item, with or without its point marker", () => {
  const originalPoint = { id: pointId, managed: true, ta: true, repairStatus: "review" };
  const first = migrateLegacyPoint(originalPoint);
  const edited = freeze({
    ...first.item, id: id(200), repairStatus: "done", repairMethod: "replace", ta: false,
    inWorklist: false, photoIds: [photoA], editVersion: 9, notes: { reason: "engineer decision" },
  });
  const markedPoint = freeze({ ...originalPoint, ...first.pointPatch });
  const repeated = migrateLegacyPoint(markedPoint, edited);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.item, edited);
  assert.deepEqual(repeated.pointPatch, {});
  repeated.item.notes.reason = "detached output";
  assert.equal(edited.notes.reason, "engineer decision");
  const existingWithoutMarker = migrateLegacyPoint(originalPoint, edited);
  assert.equal(existingWithoutMarker.created, false);
  assert.deepEqual(existingWithoutMarker.item, edited);
  assert.deepEqual(existingWithoutMarker.pointPatch, first.pointPatch);
});

test("a completed migration with a missing item fails instead of resurrecting legacy membership", () => {
  const point = freeze({ id: pointId, maintenanceMigrationVersion: 1, managed: true, ta: true });
  rejects(() => migrateLegacyPoint(point), "migration_target_missing", 409);
  for (const maintenanceMigrationVersion of [0, 2, "1", true, null, undefined])
    rejects(() => migrateLegacyPoint({ id: pointId, maintenanceMigrationVersion }), "invalid_migration_version");
});

test("migration refuses an existing item for another pair or corrupted migration origin", () => {
  rejects(() => migrateLegacyPoint({ id: pointId }, create()), "migration_pair_mismatch", 409);
  rejects(() => migrateLegacyPoint({ id: pointId }, create({ planId: null, pointId: otherPointId })), "migration_pair_mismatch", 409);
  rejects(() => validateMaintenanceItem({ ...create({ planId: null }), migratedFromPointId: otherPointId }), "invalid_migration_origin");
  rejects(() => validateMaintenanceItem({ ...create(), migratedFromPointId: pointId }), "invalid_migration_origin");
});
