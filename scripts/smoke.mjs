import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const base = process.env.TEST_API_URL || "http://127.0.0.1:4000/api";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path, init) => {
  const res = await fetch(base + path, init);
  const data = await res.json();
  assert.ok(res.ok, JSON.stringify(data));
  return data;
};
const point = await json("/points", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    equipment: "DEMO-101",
    rack: "2",
    name: "시연 검사 포인트",
  }),
});
const sources = [
  "demo-01.jpg",
  "demo-02.png",
  "demo-03.jpg",
  "demo-04.jpg",
  "demo-05.jpg",
];
const payload = new FormData();
payload.append("pointId", point.id);
const sourceHashes = [];
for (let i = 0; i < 10; i++) {
  const name = sources[i % 5];
  const bytes = await readFile(`image/demo/${name}`);
  sourceHashes.push(sha(bytes));
  payload.append(
    "images",
    new Blob([bytes], {
      type: name.endsWith("png") ? "image/png" : "image/jpeg",
    }),
    name,
  );
}
const started = performance.now();
const uploaded = await json("/inspections", { method: "POST", body: payload });
const uploadSeconds = (performance.now() - started) / 1000;
assert.equal(uploaded.length, 10);
const hashes = [];
for (const [index, photo] of uploaded.entries()) {
  const result = await fetch(`${base}/inspections/${photo.id}/image`);
  assert.ok(result.ok);
  const downloadedHash = sha(Buffer.from(await result.arrayBuffer()));
  assert.equal(downloadedHash, sourceHashes[index]);
  assert.equal(photo.sha256, downloadedHash);
  hashes.push({
    id: photo.id,
    pointId: photo.pointId,
    objectKey: photo.objectKey,
    sha256: downloadedHash,
    source: sources[index % 5],
  });
}
const deadline = Date.now() + 180000;
let results;
do {
  const all = await json("/inspections");
  results = all.filter((p) => uploaded.some((x) => x.id === p.id));
  if (results.every((p) => p.status === "done" || p.status === "error")) break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
} while (Date.now() < deadline);
const evidence = {
  at: new Date().toISOString(),
  point,
  uploadSeconds,
  inferenceSecondsFromUploadStart: (performance.now() - started) / 1000,
  hashes,
  results,
  note: "승인된 demo5장을 두 번 사용한 업로드 처리량 검증. 학습/평가 표본 추가가 아니다.",
};
await mkdir("records", { recursive: true });
await writeFile(
  "records/platform-smoke.local.json",
  JSON.stringify(evidence, null, 2),
);
console.log(
  JSON.stringify({
    uploadSeconds,
    inferenceSecondsFromUploadStart: evidence.inferenceSecondsFromUploadStart,
    sameHashes: hashes.length,
    statuses: results.map((p) => p.status),
    pointId: point.id,
  }),
);
assert.ok(
  results.every((p) => p.status === "done"),
  "실제 모델 완료가 아닌 항목이 있습니다.",
);
