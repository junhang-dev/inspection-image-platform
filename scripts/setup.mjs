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
    "로컬 .env 생성 완료. 기존 원본과 전역 설정은 변경하지 않았습니다.",
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log("기존 .env를 보존합니다.");
}
