import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { createInferencePolicy } from "./inference-policy.mjs";
import { validatePublicationPolicy } from "./publication-contract.mjs";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  throw new Error(`보존 자료 계약 확인 실패: ${message}`);
};
export async function verifiedJson(path, sha256) {
  if (!isAbsolute(path || "") || !/^[a-f0-9]{64}$/.test(sha256 || ""))
    fail("메타데이터 경로·해시");
  const bytes = await readFile(path);
  if (digest(bytes) !== sha256) fail("메타데이터 해시 불일치");
  return JSON.parse(bytes.toString("utf8"));
}

export function validateDatasetPlan(plan, manifest, freeze) {
  if (
    plan.publicExposureAllowed !== false ||
    plan.algorithm !== "virtual-four-team-placement-v1"
  )
    fail("배치 범위");
  if (freeze.manifest_sha256 !== plan.evidence.manifest.sha256)
    fail("동결 manifest");
  if (plan.entries.length !== 300 || manifest.entries.length !== 300)
    fail("원본 기록 수");
  const source = new Map(manifest.entries.map((entry) => [entry.id, entry]));
  if (
    source.size !== 300 ||
    new Set(plan.entries.map((entry) => entry.sourceId)).size !== 300
  )
    fail("원본 ID 중복");
  const counts = { train: 0, validation: 0, test: 0, excluded: 0 };
  const teams = new Map();
  for (const entry of plan.entries) {
    const item = source.get(entry.sourceId);
    if (
      !item ||
      item.sha256 !== entry.sha256 ||
      item.relative_path !== entry.relative_path ||
      item.size_bytes !== entry.size_bytes ||
      item.split !== entry.originalSplit ||
      item.included !== entry.included ||
      (item.duplicate_of ?? null) !== entry.duplicateOf
    )
      fail("배치와 보존 manifest의 원본 불일치");
    if (
      isAbsolute(entry.relative_path) ||
      entry.relative_path.split(/[\\/]/).some((part) => part === "..")
    )
      fail("원본 상대 경로");
    const canonical = source.get(entry.canonicalSourceId);
    if (
      !canonical ||
      !canonical.included ||
      canonical.sha256 !== entry.sha256 ||
      canonical.split !== entry.canonicalSplit
    )
      fail("중복 대표 연결");
    if (
      entry.inferenceAllowed !== false ||
      entry.locationVerified !== false ||
      entry.virtualAssignment !== true
    )
      fail("준비 계획 경계");
    if (!/^virtual-team-0[1-4]$/.test(entry.team)) fail("가상 팀");
    teams.set(entry.team, (teams.get(entry.team) || 0) + 1);
    if (!Object.hasOwn(counts, item.split)) fail("split");
    counts[item.included ? item.split : "excluded"]++;
  }
  if (
    counts.train !== 231 ||
    counts.validation !== 58 ||
    counts.test !== 10 ||
    counts.excluded !== 1 ||
    new Set(plan.entries.map((e) => e.sha256)).size !== 299 ||
    teams.size !== 4 ||
    [...teams.values()].some((n) => n !== 75)
  )
    fail("기존 분리·중복·배치 수량");
  if (
    plan.demo_aliases.length !== 5 ||
    new Set(plan.demo_aliases.map((e) => e.demo_name)).size !== 5
  )
    fail("시연 alias 수");
  for (const alias of plan.demo_aliases) {
    const entry = source.get(alias.sourceId);
    if (
      !entry ||
      !entry.included ||
      entry.split !== "train" ||
      entry.sha256 !== alias.sha256
    )
      fail("시연 alias 연결");
  }
  return plan;
}

export function verifiedCacheRows(report, freeze, entries, reportSha256, kind) {
  const fields = [
    "manifest_sha256",
    "model_version",
    "preprocessing_version",
    "checkpoint_sha256",
  ];
  if (fields.some((key) => report[key] !== freeze[key])) return new Map();
  const split = kind === "cached_frozen_evaluation" ? "test" : "train";
  if (report.split !== split || !Array.isArray(report.results))
    return new Map();
  const expected = new Map(
    entries
      .filter((e) => e.included && e.canonicalSplit === split)
      .map((e) => [e.sourceId, e]),
  );
  const seen = new Set();
  const result = new Map();
  for (const row of report.results) {
    if (seen.has(row.id) || !expected.has(row.id)) return new Map();
    seen.add(row.id);
    if (
      !Number.isInteger(row.grade) ||
      row.grade < 1 ||
      row.grade > 5 ||
      !Number.isFinite(row.confidence) ||
      row.confidence < 0 ||
      row.confidence > 1 ||
      row.model_version !== freeze.model_version ||
      row.preprocessing_version !== freeze.preprocessing_version
    )
      continue;
    const entry = expected.get(row.id);
    result.set(row.id, {
      ai: {
        grade: row.grade,
        confidence: row.confidence,
        model_version: row.model_version,
        preprocessing_version: row.preprocessing_version,
      },
      provenance: {
        kind,
        reportSha256,
        manifestSha256: freeze.manifest_sha256,
        sourceId: entry.sourceId,
        sourceSha256: entry.sha256,
        modelVersion: freeze.model_version,
        preprocessingVersion: freeze.preprocessing_version,
        checkpointSha256: freeze.checkpoint_sha256,
        predictedAt: null,
      },
    });
  }
  return result;
}

export async function loadDatasetContract(profile, env = process.env) {
  if (!["shared", "local-private"].includes(profile.scope))
    fail("명시적인 실행 범위가 필요합니다.");
  const plan = await verifiedJson(profile.planPath, profile.planSha256);
  const manifest = await verifiedJson(
    plan.evidence.manifest.path,
    plan.evidence.manifest.sha256,
  );
  const freeze = await verifiedJson(
    plan.evidence.freeze.path,
    plan.evidence.freeze.sha256,
  );
  validateDatasetPlan(plan, manifest, freeze);
  let publication = null;
  if (env.PUBLICATION_POLICY_PATH || env.PUBLICATION_POLICY_SHA256) {
    if (profile.scope !== "shared") fail("공개 승인 정책은 별도 공유 프로필에서만 사용합니다.");
    publication = validatePublicationPolicy(await verifiedJson(env.PUBLICATION_POLICY_PATH, env.PUBLICATION_POLICY_SHA256), plan, env.PUBLICATION_POLICY_SHA256);
    if (!(env.CORS_ORIGINS ?? "").split(",").includes(publication.origin)) fail("승인한 최종 공개 Origin이 설정과 다릅니다.");
  }
  const policy = createInferencePolicy(plan.entries, {
    scope: profile.scope,
    publicHashes: [...plan.demo_aliases.map((e) => e.sha256), ...(publication?.hashes ?? [])],
    manifestSha256: plan.evidence.manifest.sha256,
  });
  const caches = new Map();
  const cacheReports = [];
  for (const [ref, kind] of [
    [plan.evidence.evaluation, "cached_frozen_evaluation"],
    [
      {
        path: env.DATASET_TRAIN_REPORT_PATH,
        sha256: env.DATASET_TRAIN_REPORT_SHA256,
      },
      "cached_frozen_training",
    ],
  ]) {
    try {
      const report = await verifiedJson(ref?.path, ref?.sha256);
      const rows = verifiedCacheRows(
        report,
        freeze,
        plan.entries,
        ref.sha256,
        kind,
      );
      for (const [id, result] of rows) caches.set(id, result);
      cacheReports.push({ kind, sha256: ref.sha256, reused: rows.size });
    } catch {
      cacheReports.push({
        kind,
        reused: 0,
        reason: "missing_or_mismatched_report",
      });
    }
  }
  return {
    profile,
    publication,
    plan,
    manifest,
    freeze,
    policy,
    caches,
    cacheReports,
    manifestSha256: plan.evidence.manifest.sha256,
  };
}
