const hashPattern = /^[a-f0-9]{64}$/;
const deny = (code, message) => ({ allowed: false, code, message });
const allow = Object.freeze({ allowed: true, code: "allowed", message: null });
const fail = (message) => {
  throw new Error(`판독 정책 확인 실패: ${message}`);
};

export function createInferencePolicy(
  entries,
  { scope = "local-private", publicHashes = [], manifestSha256 } = {},
) {
  const byId = new Map();
  const byHash = new Map();
  const approved = new Set(publicHashes);
  for (const entry of entries) {
    if (
      !entry.sourceId ||
      !hashPattern.test(entry.sha256) ||
      !["train", "validation", "test"].includes(entry.canonicalSplit)
    )
      fail("자료 식별자 또는 split");
    if (byId.has(entry.sourceId)) fail("중복 sourceId");
    byId.set(entry.sourceId, entry);
    const previous = byHash.get(entry.sha256);
    if (
      previous &&
      (previous.canonicalSplit !== entry.canonicalSplit ||
        previous.canonicalSourceId !== entry.canonicalSourceId)
    )
      fail("같은 원본 SHA의 출처 충돌");
    byHash.set(entry.sha256, entry);
  }
  function identity(photo, actualSha256 = photo.sha256) {
    if (!hashPattern.test(actualSha256 || ""))
      return deny("invalid_sha", "원본 해시를 확인할 수 없습니다.");
    const source = photo.sourceId ? byId.get(photo.sourceId) : null;
    const bytes = byHash.get(actualSha256);
    if (source?.canonicalSplit === "test" || bytes?.canonicalSplit === "test")
      return deny("fixed_test", "보존된 평가 사진은 새로 판독하지 않습니다.");
    if (photo.sourceId && (!source || source.sha256 !== actualSha256))
      return deny("source_mismatch", "자료 식별자와 원본 해시가 다릅니다.");
    if (photo.sha256 && photo.sha256 !== actualSha256)
      return deny("object_mismatch", "저장된 원본과 메타데이터가 다릅니다.");
    if (scope === "shared" && bytes && !approved.has(actualSha256))
      return deny(
        "private_original",
        "이 원본은 공개 업로드 대상으로 등록되지 않았습니다.",
      );
    return allow;
  }
  function queue(photo, actualSha256 = photo.sha256) {
    const checked = identity(photo, actualSha256);
    if (!checked.allowed) return checked;
    if (photo.inferencePolicy?.allowed === false || photo.datasetManifestSha256)
      return deny(
        "import_hold",
        "가져온 사진은 기존 판독 결과를 보존하며 자동 재판독하지 않습니다.",
      );
    return allow;
  }
  function assertUpload(photo, actualSha256 = photo.sha256) {
    const checked = identity(photo, actualSha256);
    if (!checked.allowed)
      throw Object.assign(new Error(checked.message), {
        status: 422,
        code: checked.code,
      });
  }
  function explicitImportInference(photo, actualSha256) {
    const checked = identity(photo, actualSha256);
    if (!checked.allowed) return checked;
    const entry = byId.get(photo.sourceId);
    if (
      scope !== "local-private" ||
      !entry ||
      !manifestSha256 ||
      photo.datasetManifestSha256 !== manifestSha256 ||
      photo.ai
    )
      return deny(
        "not_unread_import",
        "판독이 필요한 로컬 원본만 명시적으로 처리할 수 있습니다.",
      );
    return allow;
  }
  return Object.freeze({
    identity,
    queue,
    assertUpload,
    explicitImportInference,
  });
}
