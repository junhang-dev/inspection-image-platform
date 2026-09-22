import { z } from "zod";
import { locations, planPointIds } from "./relations.mjs";

export const fail = (status, message, details) =>
  Object.assign(new Error(message), { status, details });
export const auditFields = {
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  actor: z.string().trim().min(1, "수정자를 입력하세요.").max(60),
  reason: z.string().trim().min(1, "변경 사유를 입력하세요.").max(1000),
};
const title = z.string().trim().min(1, "계획 이름을 입력하세요.").max(120);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "올바른 날짜를 선택하세요.",
);
const teamId = z.enum(locations.teams.map((team) => team.id));
const rackIds = z.array(z.enum(locations.racks.map((rack) => rack.id)))
  .min(1, "검사할 랙을 하나 이상 선택하세요.").max(30)
  .transform((ids) => [...new Set(ids)]);
const fields = { title, date, teamId, rackIds, note: z.string().trim().max(1000), pointIds: z.array(z.string().uuid()).max(1000).transform((ids) => [...new Set(ids)]) };
export const createPlanSchema = z.object({ ...fields, note: fields.note.default(""), pointIds: fields.pointIds.default([]) }).strict();
export const patchPlanSchema = z.object({
  ...Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, schema.optional()])),
  status: z.enum(["planned", "done", "cancelled"]).optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
  ...auditFields,
}).strict().refine((input) => Object.keys(input).some((key) => !Object.hasOwn(auditFields, key)), "변경할 내용을 선택하세요.");

export function validatePlanScope(plan) {
  if (!locations.teams.some((team) => team.id === plan.teamId) || !plan.rackIds?.length)
    throw fail(422, "생산팀과 검사할 랙을 선택하세요.");
  if (new Set(plan.rackIds).size !== plan.rackIds.length || plan.rackIds.some((id) => !locations.racks.some((rack) => rack.id === id && rack.teamId === plan.teamId)))
    throw fail(422, "선택한 생산팀에 속한 랙을 중복 없이 선택하세요.");
  return plan;
}

// Compatibility is based only on stored point relations, never names or files.
// Reading an old plan does not rewrite its original record or history.
export function planView(plan, points = []) {
  const pointIds = planPointIds(plan);
  const linked = points.filter((point) => pointIds.includes(point.id));
  const racks = plan.rackIds ?? [...new Set(linked.map((point) => point.rackId).filter(Boolean))];
  const teams = [...new Set(racks.map((id) => locations.racks.find((rack) => rack.id === id)?.teamId).filter(Boolean))];
  const teamId = plan.teamId ?? (teams.length === 1 ? teams[0] : null);
  return { ...plan, pointIds, teamId, rackIds: racks, visibility: plan.visibility ?? "visible", scopeNeedsReview: !teamId || !racks.length || teams.some((id) => id !== teamId) };
}

export function assertPlanAcceptsUpload(plan, rackId, point = null) {
  if (plan.visibility === "hidden" || plan.status !== "planned")
    throw fail(409, "사진을 추가하려면 검사계획을 복원·재개하세요. 받은 파일은 유지되며 같은 전송을 다시 완료할 수 있습니다.");
  if (plan.scopeNeedsReview)
    throw fail(409, "이 기존 계획의 생산팀·랙 범위를 먼저 확인하고 저장하세요.");
  if (!rackId || !plan.rackIds.includes(rackId))
    throw fail(422, "이 검사계획에 포함된 랙을 선택하세요.");
  if (point && point.rackId !== rackId)
    throw fail(422, "선택한 포인트와 사진의 랙이 다릅니다.");
  return { teamId: plan.teamId, rackId };
}

export function scopeImpact(plan, photos, sessions, points) {
  const pointById = new Map(points.map((point) => [point.id, point]));
  const invalid = (item) => {
    const rackId = item.rackId ?? pointById.get(item.pointId)?.rackId;
    return !rackId || !plan.rackIds.includes(rackId) || (item.teamId && item.teamId !== plan.teamId);
  };
  return {
    photos: photos.filter(invalid).length,
    sessions: sessions.filter((session) => ["receiving", "finalizing", "expired"].includes(session.status) && invalid(session)).length,
  };
}
