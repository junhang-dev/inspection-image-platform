import { randomUUID } from "node:crypto";
import { pool, get, decodeEntity, append, insertEntity } from "./store.mjs";
import { planView, validatePlanScope, assertPlanAcceptsUpload, scopeImpact, fail } from "./plan-domain.mjs";

const parse = (data) => typeof data === "string" ? JSON.parse(data) : data;
export async function readPoints(connection) {
  const [rows] = await connection.execute("SELECT data FROM entities WHERE kind = 'point'");
  return rows.map((row) => decodeEntity(row.data, "point"));
}
export async function getPlan(id, connection = pool, { lock = false } = {}) {
  const [rows] = await connection.execute(`SELECT data FROM entities WHERE kind = 'plan' AND id = ?${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!rows[0]) return null;
  return planView(decodeEntity(rows[0].data, "plan"), await readPoints(connection));
}
export async function listPlans(query) {
  const [rows] = await pool.execute("SELECT data FROM entities WHERE kind = 'plan' ORDER BY created_at DESC, id DESC");
  const points = await readPoints(pool);
  return rows.map((row) => planView(decodeEntity(row.data, "plan"), points)).filter((plan) =>
    (query.recordPurpose === "all" || plan.recordPurpose === query.recordPurpose) &&
    (query.visibility === "all" || plan.visibility === query.visibility) &&
    (query.teamId === "all" || plan.teamId === query.teamId) &&
    (query.rackId === "all" || plan.rackIds.includes(query.rackId)));
}
async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => {});
    if (["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"].includes(error.code))
      throw fail(409, "관련 기록을 변경 중입니다. 입력을 유지하고 잠시 후 다시 저장하세요.");
    throw error;
  } finally { connection.release(); }
}
async function validatePoints(plan, connection) {
  for (const id of [...plan.pointIds].sort()) {
    const [rows] = await connection.execute("SELECT data FROM entities WHERE kind = 'point' AND id = ? FOR UPDATE", [id]);
    const point = rows[0] && parse(rows[0].data);
    if (!point || !plan.rackIds.includes(point.rackId))
      throw fail(422, "연결할 포인트가 계획의 랙 범위에 속하지 않습니다.");
  }
}
export async function createPlan(input) {
  validatePlanScope(input);
  return transaction(async (connection) => {
    await validatePoints(input, connection);
    const item = { ...input, id: randomUUID(), pointId: input.pointIds[0] ?? null, recordPurpose: "inspection", status: "planned", visibility: "visible", editVersion: 0, createdAt: new Date().toISOString() };
    await insertEntity(connection, "plan", item, "현업 엔지니어", "검사계획 등록");
    return item;
  });
}
export async function patchPlan(id, { actor, reason, expectedVersion, ...patch }) {
  return transaction(async (connection) => {
    const [rows] = await connection.execute("SELECT data FROM entities WHERE kind = 'plan' AND id = ? FOR UPDATE", [id]);
    if (!rows[0]) throw fail(404, "검사계획을 찾을 수 없습니다.");
    const before = decodeEntity(rows[0].data, "plan");
    if (before.editVersion !== expectedVersion) throw fail(409, "다른 화면에서 검사계획을 수정했습니다. 입력을 보관한 뒤 최신 내용을 확인하세요.");
    const points = await readPoints(connection);
    const current = planView(before, points);
    const candidate = { ...current, ...patch };
    const changesScope = ["teamId", "rackIds", "pointIds"].some((key) => Object.hasOwn(patch, key));
    if (changesScope) {
      validatePlanScope(candidate);
      await validatePoints(candidate, connection);
      const [photos] = await connection.execute("SELECT data FROM entities WHERE kind = 'inspection' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.planId')) = ?", [id]);
      const [sessions] = await connection.execute("SELECT data FROM upload_sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.planId')) = ?", [id]);
      const impact = scopeImpact(candidate, photos.map((row) => parse(row.data)), sessions.map((row) => parse(row.data)), points);
      const [maintenance] = await connection.execute("SELECT data FROM entities WHERE kind = 'maintenance' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.planId')) = ?", [id]);
      impact.maintenance = maintenance.map((row) => parse(row.data)).filter((item) => item.pointId && !candidate.rackIds.includes(points.find((point) => point.id === item.pointId)?.rackId)).length;
      if (impact.photos || impact.sessions || impact.maintenance) throw fail(409, `범위 변경의 영향을 받는 사진 ${impact.photos}장, 전송 ${impact.sessions}건, 보수 기록 ${impact.maintenance}건이 있습니다. 기존 범위를 유지하거나 사진의 연결을 먼저 수정하세요.`, impact);
      Object.assign(patch, { teamId: candidate.teamId, rackIds: candidate.rackIds, pointIds: candidate.pointIds, pointId: candidate.pointIds[0] ?? null });
    }
    if (Object.hasOwn(patch, "visibility")) Object.assign(patch, { hiddenAt: patch.visibility === "hidden" ? new Date().toISOString() : null, hiddenBy: patch.visibility === "hidden" ? actor : null, hiddenReason: patch.visibility === "hidden" ? reason : null });
    const after = { ...before, ...patch, editVersion: before.editVersion + 1, updatedAt: new Date().toISOString() };
    await connection.execute("UPDATE entities SET data = ? WHERE kind = 'plan' AND id = ?", [JSON.stringify(after), id]);
    await append(connection, id, "수정", before, after, actor, reason);
    return planView(after, points);
  });
}

// Upload callers hold this row lock through session creation or photo commit.
export async function validateNewPhotoRelation(planId, pointId, connection = pool, input = {}, { lock = false, phase = "create" } = {}) {
  if (phase === "finalize" && input.contractVersion !== "plan-rack-v3") {
    // Persisted pre-v3 transfers retain their accepted contract. This marker
    // is server-owned; a new request can never select the compatibility path.
    const plan = planId ? await getPlan(planId, connection, { lock }) : null;
    const point = pointId ? await get("point", pointId, connection) : null;
    if (pointId && !point) throw fail(422, "기존 전송의 포인트를 찾을 수 없습니다.");
    if (planId && (!plan || !plan.pointIds.includes(pointId))) throw fail(409, "기존 전송의 계획·포인트 관계를 확인하세요.");
    return {};
  }
  if ((input.recordPurpose ?? "inspection") !== "inspection") throw fail(422, "새 사진은 업무 검사로 등록됩니다.");
  if (!planId) throw fail(422, "사진을 추가할 검사계획을 선택하세요.");
  const plan = await getPlan(planId, connection, { lock });
  if (!plan) throw fail(422, "검사계획을 찾을 수 없습니다.");
  let point = null;
  if (pointId) {
    const [rows] = await connection.execute(`SELECT data FROM entities WHERE kind = 'point' AND id = ?${lock ? " FOR UPDATE" : ""}`, [pointId]);
    point = rows[0] && parse(rows[0].data);
    if (!point) throw fail(422, "연결할 포인트를 찾을 수 없습니다.");
  }
  const relation = assertPlanAcceptsUpload(plan, input.rackId, point);
  if (input.teamId && input.teamId !== relation.teamId) throw fail(409, "계획의 생산팀이 바뀌었습니다. 계획 범위를 다시 확인하세요.");
  if (plan.recordPurpose !== "inspection") throw fail(422, "업무 검사계획을 선택하세요.");
  return relation;
}

// Existing unassigned/unknown records remain editable. Only relation changes
// need scope validation; human review never invents a new location or plan.
export async function validatePhotoEdit(connection, before, after, patch) {
  if ((after.retake ?? false) && !(after.retakeReason ?? "").trim()) throw fail(422, "재촬영 사유를 입력하세요.");
  if (!["planId", "pointId", "rackId"].some((key) => Object.hasOwn(patch, key) && patch[key] !== before[key])) return;
  const ids = [...new Set([before.planId, after.planId].filter(Boolean))].sort();
  const plans = new Map();
  for (const id of ids) plans.set(id, await getPlan(id, connection, { lock: true }));
  let point = null;
  if (after.pointId) {
    const [rows] = await connection.execute("SELECT data FROM entities WHERE kind = 'point' AND id = ? FOR UPDATE", [after.pointId]);
    point = rows[0] && parse(rows[0].data);
  }
  if (after.pointId && !point) throw fail(422, "연결할 포인트를 찾을 수 없습니다.");
  const rackId = after.rackId ?? point?.rackId ?? null;
  if (point && point.rackId !== rackId) throw fail(422, "사진과 포인트의 랙이 다릅니다.");
  if (after.planId) {
    const plan = plans.get(after.planId);
    if (!plan || plan.scopeNeedsReview || !plan.rackIds.includes(rackId)) throw fail(422, "연결할 검사계획의 랙 범위를 확인하세요.");
    if (plan.visibility === "hidden") throw fail(409, "삭제한 계획은 먼저 복원하세요.");
    after.teamId = plan.teamId;
  } else {
    const { locations } = await import("./relations.mjs");
    after.teamId = locations.racks.find((rack) => rack.id === rackId)?.teamId ?? null;
  }
  after.rackId = rackId;
}

export async function validatePointEdit(connection, before, after) {
  if (before.rackId === after.rackId) return;
  const [rows] = await connection.execute(`SELECT kind, data FROM entities WHERE kind IN ('plan', 'inspection', 'maintenance')`);
  const referenced = rows.some((row) => {
    const data = parse(row.data);
    return row.kind !== "plan" ? data.pointId === before.id : (data.pointIds ?? [data.pointId]).includes(before.id);
  });
  const [sessions] = await connection.execute("SELECT id FROM upload_sessions WHERE JSON_UNQUOTE(JSON_EXTRACT(data, '$.pointId')) = ? LIMIT 1", [before.id]);
  if (referenced || sessions.length) throw fail(409, "기존 계획·사진·전송에 연결된 포인트의 랙은 이동할 수 없습니다. 원래 위치 관계를 보존하고 새 포인트를 사용하세요.");
}
