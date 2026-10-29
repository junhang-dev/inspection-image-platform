import dotenv from "dotenv";
import mysql from "mysql2/promise";
import { Client } from "minio";
import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { locations } from "../../../server/relations.mjs";
import { photoMaintenanceId } from "../../../server/maintenance-domain.mjs";
import { evidenceFingerprint } from "../../../server/maintenance-view.mjs";
import { loadDatasetContract } from "../../../server/dataset-contract.mjs";
import { runtimeProfile } from "../../../server/runtime-profile.mjs";

dotenv.config({ path: "local/shared-v3-final/api.env", override: true, quiet: true });

const ROOT = "local/shared-v3-final/runtime/demo-data-backups";
const FIXTURE = ROOT + "/curated-business-data.json";
const APPLIED = ROOT + "/curated-business-data-applied.json";
const MARKER_KEY = "__storage_profile.json";
const CORE_PLAN_IDS = new Set([
  "cbf2216b-b4b2-453e-96a6-dda1c6ad6b9a",
  "092b938c-ba9a-4bee-98d1-359775adf74a",
  "782a6788-d7f6-4d62-96eb-077bd8a4b53e",
  "166bda9e-98a0-4853-9f74-c667abfb3967",
]);
const PROFILE = {
  "team-1": { title: "정유1팀 배관 외관 점검", date: "2026-09-21", segments: ["동측 배관 용접부", "지지부 접합부", "곡관 연결부"] },
  "team-2": { title: "정유2팀 파이프랙 부식 점검", date: "2026-09-21", segments: ["상부 배관 플랜지", "지지대 하부", "분기관 접합부"] },
  "team-3": { title: "정유3팀 배관 지지부 점검", date: "2026-09-21", segments: ["수평 배관 용접부", "보온재 이음부", "곡관 외면"] },
  "team-4": { title: "정유4팀 정기 순회 점검", date: "2026-09-21", segments: ["배관 플랜지 주변", "지지대 앵커부", "곡관 접합부"] },
};
const ACTORS = {
  "team-1": "정유1팀 현장 담당자",
  "team-2": "정유2팀 현장 담당자",
  "team-3": "정유3팀 현장 담당자",
  "team-4": "정유4팀 현장 담당자",
};
const parse = (value) => typeof value === "string" ? JSON.parse(value) : value;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) => value && typeof value === "object"
  ? Array.isArray(value)
    ? value.map(stable)
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
  : value;
const stableJson = (value) => JSON.stringify(stable(value));
const teamForRack = (rackId) => locations.racks.find((rack) => rack.id === rackId)?.teamId ?? null;
const timestamp = (date, minutes = 0) => new Date(Date.parse(date + "T00:00:00.000Z") + minutes * 60000).toISOString();
const addDays = (date, days, minutes = 0) => timestamp(new Date(Date.parse(date + "T00:00:00.000Z") + days * 86400000).toISOString().slice(0, 10), minutes);
const ordered = (items) => items.toSorted((a, b) => sha(String(a.sourceId ?? a.id)).localeCompare(sha(String(b.sourceId ?? b.id))));
const asObject = (rows) => rows.map(({ kind, data }) => ({ kind, data: parse(data) }));

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  connectionLimit: 2,
  timezone: "Z",
});
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
const bucket = process.env.MINIO_BUCKET;

async function currentSnapshot() {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET SESSION TRANSACTION READ ONLY");
    await connection.beginTransaction();
    const [entityRows] = await connection.query("SELECT kind, data FROM entities");
    const [historyRows] = await connection.query("SELECT id, entity_id, data FROM history");
    const [sessionRows] = await connection.query("SELECT id, data FROM upload_sessions");
    const [chunkRows] = await connection.query("SELECT upload_id, byte_offset FROM upload_chunks");
    const [profileRows] = await connection.query("SELECT data FROM storage_profile WHERE id=1");
    await connection.commit();
    return {
      entities: asObject(entityRows),
      history: historyRows,
      sessions: sessionRows,
      chunks: chunkRows,
      profile: profileRows[0] ? parse(profileRows[0].data) : null,
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

async function backupManifest() {
  const path = ROOT + "/shared-objects/manifest.json";
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.objectCount !== value.entries.length || value.entries.some((entry) => entry.sha256 !== entry.verifiedSha256))
    throw new Error("백업한 사진 목록의 무결성을 확인할 수 없습니다.");
  return value;
}

async function buildFixture() {
  const contract = await loadDatasetContract(runtimeProfile());
  const backup = await backupManifest();
  const backupByKey = new Map(backup.entries.map((entry) => [entry.objectKey, entry]));
  const snap = await currentSnapshot();
  if (snap.profile?.scope !== "shared") throw new Error("공유 저장소 프로필이 확인되지 않습니다.");

  const plans = snap.entities.filter((row) => row.kind === "plan" && CORE_PLAN_IDS.has(row.data.id));
  const points = snap.entities.filter((row) => row.kind === "point");
  const photos = snap.entities.filter((row) => row.kind === "inspection");
  if (plans.length !== 4) throw new Error("기준 검사계획 4건을 확인할 수 없습니다.");
  const oldPoints = new Map(points.map((row) => [row.data.id, row.data]));
  const contractBySource = new Map(contract.plan.entries.map((entry) => [entry.sourceId, entry]));
  const pointIdMap = new Map();
  const planIdMap = new Map();
  const newPlans = [];
  const newPoints = [];
  const newPhotos = [];
  const photosByTeam = new Map();

  for (const { data: oldPlan } of plans) {
    const oldTeamPoints = oldPlan.pointIds.map((id) => oldPoints.get(id)).filter(Boolean);
    if (oldTeamPoints.length !== 3) throw new Error("기준 계획의 검사 포인트 3개를 확인할 수 없습니다.");
    const teams = [...new Set(oldTeamPoints.map((point) => teamForRack(point.rackId)))];
    if (teams.length !== 1 || !PROFILE[teams[0]]) throw new Error("계획의 생산팀 범위를 확인할 수 없습니다.");
    const teamId = teams[0];
    const setup = PROFILE[teamId];
    const planId = randomUUID();
    planIdMap.set(oldPlan.id, planId);
    const rackOrder = oldTeamPoints.toSorted((a, b) => a.rackId.localeCompare(b.rackId));
    const pointIds = [];
    const rackIds = [];
    for (const [index, oldPoint] of rackOrder.entries()) {
      const pointId = randomUUID();
      pointIdMap.set(oldPoint.id, pointId);
      pointIds.push(pointId);
      rackIds.push(oldPoint.rackId);
      newPoints.push({
        ...oldPoint,
        id: pointId,
        recordPurpose: "inspection",
        equipment: "공정 배관",
        rack: locations.racks.find((rack) => rack.id === oldPoint.rackId).name,
        rackId: oldPoint.rackId,
        name: setup.segments[index],
        locationSource: "virtual",
        locationVerified: false,
        maintenanceSchemaVersion: 1,
        editVersion: 0,
        createdAt: timestamp("2026-09-21", 15 + index),
      });
    }
    newPlans.push({
      ...oldPlan,
      id: planId,
      title: setup.title,
      date: setup.date,
      teamId,
      rackIds,
      pointIds,
      pointId: pointIds[0] ?? null,
      note: "배관 외관과 지지부 상태를 확인하고 후속 조치 대상을 기록합니다.",
      recordPurpose: "inspection",
      status: "done",
      visibility: "visible",
      hiddenAt: null,
      hiddenBy: null,
      hiddenReason: null,
      editVersion: 0,
      createdAt: timestamp(setup.date, 5),
      updatedAt: null,
    });
    photosByTeam.set(teamId, []);
  }

  const selectedPhotos = photos.filter(({ data }) => CORE_PLAN_IDS.has(data.planId));
  if (selectedPhotos.length !== 300) throw new Error("업무 사진 300장을 확인할 수 없습니다.");
  for (const { data: original } of ordered(selectedPhotos)) {
    const oldPlanId = original.planId;
    const plan = newPlans.find((candidate) => candidate.id === planIdMap.get(oldPlanId));
    const oldPoint = oldPoints.get(original.pointId);
    if (!plan || !oldPoint || !original.objectKey || !original.ai || original.status !== "done" || original.recordPurpose !== "inspection")
      throw new Error("사진의 계획·포인트·기존 판독 결과가 완전하지 않습니다.");
    const source = contractBySource.get(original.sourceId);
    if (!source || source.sha256 !== original.sha256) throw new Error("보존된 원본 자료 계약과 사진이 일치하지 않습니다.");
    const backupObject = backupByKey.get(original.objectKey);
    if (!backupObject || backupObject.sha256 !== original.sha256) throw new Error("사진 원본의 검증된 백업이 없습니다.");
    const oldPointIndex = plan.pointIds.length ? newPoints.findIndex((point) => point.id === pointIdMap.get(oldPoint.id)) : -1;
    const newId = randomUUID();
    const teamPhotos = photosByTeam.get(plan.teamId);
    const createdAt = timestamp(plan.date, 30 + (teamPhotos.length * 4));
    const photo = {
      ...original,
      id: newId,
      teamId: plan.teamId,
      rackId: oldPoint.rackId,
      planId: plan.id,
      pointId: oldPointIndex >= 0 ? pointIdMap.get(oldPoint.id) : null,
      recordPurpose: "inspection",
      status: "done",
      error: null,
      visibility: "visible",
      hiddenAt: null,
      hiddenBy: null,
      hiddenReason: null,
      humanGrade: null,
      retake: false,
      retakeReason: "",
      labeling: false,
      editVersion: 0,
      createdAt,
      updatedAt: createdAt,
    };
    newPhotos.push(photo);
    teamPhotos.push(photo);
  }
  for (const [teamId, teamPhotos] of photosByTeam) {
    if (teamPhotos.length !== 75) throw new Error("생산팀별 사진 수가 75장과 다릅니다.");
  }
  const originalPhotoState = new Map(newPhotos.map((photo) => [photo.id, structuredClone(photo)]));

  // These records remain inside the original training split. Validation/test
  // rows retain their AI-only state and are never human-labelled here.
  const byTraining = new Map(newPhotos.map((photo) => [photo.id, contractBySource.get(photo.sourceId)?.canonicalSplit === "train"]));
  const candidates = newPhotos.filter((photo) => byTraining.get(photo.id));
  const correctionsUp = ordered(candidates.filter((photo) => photo.ai.grade === 3)).slice(0, 8);
  const correctionsFromTwo = ordered(candidates.filter((photo) => photo.ai.grade === 2)).slice(0, 4);
  const corrections = [...correctionsUp, ...correctionsFromTwo];
  for (const photo of corrections) {
    photo.humanGrade = photo.ai.grade === 3 ? 4 : 3;
    photo.labeling = true;
  }
  const retakes = ordered(candidates.filter((photo) => [1, 2].includes(photo.ai.grade) && !corrections.includes(photo))).slice(0, 5);
  for (const photo of retakes) {
    photo.retake = true;
    photo.retakeReason = [
      "초점이 흔들려 해당 구간을 다시 촬영합니다.",
      "표면 반사로 상태 확인이 어려워 각도를 바꿔 촬영합니다.",
      "접합부가 충분히 보이지 않아 근접 사진을 추가합니다.",
      "촬영 거리가 멀어 부식 상태를 확인할 수 있도록 재촬영합니다.",
      "가림이 있어 시야를 확보한 뒤 다시 촬영합니다.",
    ][retakes.indexOf(photo)];
  }

  // Twelve records demonstrate that a rack-level inspection can omit a point.
  const optionalPointPhotos = ordered(candidates.filter((photo) => photo.pointId)).slice(0, 12);
  for (const photo of optionalPointPhotos) photo.pointId = null;

  const eligible = newPhotos.filter((photo) => (photo.humanGrade ?? photo.ai.grade) >= 3 && (photo.humanGrade ?? photo.ai.grade) <= 5);
  const trainEligible = ordered(eligible.filter((photo) => byTraining.get(photo.id)));
  const exceptionPhoto = ordered(candidates.filter((photo) => photo.ai.grade === 2 && !corrections.includes(photo)))[0];
  if (!exceptionPhoto || trainEligible.length < 80) throw new Error("보수 상태를 다양하게 구성할 원본 자료가 부족합니다.");
  const targetCounts = [38, 24, 16, trainEligible.length - 78];
  if (targetCounts[3] < 1) throw new Error("보수 상태 배분을 확인하세요.");
  const statuses = ["review", "planned", "progress", "done"];
  const maintenance = [];
  const maintenanceHistory = [];
  const statusPhotoIds = new Set();

  const addEvent = (entityId, action, before, after, actor, reason, at) => {
    const id = randomUUID();
    maintenanceHistory.push({ id, entityId, data: { id, entityId, action, before, after, actor, reason, at }, at });
  };
  const addMaintenance = (photo, finalStatus, ta, index, inclusionMode = "auto") => {
    const id = photoMaintenanceId(photo.id);
    const planned = finalStatus !== "review";
    const item = {
      id,
      planId: photo.planId,
      pointId: null,
      targetType: "photo",
      targetId: photo.id,
      sourceInspectionId: photo.id,
      photoIds: [photo.id],
      repairStatus: finalStatus,
      repairMethod: planned ? (index % 4 === 0 ? "replace" : "paint") : "undecided",
      inWorklist: true,
      ta,
      inclusionMode,
      visibility: "visible",
      recordPurpose: "inspection",
      editVersion: finalStatus === "review" ? 0 : ({ planned: 1, progress: 2, done: 3 }[finalStatus]),
      createdAt: addDays("2026-09-21", 1 + (index % 3), 9 * 60 + (index % 60)),
      updatedAt: null,
    };
    if (finalStatus === "done") item.reviewedEvidence = { [photo.id]: evidenceFingerprint(photo) };
    maintenance.push(item);
    const actor = ACTORS[photo.teamId];
    const initial = { ...item, repairStatus: "review", repairMethod: "undecided", ta: false, editVersion: 0 };
    delete initial.reviewedEvidence;
    addEvent(id, "등록", null, initial, actor, "판독 결과 확인 후 보수 검토 목록에 등록", item.createdAt);
    let before = initial;
    const path = finalStatus === "review" ? [] : finalStatus === "planned" ? ["planned"] : finalStatus === "progress" ? ["planned", "progress"] : ["planned", "progress", "done"];
    for (const state of path) {
      const version = before.editVersion + 1;
      const at = addDays("2026-09-21", 3 + (index % 6) + version, 8 * 60 + (index % 90));
      const after = {
        ...before,
        repairStatus: state,
        repairMethod: state === "planned" || before.repairMethod !== "undecided" ? item.repairMethod : before.repairMethod,
        ta: state === "planned" ? ta : before.ta,
        editVersion: version,
        updatedAt: at,
        ...(state === "done" ? { reviewedEvidence: { [photo.id]: evidenceFingerprint(photo) } } : {}),
      };
      const why = state === "planned" ? "보수 방법과 작업 일정을 지정" : state === "progress" ? "현장 보수 작업 착수" : "현장 보수 작업 완료 확인";
      addEvent(id, "수정", before, after, actor, why, at);
      before = after;
    }
    Object.assign(item, before, { id, planId: photo.planId, pointId: null, targetType: "photo", targetId: photo.id, sourceInspectionId: photo.id, photoIds: [photo.id], inWorklist: true, inclusionMode, visibility: "visible", recordPurpose: "inspection" });
    statusPhotoIds.add(photo.id);
  };
  let cursor = 0;
  for (const [stateIndex, count] of targetCounts.entries()) {
    for (const photo of trainEligible.slice(cursor, cursor + count)) {
      const state = statuses[stateIndex];
      const ta = state !== "review" && (maintenance.length % 4 === 0);
      addMaintenance(photo, state, ta, maintenance.length);
    }
    cursor += count;
  }
  addMaintenance(exceptionPhoto, "review", false, maintenance.length, "include");

  const photoHistory = [];
  const registerHistory = (kind, item, actor, reason) => {
    const id = randomUUID();
    photoHistory.push({ id, entityId: item.id, data: { id, entityId: item.id, action: "등록", before: null, after: item, actor, reason, at: item.createdAt }, at: item.createdAt });
  };
  const eventFor = (entityId, before, after, actor, reason, at) => {
    const id = randomUUID();
    photoHistory.push({ id, entityId, data: { id, entityId, action: "수정", before, after, actor, reason, at }, at });
  };
  for (const plan of newPlans) {
    if (plan.status === "done") {
      const before = { ...plan, status: "planned", editVersion: 0, updatedAt: null };
      registerHistory("plan", before, ACTORS[plan.teamId], "정기 점검 계획 등록");
      plan.updatedAt = addDays(plan.date, 4, 15 * 60);
      plan.editVersion = 1;
      eventFor(plan.id, before, plan, ACTORS[plan.teamId], "사진 등록과 판독 확인을 마쳐 계획 완료", plan.updatedAt);
    } else {
      registerHistory("plan", plan, ACTORS[plan.teamId], "정기 점검 계획 등록");
    }
  }
  for (const point of newPoints) registerHistory("point", point, ACTORS[teamForRack(point.rackId)], "점검 포인트 등록");
  for (const photo of newPhotos) {
    const initial = originalPhotoState.get(photo.id);
    registerHistory("inspection", initial, ACTORS[photo.teamId], "정기 점검 사진과 판독 결과 등록");
    let before = initial;
    if (photo.humanGrade !== null || photo.retake) {
      const at = addDays("2026-09-21", 6 + (photo.ai.grade % 3), 10 * 60 + (photo.ai.grade * 7));
      const after = { ...before, humanGrade: photo.humanGrade, retake: photo.retake, retakeReason: photo.retakeReason, editVersion: before.editVersion + 1, updatedAt: at };
      photo.updatedAt = at;
      photo.editVersion = after.editVersion;
      eventFor(photo.id, before, after, ACTORS[photo.teamId], photo.retake ? photo.retakeReason : "현장 확인 결과에 따라 판독 등급을 조정", at);
      before = after;
    }
    if (photo.labeling) {
      const at = addDays("2026-09-21", 10, 11 * 60 + (photo.ai.grade * 4));
      const after = { ...before, labeling: true, editVersion: before.editVersion + 1, updatedAt: at };
      photo.updatedAt = at;
      photo.editVersion = after.editVersion;
      eventFor(photo.id, before, after, ACTORS[photo.teamId], "판독 결과와 현장 검토 차이를 학습 후보로 지정", at);
      before = after;
    }
  }
  const newPlan = {
    id: randomUUID(), title: "정유2팀 10월 배관 점검", date: "2026-10-06", teamId: "team-2",
    rackIds: ["team-2-rack-2"], pointIds: [], pointId: null,
    note: "배관 외관과 지지부 상태를 확인하고 점검 사진을 등록합니다.",
    recordPurpose: "inspection", status: "planned", visibility: "visible", editVersion: 0,
    createdAt: timestamp("2026-10-01", 12 * 60), updatedAt: null,
  };
  newPlans.push(newPlan);
  registerHistory("plan", newPlan, ACTORS[newPlan.teamId], "10월 정기 점검 계획 등록");

  registerHistory("plan", newPlan, ACTORS[newPlan.teamId], "10월 정기 점검 계획 등록");

  const fixture = {
    version: 1,
    preparedAt: new Date().toISOString(),
    source: { planIds: [...CORE_PLAN_IDS], photoCount: selectedPhotos.length },
    storageProfileSha256: sha(stableJson(snap.profile)),
    expectedBefore: {
      entities: snap.entities.length,
      history: snap.history.length,
      sessions: snap.sessions.length,
      chunks: snap.chunks.length,
      storageProfile: snap.profile.scope,
    },
    records: { plans: newPlans, points: newPoints, photos: newPhotos, maintenance },
    history: [...photoHistory, ...maintenanceHistory],
    cleanupKeys: [...new Set(snap.entities.filter((row) => row.kind === "inspection").map((row) => row.data.objectKey).filter(Boolean))],
    newObjectKeys: [...new Set(newPhotos.map((photo) => photo.objectKey))],
    counts: {
      plans: newPlans.length,
      photos: newPhotos.length,
      points: newPoints.length,
      maintenance: maintenance.length,
      labeling: newPhotos.filter((photo) => photo.labeling).length,
      retake: newPhotos.filter((photo) => photo.retake).length,
      noPoint: newPhotos.filter((photo) => !photo.pointId).length,
      eligiblePhotos: eligible.length,
      status: Object.fromEntries(statuses.map((state) => [state, eligible.filter((photo) => (photo.humanGrade ?? photo.ai.grade) >= 3 && statusPhotoIds.has(photo.id) && maintenance.find((item) => item.targetId === photo.id)?.repairStatus === state).length])),
      targetStatuses: Object.fromEntries(statuses.map((state) => [state, maintenance.filter((item) => item.repairStatus === state).length])),
      manualInclusions: maintenance.filter((item) => item.inclusionMode === "include").length,
      ta: maintenance.filter((item) => item.ta).length,
      trainingCorrections: corrections.length,
      splitCounts: Object.fromEntries(["train", "validation", "test"].map((split) => [split, newPhotos.filter((photo) => contractBySource.get(photo.sourceId)?.canonicalSplit === split).length])),
      photosPerTeam: Object.fromEntries([...photosByTeam].map(([teamId, items]) => [teamId, items.length])),
      uniquePhotoHashes: new Set(newPhotos.map((photo) => photo.sha256)).size,
      history: photoHistory.length + maintenanceHistory.length,
    },
  };
  for (const key of fixture.newObjectKeys) {
    if (!backupByKey.has(key)) throw new Error("재구성 자료에 대한 원본 백업이 없습니다.");
  }
  await writeFile(FIXTURE, JSON.stringify(fixture), { mode: 0o600 });
  await chmod(FIXTURE, 0o600);
  console.log(JSON.stringify({ fixture: FIXTURE, counts: fixture.counts, expectedBefore: fixture.expectedBefore, uniqueKeptObjects: fixture.newObjectKeys.length, verifiedBackupObjects: backup.objectCount }));
}

async function applyFixture() {
  const fixture = JSON.parse(await readFile(FIXTURE, "utf8"));
  const snap = await currentSnapshot();
  const currentCounts = { entities: snap.entities.length, history: snap.history.length, sessions: snap.sessions.length, chunks: snap.chunks.length };
  for (const key of Object.keys(currentCounts)) {
    if (currentCounts[key] !== fixture.expectedBefore[key]) throw new Error("저장소가 준비 이후 변경되어 쓰기를 중단했습니다.");
  }
  if (snap.profile?.scope !== "shared" || sha(stableJson(snap.profile)) !== fixture.storageProfileSha256)
    throw new Error("저장소 프로필이 준비 시점과 달라 쓰기를 중단했습니다.");
  const expectedIds = new Map([
    ["plan", fixture.records.plans.map((item) => item.id)],
    ["point", fixture.records.points.map((item) => item.id)],
    ["inspection", fixture.records.photos.map((item) => item.id)],
    ["maintenance", fixture.records.maintenance.map((item) => item.id)],
  ]);
  const connection = await pool.getConnection();
  try {
    await connection.query("SET SESSION TRANSACTION READ WRITE");
    await connection.beginTransaction();
    const [[profile]] = await connection.query("SELECT data FROM storage_profile WHERE id=1 FOR UPDATE");
    if (!profile || sha(stableJson(parse(profile.data))) !== fixture.storageProfileSha256) throw new Error("저장소 프로필을 다시 확인하세요.");
    await connection.query("DELETE FROM history");
    await connection.query("DELETE FROM upload_chunks");
    await connection.query("DELETE FROM upload_sessions");
    await connection.query("DELETE FROM entities");
    const all = [
      ...fixture.records.plans.map((data) => ["plan", data]),
      ...fixture.records.points.map((data) => ["point", data]),
      ...fixture.records.photos.map((data) => ["inspection", data]),
      ...fixture.records.maintenance.map((data) => ["maintenance", data]),
    ];
    for (const [kind, data] of all) await connection.execute(
      "INSERT INTO entities(kind,id,data,created_at) VALUES (?,?,?,?)",
      [kind, data.id, JSON.stringify(data), new Date(data.createdAt)],
    );
    for (const row of fixture.history) await connection.execute(
      "INSERT INTO history(id,entity_id,data,created_at) VALUES (?,?,?,?)",
      [row.id, row.entityId, JSON.stringify(row.data), new Date(row.at)],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
  const [rows] = await pool.query("SELECT kind,id FROM entities");
  const actual = new Map();
  for (const row of rows) actual.set(row.kind, [...(actual.get(row.kind) ?? []), row.id]);
  for (const [kind, ids] of expectedIds) {
    const current = actual.get(kind) ?? [];
    if (current.length !== ids.length || ids.some((id) => !current.includes(id))) throw new Error("새 업무 기록 집합을 확인하지 못했습니다.");
  }
  if ([...actual.keys()].some((kind) => !expectedIds.has(kind))) throw new Error("비업무 기록이 남아 있습니다.");
  const applied = {
    appliedAt: new Date().toISOString(),
    entityIds: Object.fromEntries([...expectedIds].map(([kind, ids]) => [kind, ids])),
    historyCount: fixture.history.length,
    keptObjectKeys: fixture.newObjectKeys,
    removedObjectKeys: fixture.cleanupKeys.filter((key) => !fixture.newObjectKeys.includes(key)),
    expectedCounts: fixture.counts,
  };
  await writeFile(APPLIED, JSON.stringify(applied), { flag: "wx", mode: 0o600 });
  await chmod(APPLIED, 0o600);
  console.log(JSON.stringify({ applied: true, counts: fixture.counts, expectedStorageMarkerPreserved: true }));
}

async function cleanupObjects() {
  const applied = JSON.parse(await readFile(APPLIED, "utf8"));
  const [rows] = await pool.query("SELECT kind,id,data FROM entities");
  const liveIds = new Map();
  const referenced = new Set();
  for (const row of rows) {
    liveIds.set(row.kind, [...(liveIds.get(row.kind) ?? []), row.id]);
    const data = parse(row.data);
    if (row.kind === "inspection" && data.objectKey) referenced.add(data.objectKey);
  }
  for (const [kind, ids] of Object.entries(applied.entityIds)) {
    const current = liveIds.get(kind) ?? [];
    if (current.length !== ids.length || ids.some((id) => !current.includes(id))) throw new Error("현재 DB가 적용된 기록과 달라 객체 정리를 중단했습니다.");
  }
  if (referenced.size !== applied.keptObjectKeys.length || applied.keptObjectKeys.some((key) => !referenced.has(key)))
    throw new Error("사진 저장 키가 DB와 일치하지 않아 객체 정리를 중단했습니다.");
  const backup = JSON.parse(await readFile(ROOT + "/shared-objects/manifest.json", "utf8"));
  const backupKeys = new Set(backup.entries.map((entry) => entry.objectKey));
  const existing = [];
  for await (const object of objects.listObjectsV2(bucket, "", true)) {
    if (object.name && object.name !== MARKER_KEY) existing.push(object.name);
  }
  const toRemove = existing.filter((key) => !referenced.has(key));
  if (toRemove.some((key) => !backupKeys.has(key))) throw new Error("백업되지 않은 저장 객체가 있어 정리를 중단했습니다.");
  if (toRemove.length) {
    const errors = [];
    for (const key of toRemove) {
      try { await objects.removeObject(bucket, key); }
      catch (error) { errors.push({ key, message: String(error?.message ?? error).slice(0, 240) }); }
    }
    if (errors.length) throw new Error(`일부 저장 객체 정리가 끝나지 않았습니다. 백업은 유지했습니다. ${JSON.stringify(errors.slice(0, 8))}`);
  }
  const marker = await objects.statObject(bucket, MARKER_KEY);
  if (!marker) throw new Error("저장소 식별 표시를 확인할 수 없습니다.");
  const after = [];
  for await (const object of objects.listObjectsV2(bucket, "", true)) if (object.name) after.push(object.name);
  if (after.filter((key) => key !== MARKER_KEY).length !== referenced.size || after.some((key) => key !== MARKER_KEY && !referenced.has(key)))
    throw new Error("남은 저장 객체가 새 사진 목록과 일치하지 않습니다.");
  console.log(JSON.stringify({ removedOldObjects: toRemove.length, keptPhotoObjects: referenced.size, markerPreserved: true, allRemainingObjectsReferenced: true }));
}

try {
  const mode = process.argv[2] ?? "prepare";
  if (mode === "prepare") await buildFixture();
  else if (mode === "apply") await applyFixture();
  else if (mode === "cleanup") await cleanupObjects();
  else throw new Error("사용법: prepare | apply | cleanup");
} finally {
  await pool.end();
  objects.destroy?.();
}
