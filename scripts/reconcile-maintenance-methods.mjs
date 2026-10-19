import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool, decodeEntity, append, insertEntity } from '../server/store.mjs';
import { createMaintenanceItem, maintenanceId, validateMaintenanceItem } from '../server/maintenance-domain.mjs';
import { deriveMaintenance, defaultRepairMethod, evidenceFingerprint } from '../server/maintenance-view.mjs';

// Explicit one-time operation. Default is a read-only preview, never startup migration.
assert.ok(['shared', 'local-private'].includes(process.env.DATA_SCOPE));
const apply = process.argv.includes('--apply');
const folder = resolve(process.argv.find((arg) => arg.startsWith('--backup='))?.slice(9) ?? 'local/maintenance-reconciliation-20261019');
assert.ok(folder.startsWith(resolve('local') + '/'), '백업은 Git 제외 local 경로에만 보존');
const connection = await pool.getConnection();
const actor = '운영 데이터 정리';
const reason = '2026-10-19 사용자 승인: 현재 등급 기준 후속 조치 1차 정합성 정리';
try {
  await connection.beginTransaction();
  const [entities] = await connection.query('SELECT kind,id,data FROM entities ORDER BY kind,id' + (apply ? ' FOR UPDATE' : ''));
  const [history] = await connection.query('SELECT id,entity_id,data FROM history ORDER BY id');
  const [memberships] = await connection.query('SELECT * FROM maintenance_bundle_members ORDER BY maintenance_id');
  const snapshot = { photos: [], saved: [], points: [], plans: [], history: history.map((row) => typeof row.data === 'string' ? JSON.parse(row.data) : row.data) };
  const names = { inspection: 'photos', maintenance: 'saved', point: 'points', plan: 'plans' };
  for (const row of entities) if (names[row.kind]) snapshot[names[row.kind]].push(decodeEntity(row.data, row.kind));
  const savedById = new Map(snapshot.saved.map((item) => [item.id, item]));
  const views = deriveMaintenance(snapshot, { photoBased: true });
  const changes = views.filter((row) => row.recordPurpose === 'inspection' && Number.isInteger(row.photoGrade) && row.photoGrade >= 1 && row.photoGrade <= 5 && row.repairMethod !== defaultRepairMethod(row.photoGrade));
  const proposed = [];
  const at = new Date().toISOString();
  for (const row of changes) {
    const current = savedById.get(row.id);
    const legacy = row.sourcePointId ? savedById.get(maintenanceId(row.planId, row.sourcePointId)) : null;
    const inherited = current ?? legacy;
    const repairMethod = defaultRepairMethod(row.photoGrade);
    const after = current
      ? { ...current, repairMethod, repairMethodMode: 'auto', editVersion: current.editVersion + 1, updatedAt: at }
      : {
          ...createMaintenanceItem({ planId: row.planId, pointId: null, targetType: 'photo', targetId: row.targetId, photoIds: [row.targetId], repairMethod, repairMethodMode: 'auto', repairStatus: row.repairStatus, ta: row.ta, inWorklist: inherited?.inWorklist ?? row.inWorklist, inclusionMode: row.inclusionMode, visibility: row.visibility }, snapshot.photos.filter((photo) => photo.id === row.targetId)),
          sourceInspectionId: row.targetId, recordPurpose: row.recordPurpose, createdAt: at,
          ...(inherited?.reviewedEvidence ? { reviewedEvidence: structuredClone(inherited.reviewedEvidence) } : {}),
        };
    // Method cleanup must not acknowledge new evidence by advancing updatedAt.
    if (row.repairStatus === 'done' && !inherited?.reviewedEvidence) {
      const photo = snapshot.photos.find((photo) => photo.id === row.targetId);
      after.reviewedEvidence = row.newEvidenceCount ? {} : { [photo.id]: evidenceFingerprint(photo) };
    }
    assert.equal(after.repairStatus, row.repairStatus);
    assert.equal(after.ta, row.ta);
    assert.equal(after.inclusionMode, row.inclusionMode);
    assert.equal(after.visibility, row.visibility);
    validateMaintenanceItem(after, snapshot.photos);
    proposed.push({ before: current ?? null, after, photoId: row.targetId, grade: row.photoGrade, previousMethod: row.repairMethod });
  }
  const replacements = new Map(proposed.map(({ after }) => [after.id, after]));
  const saved = [...snapshot.saved.filter((item) => !replacements.has(item.id)), ...replacements.values()];
  const afterViews = deriveMaintenance({ ...snapshot, saved }, { photoBased: true });
  for (const row of changes) {
    const after = afterViews.find((item) => item.id === row.id);
    assert.equal(after.repairMethod, defaultRepairMethod(row.photoGrade));
    for (const field of ['repairStatus', 'ta', 'inWorklist', 'inclusionMode', 'visibility', 'newEvidenceCount']) assert.equal(after[field], row[field], field);
  }
  const summary = { scope: process.env.DATA_SCOPE, apply, photos: snapshot.photos.length, changed: proposed.length, updated: proposed.filter((p) => p.before).length, photoOverrides: proposed.filter((p) => !p.before).length, remainingMismatches: afterViews.filter((row) => row.methodMismatch).length, statusesPreserved: true, taAndMembershipPreserved: true, beforeMethodCounts: {}, afterMethodCounts: {} };
  for (const row of views.filter((row) => row.inWorklist)) summary.beforeMethodCounts[row.repairMethod] = (summary.beforeMethodCounts[row.repairMethod] ?? 0) + 1;
  for (const row of afterViews.filter((row) => row.inWorklist)) summary.afterMethodCounts[row.repairMethod] = (summary.afterMethodCounts[row.repairMethod] ?? 0) + 1;
  if (apply) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    // Exclusive creation prevents overwriting a prior recovery snapshot.
    await writeFile(folder + '/before.local.json', JSON.stringify({ at, scope: process.env.DATA_SCOPE, entities, history, memberships, proposed }, null, 2), { mode: 0o600, flag: 'wx' });
    for (const { before, after } of proposed) {
      if (before) {
        await connection.execute('UPDATE entities SET data=? WHERE kind=? AND id=?', [JSON.stringify(after), 'maintenance', after.id]);
        await append(connection, after.id, '후속 조치 정합성 정리', before, after, actor, reason);
      } else await insertEntity(connection, 'maintenance', after, actor, reason);
    }
    await connection.commit();
    await writeFile(folder + '/result.local.json', JSON.stringify({ at, ...summary }, null, 2), { mode: 0o600 });
  } else await connection.rollback();
  console.log(JSON.stringify(summary));
} catch (error) {
  await connection.rollback().catch(() => {});
  throw error;
} finally {
  connection.release();
  await pool.end();
}
