import { createHash } from "node:crypto";
import { locations } from "./relations.mjs";
import { maintenanceId, photoMaintenanceId } from "./maintenance-domain.mjs";

export const effectiveGrade = (photo) => photo.humanGrade ?? photo.ai?.grade ?? null;
export const repairNeeded = (photo) => effectiveGrade(photo) >= 3 && effectiveGrade(photo) <= 5 && photo.visibility !== "hidden";
export const evidenceFingerprint = (photo) => createHash("sha256").update(JSON.stringify([photo.id, photo.humanGrade ?? null, photo.ai?.grade ?? null, photo.ai?.model_version ?? null, photo.ai?.preprocessing_version ?? null, photo.ai?.checkpoint_sha256 ?? null])).digest("hex");
export const photoTarget = (photo) => photo.pointId
  ? { id: maintenanceId(photo.planId ?? null, photo.pointId), planId: photo.planId ?? null, pointId: photo.pointId, targetType: "point", targetId: photo.pointId }
  : { id: photoMaintenanceId(photo.id), planId: photo.planId ?? null, pointId: null, targetType: "photo", targetId: photo.id };

export function legacyInclusionMode(item, history = []) {
  if (item.inclusionMode) return item.inclusionMode;
  if (item.inWorklist) return "include";
  // The old default false was not an exclusion. Preserve an actual removal.
  return history.some((event) => event.entityId === item.id && event.before?.inWorklist === true && event.after?.inWorklist === false) ? "exclude" : "auto";
}

// One metadata snapshot supplies membership, totals, pagination and details.
// Reading automatic candidates never overwrites saved decisions or history.
export function deriveMaintenance({ photos, saved, points, plans, history = [] }) {
  const pointById = new Map(points.map((point) => [point.id, point]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const groups = new Map();
  for (const photo of photos) {
    const target = photoTarget(photo);
    if (!groups.has(target.id)) groups.set(target.id, { ...target, photos: [] });
    groups.get(target.id).photos.push(photo);
  }
  for (const item of saved) {
    if (!groups.has(item.id)) groups.set(item.id, { id: item.id, planId: item.planId ?? null, pointId: item.pointId ?? null, targetType: item.targetType ?? "point", targetId: item.targetId ?? item.pointId, photos: [] });
    groups.get(item.id).saved = item;
  }
  return [...groups.values()].map((group) => {
    const item = group.saved;
    const point = pointById.get(group.pointId);
    const plan = planById.get(group.planId);
    const source = group.targetType === "photo" ? group.photos[0] : null;
    const purpose = item?.recordPurpose ?? source?.recordPurpose ?? plan?.recordPurpose ?? point?.recordPurpose ?? "inspection";
    const currentPhotos = group.photos.filter((photo) => photo.visibility !== "hidden" && (photo.recordPurpose ?? "inspection") === purpose);
    const eligible = currentPhotos.filter(repairNeeded);
    const mode = item ? legacyInclusionMode(item, history) : "auto";
    const visibility = item?.visibility ?? "visible";
    const included = visibility === "visible" && (mode === "include" || (mode === "auto" && eligible.length > 0));
    const rackId = source?.rackId ?? point?.rackId ?? null;
    const rack = locations.racks.find((rack) => rack.id === rackId);
    const reviewed = item?.reviewedEvidence;
    const newEvidenceCount = item?.repairStatus === "done" ? eligible.filter((photo) => reviewed
      ? reviewed[photo.id] !== evidenceFingerprint(photo)
      : Date.parse(photo.updatedAt ?? photo.createdAt) > Date.parse(item.updatedAt ?? item.createdAt)).length : 0;
    return {
      id: group.id, planId: group.planId, pointId: group.pointId,
      photoIds: [], repairStatus: eligible.length ? "review" : "none", repairMethod: "undecided", ta: false, editVersion: 0,
      recordPurpose: group.targetType === "photo" ? source?.recordPurpose ?? "inspection" : purpose,
      createdAt: group.photos[0]?.createdAt,
      ...item,
      targetType: group.targetType, targetId: group.targetId,
      persisted: Boolean(item), visibility, inclusionMode: mode,
      inWorklist: included, automaticEligible: eligible.length > 0,
      inclusionSource: mode === "include" ? "manual" : mode === "exclude" ? "excluded" : "automatic",
      rackId, teamId: source?.teamId ?? rack?.teamId ?? null,
      planTitle: plan?.title ?? "계획 미지정",
      pointLabel: source?.name ?? ([point?.equipment, rack?.name ?? point?.rack, point?.name].filter(Boolean).join(" · ") || "위치 미확인"),
      candidatePhotoIds: currentPhotos.map((photo) => photo.id),
      automaticPhotoIds: eligible.map((photo) => photo.id),
      evidenceVersions: Object.fromEntries(eligible.map((photo) => [photo.id, evidenceFingerprint(photo)])),
      photoCount: currentPhotos.length,
      effectiveGrade: eligible.length ? Math.max(...eligible.map(effectiveGrade)) : currentPhotos.length ? Math.max(...currentPhotos.map((photo) => effectiveGrade(photo) ?? 0)) || null : null,
      newEvidenceCount,
    };
  });
}

export function maintenancePage(items, query) {
  const filtered = items.filter((item) =>
    (query.planId === "all" || item.planId === (query.planId === "unassigned" ? null : query.planId)) &&
    (query.pointId === "all" || item.pointId === query.pointId) &&
    (query.recordPurpose === "all" || item.recordPurpose === query.recordPurpose) &&
    (query.visibility === "all" || item.visibility === query.visibility) &&
    (query.inWorklist === "all" || item.inWorklist) &&
    (query.ta === "all" || item.ta === (query.ta === "true")) &&
    (query.repairStatus === "all" || item.repairStatus === query.repairStatus) &&
    (query.repairMethod === "all" || item.repairMethod === query.repairMethod) &&
    (query.teamId === "all" || item.teamId === query.teamId) &&
    (query.rackId === "all" || item.rackId === query.rackId) &&
    (!query.search || `${item.planTitle} ${item.pointLabel}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))
  ).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || b.id.localeCompare(a.id));
  const total = filtered.length, pages = Math.max(1, Math.ceil(total / query.pageSize)), page = Math.min(query.page, pages);
  const pointSummaries = {};
  for (const item of filtered) {
    if (!item.pointId) continue;
    const row = pointSummaries[item.pointId] ??= { total: 0, registered: 0, none: 0, review: 0, planned: 0, progress: 0, done: 0 };
    row.total++; if (item.inWorklist) row.registered++; row[item.repairStatus]++;
  }
  return { items: filtered.slice((page - 1) * query.pageSize, page * query.pageSize), total, pages, page, pageSize: query.pageSize, pointSummaries, summary: { automatic: filtered.filter((item) => item.automaticEligible).length, newEvidence: filtered.filter((item) => item.newEvidenceCount > 0).length }, scope: query };
}
