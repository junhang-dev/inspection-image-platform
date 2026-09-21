import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  mkdtemp,
  readdir,
  rm,
  mkdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, verifiedCacheRows } from "../server/dataset-contract.mjs";
import { createInferencePolicy } from "../server/inference-policy.mjs";
import {
  runtimeProfile,
  privateRequestAllowed,
} from "../server/runtime-profile.mjs";
import {
  withVerifiedModelInput,
  assertFrozenIdentity,
  cleanupModelScratch,
} from "../server/verified-model-input.mjs";

const trainBytes = Buffer.from("synthetic train bytes");
const testBytes = Buffer.from("synthetic protected bytes");
const entries = [
  {
    sourceId: "S-1",
    canonicalSourceId: "S-1",
    sha256: digest(trainBytes),
    canonicalSplit: "train",
    included: true,
  },
  {
    sourceId: "S-2",
    canonicalSourceId: "S-2",
    sha256: digest(testBytes),
    canonicalSplit: "test",
    included: true,
  },
  {
    sourceId: "S-alias",
    canonicalSourceId: "S-2",
    sha256: digest(testBytes),
    canonicalSplit: "test",
    included: false,
  },
];
const policy = createInferencePolicy(entries, {
  manifestSha256: "a".repeat(64),
});
test("abort after verification but before model consumption cleans scratch without unhandled stream errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "policy-abort-"));
  const controller = new AbortController();
  let modelCalls = 0;
  try {
    await assert.rejects(
      withVerifiedModelInput(
        {
          objects: { getObject: async () => Readable.from([trainBytes]) },
          bucket: "fixture",
          photo: { sha256: digest(trainBytes), size: trainBytes.length },
          directory,
          decide: policy.queue,
          signal: controller.signal,
        },
        async () => {
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 10));
          controller.signal.throwIfAborted();
          modelCalls++;
        },
      ),
      /aborted/i,
    );
    assert.equal(modelCalls, 0);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("protected source or actual hash wins over filename, split and claimed hash", () => {
  for (const input of [
    { sourceId: "S-2", sha256: digest(trainBytes), split: "train" },
    { sourceId: "S-alias", sha256: digest(trainBytes) },
    { sourceId: "S-1", sha256: digest(testBytes) },
    { name: "renamed.jpg", sha256: digest(testBytes) },
  ]) {
    assert.equal(policy.queue(input).code, "fixed_test");
    assert.throws(() => policy.assertUpload(input), { code: "fixed_test" });
  }
  assert.throws(
    () =>
      policy.assertUpload({ sha256: digest(trainBytes) }, digest(testBytes)),
    { code: "fixed_test" },
  );
  assert.equal(
    policy.queue({ sourceId: "S-1", sha256: digest(Buffer.from("changed")) })
      .code,
    "source_mismatch",
  );
});
test("import holds all automatic/retry queues and only explicit unread non-test is eligible", () => {
  const imported = {
    sourceId: "S-1",
    sha256: digest(trainBytes),
    datasetManifestSha256: "a".repeat(64),
    inferencePolicy: { allowed: false },
    ai: null,
  };
  assert.equal(policy.queue(imported).code, "import_hold");
  assert.equal(
    policy.explicitImportInference(imported, imported.sha256).allowed,
    true,
  );
  assert.equal(
    policy.explicitImportInference(
      { ...imported, datasetManifestSha256: "b".repeat(64) },
      imported.sha256,
    ).allowed,
    false,
  );
  assert.equal(
    policy.explicitImportInference(
      { ...imported, ai: { grade: 1 } },
      imported.sha256,
    ).allowed,
    false,
  );
  assert.equal(
    policy.explicitImportInference(
      { ...imported, sourceId: "S-2" },
      digest(testBytes),
    ).allowed,
    false,
  );
  const shared = createInferencePolicy(entries, {
    scope: "shared",
    publicHashes: [digest(trainBytes)],
  });
  assert.equal(shared.identity({ sha256: digest(trainBytes) }).allowed, true);
  assert.equal(shared.identity({ sha256: digest(testBytes) }).allowed, false);
  assert.equal(
    createInferencePolicy(entries, { scope: "shared" }).identity({
      sha256: digest(trainBytes),
    }).code,
    "private_original",
  );
});
test("protected or changed object never sends a byte to the model; verified input is exactly reused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "policy-test-"));
  let calls = 0;
  try {
    const invoke = async (bytes, photo) =>
      withVerifiedModelInput(
        {
          objects: { getObject: async () => Readable.from([bytes]) },
          bucket: "test",
          photo,
          directory,
          decide: policy.queue,
        },
        async (stream) => {
          calls++;
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          return Buffer.concat(chunks);
        },
      );
    await assert.rejects(
      invoke(testBytes, { sha256: digest(testBytes), size: testBytes.length }),
      { inferenceBlocked: true },
    );
    await assert.rejects(
      invoke(testBytes, { sha256: digest(trainBytes), size: testBytes.length }),
      { code: "object_mismatch" },
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await invoke(trainBytes, {
        sha256: digest(trainBytes),
        size: trainBytes.length,
      }),
      trainBytes,
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
const frozen = {
  manifest_sha256: "a".repeat(64),
  model_version: "frozen",
  preprocessing_version: "prep",
  checkpoint_sha256: "b".repeat(64),
};
test("a stalled source times out without model bytes and only stale model scratch is removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "policy-timeout-"));
  let calls = 0;
  try {
    await assert.rejects(
      withVerifiedModelInput(
        {
          objects: { getObject: async () => new Readable({ read() {} }) },
          bucket: "test",
          photo: { sha256: digest(trainBytes), size: trainBytes.length },
          directory,
          decide: policy.queue,
          copyTimeoutMs: 20,
        },
        async () => {
          calls++;
        },
      ),
      { code: "source_timeout" },
    );
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(directory), []);
    await mkdir(join(directory, "model-ABC123"));
    await utimes(join(directory, "model-ABC123"), new Date(0), new Date(0));
    await writeFile(join(directory, "preserved.upload"), "keep");
    await cleanupModelScratch(directory);
    assert.deepEqual(await readdir(directory), ["preserved.upload"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("cache provenance rejects another model, duplicate IDs or unknown source; actual label is not prediction", () => {
  const report = {
    ...frozen,
    split: "train",
    results: [
      {
        id: "S-1",
        actual: 5,
        grade: 2,
        confidence: 0.7,
        model_version: "frozen",
        preprocessing_version: "prep",
      },
    ],
  };
  const cache = verifiedCacheRows(
    report,
    frozen,
    entries,
    "c".repeat(64),
    "cached_frozen_training",
  );
  assert.equal(cache.get("S-1").ai.grade, 2);
  assert.equal(cache.get("S-1").provenance.predictedAt, null);
  assert.equal(cache.get("S-1").provenance.sourceSha256, digest(trainBytes));
  assert.equal(
    verifiedCacheRows(
      { ...report, model_version: "old" },
      frozen,
      entries,
      "c".repeat(64),
      "cached_frozen_training",
    ).size,
    0,
  );
  assert.equal(
    verifiedCacheRows(
      { ...report, results: [...report.results, ...report.results] },
      frozen,
      entries,
      "c".repeat(64),
      "cached_frozen_training",
    ).size,
    0,
  );
  assert.throws(
    () => assertFrozenIdentity({ ...frozen, checkpoint_sha256: "x" }, frozen),
    { code: "model_identity_mismatch" },
  );
});
const env = {
  DATA_SCOPE: "local-private",
  DATASET_PLAN_PATH: "/tmp/plan.json",
  DATASET_PLAN_SHA256: "a".repeat(64),
  PRIVATE_RUNTIME_ROOT: "/tmp/private-test",
  API_HOST: "127.0.0.1",
  API_PORT: "4100",
  PRIVATE_WEB_PORT: "3100",
  MYSQL_HOST: "127.0.0.1",
  MYSQL_PORT: "13307",
  MYSQL_DATABASE: "inspection_private_data",
  MYSQL_USER: "inspection_private_app",
  MYSQL_PASSWORD: "synthetic-secret-value-for-test",
  MINIO_ENDPOINT: "127.0.0.1",
  MINIO_PORT: "19000",
  MINIO_BUCKET: "inspection-private-originals",
  MINIO_ACCESS_KEY: "inspection_private_app",
  MINIO_SECRET_KEY: "synthetic-object-secret-for-test",
  UPLOAD_TEMP_DIR: "/tmp/private-test/uploads",
  PUBLIC_DEMO_ONLY: "0",
  PUBLIC_UPLOADS_ALLOWED: "0",
  CORS_ORIGINS: "http://127.0.0.1:3100",
  MODEL_API_URL: "http://127.0.0.1:8001",
};
test("private profile fails closed on shared defaults and forwarded public requests", () => {
  const profile = runtimeProfile(env);
  assert.throws(() => runtimeProfile({ ...env, DATA_SCOPE: undefined }));
  for (const patch of [
    { MYSQL_DATABASE: "inspection" },
    { API_HOST: "0.0.0.0" },
    { MINIO_PORT: "9000" },
    { UPLOAD_TEMP_DIR: "/tmp/shared" },
    { CORS_ORIGINS: "https://example.com" },
    { DATASET_PLAN_SHA256: "" },
    { MODEL_API_URL: "https://external.example" },
  ])
    assert.throws(() => runtimeProfile({ ...env, ...patch }));
  assert.equal(
    privateRequestAllowed(profile, { host: "127.0.0.1:4100" }),
    true,
  );
  assert.equal(
    privateRequestAllowed(profile, { host: "public.example" }),
    false,
  );
  assert.equal(
    privateRequestAllowed(profile, {
      host: "127.0.0.1:4100",
      "x-forwarded-host": "public.example",
    }),
    false,
  );
  assert.equal(
    privateRequestAllowed(profile, {
      host: "127.0.0.1:4100",
      "cf-connecting-ip": "127.0.0.1",
    }),
    false,
  );
});
