const fail = (status, code, message) =>
  Object.assign(new Error(message), { status, code });

export function normalizeMaintenanceBundleInput({
  name,
  maintenanceIds,
  expectedVersions,
}) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100)
    throw fail(
      422,
      "invalid_bundle_name",
      "작업 묶음 이름을 1~100자로 입력하세요.",
    );
  if (!Array.isArray(maintenanceIds) || maintenanceIds.length < 2)
    throw fail(
      422,
      "bundle_needs_multiple_photos",
      "TA 사진을 두 장 이상 선택하세요.",
    );
  if (new Set(maintenanceIds).size !== maintenanceIds.length)
    throw fail(
      422,
      "duplicate_bundle_member",
      "같은 사진을 중복 선택할 수 없습니다.",
    );
  if (
    !expectedVersions ||
    typeof expectedVersions !== "object" ||
    Array.isArray(expectedVersions)
  )
    throw fail(
      422,
      "invalid_bundle_versions",
      "사진별 최신 버전을 확인할 수 없습니다.",
    );
  const versionIds = Object.keys(expectedVersions).sort();
  if (
    versionIds.length !== maintenanceIds.length ||
    versionIds.join("\n") !== [...maintenanceIds].sort().join("\n")
  )
    throw fail(
      422,
      "invalid_bundle_versions",
      "선택한 사진의 버전 정보가 일치하지 않습니다.",
    );
  if (
    versionIds.some(
      (id) =>
        !Number.isSafeInteger(expectedVersions[id]) || expectedVersions[id] < 0,
    )
  )
    throw fail(
      422,
      "invalid_bundle_versions",
      "사진별 최신 버전을 확인할 수 없습니다.",
    );
  return {
    name: name.trim(),
    maintenanceIds: [...maintenanceIds],
    expectedVersions,
  };
}

export function assertMaintenanceBundleMember(item) {
  if (!item || item.targetType !== "photo" || !item.persisted)
    throw fail(
      422,
      "photo_work_record_required",
      "사진별 보수 기록이 저장된 항목만 작업 묶음에 넣을 수 있습니다.",
    );
  if (item.recordPurpose !== "inspection")
    throw fail(
      422,
      "inspection_record_required",
      "검사 업무 사진만 작업 묶음에 넣을 수 있습니다.",
    );
  if (
    item.visibility !== "visible" ||
    (item.photoVisibility ?? "visible") !== "visible" ||
    !item.inWorklist ||
    !item.ta
  )
    throw fail(
      409,
      "bundle_member_not_eligible",
      "선택한 사진이 더 이상 공개된 TA 보수 대상이 아닙니다. 목록을 새로고침해 확인하세요.",
    );
  return item;
}

export function maintenanceBundleStatusCounts(items) {
  const counts = { review: 0, planned: 0, progress: 0, done: 0, none: 0 };
  for (const item of items) {
    const status = Object.hasOwn(counts, item.repairStatus)
      ? item.repairStatus
      : "none";
    counts[status]++;
  }
  return counts;
}
