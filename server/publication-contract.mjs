const hashPattern = /^[a-f0-9]{64}$/;
export function validatePublicationPolicy(value, plan, sha256) {
  const origin = new URL(value.origin);
  const known = new Set(plan.entries.map((entry) => entry.sha256));
  const hashes = new Set(value.approvedHashes);
  if (value.version !== 1 || value.scope !== "shared" || value.purpose !== "final-submission" ||
      value.manifestSha256 !== plan.evidence.manifest.sha256 || origin.protocol !== "https:" || origin.origin !== value.origin ||
      !value.approvedAt || !Number.isFinite(Date.parse(value.approvedAt)) || !hashPattern.test(sha256) ||
      !Array.isArray(value.approvedHashes) || hashes.size !== value.approvedHashes.length || !hashes.size ||
      [...hashes].some((hash) => !hashPattern.test(hash) || !known.has(hash)) ||
      value.recordCount !== plan.entries.filter((entry) => hashes.has(entry.sha256)).length)
    throw new Error("공개 승인 자료의 범위·해시·목적지가 일치하지 않습니다.");
  return Object.freeze({ hashes, sha256, origin: value.origin, recordCount: value.recordCount });
}

export function assertPublicationRecords(photos, dataset) {
  const entries = dataset.plan?.entries ?? [];
  const knownHashes = new Set(entries.map((entry) => entry.sha256));
  const knownSources = new Map(entries.map((entry) => [entry.sourceId, entry]));
  const approved = new Set([...(dataset.publication?.hashes ?? []), ...(dataset.plan?.demo_aliases ?? []).map((alias) => alias.sha256)]);
  for (const photo of photos) {
    if (!photo.datasetManifestSha256 && !photo.sourceId && !knownHashes.has(photo.sha256)) continue;
    if (!approved.has(photo.sha256) || (photo.datasetManifestSha256 && photo.datasetManifestSha256 !== dataset.manifestSha256) ||
        (photo.sourceId && knownSources.get(photo.sourceId)?.sha256 !== photo.sha256))
      throw new Error("명시적으로 공개 승인되지 않은 보존 원본이 공유 저장소에 있습니다.");
  }
}

// Applied to every shared JSON response, including history, upload receipts,
// jobs and nested model replies. The internal DB keeps the original evidence.
const internalFields = new Set([
  "sourceId", "source_id", "canonicalSourceId", "cacheSourceId", "assetAlias", "objectKey",
  "aiProvenance", "inferencePolicy", "protectedEvaluation", "datasetManifestSha256",
  "manifestSha256", "manifest_sha256", "reportSha256", "sourceSha256",
  "split", "originalSplit", "canonicalSplit", "included", "duplicateOf", "duplicate_of",
  "relative_path", "originalName", "originalFilename", "originalPath", "sourcePath", "source_root_reference",
  "checkpoint_path", "weights_path", "manifest_path", "contract_path", "backgroundSourceIds",
]);
export function publicPayload(value) {
  if (Array.isArray(value)) return value.map(publicPayload);
  if (typeof value === "string" && /(?:file:\/\/)?\/(?:Users|private|tmp|var|home|etc|opt|Volumes)\/|[A-Za-z]:\\/.test(value))
    return "내부 처리 경로가 포함된 내용은 공개하지 않습니다. 오류가 계속되면 운영 담당자에게 알려주세요.";
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !internalFields.has(key)).map(([key, item]) => [key, publicPayload(item)]));
}
