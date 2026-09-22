import { createHash } from "node:crypto";

export const REPAIR_STATUSES = Object.freeze([
  "none",
  "review",
  "planned",
  "progress",
  "done",
]);
export const REPAIR_METHODS = Object.freeze(["undecided", "paint", "replace"]);
export const LEGACY_MIGRATION_VERSION = 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// RFC UUID v5 DNS namespace. Keep the namespace and tuple serialization stable.
const NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
const EDITABLE = Object.freeze([
  "photoIds",
  "repairStatus",
  "repairMethod",
  "inWorklist",
  "ta",
  "inclusionMode",
  "visibility",
]);
const CREATABLE = new Set(["planId", "pointId", "targetType", "targetId", ...EDITABLE]);
const PATCHABLE = new Set(EDITABLE);
const fail = (status, code, message) =>
  Object.assign(new Error(message), { status, code });
const invalid = (code, message) => fail(422, code, message);

function record(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw invalid("invalid_record", `${label}은 객체여야 합니다.`);
}

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value))
    throw invalid("invalid_id", `${label} 식별자가 올바르지 않습니다.`);
  // UUID case is not a different database identity. Never trim or coerce IDs.
  return value.toLowerCase();
}

function pair(planId, pointId) {
  return {
    planId: planId === null ? null : uuid(planId, "계획"),
    pointId: uuid(pointId, "포인트"),
  };
}

function boolean(value, label) {
  if (typeof value !== "boolean")
    throw invalid("invalid_boolean", `${label}은 참 또는 거짓이어야 합니다.`);
  return value;
}

function enumeration(value, values, code, label) {
  if (!values.includes(value))
    throw invalid(code, `${label} 값이 올바르지 않습니다.`);
  return value;
}

function knownKeys(input, allowed) {
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowed.has(key))
      throw invalid(
        "unsupported_field",
        "직접 변경할 수 없는 보수 항목 필드가 포함되어 있습니다.",
      );
  }
}

function photoIds(value) {
  if (!Array.isArray(value))
    throw invalid("invalid_photo_ids", "근거 사진은 식별자 목록이어야 합니다.");
  const result = value.map((id) => uuid(id, "사진"));
  if (new Set(result).size !== result.length)
    throw invalid(
      "duplicate_photo_id",
      "같은 근거 사진을 중복 선택할 수 없습니다.",
    );
  return result;
}

/** Stable, 36-character UUID for the typed (nullable planId, pointId) pair. */
export function maintenanceId(planId, pointId) {
  const relation = pair(planId, pointId);
  const name = `inspection-image-platform/maintenance/v1:${JSON.stringify([
    relation.planId,
    relation.pointId,
  ])}`;
  return uuidForName(name);
}

function uuidForName(name) {
  const bytes = createHash("sha1")
    .update(NAMESPACE)
    .update(name, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function photoMaintenanceId(photoId) {
  return uuidForName(`inspection-image-platform/maintenance/photo/v1:${uuid(photoId, "사진")}`);
}
export function maintenanceTarget(input) {
  if (input.targetType === "photo") {
    if (input.pointId !== null && input.pointId !== undefined) throw invalid("invalid_target", "사진별 보수 대상에는 포인트를 함께 지정할 수 없습니다.");
    return { planId: input.planId === null ? null : uuid(input.planId, "계획"), pointId: null, targetType: "photo", targetId: uuid(input.targetId, "사진") };
  }
  if (input.targetType !== undefined && input.targetType !== "point") throw invalid("invalid_target", "보수 대상 형식이 올바르지 않습니다.");
  const relation = pair(input.planId, input.pointId);
  if (input.targetId !== undefined && input.targetId !== relation.pointId) throw invalid("invalid_target", "포인트 식별자가 일치하지 않습니다.");
  return relation;
}
export function targetMaintenanceId(input) {
  const relation = maintenanceTarget(input);
  return relation.targetType === "photo" ? photoMaintenanceId(relation.targetId) : maintenanceId(relation.planId, relation.pointId);
}

function shape(item) {
  record(item, "보수 항목");
  uuid(item.id, "보수 항목");
  const relation = maintenanceTarget(item);
  const evidence = photoIds(item.photoIds);
  enumeration(
    item.repairStatus,
    REPAIR_STATUSES,
    "invalid_repair_status",
    "보수 상태",
  );
  enumeration(
    item.repairMethod,
    REPAIR_METHODS,
    "invalid_repair_method",
    "보수 방법",
  );
  boolean(item.inWorklist, "워크리스트 포함 여부");
  boolean(item.ta, "TA 포함 여부");
  if (item.inclusionMode !== undefined) enumeration(item.inclusionMode, ["auto", "include", "exclude"], "invalid_inclusion", "목록 반영 방식");
  if (item.visibility !== undefined) enumeration(item.visibility, ["visible", "hidden"], "invalid_visibility", "표시 상태");
  if (!Number.isSafeInteger(item.editVersion) || item.editVersion < 0)
    throw invalid("invalid_edit_version", "수정 버전이 올바르지 않습니다.");
  if (Object.hasOwn(item, "migratedFromPointId")) {
    if (
      uuid(item.migratedFromPointId, "이관 원본 포인트") !== relation.pointId ||
      relation.planId !== null
    )
      throw invalid(
        "invalid_migration_origin",
        "이관 원본 포인트와 계획 미지정 항목이 일치하지 않습니다.",
      );
  }
  return { ...relation, photoIds: evidence };
}

/**
 * photos may be the complete snapshot or just the requested photo IDs. Every
 * selected ID must be present exactly once. Read its current pair in the same
 * transaction as the write; this pure function cannot prevent stale snapshots.
 * Legacy photos with no planId are explicitly treated as unassigned (null).
 * Visibility and caller access filtering remain the API's responsibility.
 */
function validatePhotos(relation, photos) {
  if (!Array.isArray(photos))
    throw invalid(
      "invalid_photo_snapshot",
      "근거 사진 조회 결과가 올바르지 않습니다.",
    );
  const index = new Map();
  for (const photo of photos) {
    record(photo, "사진");
    const id = uuid(photo.id, "사진");
    if (index.has(id))
      throw invalid(
        "ambiguous_photo_snapshot",
        "사진 조회 결과에 중복 식별자가 있습니다.",
      );
    index.set(id, photo);
  }
  for (const id of relation.photoIds) {
    const photo = index.get(id);
    if (!photo)
      throw invalid(
        "photo_not_found",
        "선택한 근거 사진을 찾을 수 없습니다. 다시 확인하세요.",
      );
    const photoPlanId = Object.hasOwn(photo, "planId") ? photo.planId : null;
    if (relation.targetType === "photo") {
      if (photo.id !== relation.targetId || photo.pointId || photoPlanId !== relation.planId) throw invalid("photo_relation_mismatch", "사진별 보수 항목의 원본 사진과 계획이 다릅니다.");
      continue;
    }
    const actual = pair(photoPlanId, photo.pointId);
    if (
      actual.planId !== relation.planId ||
      actual.pointId !== relation.pointId
    )
      throw invalid(
        "photo_relation_mismatch",
        "근거 사진은 보수 항목과 같은 계획·포인트에 속해야 합니다.",
      );
  }
}

/** Validate a stored item without normalizing away unknown enums or metadata. */
export function validateMaintenanceItem(item, photos = []) {
  validatePhotos(shape(item), photos);
  return structuredClone(item);
}

/**
 * Explicitly supplying inWorklist:true means registration. Status/method/TA
 * never imply registration. id/editVersion/migration metadata are server-owned.
 * Missing planId is an error: the caller must explicitly choose null or a plan.
 */
export function createMaintenanceItem(input, photos = []) {
  record(input, "새 보수 항목");
  knownKeys(input, CREATABLE);
  const relation = maintenanceTarget(input);
  const item = {
    id: targetMaintenanceId(input),
    ...relation,
    photoIds: Object.hasOwn(input, "photoIds") ? photoIds(input.photoIds) : [],
    repairStatus: Object.hasOwn(input, "repairStatus")
      ? input.repairStatus
      : "none",
    repairMethod: Object.hasOwn(input, "repairMethod")
      ? input.repairMethod
      : "undecided",
    inWorklist: Object.hasOwn(input, "inWorklist") ? input.inWorklist : false,
    ta: Object.hasOwn(input, "ta") ? input.ta : false,
    editVersion: 0,
    ...(input.inclusionMode !== undefined ? { inclusionMode: input.inclusionMode } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
  };
  return validateMaintenanceItem(item, photos);
}

/**
 * Return a detached candidate; do NOT increment editVersion. The store owns
 * locking, expectedVersion comparison, version increment, persistence/history.
 * A caller must explicitly include inWorklist to register or remove an item.
 */
export function applyMaintenancePatch(current, patch, photos = []) {
  shape(current);
  record(patch, "보수 변경 내용");
  knownKeys(patch, PATCHABLE);
  const next = { ...structuredClone(current), ...structuredClone(patch) };
  if (Object.hasOwn(patch, "photoIds"))
    next.photoIds = photoIds(patch.photoIds);
  return validateMaintenanceItem(next, photos);
}

/**
 * One-time legacy migration proposal. Persist item creation + pointPatch in one
 * transaction, and retry using the locked existing item. Never overwrite it.
 * Source fields remain on the point; no plan or evidence is inferred.
 * Existing item evidence is not reselected here, so no photo snapshot is read.
 */
export function migrateLegacyPoint(point, existingItem = null) {
  record(point, "기존 포인트");
  const pointId = uuid(point.id, "포인트");
  const marked = Object.hasOwn(point, "maintenanceMigrationVersion");
  if (marked && point.maintenanceMigrationVersion !== LEGACY_MIGRATION_VERSION)
    throw invalid(
      "invalid_migration_version",
      "보수 이관 표식이 알려진 버전과 다릅니다.",
    );

  if (existingItem !== null) {
    const existing = shape(existingItem);
    if (existing.planId !== null || existing.pointId !== pointId)
      throw fail(
        409,
        "migration_pair_mismatch",
        "기존 보수 항목이 이 포인트의 계획 미지정 항목과 다릅니다.",
      );
    return {
      item: structuredClone(existingItem),
      created: false,
      pointPatch: marked
        ? {}
        : { maintenanceMigrationVersion: LEGACY_MIGRATION_VERSION },
    };
  }
  if (marked)
    throw fail(
      409,
      "migration_target_missing",
      "이관 완료 표식은 있지만 보수 항목이 없습니다. 기존 기록을 확인하세요.",
    );

  // Only genuinely absent legacy fields receive documented initial defaults.
  const managed = Object.hasOwn(point, "managed")
    ? boolean(point.managed, "기존 관리 대상")
    : false;
  const ta = Object.hasOwn(point, "ta")
    ? boolean(point.ta, "기존 TA 포함 여부")
    : false;
  const item = createMaintenanceItem({
    planId: null,
    pointId,
    repairStatus: Object.hasOwn(point, "repairStatus")
      ? point.repairStatus
      : "none",
    repairMethod: Object.hasOwn(point, "repairMethod")
      ? point.repairMethod
      : "undecided",
    inWorklist: managed || ta,
    ta,
  });
  return {
    item: { ...item, migratedFromPointId: pointId },
    created: true,
    pointPatch: { maintenanceMigrationVersion: LEGACY_MIGRATION_VERSION },
  };
}
