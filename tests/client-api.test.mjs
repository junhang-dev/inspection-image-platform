import test from "node:test";
import assert from "node:assert/strict";
import { requestJson } from "../src/lib/api.ts";

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
