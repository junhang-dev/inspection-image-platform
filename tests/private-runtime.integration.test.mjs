import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { request } from "node:http";
import express from "express";
import multer from "multer";
import { Client } from "minio";
import { withPrivateImportLease } from "../server/private-import-lease.mjs";
import { withVerifiedModelInput } from "../server/verified-model-input.mjs";
import { predictStream } from "../server/model-input.mjs";
import { pool, get, insertEntity } from "../server/store.mjs";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract, digest } from "../server/dataset-contract.mjs";

test(
  "synthetic HTTP boundaries, restart recovery, verified worker input and explicit frozen inference",
  {
    skip: process.env.PRIVATE_IMPORT_INTEGRATION !== "1",
    timeout: 120000,
  },
  async () => {
    assert.equal(process.env.API_PORT, "4300");
    assert.equal(process.env.MYSQL_PORT, "13308");
    assert.match(
      process.env.DATASET_PLAN_PATH,
      /private-verification\/fixture\//,
    );
    const dataset = await loadDatasetContract(runtimeProfile());
    const [rows] = await pool.query(
      "SELECT data FROM entities WHERE kind='inspection'",
    );
    const photos = rows.map((r) =>
      typeof r.data === "string" ? JSON.parse(r.data) : r.data,
    );
    assert.equal(photos.length, 300, "run the synthetic SQL fixture first");
    const protectedPhoto = photos.find((p) => p.sourceId === "FIX-290");
    const normal = photos.find((p) => p.sourceId === "FIX-002");
    const protectedBytes = await readFile(
      `${dataset.plan.source_root_reference}/FIX-290.png`,
    );
    const protectedHashes = new Set(
      dataset.plan.entries
        .filter((e) => e.canonicalSplit === "test")
        .map((e) => e.sha256),
    );
    const calls = [];
    let heldRequest;
    let disconnected;
    const stub = express();
    stub.get("/health", (_req, res) =>
      res.json({ ...dataset.freeze, ready: true }),
    );
    stub.post(
      "/predict",
      multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 1024 * 1024 },
      }).single("image"),
      (req, res) => {
        calls.push(digest(req.file.buffer));
        if (heldRequest) {
          res.on("close", () => disconnected?.());
          heldRequest();
          return;
        }
        res.json({
          grade: 2,
          confidence: 0.75,
          model_version: dataset.freeze.model_version,
          preprocessing_version: dataset.freeze.preprocessing_version,
        });
      },
    );
    const server = await new Promise((resolve) => {
      const s = stub.listen(8101, "127.0.0.1", () => resolve(s));
    });
    let api;
    const run = async (args) => {
      const child = spawn(process.execPath, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      const code = await new Promise((resolve) => child.on("close", resolve));
      assert.equal(code, 0, output);
      return output;
    };
    const base = "http://127.0.0.1:4300";
    const json = async (path, method = "GET", body) =>
      fetch(base + path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    try {
      // Persist processing before API startup; recovery must refuse a protected job.
      await pool.execute(
        "UPDATE entities SET data=JSON_SET(data,'$.status','processing') WHERE kind='inspection' AND id=?",
        [protectedPhoto.id],
      );
      const changed = {
        ...normal,
        id: randomUUID(),
        sourceId: null,
        datasetManifestSha256: null,
        inferencePolicy: null,
        ai: null,
        aiProvenance: null,
        status: "pending",
        objectKey: protectedPhoto.objectKey,
        sha256: normal.sha256,
        size: protectedPhoto.size,
      };
      await insertEntity(
        pool,
        "inspection",
        changed,
        "합성 검증",
        "저장 객체 교체 차단",
      );
      api = spawn(process.execPath, ["server/index.mjs"], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      api.stdout.on("data", (b) => (output += b));
      api.stderr.on("data", (b) => (output += b));
      for (let i = 0; i < 80; i++) {
        if (
          await fetch(base + "/api/health")
            .then((r) => r.ok)
            .catch(() => false)
        )
          break;
        assert.equal(api.exitCode, null, output);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal((await json("/api/health")).status, 200, output);
      for (const headers of [
        { host: "external.example" },
        { "x-forwarded-host": "external.example" },
        { "x-forwarded-for": "203.0.113.1" },
        { "cf-connecting-ip": "127.0.0.1" },
        { origin: "https://external.example" },
      ])
        assert.equal(
          await new Promise((resolve, reject) => {
            const req = request(base + "/api/health", { headers }, (res) => {
              res.resume();
              resolve(res.statusCode);
            });
            req.on("error", reject);
            req.end();
          }),
          403,
          JSON.stringify(headers),
        );
      const form = new FormData();
      form.append("uploadIds", JSON.stringify([randomUUID()]));
      form.append(
        "images",
        new Blob([protectedBytes], { type: "image/png" }),
        "renamed-train.png",
      );
      assert.equal(
        (await fetch(base + "/api/inspections", { method: "POST", body: form }))
          .status,
        422,
      );
      const input = {
        id: randomUUID(),
        name: "renamed.png",
        size: protectedBytes.length,
        sha256: digest(protectedBytes),
        pointId: null,
        planId: null,
      };
      assert.equal(
        (await json("/api/upload-sessions", "POST", input)).status,
        422,
      );
      const disguised = { ...input, id: randomUUID(), sha256: normal.sha256 };
      assert.equal(
        (await json("/api/upload-sessions", "POST", disguised)).status,
        200,
      );
      assert.equal(
        (
          await fetch(
            base + `/api/upload-sessions/${disguised.id}/chunks?offset=0`,
            {
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "X-Chunk-Sha256": digest(protectedBytes),
              },
              body: protectedBytes,
            },
          )
        ).status,
        200,
      );
      assert.equal(
        (await json(`/api/upload-sessions/${disguised.id}/complete`, "POST"))
          .status,
        422,
      );
      for (const photo of [protectedPhoto, normal])
        assert.equal(
          (await json(`/api/inspections/${photo.id}/retry`, "POST")).status,
          409,
        );
      for (let i = 0; i < 80; i++) {
        if ((await get("inspection", changed.id)).status === "error") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal((await get("inspection", changed.id)).status, "error");
      assert.equal(
        (await get("inspection", protectedPhoto.id)).status,
        "unread",
      );
      assert.equal(
        calls.length,
        0,
        "protected, altered or merely queued originals never reach model",
      );
      const cached = photos.filter((p) => p.ai);
      const first = await run(["scripts/infer-private.mjs", "--apply"]);
      assert.match(first, /"modelCalls":59/);
      assert.equal(calls.length, 59);
      assert.ok(calls.every((hash) => !protectedHashes.has(hash)));
      for (const photo of cached) {
        const now = await get("inspection", photo.id);
        assert.deepEqual(now.ai, photo.ai);
        assert.deepEqual(now.aiProvenance, photo.aiProvenance);
      }
      assert.equal((await get("inspection", protectedPhoto.id)).ai, null);
      const [before] = await pool.query("SELECT * FROM history ORDER BY id");
      assert.match(
        await run(["scripts/infer-private.mjs", "--apply"]),
        /"modelCalls":0/,
      );
      assert.equal(calls.length, 59);
      assert.deepEqual(
        (await pool.query("SELECT * FROM history ORDER BY id"))[0],
        before,
      );
      // Loss during a real HTTP response wait aborts fetch; it cannot commit or
      // leave the old client running alongside the next lease.
      const received = new Promise((resolve) => {
        heldRequest = resolve;
      });
      const closed = new Promise((resolve) => {
        disconnected = resolve;
      });
      const objects = new Client({
        endPoint: "127.0.0.1",
        port: 19002,
        useSSL: false,
        accessKey: process.env.MINIO_ACCESS_KEY,
        secretKey: process.env.MINIO_SECRET_KEY,
      });
      let lockId;
      const pending = withPrivateImportLease(pool, async (lease) => {
        lockId = (await lease.db.query("SELECT CONNECTION_ID() AS id"))[0][0]
          .id;
        const photo = { ...normal, ai: null };
        await withVerifiedModelInput(
          {
            objects,
            bucket: process.env.MINIO_BUCKET,
            photo,
            directory: process.env.UPLOAD_TEMP_DIR,
            decide: dataset.policy.explicitImportInference,
            signal: lease.signal,
          },
          (stream) =>
            predictStream("http://127.0.0.1:8101", stream, photo, {
              signal: lease.signal,
            }),
        );
        assert.fail("lost lease must not finish inference");
      });
      const rejected = assert.rejects(
        pending,
        /잠금 연결|aborted|closed|connection/i,
      );
      await received;
      await pool.query(`KILL CONNECTION ${Number(lockId)}`);
      await rejected;
      await Promise.race([
        closed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("model fetch was not cancelled")),
            3000,
          ),
        ),
      ]);
      await withPrivateImportLease(pool, (lease) => lease.assertOwned());
      assert.deepEqual(
        (await pool.query("SELECT * FROM history ORDER BY id"))[0],
        before,
      );
    } finally {
      if (api && api.exitCode === null) {
        api.kill("SIGTERM");
        await new Promise((r) => api.on("close", r));
      }
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    }
  },
);
