import { readFile, writeFile, chmod } from 'node:fs/promises';
import { parse } from 'dotenv';
import mysql from 'mysql2/promise';
import { Client } from 'minio';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const folder = new URL('./', import.meta.url);
await chmod(folder,0o700);
const env = parse(await readFile(new URL('../../../api.env', import.meta.url)));
const db = await mysql.createConnection({host:env.MYSQL_HOST ?? '127.0.0.1',port:Number(env.MYSQL_PORT??3307),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,dateStrings:true});
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
 const [names] = await db.query('SHOW TABLES');
 const tables={};
 for(const value of names){const name=Object.values(value)[0];assert.match(name,/^[a-z_]+$/);const [rows]=await db.query(`SELECT * FROM \`${name}\``);tables[name]=rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
 const entities=tables.entities.map(row=>typeof row.data==='string'?JSON.parse(row.data):row.data);
 const counts={};for(const row of tables.entities)counts[row.kind]=(counts[row.kind]??0)+1;
 const active=entities.filter(row=>['pending','processing'].includes(row.status) && Object.hasOwn(row,'objectKey'));
 const uploads=tables.upload_sessions?.filter(row=>['receiving','finalizing'].includes(row.status))??[];
 assert.equal(active.length,0,'진행 중인 판독이 없어야 전환');assert.equal(uploads.length,0,'진행 중인 업로드가 없어야 전환');
 const objects=new Client({endPoint:env.MINIO_ENDPOINT??'127.0.0.1',port:Number(env.MINIO_PORT??9000),useSSL:false,accessKey:env.MINIO_ACCESS_KEY,secretKey:env.MINIO_SECRET_KEY});
 const inventory=[];for await(const entry of objects.listObjectsV2(env.MINIO_BUCKET,'',true))inventory.push({name:entry.name,size:entry.size,etag:entry.etag});inventory.sort((a,b)=>a.name.localeCompare(b.name));
 const snapshot={at:new Date().toISOString(),tables,objects:inventory};
 const summary={counts,history:tables.history.length,bundleMembers:tables.maintenance_bundle_members.length,tableHashes:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,{count:rows.length,sha256:hash(rows)}])),objectCount:inventory.length,objectHash:hash(inventory),active:active.length,uploads:uploads.length};
 const phase=process.argv[2]??'before';
 if(phase==='after'){const before=JSON.parse(await readFile(new URL('before-summary.local.json',folder)));assert.deepEqual(summary,before,'운영 DB 및 객체 메타데이터 전후 일치');}
 await writeFile(new URL(`${phase}.local.json`,folder),JSON.stringify(snapshot),{mode:0o600});await writeFile(new URL(`${phase}-summary.local.json`,folder),JSON.stringify(summary,null,2),{mode:0o600});
 console.log(JSON.stringify({phase,...summary}));
}finally{await db.end();}
