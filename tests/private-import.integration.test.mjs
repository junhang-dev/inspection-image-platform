import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "minio";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { pool, initializeStore, update } from "../server/store.mjs";
import { runtimeProfile } from "../server/runtime-profile.mjs";
import { loadDatasetContract } from "../server/dataset-contract.mjs";
import {
  initializePrivateRegistry,
  reservePrivateImport,
  ensurePrivateParents,
  commitPrivatePhoto,
  readPrivateRegistry,
} from "../server/private-import-store.mjs";
import { withPrivateImportLease } from "../server/private-import-lease.mjs";
import {
  storePrivateOriginal,
  cleanupPrivateImportScratch,
} from "../server/private-original.mjs";

test(
  "private synthetic SQL import: rollback, resume, aliases, cached provenance and lost lease",
  {
    skip: process.env.PRIVATE_IMPORT_INTEGRATION !== "1",
    timeout: 120000,
  },
  async () => {
    assert.equal(
      process.env.MYSQL_PORT,
      "13308",
      "dedicated synthetic instance required",
    );
    assert.match(
      process.env.DATASET_PLAN_PATH,
      /private-verification\/fixture\//,
    );
    const dataset = await loadDatasetContract(runtimeProfile());
    assert.ok(dataset.plan.entries.every((e) => e.sourceId.startsWith("FIX-")));
    const objects = new Client({
      endPoint: "127.0.0.1",
      port: 19002,
      useSSL: false,
      accessKey: process.env.MINIO_ACCESS_KEY,
      secretKey: process.env.MINIO_SECRET_KEY,
    });
    const bucket = process.env.MINIO_BUCKET;
    const directory = process.env.UPLOAD_TEMP_DIR;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const source = new Map(dataset.plan.entries.map((e) => [e.sourceId, e]));
    const raw = async () => {
      const result = {};
      for (const table of [
        "entities",
        "history",
        "private_import_registry",
        "private_import_parents",
        "private_import_aliases",
      ]) {
        const [rows] = await pool.query(`SELECT * FROM ${table}`);
        result[table] = rows.map((row) => JSON.stringify(row)).sort();
      }
      return result;
    };
    try {
      await initializeStore(dataset.policy, { recover: false });
      await initializePrivateRegistry(pool);
      const [existing] = await pool.query(
        "SELECT JSON_UNQUOTE(JSON_EXTRACT(data,'$.sourceId')) AS source, JSON_UNQUOTE(JSON_EXTRACT(data,'$.sha256')) AS sha256 FROM entities WHERE kind='inspection'",
      );
      assert.ok(
        existing.every(
          (row) =>
            row.source?.startsWith("FIX-") ||
            dataset.plan.entries.some((e) => e.sha256 === row.sha256),
        ),
        "never reset non-fixture records",
      );
      for (const table of [
        "history",
        "entities",
        "private_import_registry",
        "private_import_parents",
        "private_import_aliases",
      ])
        await pool.query(`TRUNCATE TABLE ${table}`);
      let registry;
      await withPrivateImportLease(pool, async (lease) => {
        await initializeStore(dataset.policy, {
          connection: lease.db,
          recover: false,
        });
        await initializePrivateRegistry(lease.db);
        registry = await reservePrivateImport(lease.db, dataset);
        await ensurePrivateParents(lease.db, dataset);
        assert.equal(registry.length, 300);
        const before = await raw();
        await assert.rejects(
          commitPrivatePhoto(
            lease.db,
            dataset,
            registry[0],
            source.get(registry[0].sourceId),
            { mime: "image/png", failBeforeCommit: true },
          ),
          /synthetic failure/,
        );
        assert.deepEqual(
          await raw(),
          before,
          "failure commits no photo, history or registry completion",
        );
        for (const row of registry.slice(0, 6)) {
          const entry = source.get(row.sourceId);
          const object = await storePrivateOriginal(
            objects,
            bucket,
            row,
            entry,
            dataset.plan.source_root_reference,
            directory,
            lease,
          );
          await commitPrivatePhoto(lease.db, dataset, row, entry, object);
        }
      });
      // A separate run uses the exact already-reserved random IDs and object keys.
      await withPrivateImportLease(pool, async (lease) => {
        const resumed = await reservePrivateImport(lease.db, dataset);
        assert.deepEqual(
          resumed.map((r) => [
            r.inspectionId,
            r.pointId,
            r.planId,
            r.objectKey,
          ]),
          registry.map((r) => [
            r.inspectionId,
            r.pointId,
            r.planId,
            r.objectKey,
          ]),
        );
        for (const row of resumed) {
          const entry = source.get(row.sourceId);
          const object = await storePrivateOriginal(
            objects,
            bucket,
            row,
            entry,
            dataset.plan.source_root_reference,
            directory,
            lease,
          );
          await commitPrivatePhoto(lease.db, dataset, row, entry, object);
        }
      });
      await update(
        "inspection",
        registry[0].inspectionId,
        { humanGrade: 4, retake: true },
        "합성 검증",
        "재실행 보존 확인",
        { expectedVersion: 0 },
      );
      const saved = await raw();
      await withPrivateImportLease(pool, async (lease) => {
        await ensurePrivateParents(lease.db, dataset);
        for (const row of await reservePrivateImport(lease.db, dataset))
          assert.equal(
            (
              await commitPrivatePhoto(
                lease.db,
                dataset,
                row,
                source.get(row.sourceId),
                { mime: "image/png" },
              )
            ).created,
            false,
          );
      });
      assert.deepEqual(
        await raw(),
        saved,
        "completed replay preserves every user field, timestamp and history byte",
      );
      const [photos] = await pool.query(
        "SELECT data FROM entities WHERE kind='inspection'",
      );
      const data = photos.map((r) =>
        typeof r.data === "string" ? JSON.parse(r.data) : r.data,
      );
      assert.equal(data.length, 300);
      assert.equal(new Set(data.map((p) => p.objectKey)).size, 299);
      assert.equal(data.filter((p) => p.ai).length, 240);
      assert.equal(data.filter((p) => p.status === "unread").length, 60);
      assert.ok(
        data
          .filter((p) => p.ai)
          .every(
            (p) => p.ai.grade === 3 && p.aiProvenance.predictedAt === null,
          ),
      );
      assert.equal(data.filter((p) => p.protectedEvaluation).length, 10);
      assert.ok(data.every((p) => !dataset.policy.queue(p).allowed));
      const [aliases] = await pool.query(
        "SELECT COUNT(*) AS n FROM private_import_aliases",
      );
      assert.equal(aliases[0].n, 5);
      assert.ok(
        (await readPrivateRegistry(pool, dataset.manifestSha256)).every(
          (r) => r.state === "complete",
        ),
      );

      let started;
      const copying = new Promise((resolve) => {
        started = resolve;
      });
      let connectionId;
      const scratchRoot = await mkdtemp(join(directory, "import-run-"));
      let calls = 0;
      const stalled = {
        statObject: async () => ({
          size: source.get(registry[0].sourceId).size_bytes,
        }),
        getObject: async () => {
          started();
          return new Readable({ read() {} });
        },
        putObject: async () => {
          calls++;
        },
      };
      const interrupted = withPrivateImportLease(pool, async (lease) => {
        const [rows] = await lease.db.query("SELECT CONNECTION_ID() AS id");
        connectionId = rows[0].id;
        await storePrivateOriginal(
          stalled,
          bucket,
          registry[0],
          source.get(registry[0].sourceId),
          dataset.plan.source_root_reference,
          scratchRoot,
          lease,
        );
        await lease.db.query(
          "INSERT INTO entities VALUES ('unreachable','unreachable','{}',NOW())",
        );
      });
      const rejection = assert.rejects(
        interrupted,
        /잠금 연결|aborted|closed|connection/i,
      );
      await copying;
      await pool.query(`KILL CONNECTION ${Number(connectionId)}`);
      await withPrivateImportLease(pool, async () => {
        await cleanupPrivateImportScratch(directory);
        await access(scratchRoot); // another execution never blindly removes fresh scratch
      });
      await rejection;
      assert.equal(calls, 0);
      assert.deepEqual(await raw(), saved);
      await rm(scratchRoot, { recursive: true, force: true });
    } finally {
      await pool.end();
    }
  },
);
