import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPlanSchema, validatePlanScope, planView, assertPlanAcceptsUpload, scopeImpact } from "../server/plan-domain.mjs";
import { deriveMaintenance, maintenancePage, evidenceFingerprint } from "../server/maintenance-view.mjs";
import { createMaintenanceItem, photoMaintenanceId, maintenanceId } from "../server/maintenance-domain.mjs";
import { roiCoordinates, currentAnalysis } from "../server/roi-domain.mjs";
import { maintenanceQuerySchema } from "../server/maintenance-query.mjs";

const planId = randomUUID(), pointId = randomUUID();
const plan = { id: planId, title: "합성 계약 검증", date: "2026-09-22", teamId: "team-1", rackIds: ["team-1-rack-1", "team-1-rack-30"], pointIds: [], status: "planned", visibility: "visible", recordPurpose: "inspection" };
const photo = (patch = {}) => ({ id: randomUUID(), planId, pointId: null, rackId: "team-1-rack-30", teamId: "team-1", recordPurpose: "inspection", visibility: "visible", ai: { grade: 5, model_version: "synthetic" }, humanGrade: null, createdAt: "2026-09-22T00:00:00Z", ...patch });
const views = (photos, saved = [], extra = {}) => deriveMaintenance({ photos, saved, points: [{ id: pointId, rackId: "team-1-rack-1", recordPurpose: "inspection" }], plans: [plan], ...extra });
const query = (rows, extra = {}) => maintenancePage(rows, maintenanceQuerySchema.parse(extra));

test("v3 계획은 한 팀의 랙1~30을 포인트 없이 저장하고 중복 랙을 제거한다", () => {
  const parsed = createPlanSchema.parse({ title: plan.title, date: plan.date, teamId: plan.teamId, rackIds: ["team-1-rack-30", "team-1-rack-30"] });
  assert.deepEqual(parsed.pointIds, []); assert.deepEqual(parsed.rackIds, ["team-1-rack-30"]); validatePlanScope(parsed);
  assert.throws(() => validatePlanScope({ ...parsed, rackIds: ["team-2-rack-30"] }), { status: 422 });
  assert.equal(createPlanSchema.safeParse({ ...parsed, date: "2026-02-30" }).success, false);
});
test("기존 계획 범위는 관계로만 호환 조회하고 모르는 팀을 만들어내지 않는다", () => {
  const old = { id: planId, pointId, title: "old" };
  const original = structuredClone(old);
  assert.equal(planView(old, [{ id: pointId, rackId: "team-2-rack-3" }]).teamId, "team-2");
  assert.equal(planView(old, []).scopeNeedsReview, true);
  assert.deepEqual(old, original);
});
test("닫힘/삭제 계획과 명시되지 않은 랙은 신규 전송을 막고 포인트는 옵션이다", () => {
  assert.deepEqual(assertPlanAcceptsUpload(plan, "team-1-rack-30"), { teamId: "team-1", rackId: "team-1-rack-30" });
  for (const status of ["done", "cancelled"]) assert.throws(() => assertPlanAcceptsUpload({ ...plan, status }, "team-1-rack-1"), { status: 409 });
  assert.throws(() => assertPlanAcceptsUpload({ ...plan, visibility: "hidden" }, "team-1-rack-1"), { status: 409 });
  assert.throws(() => assertPlanAcceptsUpload(plan, null), { status: 422 });
});
test("범위 축소는 숨긴 사진과 재시작 가능한 세션도 보존한다", () => {
  const narrowed = { ...plan, rackIds: ["team-1-rack-1"] };
  assert.deepEqual(scopeImpact(narrowed, [photo({ visibility: "hidden" })], ["receiving", "finalizing", "expired", "completed"].map((status) => ({ rackId: "team-1-rack-30", status })), []), { photos: 1, sessions: 3 });
});
test("포인트 없는 사진은 같은 계획·랙·바이트라도 서로 다른 보수 대상이다", () => {
  const a = photo(), b = photo(); const items = views([a, b]);
  assert.equal(new Set(items.map((item) => item.id)).size, 2); assert.equal(items[0].id, photoMaintenanceId(a.id));
  assert.equal(query(items).total, 2);
  const saved = createMaintenanceItem({ planId, pointId: null, targetType: "photo", targetId: a.id, photoIds: [a.id], inclusionMode: "auto" }, [a]);
  assert.equal(saved.id, items[0].id);
});
test("사람 등급이 우선이고 하향/재상향·수동 제외에도 업무 상태와 ID가 유지된다", () => {
  const a = photo(); const saved = { id: photoMaintenanceId(a.id), planId, pointId: null, targetType: "photo", targetId: a.id, photoIds: [a.id], repairStatus: "done", repairMethod: "paint", ta: true, editVersion: 2, inWorklist: false, inclusionMode: "auto", recordPurpose: "inspection", reviewedEvidence: { [a.id]: evidenceFingerprint(a) } };
  const original = structuredClone(saved);
  assert.equal(query(views([{ ...a, humanGrade: 2 }], [saved])).total, 0);
  const up = views([{ ...a, humanGrade: 4 }], [saved])[0];
  assert.equal(up.id, saved.id); assert.equal(up.repairStatus, "done"); assert.equal(up.newEvidenceCount, 1); assert.equal(up.ta, true);
  assert.equal(query(views([a], [{ ...saved, inclusionMode: "exclude" }])).total, 0);
  assert.deepEqual(saved, original);
});
test("기존 plan+point ID/완료를 유지하고 나중에 들어온 사진은 새 근거로 남는다", () => {
  const a = photo({ pointId, rackId: "team-1-rack-1" }), b = photo({ pointId, rackId: "team-1-rack-1" });
  const saved = { id: maintenanceId(planId, pointId), planId, pointId, photoIds: [a.id], repairStatus: "done", repairMethod: "replace", inWorklist: true, ta: false, editVersion: 0, inclusionMode: "auto", reviewedEvidence: { [a.id]: evidenceFingerprint(a) } };
  const result = views([a, b], [saved])[0]; assert.equal(result.id, saved.id); assert.equal(result.newEvidenceCount, 1);
  assert.equal(views([a, b], [{ ...saved, ta: true }])[0].newEvidenceCount, 1);
});
test("검증 목적의 5등급은 업무 2등급의 자동 보수 판정에 섞이지 않는다", () => {
  const work = photo({ pointId, humanGrade: 2 }), verification = photo({ pointId, recordPurpose: "verification" });
  for (const photos of [[work, verification], [verification, work]]) {
    const result = views(photos); assert.equal(query(result).total, 0); assert.equal(result[0].recordPurpose, "inspection"); assert.equal(result[0].candidatePhotoIds.length, 1);
  }
});
test("필터와 전체 건수는 페이지 전에 적용하고 기본 전체는 TA 여부와 무관하다", () => {
  const items = views([photo(), photo(), photo({ rackId: "team-1-rack-1" }), photo({ humanGrade: 1 })]);
  assert.equal(query(items, { rackId: "team-1-rack-30", pageSize: 1 }).total, 2);
  assert.equal(query(items, { rackId: "team-1-rack-30", page: 2, pageSize: 1 }).items.length, 1);
  assert.equal(query(items, { ta: "true" }).total, 0);
  assert.equal(query(items).total, 3);
});
test("포인트 없는 검증 사진도 자체 목적을 유지하며 업무 보수에 포함되지 않는다", () => {
  const item = views([photo({ recordPurpose: "verification" })])[0];
  assert.equal(item.recordPurpose, "verification"); assert.equal(item.automaticEligible, true);
  assert.equal(query([item]).total, 0); assert.equal(query([item], { recordPurpose: "verification" }).total, 1);
});
test("ROI는 원본 범위를 벗어나거나 영면적이면 거절하며 늦은 결과는 현재 영역을 대체하지 않는다", () => {
  for (const value of [{ x: 0, y: 0, w: 0, h: 1 }, { x: 0.5, y: 0, w: 0.6, h: 1 }, { x: NaN, y: 0, w: 1, h: 1 }]) assert.equal(roiCoordinates.safeParse(value).success, false);
  const image = { id: randomUUID(), sha256: "x", visibility: "visible" }, roi = { id: "roi", photoId: null, originalSha256: "x", editVersion: 2, visibility: "visible" };
  roi.photoId = image.id;
  const job = { photoId: image.id, originalSha256: "x", roiId: "roi", roiVersion: 2 };
  assert.equal(currentAnalysis(job, image, roi), true);
  assert.equal(currentAnalysis(job, image, { ...roi, editVersion: 3 }), false);
  assert.equal(currentAnalysis(job, { ...image, visibility: "hidden" }, roi), false);
  assert.equal(currentAnalysis(job, { ...image, id: "other-photo" }, roi), false);
});
