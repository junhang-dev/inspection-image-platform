import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateConfig } from "./validate-config.mjs";

async function fixture() {
  const worker = JSON.parse(await readFile(new URL("./wrangler.example.json", import.meta.url), "utf8"));
  const service = JSON.parse(await readFile(new URL("./vpc-service.example.json", import.meta.url), "utf8"));
  worker.account_id = "0".repeat(32);
  worker.vars.PUBLIC_HOSTNAME = "drone-inspection-g10.test-account.workers.dev";
  worker.vpc_services[0].service_id = "00000000-0000-4000-8000-000000000001";
  service.host.network.tunnel_id = "00000000-0000-4000-8000-000000000002";
  return { worker, service };
}

test("accepts a populated fixture for exactly the shared web binding", async () => {
  const { worker, service } = await fixture();
  assert.doesNotThrow(() => validateConfig(worker, service));
});

test("rejects unfilled templates before any deployment", async () => {
  const worker = JSON.parse(await readFile(new URL("./wrangler.example.json", import.meta.url), "utf8"));
  const service = JSON.parse(await readFile(new URL("./vpc-service.example.json", import.meta.url), "utf8"));
  assert.throws(() => validateConfig(worker, service));
});

test("rejects private services, database, object storage and direct model ports", async () => {
  for (const port of [3100, 4100, 4000, 3307, 9000, 9001, 8001]) {
    const { worker, service } = await fixture();
    service.http_port = port;
    assert.throws(() => validateConfig(worker, service));
  }
});

test("rejects network-wide, additional and arbitrary host bindings", async () => {
  const { worker, service } = await fixture();
  assert.throws(() => validateConfig({ ...worker, vpc_networks: [{}] }, service));
  assert.throws(() => validateConfig({ ...worker, vpc_services: [...worker.vpc_services, ...worker.vpc_services] }, service));
  assert.throws(() => validateConfig(worker, { ...service, host: { ...service.host, ipv4: "10.0.0.2" } }));
});

test("rejects route, raw secret and request logging fields outside the reviewed schema", async () => {
  const { worker, service } = await fixture();
  assert.throws(() => validateConfig({ ...worker, routes: ["*.example.com/*"] }, service));
  assert.throws(() => validateConfig({ ...worker, vars: { ...worker.vars, TOKEN: "test-only" } }, service));
  assert.throws(() => validateConfig({ ...worker, observability: { enabled: true } }, service));
});

test("rejects a public hostname outside the named workers.dev application", async () => {
  const { worker, service } = await fixture();
  worker.vars.PUBLIC_HOSTNAME = "another-worker.test-account.workers.dev";
  assert.throws(() => validateConfig(worker, service));
});
