import test from "node:test";
import assert from "node:assert/strict";
import { validatePublicationPolicy, assertPublicationRecords, publicPayload } from "../server/publication-contract.mjs";
import { createInferencePolicy } from "../server/inference-policy.mjs";
const a = "a".repeat(64), b = "b".repeat(64), manifest = "c".repeat(64);
const plan = { evidence: { manifest: { sha256: manifest } }, entries: [{ sha256: a }, { sha256: b }, { sha256: a }] };
const policy = { version: 1, scope: "shared", purpose: "final-submission", manifestSha256: manifest, origin: "https://approved.example", approvedAt: "2026-09-22T00:05:06Z", approvedHashes: [a, b], recordCount: 3 };
test("공개 정책은 승인된 manifest의 실제 SHA와 목적지·수량에 묶인다", () => {
  const approved = validatePublicationPolicy(policy, plan, "d".repeat(64)); assert.equal(approved.hashes.size, 2);
  for (const change of [{ approvedHashes: ["e".repeat(64)] }, { approvedHashes: [a, a] }, { manifestSha256: a }, { origin: "http://approved.example" }, { origin: "https://approved.example/path" }, { recordCount: 2 }])
    assert.throws(() => validatePublicationPolicy({ ...policy, ...change }, plan, "d".repeat(64)));
  assert.doesNotThrow(() => assertPublicationRecords([{ datasetManifestSha256: manifest, sha256: a }], { publication: approved, manifestSha256: manifest }));
  assert.throws(() => assertPublicationRecords([{ datasetManifestSha256: manifest, sha256: a }], { publication: null, manifestSha256: manifest }));
  assert.throws(() => assertPublicationRecords([{ datasetManifestSha256: manifest, sha256: "e".repeat(64) }], { publication: approved, manifestSha256: manifest }));
  assert.throws(() => assertPublicationRecords([{ sha256: b }], { plan, publication: { hashes: new Set([a]) }, manifestSha256: manifest }));
  assert.doesNotThrow(() => assertPublicationRecords([{ sha256: "e".repeat(64) }], { plan, publication: approved, manifestSha256: manifest }));
});
test("사진·이력·전송·ROI 응답 어디에도 내부 원본·학습 출처를 내보내지 않는다", () => {
  const photo = { id: "public-id", name: "검사 사진", sha256: a, ai: { grade: 3 }, sourceId: "internal-source", objectKey: "internal/key", datasetManifestSha256: manifest, protectedEvaluation: true, inferencePolicy: { allowed: false }, aiProvenance: { kind: "cached_frozen_evaluation" }, relative_path: "private/original.png", split: "test" };
  const value = { photo, history: [{ before: photo, after: photo }], jobs: [{ sourceId: "internal-source", result: { sourceId: "internal-source", explanation: { map: [[1, -1]], targetGrade: 3 } } }] };
  const clean = publicPayload(value), text = JSON.stringify(clean);
  for (const token of ["internal-source", "internal/key", "datasetManifest", "protectedEvaluation", "inferencePolicy", "aiProvenance", "private/original", "split", "cached_frozen_evaluation"]) assert.equal(text.includes(token), false, token);
  assert.equal(clean.photo.ai.grade, 3); assert.deepEqual(clean.jobs[0].result.explanation.map, [[1, -1]]);
  assert.ok(value.photo.sourceId, "internal evidence must remain unchanged");
  for (const path of ["/Users/example/private source/input.png", "/private/tmp/model-abc/input", "/var/lib/storage/input", "C:\\private\\input.png"]) {
    const sanitized = publicPayload({ error: `ENOENT open '${path}'`, history: [{ after: { error: `statfs ${path}`, reason: path } }] });
    assert.equal(JSON.stringify(sanitized).includes(path), false);
    assert.equal(sanitized.error.includes("공개하지 않습니다"), true);
  }
});
test("원본 공개 승인은 고정 test 새 추론 금지를 해제하지 않는다", () => {
  const inference = createInferencePolicy([{ sourceId: "train", canonicalSourceId: "train", canonicalSplit: "train", sha256: a }, { sourceId: "held", canonicalSourceId: "held", canonicalSplit: "test", sha256: b }], { scope: "shared", publicHashes: [a, b] });
  assert.equal(inference.identity({ sourceId: "train", sha256: a }).allowed, true);
  assert.equal(inference.identity({ sourceId: "held", sha256: b }).allowed, false);
  assert.equal(inference.identity({ id: "new-id", sha256: b }).allowed, false);
});
