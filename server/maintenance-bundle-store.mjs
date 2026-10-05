import { randomUUID } from "node:crypto";
import { pool, list, decodeEntity, insertEntity } from "./store.mjs";
import { allMaintenanceViews } from "./maintenance-query.mjs";
import { maintenanceTransaction } from "./maintenance-store.mjs";
import { repairNeeded, legacyInclusionMode } from "./maintenance-view.mjs";
import { photoMaintenanceId } from "./maintenance-domain.mjs";
import {
  assertMaintenanceBundleMember,
  maintenanceBundleStatusCounts,
  normalizeMaintenanceBundleInput,
} from "./maintenance-bundle-domain.mjs";

const fail = (status, code, message) =>
  Object.assign(new Error(message), { status, code });

async function locked(connection, kind, id) {
  const [rows] = await connection.execute(
    "SELECT data FROM entities WHERE kind = ? AND id = ? FOR UPDATE",
    [kind, id],
  );
  return rows[0] ? decodeEntity(rows[0].data, kind) : null;
}

async function validateMember(connection, id, expectedVersion) {
  const item = await locked(connection, "maintenance", id);
  if (
    !item ||
    item.id !== id ||
    item.targetType !== "photo" ||
    !item.targetId ||
    (item.sourceInspectionId && item.targetId !== item.sourceInspectionId)
  )
    throw fail(
      422,
      "photo_work_record_required",
      "사진별 보수 기록이 저장된 항목만 작업 묶음에 넣을 수 있습니다.",
    );
  if (item.editVersion !== expectedVersion)
    throw fail(
      409,
      "stale_bundle_member",
      "사진별 보수 기록이 바뀌었습니다. 최신 목록을 불러와 다시 선택하세요.",
    );
  if (item.id !== photoMaintenanceId(item.targetId))
    throw fail(
      422,
      "invalid_photo_work_record",
      "사진과 보수 기록의 연결을 확인할 수 없습니다.",
    );

  const photo = await locked(connection, "inspection", item.targetId);
  if (!photo || (photo.planId ?? null) !== (item.planId ?? null))
    throw fail(
      409,
      "photo_work_record_changed",
      "사진의 검사계획 연결이 바뀌었습니다. 목록을 새로고침해 확인하세요.",
    );
  if (
    (photo.recordPurpose ?? "inspection") !== "inspection" ||
    item.recordPurpose !== "inspection"
  )
    throw fail(
      422,
      "inspection_record_required",
      "검사 업무 사진만 작업 묶음에 넣을 수 있습니다.",
    );

  const [historyRows] = await connection.execute(
    "SELECT data FROM history WHERE entity_id = ?",
    [item.id],
  );
  const history = historyRows.map((row) =>
    typeof row.data === "string" ? JSON.parse(row.data) : row.data,
  );
  const mode = legacyInclusionMode(item, history);
  const visibility = item.visibility ?? "visible";
  const photoVisibility = photo.visibility ?? "visible";
  const view = {
    id: item.id,
    targetType: item.targetType,
    persisted: true,
    recordPurpose: item.recordPurpose,
    visibility,
    photoVisibility,
    inWorklist:
      visibility === "visible" &&
      photoVisibility === "visible" &&
      (mode === "include" || (mode === "auto" && repairNeeded(photo))),
    ta: item.ta === true,
    repairStatus: item.repairStatus,
    editVersion: item.editVersion,
    planId: item.planId ?? null,
    targetId: item.targetId,
  };
  return assertMaintenanceBundleMember(view);
}

export async function createMaintenanceBundle(input) {
  const normalized = normalizeMaintenanceBundleInput(input);
  const orderedIds = [...normalized.maintenanceIds].sort();
  const actor = input.actor.trim();
  const reason = input.reason.trim();
  return maintenanceTransaction(async (connection) => {
    const members = [];
    for (const id of orderedIds) {
      members.push(
        await validateMember(connection, id, normalized.expectedVersions[id]),
      );
    }
    const id = randomUUID();
    const bundle = {
      id,
      name: normalized.name,
      maintenanceIds: normalized.maintenanceIds,
      editVersion: 0,
      createdAt: new Date().toISOString(),
    };
    await insertEntity(connection, "maintenance_bundle", bundle, actor, reason);
    for (const [
      position,
      maintenanceId,
    ] of normalized.maintenanceIds.entries()) {
      await connection.execute(
        "INSERT INTO maintenance_bundle_members (maintenance_id, bundle_id, position) VALUES (?, ?, ?)",
        [maintenanceId, id, position],
      );
    }
    return bundle;
  });
}

export async function unbundledMaintenanceIds(connection = pool) {
  const [rows] = await connection.execute(
    "SELECT maintenance_id FROM maintenance_bundle_members",
  );
  return new Set(rows.map((row) => row.maintenance_id));
}

export async function readMaintenanceBundles() {
  const [entities, membershipRows, workItems] = await Promise.all([
    list("maintenance_bundle"),
    pool.execute(
      "SELECT bundle_id, maintenance_id FROM maintenance_bundle_members ORDER BY bundle_id, position",
    ),
    allMaintenanceViews(pool, decodeEntity, { photoBased: true }),
  ]);
  const bundles = entities;
  const [memberships] = membershipRows;
  const itemById = new Map(workItems.map((item) => [item.id, item]));
  const memberIdsByBundle = new Map();
  for (const row of memberships) {
    const ids = memberIdsByBundle.get(row.bundle_id) ?? [];
    ids.push(row.maintenance_id);
    memberIdsByBundle.set(row.bundle_id, ids);
  }
  return bundles
    .map((bundle) => {
      const maintenanceIds =
        memberIdsByBundle.get(bundle.id) ?? bundle.maintenanceIds ?? [];
      const members = maintenanceIds.map((maintenanceId) => {
        const item = itemById.get(maintenanceId);
        return (
          item ?? {
            id: maintenanceId,
            targetType: "photo",
            targetId: null,
            photoName: "사진 기록을 찾을 수 없음",
            planTitle: "계획 미조회",
            pointLabel: "위치 미확인",
            photoGrade: null,
            repairStatus: "none",
            repairMethod: "undecided",
            ta: false,
            inWorklist: false,
            visibility: "hidden",
            recordPurpose: "inspection",
            missing: true,
          }
        );
      });
      const activeMembers = members.filter(
        (item) =>
          item.inWorklist &&
          item.ta &&
          item.visibility === "visible" &&
          item.photoVisibility !== "hidden" &&
          !item.missing,
      );
      return {
        ...bundle,
        maintenanceIds,
        members,
        activeCount: activeMembers.length,
        inactiveCount: members.length - activeMembers.length,
        statusCounts: maintenanceBundleStatusCounts(activeMembers),
      };
    })
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
}
