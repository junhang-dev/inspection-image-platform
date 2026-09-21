import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "./worker.mjs";

const host = "drone-inspection-g10.test-account.workers.dev";
const request = (path, init) => new Request("https://" + host + path, init);
const environment = (fetch) => ({ PUBLIC_HOSTNAME: host, SHARED_WEB: { fetch } });

test("forwards GET path, query and public Host through the single binding", async () => {
  let call;
  const response = await worker.fetch(
    request("/api/inspections/query?recordPurpose=all&search=%EA%B2%80%EC%82%AC"),
    environment(async (input) => {
      call = input;
      return Response.json({ total: 9 });
    }),
  );
  assert.equal(call.url, "http://" + host + "/api/inspections/query?recordPurpose=all&search=%EA%B2%80%EC%82%AC");
  assert.equal(call.headers.get("host"), host);
  assert.equal(call.headers.get("x-forwarded-proto"), "https");
  assert.equal(call.redirect, "manual");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { total: 9 });
});

test("preserves one full 4 MiB upload chunk and SHA header without aggregating files", async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(37);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let callCount = 0;
  const response = await worker.fetch(
    request("/api/upload-sessions/test/chunks?offset=4194304", {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash },
      body: bytes,
    }),
    environment(async (input) => {
      callCount++;
      assert.equal(input.method, "PUT");
      assert.equal(input.headers.get("content-type"), "application/octet-stream");
      assert.equal(input.headers.get("x-chunk-sha256"), hash);
      const received = new Uint8Array(await input.arrayBuffer());
      assert.equal(received.byteLength, bytes.byteLength);
      assert.equal(createHash("sha256").update(received).digest("hex"), hash);
      return Response.json({ offset: 8388608 });
    }),
  );
  assert.equal(callCount, 1);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { offset: 8388608 });
});

test("preserves JSON completion body and backend conflict status", async () => {
  const body = JSON.stringify({ expectedVersion: 4, reason: "contract fixture" });
  const result = await worker.fetch(request("/api/upload-sessions/test/complete", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }), environment(async (input) => {
    assert.equal(await input.text(), body);
    return Response.json({ error: "conflict" }, { status: 409 });
  }));
  assert.equal(result.status, 409);
});

test("passes OPTIONS headers and empty response through without claiming upload success", async () => {
  const result = await worker.fetch(request("/api/upload-sessions/test/chunks", {
    method: "OPTIONS",
    headers: { Origin: "https://" + host, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type,x-chunk-sha256" },
  }), environment(async (input) => {
    assert.equal(input.method, "OPTIONS");
    assert.equal(input.headers.get("access-control-request-method"), "PUT");
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "https://" + host } });
  }));
  assert.equal(result.status, 204);
  assert.equal(result.headers.get("access-control-allow-origin"), "https://" + host);
});

test("does not follow or rewrite an origin redirect", async () => {
  const result = await worker.fetch(request("/"), environment(async (input) => {
    assert.equal(input.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "/login" } });
  }));
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/login");
});

test("streams an API response before the remaining body is available", async () => {
  let controller;
  const source = new ReadableStream({ start(value) { controller = value; } });
  const result = await worker.fetch(request("/api/inspections/test/image"), environment(async () => new Response(source)));
  const reader = result.body.getReader();
  controller.enqueue(new Uint8Array([1, 2, 3]));
  assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
  controller.close();
  assert.equal((await reader.read()).done, true);
});

test("rejects another host, explicit port, or missing binding without an origin request", async () => {
  const env = environment(async () => assert.fail("must not call origin"));
  assert.equal((await worker.fetch(new Request("https://other.workers.dev/"), env)).status, 421);
  assert.equal((await worker.fetch(new Request("https://" + host + ":8443/"), env)).status, 421);
  assert.equal((await worker.fetch(request("/"), {})).status, 503);
});

test("returns a retryable generic failure without leaking origin details", async () => {
  const result = await worker.fetch(request("/api/health"), environment(async () => { throw new Error("private path or credential"); }));
  assert.equal(result.status, 503);
  assert.equal(result.headers.get("retry-after"), "5");
  assert.equal((await result.text()).includes("credential"), false);
});

test("retains an upgrade object; real WebSocket transport still requires deployment verification", async () => {
  const upgrade = { status: 101, webSocket: { testOnly: true } };
  assert.equal(await worker.fetch(request("/api/socket"), environment(async () => upgrade)), upgrade);
});
