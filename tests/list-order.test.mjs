import test from 'node:test';
import assert from 'node:assert/strict';
import { compareListRows } from '../src/lib/list-order.mjs';
import { formatDateTime } from '../src/lib/date-time.ts';
import { photoOrder, photoQuerySchema, photoWhere } from '../server/photo-query.mjs';
import { maintenanceQuerySchema } from '../server/maintenance-query.mjs';
import { maintenancePage } from '../server/maintenance-view.mjs';

test('위험 등급 정렬은 미판독을 뒤에 두고 동급은 등록일·ID로 안정 정렬한다', () => {
  const rows = [
    { id: 'a', photoGrade: 3, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'b', photoGrade: null, createdAt: '2026-10-03T00:00:00Z' },
    { id: 'c', photoGrade: 5, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'd', photoGrade: 1, createdAt: '2026-10-01T00:00:00Z' },
    { id: 'e', photoGrade: 5, createdAt: '2026-10-02T00:00:00Z' },
    { id: 'f', photoGrade: 5, createdAt: '2026-10-02T00:00:00Z' },
  ];
  assert.deepEqual([...rows].sort((a,b)=>compareListRows(a,b,'grade_desc')).map(r=>r.id), ['f','e','c','a','d','b']);
  assert.deepEqual([...rows].sort((a,b)=>compareListRows(a,b,'grade_asc')).map(r=>r.id), ['d','a','f','e','c','b']);
  const items = rows.map(row=>({ ...row, targetType:'photo', planId:null, recordPurpose:'inspection', visibility:'visible', inWorklist:true, ta:false, repairMethod:'monitor', repairStatus:'review', planTitle:'계획', pointLabel:'대상' }));
  const page = (number) => maintenancePage(items, maintenanceQuerySchema.parse({targetType:'photo',sort:'grade_desc',pageSize:2,page:number}));
  assert.deepEqual([1,2,3].flatMap(n=>page(n).items.map(r=>r.id)), ['f','e','c','a','d','b']);
  assert.equal(page(2).total, 6);
  assert.equal(page(2).methodCounts.monitor, 6);
});

test('정렬 입력은 허용 목록만 받고 사진 SQL도 사람 등급 우선·미판독 마지막이다', () => {
  for(const schema of [photoQuerySchema, maintenanceQuerySchema]) {
    assert.equal(schema.parse({}).sort,'newest');
    assert.equal(schema.safeParse({sort:'grade_desc; DROP TABLE entities'}).success,false);
  }
  assert.match(photoWhere(photoQuerySchema.parse({grade:'ungraded'})).sql, /CASE WHEN.*IS NULL/);
  assert.match(photoOrder('grade_desc'), /humanGrade.*ai\.grade/);
  assert.match(photoOrder('grade_desc'), /IS NULL ASC.*DESC.*i\.created_at DESC, i\.id DESC/);
  assert.match(photoOrder('grade_asc'), /IS NULL ASC.*ASC.*i\.created_at DESC, i\.id DESC/);
});

test('등록일시는 한국 시각의 실제 날짜·시각을 표시하고 누락값을 만들지 않는다', () => {
  assert.match(formatDateTime('2026-10-18T18:30:00Z'), /2026.*10.*19.*03:30/);
  for(const value of [undefined, null, '', 'invalid']) assert.equal(formatDateTime(value), '—');
});
