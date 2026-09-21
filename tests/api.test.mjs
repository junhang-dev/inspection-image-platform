import test from "node:test";
import assert from "node:assert/strict";
const base = process.env.TEST_API_URL || "http://127.0.0.1:4000/api";
test("시연 사진 요청은 사용자 파일 경로나 URL을 받지 않는다", async () => {
  const response = await fetch(`${base}/demo-inspections`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pointId: null, file: "unapproved.jpg" }),
  });
  assert.equal(response.status, 422);
});
test("시연 요청은 허용 사진과 비허용 바이트의 혼합 묶음을 전부 거절한다", async () => {
  const before = await (await fetch(`${base}/inspections`)).json();
  const approved = await (await fetch(`${base}/demo/demo-01.jpg`)).blob();
  const body = new FormData();
  body.append("demo", "1");
  body.append("images", approved, "renamed-approved.jpg");
  body.append(
    "images",
    new Blob(["unapproved bytes"], { type: "image/jpeg" }),
    "demo-01.jpg",
  );
  const response = await fetch(`${base}/inspections`, { method: "POST", body });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /제공된 시연 사진/);
  const after = await (await fetch(`${base}/inspections`)).json();
  assert.deepEqual(after, before);
});
test("사진 없음과 잘못된 이미지가 저장 성공으로 표시되지 않는다", async () => {
  const empty = await fetch(`${base}/inspections`, {
    method: "POST",
    body: new FormData(),
  });
  assert.equal(empty.status, 400);
  const invalid = new FormData();
  invalid.append(
    "images",
    new Blob(["this is not an image"], { type: "image/png" }),
    "invalid.png",
  );
  const bad = await fetch(`${base}/inspections`, {
    method: "POST",
    body: invalid,
  });
  assert.equal(bad.status, 422);
});
test("허용되지 않은 브라우저 출처의 수정 요청은 거절한다", async () => {
  const response = await fetch(`${base}/points`, {
    method: "POST",
    headers: {
      Origin: "https://unapproved.invalid",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(response.status, 403);
});
test("사람 수정 API로 원래 AI 결과를 주입할 수 없다", async () => {
  const response = await fetch(
    `${base}/inspections/00000000-0000-0000-0000-000000000000`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ai: { grade: 5 },
        expectedVersion: 0,
        actor: "검증",
        reason: "잘못된 주입 검증",
      }),
    },
  );
  assert.equal(response.status, 422);
});

test("업무 수정 API는 버전 누락·잘못된 버전·내부 옵션 주입을 거절한다", async () => {
  for (const kind of ["points", "inspections", "plans"]) {
    for (const invalid of [
      {},
      { expectedVersion: -1 },
      { expectedVersion: 0.5 },
      { expectedVersion: "0" },
      { expectedVersion: 0, editVersion: 99 },
      { expectedVersion: 0, inference: true },
    ]) {
      const response = await fetch(
        `${base}/${kind}/00000000-0000-0000-0000-000000000000`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(kind === "plans" ? { status: "done" } : {}),
            actor: "AI 서비스",
            reason: "잘못된 수정 버전 검증",
            ...invalid,
          }),
        },
      );
      assert.equal(response.status, 422, `${kind}: ${JSON.stringify(invalid)}`);
      if (!("expectedVersion" in invalid))
        assert.match((await response.json()).error, /새로고침/);
    }
  }
});
