import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract } from "../server/dataset-contract.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
for (const key of [
  "--root",
  "--plan",
  "--plan-sha256",
  "--train-report",
  "--train-report-sha256",
])
  if (!args.get(key)) throw new Error(`${key} 값을 명시하세요.`);
const root = resolve(args.get("--root"));
const secret = () => randomBytes(32).toString("hex");
const env = {
  DATA_SCOPE: "local-private",
  PRIVATE_RUNTIME_ROOT: root,
  DATASET_PLAN_PATH: resolve(args.get("--plan")),
  DATASET_PLAN_SHA256: args.get("--plan-sha256"),
  DATASET_TRAIN_REPORT_PATH: resolve(args.get("--train-report")),
  DATASET_TRAIN_REPORT_SHA256: args.get("--train-report-sha256"),
  API_HOST: "127.0.0.1",
  API_PORT: args.get("--api-port") || "4100",
  PRIVATE_WEB_PORT: args.get("--web-port") || "3100",
  MYSQL_HOST: "127.0.0.1",
  MYSQL_PORT: args.get("--mysql-port") || "13307",
  MYSQL_DATABASE: "inspection_private_data",
  MYSQL_USER: "inspection_private_a",
  MYSQL_PASSWORD: secret(),
  MINIO_ENDPOINT: "127.0.0.1",
  MINIO_PORT: args.get("--minio-port") || "19000",
  MINIO_BUCKET: "inspection-private-originals",
  MINIO_ACCESS_KEY: "inspection_private_a",
  MINIO_SECRET_KEY: secret(),
  UPLOAD_TEMP_DIR: join(root, "uploads"),
  PUBLIC_DEMO_ONLY: "0",
  PUBLIC_UPLOADS_ALLOWED: "0",
  CORS_ORIGINS: `http://127.0.0.1:${args.get("--web-port") || "3100"},http://localhost:${args.get("--web-port") || "3100"}`,
  MODEL_API_URL: args.get("--model-url") || "http://127.0.0.1:8001",
};
const profile = runtimeProfile(env);
const dataset = await loadDatasetContract(profile, env);
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await stat(root)).mode & 0o077)
  throw new Error("전용 폴더는 소유자만 읽을 수 있어야 합니다.");
const writeExclusive = async (name, values) => {
  const handle = await open(join(root, name), "wx", 0o600);
  try {
    await handle.writeFile(
      Object.entries(values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
};
// Refuse to regenerate a live credential set. Recovery uses the existing files.
for (const name of ["api.env", "infra.env"]) {
  try {
    await readFile(join(root, name));
    throw new Error("기존 전용 설정이 있습니다. 덮어쓰지 않습니다.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
await writeExclusive("infra.env", {
  MYSQL_DATABASE: env.MYSQL_DATABASE,
  MYSQL_USER: env.MYSQL_USER,
  MYSQL_PASSWORD: env.MYSQL_PASSWORD,
  MYSQL_PORT: env.MYSQL_PORT,
  MINIO_PORT: env.MINIO_PORT,
  PRIVATE_MYSQL_ROOT_PASSWORD: secret(),
  PRIVATE_MINIO_ROOT_USER: "privatebootstrap",
  PRIVATE_MINIO_ROOT_PASSWORD: secret(),
});
await writeExclusive("api.env", env);
console.log(
  JSON.stringify({
    created: true,
    root,
    scope: profile.scope,
    metadataRecords: dataset.plan.entries.length,
    cacheReferences: dataset.caches.size,
    photosRead: 0,
  }),
);
