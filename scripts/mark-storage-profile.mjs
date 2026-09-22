import "dotenv/config";
import { Client } from "minio";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract } from "../server/dataset-contract.mjs";
import { pool } from "../server/store.mjs";
import {
  bootstrapStorageProfile,
  verifyStorageProfile,
} from "../server/storage-profile.mjs";
const profile = runtimeProfile();
const dataset = await loadDatasetContract(profile);
const objects = new Client({
  endPoint: process.env.MINIO_ENDPOINT,
  port: Number(process.env.MINIO_PORT),
  useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
try {
  const apply = process.argv.includes("--apply");
  if (apply) await bootstrapStorageProfile(pool, objects, profile, dataset);
  else await verifyStorageProfile(pool, objects, profile, dataset);
  console.log(
    JSON.stringify({
      apply,
      verified: true,
      scope: profile.scope,
      photosRead: 0,
    }),
  );
} finally {
  await pool.end();
}
