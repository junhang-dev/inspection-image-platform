import { pool, get, decodeEntity, insertEntity, append } from "./store.mjs";
import {
  maintenanceId,
  maintenanceTarget,
  targetMaintenanceId,
  createMaintenanceItem,
  applyMaintenancePatch,
  migrateLegacyPoint,
} from "./maintenance-domain.mjs";
import { planPointIds } from "./relations.mjs";
import { getPlan } from "./plan-store.mjs";
import { evidenceFingerprint, repairNeeded, legacyInclusionMode } from "./maintenance-view.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const conflict = () =>
  fail(
    409,
    "다른 화면에서 보수 기록이 변경되었습니다. 입력을 보관한 뒤 다시 열어 최신 기록을 확인하세요.",
  );
export async function maintenanceTransaction(work) {
  const connection = await pool.getConnection();
  let commitAttempted = false;
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    const value = await work(connection);
    commitAttempted = true;
    await connection.commit();
    return value;
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (
      ["ER_DUP_ENTRY", "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(
        error.code,
      )
    )
      throw fail(
        409,
        "다른 저장과 겹쳐 반영하지 못했습니다. 최신 기록을 확인한 뒤 다시 시도하세요.",
      );
    error.commitUncertain = commitAttempted;
    throw error;
  } finally {
    connection.release();
  }
}
async function locked(connection, kind, id, raw = false) {
  const [rows] = await connection.execute(
    "SELECT data FROM entities WHERE kind = ? AND id = ? FOR UPDATE",
    [kind, id],
  );
  if (!rows[0]) return null;
  return raw
    ? typeof rows[0].data === "string"
      ? JSON.parse(rows[0].data)
      : rows[0].data
    : decodeEntity(rows[0].data, kind);
}
async function parents(connection, planId, pointId) {
  const planView = planId ? await getPlan(planId, connection, { lock: true }) : null;
  const point = await locked(connection, "point", pointId);
  if (!point) throw fail(422, "포인트를 찾을 수 없습니다.");
  if (
    point.maintenanceMigrationVersion !== 1 &&
    point.maintenanceSchemaVersion !== 1
  )
    throw fail(
      409,
      "기존 보수 기록을 준비 중입니다. 잠시 후 새로고침해 주세요.",
    );
  if (planId !== null) {
    const plan = await get("plan", planId, connection);
    const view = planView;
    if (!plan || (!planPointIds(plan).includes(pointId) && !view.rackIds.includes(point.rackId)))
      throw fail(
        422,
        "선택한 계획에 연결된 포인트만 보수 기록을 만들 수 있습니다.",
      );
  }
}
// Both additions and removals lock the same photo rows used by relation edits.
async function evidence(connection, oldIds, newIds) {
  const photos = [];
  for (const id of [
    ...new Set([...oldIds, ...newIds].map((id) => id.toLowerCase())),
  ].sort()) {
    const photo = await locked(connection, "inspection", id);
    if (!photo)
      throw fail(422, "근거 사진을 찾을 수 없습니다. 최신 기록을 확인하세요.");
    photos.push(photo);
  }
  return photos;
}
export async function saveMaintenance(input) {
  const {
    planId,
    pointId,
    targetType,
    targetId,
    expectedVersion,
    actor,
    reason,
    recordPurpose,
    acknowledgedEvidence,
    ...patch
  } = input;
  const target = maintenanceTarget({ planId, pointId, targetType, targetId });
  const id = targetMaintenanceId(target);
  return maintenanceTransaction(async (connection) => {
    const current = await locked(connection, "maintenance", id);
    if (
      current
        ? current.editVersion !== expectedVersion
        : expectedVersion !== null
    )
      throw conflict();
    if (target.targetType !== "photo") await parents(connection, planId, pointId);
    else {
      const photo = await locked(connection, "inspection", target.targetId);
      if (!photo || photo.pointId || (photo.planId ?? null) !== planId) throw fail(422, "사진별 보수 대상의 계획·포인트 관계가 변경되었습니다.");
      patch.photoIds ??= current?.photoIds ?? [photo.id];
      if (patch.photoIds.length !== 1 || patch.photoIds[0] !== photo.id) throw fail(422, "사진별 보수 항목은 해당 원본 한 장에 연결됩니다.");
    }
    const photos = await evidence(
      connection,
      current?.photoIds ?? [],
      [...(patch.photoIds ?? current?.photoIds ?? []), ...Object.keys(acknowledgedEvidence ?? {})],
    );
    const now = new Date().toISOString();
    if (Object.hasOwn(patch, "inWorklist") && patch.inclusionMode === undefined) patch.inclusionMode = patch.inWorklist ? "include" : "exclude";
    if (patch.inclusionMode === undefined && !current?.inclusionMode) {
      const [rows] = current ? await connection.execute("SELECT data FROM history WHERE entity_id = ?", [id]) : [[]];
      patch.inclusionMode = current ? legacyInclusionMode(current, rows.map((row) => typeof row.data === "string" ? JSON.parse(row.data) : row.data)) : "auto";
    }
    const candidate = current
      ? applyMaintenancePatch(current, patch, photos)
      : createMaintenanceItem({ ...target, ...patch }, photos);
    const after = {
      ...candidate,
      ...(target.targetType === "photo" ? { sourceInspectionId: target.targetId } : {}),
      recordPurpose: recordPurpose ?? current?.recordPurpose ?? "inspection",
      editVersion: current ? current.editVersion + 1 : 0,
      ...(current ? { updatedAt: now } : { createdAt: now }),
    };
    if (patch.visibility !== undefined) Object.assign(after, { hiddenAt: patch.visibility === "hidden" ? now : null, hiddenBy: patch.visibility === "hidden" ? actor : null, hiddenReason: patch.visibility === "hidden" ? reason : null });
    if (patch.repairStatus === "done" && current?.repairStatus !== "done") after.reviewedEvidence = {};
    if (acknowledgedEvidence) {
      const accepted = {};
      for (const [photoId, fingerprint] of Object.entries(acknowledgedEvidence)) {
        const photo = photos.find((photo) => photo.id === photoId);
        if (!photo || !repairNeeded(photo) || evidenceFingerprint(photo) !== fingerprint) throw fail(409, "확인하는 동안 사진 판독이 바뀌었습니다. 최신 근거를 확인하세요.");
        if (target.targetType === "photo" ? photo.id !== target.targetId : photo.pointId !== pointId || (photo.planId ?? null) !== planId) throw fail(422, "다른 보수 대상의 근거를 확인할 수 없습니다.");
        accepted[photoId] = fingerprint;
      }
      after.reviewedEvidence = { ...(after.reviewedEvidence ?? {}), ...accepted };
    }
    if (current) {
      await connection.execute(
        "UPDATE entities SET data = ? WHERE kind = ? AND id = ?",
        [JSON.stringify(after), "maintenance", id],
      );
      await append(connection, id, "수정", current, after, actor, reason);
    } else await insertEntity(connection, "maintenance", after, actor, reason);
    return after;
  });
}

export async function migratePointMaintenance(pointId, { apply = false } = {}) {
  // Migration only locks point -> maintenance. Ordinary writes never lock parents.
  return maintenanceTransaction(async (connection) => {
    const rawPoint = await locked(connection, "point", pointId, true);
    if (!rawPoint) throw fail(404, "포인트가 없습니다.");
    const point = decodeEntity(rawPoint, "point");
    const existing = await locked(
      connection,
      "maintenance",
      maintenanceId(null, pointId),
    );
    const proposal = migrateLegacyPoint(point, existing);
    if (!apply)
      return {
        pointId,
        created: proposal.created,
        marked: Object.keys(proposal.pointPatch).length > 0,
      };
    if (proposal.created)
      await insertEntity(
        connection,
        "maintenance",
        {
          ...proposal.item,
          recordPurpose: point.recordPurpose,
          createdAt: new Date().toISOString(),
        },
        "기존 보수 기록 이관",
        "기존 포인트 상태·관리·TA 값을 계획 미지정 보수 기록으로 보존",
      );
    if (Object.keys(proposal.pointPatch).length) {
      const after = {
        ...rawPoint,
        ...proposal.pointPatch,
        editVersion: point.editVersion + 1,
        updatedAt: new Date().toISOString(),
      };
      await connection.execute(
        "UPDATE entities SET data = ? WHERE kind = ? AND id = ?",
        [JSON.stringify(after), "point", pointId],
      );
      await append(
        connection,
        pointId,
        "보수 기록 이관",
        point,
        decodeEntity(after, "point"),
        "기존 보수 기록 이관",
        "원래 업무 값은 유지하고 1회 이관 표식 추가",
      );
    }
    return {
      pointId,
      created: proposal.created,
      marked: Object.keys(proposal.pointPatch).length > 0,
    };
  });
}
