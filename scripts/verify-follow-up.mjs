import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { pool, insert, get, events, list, update } from '../server/store.mjs';
import { photoMaintenanceId } from '../server/maintenance-domain.mjs';

assert.equal(process.env.DATA_SCOPE, 'local-private', '개발 전용 저장소에서만 실행');
assert.equal(process.env.API_PORT, '4100');
const base = 'http://127.0.0.1:4100/api';
const health = await (await fetch(base + '/health')).json();
assert.equal(health.dataScope, 'local-private');
const created = [];
let passed = false;
const audit = { actor: '자동 조치 검증', reason: '합성 개발 검증' };
const digest = (rows) => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const snapshot = async () => {
  const [rows] = await pool.query('SELECT kind,id,data FROM entities ORDER BY kind,id');
  const [history] = await pool.query('SELECT id,entity_id,data FROM history ORDER BY id');
  return { rows, history };
};
const before = await snapshot();
const http = async (path, method = 'GET', body) => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};
const target = (id) => http('/maintenance/target?photoId=' + id).then((r) => r.body);
const save = (photo, patch, expectedVersion = null) => http(expectedVersion === null ? '/maintenance' : '/maintenance/' + photoMaintenanceId(photo.id), expectedVersion === null ? 'POST' : 'PATCH', { ...audit, ...patch, expectedVersion, ...(expectedVersion === null ? { planId: photo.planId, pointId: null, targetType: 'photo', targetId: photo.id } : {}) });
try {
  const [source] = await list('inspection', { recordPurpose: 'all' });
  assert.ok(source?.objectKey, '기존 개발 객체를 읽기 전용으로 재사용');
  const plan = await insert('plan', { title: '후속 조치 합성 검증', date: '2026-10-19', teamId: source.teamId ?? 'team-1', rackIds: [source.rackId ?? 'team-1-rack-1'], pointIds: [], status: 'planned', visibility: 'visible', recordPurpose: 'inspection' }, audit.actor, audit.reason);
  created.push(plan.id);
  const point = await insert('point', { name: '합성 후속 조치 포인트', rackId: plan.rackIds[0], recordPurpose: 'inspection', maintenanceMigrationVersion: 1 }, audit.actor, audit.reason);
  created.push(point.id);
  const photos = [];
  for (const grade of [1, 2, 3, 4, 5]) {
    const photo = await insert('inspection', { name: `후속조치-합성-${grade}등급.jpg`, planId: plan.id, pointId: grade === 4 ? point.id : null, teamId: plan.teamId, rackId: plan.rackIds[0], objectKey: source.objectKey, sha256: source.sha256, mime: source.mime, size: source.size, status: 'done', humanGrade: grade, ai: { grade: 5, model_version: 'synthetic-follow-up-check' }, visibility: 'visible', recordPurpose: 'inspection', retake: false }, audit.actor, audit.reason);
    photos.push(photo); created.push(photo.id, photoMaintenanceId(photo.id));
  }
  const q = async (extra = {}) => (await http('/maintenance/query?' + new URLSearchParams({ targetType: 'photo', planId: plan.id, ...extra }))).body;
  const initial = await q();
  assert.equal(initial.total, 3);
  assert.deepEqual(initial.methodCounts, { undecided: 0, none: 0, monitor: 1, paint: 1, replace: 1 });
  assert.equal((await q({ repairMethod: 'monitor', pageSize: '1' })).total, 1);
  const photo = photos[2];
  const missingReason = await save(photo, { repairMethod: 'paint', repairMethodMode: 'manual', reason: '' });
  assert.equal(missingReason.status, 422);
  let saved = await save(photo, { repairMethod: 'paint', repairMethodMode: 'manual', reason: '담당자 현장 확인 후 도장교체로 변경', repairStatus: 'planned', ta: true, inclusionMode: 'include' });
  assert.equal(saved.status, 201);
  assert.equal((await target(photo.id)).repairMethod, 'paint');
  assert.ok((await events(saved.body.id)).some((event) => event.reason === '담당자 현장 확인 후 도장교체로 변경'));
  assert.equal((await get('maintenance', saved.body.id)).repairMethodMode, 'manual');
  await update('inspection', photo.id, { humanGrade: 5 }, audit.actor, audit.reason, { expectedVersion: 0 });
  assert.equal((await target(photo.id)).repairMethod, 'paint');
  assert.equal((await target(photo.id)).methodMismatch, true);
  saved = await save(photo, { repairStatus: 'done' }, saved.body.editVersion);
  assert.equal(saved.status, 200);
  assert.equal((await save(photo, { repairStatus: 'review' }, 0)).status, 409);
  await update('inspection', photo.id, { humanGrade: 2 }, audit.actor, audit.reason, { expectedVersion: 1 });
  assert.equal((await q()).total, 2);
  assert.equal((await target(photo.id)).repairStatus, 'done');
  assert.equal((await target(photo.id)).repairMethod, 'paint');
  assert.equal((await q({ inWorklist: 'all' })).total, 5);
  await update('inspection', photo.id, { humanGrade: 3 }, audit.actor, audit.reason, { expectedVersion: 2 });
  const autoPhoto = photos[3];
  let automatic = await save(autoPhoto, { repairMethod: 'paint', repairMethodMode: 'auto', repairStatus: 'planned', ta: true });
  assert.equal(automatic.status, 201);
  assert.equal((await http('/maintenance/' + automatic.body.id)).body.repairMethod, 'paint', '포인트 연결 사진도 ID 재조회는 사진별 조치');
  await update('inspection', autoPhoto.id, { humanGrade: 5 }, audit.actor, audit.reason, { expectedVersion: 0 });
  assert.equal((await target(autoPhoto.id)).repairMethod, 'replace');
  automatic = await save(autoPhoto, { repairMethodMode: 'auto', repairStatus: 'progress' }, automatic.body.editVersion);
  assert.equal(automatic.status, 200);
  await update('inspection', autoPhoto.id, { humanGrade: 4 }, audit.actor, audit.reason, { expectedVersion: 1 });
  assert.equal((await target(autoPhoto.id)).repairMethod, 'replace');
  assert.equal((await target(autoPhoto.id)).methodMismatch, true);
  await update('inspection', photo.id, { humanGrade: 2 }, audit.actor, audit.reason, { expectedVersion: 3 });
  const rejectedBundle = await http('/maintenance/bundles', 'POST', { name: '등급 하향 대상 거부 검증', maintenanceIds: [saved.body.id, automatic.body.id], expectedVersions: { [saved.body.id]: saved.body.editVersion, [automatic.body.id]: automatic.body.editVersion }, ...audit });
  assert.equal(rejectedBundle.status, 409, 'TA 저장도 1~2등급 제외 기준 적용');
  assert.match(rejectedBundle.body.error, /TA 보수 대상/);
  await update('inspection', photo.id, { humanGrade: 3 }, audit.actor, audit.reason, { expectedVersion: 4 });
  const after = await snapshot();
  const newIds = new Set(created);
  assert.equal(digest(before.rows), digest(after.rows.filter((row) => !newIds.has(row.id))));
  assert.equal(digest(before.history), digest(after.history.filter((row) => !newIds.has(row.entity_id))));
  await mkdir('output/follow-up', { recursive: true });
  await writeFile('output/follow-up/development-fixture.local.json', JSON.stringify({ created, planId: plan.id, photos: photos.map(({ id, name }) => ({ id, name })) }, null, 2));
  passed = true;
  console.log(JSON.stringify({ passed: true, scope: health.dataScope, originalRecordsPreserved: before.rows.length, originalHistoryPreserved: before.history.length, checks: ['grade-mapping', 'reason-required-422', 'manual-save-history', 'manual-preserved-on-grade-change', 'downgrade-excludes-preserves-history', 'CAS-409', 'automatic-refresh', 'progress-freezes-method', 'original-entities-history-unchanged', 'linked-photo-ID-readback', 'TA-downgrade-rejected'], keptForBrowser: process.argv.includes('--keep') }));
} finally {
  if (!passed || !process.argv.includes('--keep')) for (const id of created) {
    await pool.execute('DELETE FROM history WHERE entity_id = ?', [id]);
    await pool.execute('DELETE FROM entities WHERE id = ?', [id]);
  }
  await pool.end();
}
