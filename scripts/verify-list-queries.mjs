import assert from 'node:assert/strict';
const base = process.env.VERIFY_API_BASE_URL ?? 'http://127.0.0.1:4100/api';
assert.ok(['http://127.0.0.1:4100/api','http://127.0.0.1:4000/api'].includes(base), '기존 로컬 개발·운영 API의 읽기 전용 검증');
const get = async (path) => { const r=await fetch(base+path);assert.equal(r.status,200,path);return r.json(); };
const health=await get('/health');assert.ok(['local-private','shared'].includes(health.dataScope));
async function collect(path, query) {
  const rows=[];let total;
  for(let page=1;;page++) {
    const data=await get(path+'?'+new URLSearchParams({...query,pageSize:'37',page:String(page)}));
    total??=data.total;assert.equal(data.total,total);assert.equal(data.page,page);rows.push(...data.items);
    if(page===data.pages)break;
  }
  assert.equal(rows.length,total);assert.equal(new Set(rows.map(r=>r.id)).size,total);return rows;
}
const grade = (row) => row.photoGrade ?? row.humanGrade ?? row.ai?.grade ?? null;
function ordered(rows, sort) {
  let previous=sort==='grade_desc'?Infinity:-Infinity;
  for(const row of rows) { const value=grade(row) ?? (sort==='grade_desc'?-Infinity:Infinity); assert.ok(sort==='grade_desc'?value<=previous:value>=previous);previous=value; }
}
const countChecks=[];
for(const [path,scope] of [['/inspections/query',{}],['/maintenance/query',{targetType:'photo',inWorklist:'all'}]]) {
  const ordinary=await collect(path,scope);
  for(const sort of ['grade_desc','grade_asc']) { const rows=await collect(path,{...scope,sort});ordered(rows,sort);assert.deepEqual(rows.map(r=>r.id).sort(),ordinary.map(r=>r.id).sort()); }
  countChecks.push({path,total:ordinary.length});
}
for(const scope of [{},{aiStatus:'done'},{workClassification:'repair'}]) {
  const all=await get('/inspections/query?'+new URLSearchParams({...scope,pageSize:'1'}));
  assert.equal(Object.values(all.gradeCounts).reduce((a,b)=>a+b,0),all.total);
  for(const grade of ['3','5','ungraded']) {
    const filtered=await get('/inspections/query?'+new URLSearchParams({...scope,grade,pageSize:'1'}));
    assert.deepEqual(filtered.gradeCounts,all.gradeCounts);assert.equal(filtered.total,all.gradeCounts[grade]);
  }
}
console.log(JSON.stringify({scope:health.dataScope,readOnly:true,gradeOrdersAcrossPages:true,noMissingOrDuplicateRows:true,gradeCountsIndependentOfGradeAndPage:true,otherFiltersRespected:true,lists:countChecks}));
