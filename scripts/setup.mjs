import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const template = await readFile(
  new URL("../.env.example", import.meta.url),
  "utf8",
);
const configured = template.replaceAll("replace-with-local-secret", () =>
  randomBytes(24).toString("hex"),
);
try {
  await writeFile(new URL("../.env", import.meta.url), configured, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    "로컬 .env 생성 완료. API 시작 전 DATASET_PLAN_PATH/SHA256과 저장소 표식을 설정하세요. docs/private-import.md를 참고하세요.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("기존 .env를 보존합니다.");
}
