import "dotenv/config";
import { Client } from "minio";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { withPrivateImportLease } from "../server/private-import-lease.mjs";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract } from "../server/dataset-contract.mjs";
import { planPrivatePlacement } from "../server/private-placement.mjs";
import { verifyStorageProfile } from "../server/storage-profile.mjs";
import { pool, initializeStore } from "../server/store.mjs";
import {
  initializePrivateRegistry,
  reservePrivateImport,
  ensurePrivateParents,
  commitPrivatePhoto,
} from "../server/private-import-store.mjs";
import {
  storePrivateOriginal,
  cleanupPrivateImportScratch,
} from "../server/private-original.mjs";

const profile = runtimeProfile();
if (profile.scope !== "local-private")
  throw new Error("가져오기는 전용 로컬 제품에서만 실행합니다.");
const dataset = await loadDatasetContract(profile);
const placement = planPrivatePlacement(dataset.plan.entries);
const apply = process.argv.includes("--apply");
const limitIndex = process.argv.indexOf("--stop-after");
const stopAfter =
  limitIndex < 0 ? Infinity : Number(process.argv[limitIndex + 1]);
if (
  !(stopAfter > 0) ||
  (stopAfter !== Infinity && !Number.isInteger(stopAfter))
)
  throw new Error("중단할 등록 개수가 올바르지 않습니다.");
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
try {
  if (!apply) {
    console.log(
      JSON.stringify({
        apply: false,
        originalRecords: placement.length,
        uniqueAssets: new Set(placement.map((row) => row.sha256)).size,
        cacheReports: dataset.cacheReports,
        photosRead: 0,
        modelCalls: 0,
      }),
    );
  } else {
    await verifyStorageProfile(pool, objects, profile, dataset);
    await withPrivateImportLease(pool, async (lease) => {
      await mkdir(process.env.UPLOAD_TEMP_DIR, {
        recursive: true,
        mode: 0o700,
      });
      await cleanupPrivateImportScratch(process.env.UPLOAD_TEMP_DIR);
      const scratchRoot = await mkdtemp(
        join(process.env.UPLOAD_TEMP_DIR, "import-run-"),
      );
      try {
        await initializeStore(dataset.policy, {
          connection: lease.db,
          recover: false,
        });
        await initializePrivateRegistry(lease.db);
        const registry = await reservePrivateImport(lease.db, dataset);
        await ensurePrivateParents(lease.db, dataset);
        const entries = new Map(
          dataset.plan.entries.map((entry) => [entry.sourceId, entry]),
        );
        let created = 0;
        let preserved = 0;
        let reusedObjects = 0;
        for (const reservation of registry) {
          await lease.assertOwned();
          const entry = entries.get(reservation.sourceId);
          const object = await storePrivateOriginal(
            objects,
            process.env.MINIO_BUCKET,
            reservation,
            entry,
            dataset.plan.source_root_reference,
            scratchRoot,
            lease,
          );
          if (object.reusedObject) reusedObjects++;
          await lease.assertOwned();
          const result = await commitPrivatePhoto(
            lease.db,
            dataset,
            reservation,
            entry,
            object,
          );
          if (result.created) created++;
          else preserved++;
          if (created >= stopAfter) {
            console.log(
              JSON.stringify({
                apply: true,
                interruptedForResume: true,
                created,
                preserved,
                reusedObjects,
                modelCalls: 0,
              }),
            );
            process.exitCode = 75;
            break;
          }
        }
        if (!process.exitCode)
          console.log(
            JSON.stringify({
              apply: true,
              created,
              preserved,
              reusedObjects,
              originalRecords: registry.length,
              modelCalls: 0,
            }),
          );
      } finally {
        await rm(scratchRoot, { recursive: true, force: true });
      }
    });
  }
} finally {
  await pool.end();
}
