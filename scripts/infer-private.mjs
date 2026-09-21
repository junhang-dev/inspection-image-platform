import "dotenv/config";
import { Client } from "minio";
import { mkdir } from "node:fs/promises";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract } from "../server/dataset-contract.mjs";
import { verifyStorageProfile } from "../server/storage-profile.mjs";
import { withPrivateImportLease } from "../server/private-import-lease.mjs";
import {
  withVerifiedModelInput,
  assertFrozenIdentity,
  cleanupModelScratch,
} from "../server/verified-model-input.mjs";
import { predictStream } from "../server/model-input.mjs";
import { commitPrivateInference } from "../server/private-import-store.mjs";
import { pool } from "../server/store.mjs";

const profile = runtimeProfile();
if (profile.scope !== "local-private")
  throw new Error("전용 로컬 판독만 허용합니다.");
const dataset = await loadDatasetContract(profile);
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
const modelUrl = process.env.MODEL_API_URL;
try {
  await verifyStorageProfile(pool, objects, profile, dataset);
  await withPrivateImportLease(pool, async (lease) => {
    const [rows] = await lease.db.query(
      "SELECT data FROM entities WHERE kind='inspection' ORDER BY id",
    );
    const all = rows.map((row) =>
      typeof row.data === "string" ? JSON.parse(row.data) : row.data,
    );
    const candidates = all.filter(
      (photo) =>
        dataset.policy.explicitImportInference(photo, photo.sha256).allowed,
    );
    const summary = {
      apply: process.argv.includes("--apply"),
      eligible: candidates.length,
      protectedTest: all.filter((photo) => photo.protectedEvaluation).length,
      preservedResults: all.filter((photo) => photo.ai).length,
    };
    if (!summary.apply)
      return console.log(JSON.stringify({ ...summary, modelCalls: 0 }));
    await mkdir(process.env.UPLOAD_TEMP_DIR, { recursive: true, mode: 0o700 });
    await cleanupModelScratch(process.env.UPLOAD_TEMP_DIR);
    let completed = 0;
    for (const photo of candidates) {
      await lease.assertOwned();
      const health = await fetch(`${modelUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!health.ok) throw new Error("동결 모델이 준비되지 않았습니다.");
      const identity = await health.json();
      if (!identity.ready) throw new Error("동결 모델이 준비되지 않았습니다.");
      assertFrozenIdentity(identity, dataset.freeze);
      const ai = await withVerifiedModelInput(
        {
          objects,
          bucket: process.env.MINIO_BUCKET,
          photo,
          directory: process.env.UPLOAD_TEMP_DIR,
          decide: dataset.policy.explicitImportInference,
          signal: lease.signal,
        },
        async (stream) => {
          await lease.assertOwned();
          return await predictStream(modelUrl, stream, photo, {
            signal: lease.signal,
          });
        },
      );
      assertFrozenIdentity(ai, dataset.freeze, { checkpoint: false });
      await lease.assertOwned();
      await commitPrivateInference(
        lease.db,
        dataset,
        photo,
        ai,
        new Date().toISOString(),
      );
      completed++;
      if (completed % 10 === 0 || completed === candidates.length)
        console.log(
          JSON.stringify({
            completed,
            total: candidates.length,
            protectedTestCalls: 0,
          }),
        );
    }
    console.log(
      JSON.stringify({
        ...summary,
        completed,
        modelCalls: completed,
        protectedTestCalls: 0,
      }),
    );
  });
} finally {
  await pool.end();
}
