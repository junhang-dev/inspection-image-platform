import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { createHash } from "node:crypto";

const root = resolve(process.argv[2] || "");
const env = parse(await readFile(join(root, "api.env")));
const profile = runtimeProfile(env);
if (profile.scope !== "local-private" || profile.root !== root)
  throw new Error("전용 로컬 설정을 명시하세요.");
const policy = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: [
        "s3:GetBucketLocation",
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads",
      ],
      Resource: [`arn:aws:s3:::${env.MINIO_BUCKET}`],
    },
    {
      Effect: "Allow",
      Action: [
        "s3:GetObject",
        "s3:PutObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts",
      ],
      Resource: [`arn:aws:s3:::${env.MINIO_BUCKET}/*`],
    },
  ],
};
const policyPath = join(root, "bucket-policy.local.json");
await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
const run = (args, input) => {
  const result = spawnSync("docker", args, {
    input,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `전용 MinIO 준비 실패 (${result.status}): ${result.stderr?.slice(0, 500)}`,
    );
  return result.stdout;
};
const project = process.argv[3] || "inspection-private";
if (!/^inspection-private(?:-[a-z0-9-]+)?$/.test(project))
  throw new Error("전용 로컬 Compose project만 지정할 수 있습니다.");
const container = `${project}-minio-1`;
const identity = JSON.parse(
  run(["inspect", "--format", "{{json .Config.Labels}}", container]),
);
if (
  identity["com.docker.compose.project"] !== project ||
  identity["com.docker.compose.service"] !== "minio"
)
  throw new Error("전용 MinIO 컨테이너가 아닙니다.");
run(["cp", policyPath, `${container}:/tmp/private-policy.json`]);
// The root credential stays in the dedicated container. It is never given to API.
run(
  [
    "exec",
    "-i",
    "--env",
    `PRIVATE_APP_ACCESS=${env.MINIO_ACCESS_KEY}`,
    "--env",
    `PRIVATE_APP_SECRET=${env.MINIO_SECRET_KEY}`,
    "--env",
    `PRIVATE_BUCKET=${env.MINIO_BUCKET}`,
    container,
    "sh",
  ],
  `set -eu
mc alias set private http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "private/$PRIVATE_BUCKET" >/dev/null
mc anonymous set none "private/$PRIVATE_BUCKET" >/dev/null
mc mb --ignore-existing "private/$PRIVATE_BUCKET-scope-check" >/dev/null
printf 'scope-check' | mc pipe "private/$PRIVATE_BUCKET-scope-check/scope-check" >/dev/null
mc anonymous set none "private/$PRIVATE_BUCKET-scope-check" >/dev/null
if ! mc admin user info private "$PRIVATE_APP_ACCESS" >/dev/null 2>&1; then
  mc admin user add private "$PRIVATE_APP_ACCESS" "$PRIVATE_APP_SECRET" >/dev/null
fi
mc admin policy create private inspection-private-app /tmp/private-policy.json >/dev/null
mc admin policy attach private inspection-private-app --user "$PRIVATE_APP_ACCESS" >/dev/null
`,
);
const installed = JSON.parse(
  run([
    "exec",
    container,
    "mc",
    "--json",
    "admin",
    "policy",
    "info",
    "private",
    "inspection-private-app",
  ]),
);
const user = JSON.parse(
  run([
    "exec",
    container,
    "mc",
    "--json",
    "admin",
    "user",
    "info",
    "private",
    env.MINIO_ACCESS_KEY,
  ]),
);
const normalize = (value) =>
  Array.isArray(value)
    ? value
        .map(normalize)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, normalize(v)]),
        )
      : value;
if (
  installed.status !== "success" ||
  JSON.stringify(normalize(installed.policyInfo.Policy)) !==
    JSON.stringify(normalize(policy)) ||
  user.status !== "success" ||
  user.accessKey !== env.MINIO_ACCESS_KEY ||
  user.userStatus !== "enabled" ||
  user.policyName !== "inspection-private-app" ||
  (user.memberOf?.length ?? 0) !== 0
)
  throw new Error("설치된 정책 또는 사용자 연결이 전용 버킷 범위와 다릅니다.");
await writeFile(
  join(root, "credential-audit.local.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      container,
      accessKey: env.MINIO_ACCESS_KEY,
      bucket: env.MINIO_BUCKET,
      installedPolicy: installed.policyInfo.Policy,
      policyName: user.policyName,
      userStatus: user.userStatus,
      policySha256: createHash("sha256")
        .update(JSON.stringify(normalize(policy)))
        .digest("hex"),
      groupMemberships: [],
      verifiedInstalledPolicy: true,
      policySource: "mc admin policy info and user info",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    privateBucketReady: true,
    anonymousAccess: false,
    apiCredentialScope: "dedicated-bucket-only",
    installedPolicyVerified: true,
    photosRead: 0,
  }),
);
