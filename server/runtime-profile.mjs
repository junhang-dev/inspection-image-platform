import { isAbsolute, resolve } from "node:path";

const fail = (message) => {
  throw new Error(`실행 프로파일 확인 실패: ${message}`);
};
const required = (env, name) => {
  if (!env[name]?.trim()) fail(`${name}을 명시하세요.`);
  return env[name];
};
export function runtimeProfile(env = process.env) {
  const scope = required(env, "DATA_SCOPE");
  if (!["shared", "local-private"].includes(scope))
    fail("알 수 없는 DATA_SCOPE");
  const planPath = required(env, "DATASET_PLAN_PATH");
  const planSha256 = required(env, "DATASET_PLAN_SHA256");
  if (!isAbsolute(planPath) || !/^[a-f0-9]{64}$/.test(planSha256))
    fail("계획 경로·SHA 형식");
  if (scope === "shared") {
    for (const name of [
      "MYSQL_DATABASE",
      "MYSQL_USER",
      "MINIO_BUCKET",
      "MINIO_ACCESS_KEY",
    ])
      if (/private/i.test(required(env, name)))
        fail("공유 프로파일에 비공개 저장소를 연결할 수 없습니다.");
    if (env.PRIVATE_RUNTIME_ROOT)
      fail("공유 프로파일에 비공개 런타임이 포함됐습니다.");
    return { scope, planPath, planSha256 };
  }
  const root = required(env, "PRIVATE_RUNTIME_ROOT");
  if (!isAbsolute(root) || resolve(root) === "/") fail("전용 런타임 폴더");
  for (const name of ["API_HOST", "MYSQL_HOST", "MINIO_ENDPOINT"]) {
    if (required(env, name) !== "127.0.0.1")
      fail(`${name}은 loopback만 허용합니다.`);
  }
  const ports = [
    "API_PORT",
    "PRIVATE_WEB_PORT",
    "MYSQL_PORT",
    "MINIO_PORT",
  ].map((name) => {
    const port = Number(required(env, name));
    if (
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      [3000, 3307, 4000, 8001, 9000, 9001].includes(port)
    )
      fail(`${name}은 공유 포트와 다른 전용 포트여야 합니다.`);
    return port;
  });
  if (new Set(ports).size !== ports.length) fail("전용 포트 중복");
  for (const name of [
    "MYSQL_DATABASE",
    "MYSQL_USER",
    "MINIO_BUCKET",
    "MINIO_ACCESS_KEY",
  ]) {
    if (!/^inspection[_-]private[_-][a-z0-9_-]+$/.test(required(env, name)))
      fail(`${name}은 전용 이름이어야 합니다.`);
  }
  for (const name of ["MYSQL_PASSWORD", "MINIO_SECRET_KEY"])
    if (required(env, name).length < 24)
      fail(`${name}은 별도 자격이어야 합니다.`);
  const temp = resolve(required(env, "UPLOAD_TEMP_DIR"));
  if (!temp.startsWith(`${resolve(root)}/`))
    fail("임시 폴더가 전용 런타임 밖입니다.");
  if (env.PUBLIC_DEMO_ONLY !== "0" || env.PUBLIC_UPLOADS_ALLOWED !== "0")
    fail("로컬 전용 공개 설정");
  const origins = required(env, "CORS_ORIGINS").split(",");
  const allowedOrigins = [
    `http://127.0.0.1:${ports[1]}`,
    `http://localhost:${ports[1]}`,
  ];
  if (
    !origins.length ||
    origins.some((origin) => !allowedOrigins.includes(origin))
  )
    fail("화면 출처가 전용 웹이 아닙니다.");
  const model = new URL(required(env, "MODEL_API_URL"));
  if (
    model.protocol !== "http:" ||
    model.hostname !== "127.0.0.1" ||
    model.pathname !== "/" ||
    model.username ||
    model.password
  )
    fail("동결 모델은 같은 컴퓨터에서만 연결합니다.");
  return {
    scope,
    planPath,
    planSha256,
    root: resolve(root),
    apiPort: ports[0],
    webPort: ports[1],
  };
}

export function privateRequestAllowed(profile, headers) {
  if (profile.scope !== "local-private") return true;
  const hosts = new Set([
    `127.0.0.1:${profile.apiPort}`,
    `localhost:${profile.apiPort}`,
    `127.0.0.1:${profile.webPort}`,
    `localhost:${profile.webPort}`,
  ]);
  if (!hosts.has(headers.host)) return false;
  if (headers["x-forwarded-host"] && !hosts.has(headers["x-forwarded-host"]))
    return false;
  if (
    headers["x-forwarded-for"] &&
    !String(headers["x-forwarded-for"])
      .split(",")
      .every((s) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(s.trim()))
  )
    return false;
  return !headers["cf-connecting-ip"];
}
