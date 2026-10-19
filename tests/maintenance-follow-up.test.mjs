import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultRepairMethod, followUp, deriveMaintenance, maintenancePage } from '../server/maintenance-view.mjs';
import { photoMaintenanceId } from '../server/maintenance-domain.mjs';
import { maintenanceQuerySchema } from '../server/maintenance-query.mjs';

test('등급별 기본 조치, 사람 등급 우선, 1~2등급 기본 목록 제외', () => {
  assert.deepEqual([1, 2, 3, 4, 5, null].map(defaultRepairMethod), ['none', 'none', 'monitor', 'paint', 'replace', 'undecided']);
  const photos = [1, 2, 3, 4, 5].map((humanGrade) => ({ id: randomUUID(), planId: null, humanGrade, ai: { grade: 5 }, visibility: 'visible' }));
  const snapshot = { photos, saved: [], points: [], plans: [] };
  const original = structuredClone(snapshot);
  const rows = deriveMaintenance(snapshot, { photoBased: true });
  const page = maintenancePage(rows, maintenanceQuerySchema.parse({ targetType: 'photo' }));
  assert.equal(page.total, 3);
  assert.deepEqual(page.methodCounts, { undecided: 0, none: 0, monitor: 1, paint: 1, replace: 1 });
  assert.deepEqual(rows.map((row) => row.repairMethod), ['none', 'none', 'monitor', 'paint', 'replace']);
  assert.deepEqual(snapshot, original, '조회는 저장 기록을 변경하지 않는다');
});

test('자동 조치는 등급 변경에 따라 갱신하고 수동·진행·완료 조치는 보존한다', () => {
  const auto = { repairMethod: 'monitor', repairMethodMode: 'auto', repairStatus: 'planned' };
  assert.equal(followUp(auto, 4).repairMethod, 'paint');
  for (const item of [{ ...auto, repairMethodMode: 'manual' }, { ...auto, repairStatus: 'progress' }, { ...auto, repairStatus: 'done' }]) {
    assert.equal(followUp(item, 5).repairMethod, 'monitor');
    assert.equal(followUp(item, 5).automaticRepairMethod, 'replace');
    assert.equal(followUp(item, 5).methodMismatch, true);
  }
  assert.equal(followUp({ repairMethod: 'undecided', repairMethodMode: 'manual' }, 5).repairMethod, 'undecided', '담당자의 명시 미정도 보존');
  assert.equal(followUp({ repairMethod: 'paint' }, 5).repairMethodMode, 'manual', '기존 담당자 방법 보존');
  assert.equal(followUp({ repairMethod: 'undecided' }, 3).repairMethod, 'monitor', '기존 미정은 자동 분류');
});

test('조치별 집계는 필터와 페이지 전에 계산하고 하향된 수동 기록은 전체 조회로 보존한다', () => {
  const photos = [2, 3, 3, 4, 5].map((humanGrade) => ({ id: randomUUID(), humanGrade, ai: { grade: 5 } }));
  const saved = [{ id: photoMaintenanceId(photos[0].id), repairMethod: 'replace', repairStatus: 'done', inclusionMode: 'include', inWorklist: true }];
  const rows = deriveMaintenance({ photos, saved, points: [], plans: [] }, { photoBased: true });
  const q = (extra) => maintenancePage(rows, maintenanceQuerySchema.parse({ targetType: 'photo', ...extra }));
  const selected = q({ repairMethod: 'monitor', pageSize: 1 });
  assert.equal(selected.total, 2);
  assert.equal(selected.items.length, 1);
  assert.equal(selected.methodCounts.paint, 1);
  assert.equal(selected.methodCounts.replace, 1);
  assert.equal(q({ repairMethod: 'replace' }).total, 1);
  const preserved = q({ inWorklist: 'all' }).items.find((item) => item.id === saved[0].id);
  assert.equal(preserved.inWorklist, false);
  assert.equal(preserved.repairStatus, 'done');
  assert.equal(preserved.repairMethod, 'replace');
  assert.equal(preserved.methodMismatch, true);
});
