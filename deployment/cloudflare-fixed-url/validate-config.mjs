import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export function validateConfig(worker, service) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const exactKeys = (object, allowed) => {
    assert(object && typeof object === "object" && !Array.isArray(object));
    assert(Object.keys(object).every((key) => allowed.includes(key)), "Unexpected configuration field");
  };
  exactKeys(worker, ["$schema", "name", "main", "compatibility_date", "account_id", "workers_dev", "preview_urls", "vars", "vpc_services", "observability"]);
  assert.equal(worker.name, "drone-inspection-g10");
  assert.equal(worker.main, "worker.mjs");
  assert.equal(worker.workers_dev, true);
  assert.equal(worker.preview_urls, false);
  assert.match(worker.account_id, /^[a-f0-9]{32}$/i);
  assert.equal(worker.compatibility_date, "2026-09-22");
  exactKeys(worker.vars, ["PUBLIC_HOSTNAME"]);
  assert.match(worker.vars.PUBLIC_HOSTNAME, /^drone-inspection-g10\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/);
  assert.equal(worker.observability?.enabled, false);
  exactKeys(worker.observability, ["enabled"]);
  assert.equal(worker.vpc_services?.length, 1);
  exactKeys(worker.vpc_services[0], ["binding", "service_id"]);
  assert.equal(worker.vpc_services[0].binding, "SHARED_WEB");
  assert.match(worker.vpc_services[0].service_id, uuid);
  exactKeys(service, ["type", "name", "http_port", "host"]);
  assert.equal(service.type, "http");
  assert.equal(service.name, "drone-inspection-g10");
  assert.equal(service.http_port, 3000);
  exactKeys(service.host, ["ipv4", "network"]);
  assert.equal(service.host.ipv4, "127.0.0.1");
  exactKeys(service.host.network, ["tunnel_id"]);
  assert.match(service.host.network.tunnel_id, uuid);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [workerPath, servicePath] = process.argv.slice(2);
  if (!workerPath || !servicePath) {
    console.error("Usage: node validate-config.mjs <local-wrangler.json> <local-vpc-service.json>");
    process.exitCode = 2;
  } else {
    try {
      validateConfig(
        JSON.parse(await readFile(workerPath, "utf8")),
        JSON.parse(await readFile(servicePath, "utf8")),
      );
      console.log("Scope validated: one Worker binding; one HTTP service at 127.0.0.1:3000.");
      console.log("Live account permissions, plan, resource existence, deployment and approval remain separate checks.");
    } catch {
      console.error("Configuration rejected: check the example schema, identifiers, public hostname, and single loopback target.");
      process.exitCode = 1;
    }
  }
}
