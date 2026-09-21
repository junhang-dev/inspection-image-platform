import { pool, get, decodeEntity, insertEntity, append } from "./store.mjs";
import {
  maintenanceId,
  createMaintenanceItem,
  applyMaintenancePatch,
  migrateLegacyPoint,
} from "./maintenance-domain.mjs";
import { planPointIds } from "./relations.mjs";

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
  const point = await get("point", pointId, connection);
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
    if (!plan || !planPointIds(plan).includes(pointId))
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
    expectedVersion,
    actor,
    reason,
    recordPurpose,
    ...patch
  } = input;
  const id = maintenanceId(planId, pointId);
  return maintenanceTransaction(async (connection) => {
    const current = await locked(connection, "maintenance", id);
    if (
      current
        ? current.editVersion !== expectedVersion
        : expectedVersion !== null
    )
      throw conflict();
    await parents(connection, planId, pointId);
    const photos = await evidence(
      connection,
      current?.photoIds ?? [],
      patch.photoIds ?? current?.photoIds ?? [],
    );
    const now = new Date().toISOString();
    const candidate = current
      ? applyMaintenancePatch(current, patch, photos)
      : createMaintenanceItem({ planId, pointId, ...patch }, photos);
    const after = {
      ...candidate,
      recordPurpose: recordPurpose ?? current?.recordPurpose ?? "inspection",
      editVersion: current ? current.editVersion + 1 : 0,
      ...(current ? { updatedAt: now } : { createdAt: now }),
    };
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
