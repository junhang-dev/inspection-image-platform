import test from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "../src/lib/api.ts";
import { can, setAuthUserId, setCsrfToken } from "../src/lib/auth.ts";

test("저장 응답이 HTML 502여도 원시 문서 대신 저장 확인 행동을 안내한다", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("<html>private gateway trace</html>", {
        status: 502,
        headers: { "Content-Type": "text/html" },
      }),
  );
  await assert.rejects(
    requestJson("http://example.invalid/api", { method: "POST" }),
    (error) => {
      assert.match(error.message, /502/);
      assert.match(error.message, /저장된 목록에서 반영 여부를 확인/);
      assert.doesNotMatch(error.message, /html|private|SyntaxError/);
      return true;
    },
  );
});

test("네트워크 단절과 시간 초과에도 저장됐다고 표시하지 않는다", async (t) => {
  const mocked = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Failed to fetch");
  });
  await assert.rejects(
    requestJson("http://example.invalid/api", { method: "POST" }),
    /서버에 연결할 수 없습니다.*저장된 목록/,
  );
  mocked.mock.mockImplementation(async () => {
    throw new DOMException("Timed out", "TimeoutError");
  });
  await assert.rejects(
    requestJson("http://example.invalid/api", { method: "POST" }),
    /서버 응답이 지연.*저장된 목록/,
  );
});

test("잘린 JSON은 실패로 처리하고 정상 응답과 입력 오류는 유지한다", async (t) => {
  const mocked = t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response('{"id":', {
        headers: { "Content-Type": "application/json" },
      }),
  );
  await assert.rejects(
    requestJson("http://example.invalid/api"),
    /응답을 끝까지 받지 못했습니다/,
  );
  mocked.mock.mockImplementation(async () => Response.json({ id: "verified" }));
  assert.deepEqual(await requestJson("http://example.invalid/api"), {
    id: "verified",
  });
  mocked.mock.mockImplementation(async () =>
    Response.json({ error: "사진을 다시 선택하세요." }, { status: 422 }),
  );
  await assert.rejects(
    requestJson("http://example.invalid/api", { method: "POST" }),
    /사진을 다시 선택하세요/,
  );
});

test("작성 요청은 현재 CSRF와 같은 출처 쿠키를 사용하고 조회는 CSRF를 붙이지 않는다", async (t) => {
  setAuthUserId("fixture-user");
  setCsrfToken("fixture-csrf");
  t.after(() => {
    setCsrfToken(null);
    setAuthUserId(null);
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    requests.push(options);
    return Response.json({ saved: true });
  });
  await requestJson("/api/plans", { method: "POST", body: "{}" });
  await requestJson("/api/plans");
  assert.equal(requests[0].headers.get("X-CSRF-Token"), "fixture-csrf");
  assert.equal(requests[0].credentials, "same-origin");
  assert.equal(requests[1].headers.has("X-CSRF-Token"), false);
});

test("현재 업무 세션의 401만 만료를 알리고 로그인 오류와 비밀번호 오류는 유지한다", async (t) => {
  const previousWindow = globalThis.window;
  const target = new EventTarget();
  globalThis.window = target;
  let expired = 0;
  target.addEventListener("inspection-auth-expired", () => expired++);
  setAuthUserId("fixture-user");
  setCsrfToken("fixture-csrf");
  t.after(() => {
    setAuthUserId(null);
    setCsrfToken(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const mocked = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "로그인 필요" }, { status: 401 }),
  );
  await assert.rejects(requestJson("/api/auth/login", { method: "POST" }));
  assert.equal(expired, 0);
  await assert.rejects(requestJson("/api/plans"));
  assert.equal(expired, 1);
  mocked.mock.mockImplementation(async () =>
    Response.json({ error: "현재 비밀번호 확인" }, { status: 422 }),
  );
  await assert.rejects(requestJson("/api/auth/password", { method: "POST" }));
  assert.equal(expired, 1);
});

test("계정 또는 세션이 바뀐 뒤 도착한 이전 요청의 401은 새 로그인을 지우지 않는다", async (t) => {
  const previousWindow = globalThis.window;
  const target = new EventTarget();
  globalThis.window = target;
  let expired = 0;
  target.addEventListener("inspection-auth-expired", () => expired++);
  t.after(() => {
    setAuthUserId(null);
    setCsrfToken(null);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  for (const changed of ["owner", "session"]) {
    setAuthUserId("fixture-old-user");
    setCsrfToken("fixture-old-csrf");
    t.mock.method(globalThis, "fetch", async () => {
      if (changed === "owner") setAuthUserId("fixture-new-user");
      else setCsrfToken("fixture-new-csrf");
      return Response.json({ error: "이전 세션 만료" }, { status: 401 });
    });
    await assert.rejects(requestJson("/api/plans"));
  }
  assert.equal(expired, 0);
  for (const role of [
    null,
    undefined,
    "unknown",
    "toString",
    "constructor",
    "__proto__",
  ])
    assert.equal(can(role, "work.write"), false);
});
