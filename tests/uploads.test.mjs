import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUploadService, SESSION_TTL_MS } from "../server/uploads.mjs";
import { CHUNK_BYTES, receiveChunk } from "../server/upload-files.mjs";
import { diskInput } from "../server/disk-input.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = await readFile(
  new URL("../image/demo/demo-01.jpg", import.meta.url),
);
function database() {
  let state = {
    sessions: new Map(),
    chunks: new Map(),
    entities: new Map(),
    history: [],
  };
  const fault = { entity: false, commitResponse: false, commitBefore: false };
  const connection = () => {
    let tx = null;
    return {
      execute: async (sql, values = []) => {
        const s = tx || state;
        if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
        if (sql.includes("RELEASE_LOCK")) return [[]];
        if (sql.startsWith("SELECT data FROM upload_sessions"))
          return [
            [
              ...(s.sessions.has(values[0])
                ? [{ data: structuredClone(s.sessions.get(values[0])) }]
                : []),
            ],
          ];
        if (sql.startsWith("INSERT INTO upload_sessions"))
          s.sessions.set(values[0], JSON.parse(values[1]));
        else if (sql.startsWith("UPDATE upload_sessions"))
          s.sessions.set(values[1], JSON.parse(values[0]));
        else if (sql.startsWith("INSERT INTO upload_chunks")) {
          const key = `${values[0]}/${values[1]}`;
          assert.ok(!s.chunks.has(key), "duplicate chunk");
          s.chunks.set(key, { byte_length: values[2], sha256: values[3] });
        } else if (
          sql.startsWith("SELECT") &&
          sql.includes("FROM upload_chunks")
        )
          return [
            [
              ...(s.chunks.has(`${values[0]}/${values[1]}`)
                ? [s.chunks.get(`${values[0]}/${values[1]}`)]
                : []),
            ],
          ];
        else if (sql.startsWith("DELETE FROM upload_chunks"))
          for (const key of s.chunks.keys()) {
            if (key.startsWith(`${values[0]}/`)) s.chunks.delete(key);
          }
        else if (sql.startsWith("INSERT INTO entities")) {
          if (fault.entity) {
            fault.entity = false;
            throw new Error("injected entity write failure");
          }
          assert.ok(!s.entities.has(values[1]), "duplicate inspection");
          s.entities.set(values[1], JSON.parse(values[2]));
        } else if (sql.startsWith("INSERT INTO history"))
          s.history.push(JSON.parse(values[2]));
        else if (sql.startsWith("SELECT data FROM entities"))
          return [
            [
              ...(s.entities.has(values[0])
                ? [{ data: s.entities.get(values[0]) }]
                : []),
            ],
          ];
        else throw new Error(`Unexpected SQL: ${sql}`);
        return [{ affectedRows: 1 }];
      },
      beginTransaction: async () => {
        tx = structuredClone(state);
      },
      commit: async () => {
        if (fault.commitBefore) {
          fault.commitBefore = false;
          throw new Error("injected precommit failure");
        }
        state = tx;
        tx = null;
        if (fault.commitResponse) {
          fault.commitResponse = false;
          throw new Error("injected lost commit response");
        }
      },
      rollback: async () => {
        tx = null;
      },
      release: () => {},
    };
  };
  const pool = {
    getConnection: async () => connection(),
    execute: (...args) => connection().execute(...args),
    query: async (sql) =>
      sql.startsWith("CREATE")
        ? [[]]
        : [
            [...state.sessions.values()]
              .filter(
                (row) =>
                  row.status === "receiving" &&
                  Date.now() - Date.parse(row.updatedAt) >= SESSION_TTL_MS,
              )
              .map(({ id }) => ({ id })),
          ],
  };
  return { pool, fault, state: () => state };
}
async function setup(t, bytes = fixture) {
  const root = await mkdtemp(join(tmpdir(), "plantpilot-upload-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = database();
  const objects = new Map();
  const faults = { putResponse: false };
  let puts = 0;
  const client = {
    statObject: async (_, key) => {
      if (!objects.has(key))
        throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
      return { size: objects.get(key).length };
    },
    getObject: async (_, key) => Readable.from([objects.get(key)]),
    putObject: async (_, key, input) => {
      const parts = [];
      for await (const bytes of input) parts.push(bytes);
      objects.set(key, Buffer.concat(parts));
      puts++;
      if (faults.putResponse) {
        faults.putResponse = false;
        throw new Error("injected lost object response");
      }
    },
  };
  const options = {
    pool: db.pool,
    objects: client,
    bucket: "isolated-test",
    directory: root,
    validateRelation: async (plan, point, connection) => {
      assert.ok(connection, "validation must use the held connection");
    },
  };
  const service = await createUploadService(options);
  const input = {
    id: randomUUID(),
    name: "approved-demo.jpg",
    size: bytes.length,
    sha256: hash(bytes),
    pointId: null,
    planId: null,
  };
  const initialized = await service.initialize(input);
  async function send() {
    let current = await service.status(input.id);
    while (current.offset < bytes.length) {
      const part = bytes.subarray(current.offset, current.offset + CHUNK_BYTES);
      current = await service.chunk(
        input.id,
        current.offset,
        hash(part),
        Readable.from([part]),
      );
    }
    return current;
  }
  return {
    root,
    db,
    objects,
    faults,
    options,
    service,
    input,
    initialized,
    send,
    puts: () => puts,
  };
}

test("청크 재시도는 같은 내용만 허용하고, 부분 전송과 잘못된 위치는 확정 offset을 바꾸지 않는다", async (t) => {
  const bytes = Buffer.concat([fixture, Buffer.alloc(CHUNK_BYTES)]);
  const x = await setup(t, bytes);
  const part = bytes.subarray(0, CHUNK_BYTES);
  await assert.rejects(
    x.service.chunk(
      x.input.id,
      0,
      hash(part),
      Readable.from([part.subarray(0, 100)]),
    ),
    { status: 422 },
  );
  assert.equal((await x.service.status(x.input.id)).offset, 0);
  await x.service.chunk(x.input.id, 0, hash(part), Readable.from([part]));
  assert.equal(
    (await x.service.chunk(x.input.id, 0, hash(part), Readable.from([part])))
      .offset,
    CHUNK_BYTES,
  );
  const changed = Buffer.from(part);
  changed[100] ^= 1;
  await assert.rejects(
    x.service.chunk(x.input.id, 0, hash(changed), Readable.from([changed])),
    { status: 409 },
  );
  await assert.rejects(
    x.service.chunk(
      x.input.id,
      CHUNK_BYTES + 1,
      hash(part),
      Readable.from([part]),
    ),
    { status: 409 },
  );
  await assert.rejects(
    x.service.initialize({ ...x.input, sha256: hash(changed) }),
    { status: 409 },
  );
  assert.equal((await x.service.status(x.input.id)).offset, CHUNK_BYTES);
});

test("청크 COMMIT 응답 손실은 확정 파일을 보존하고 COMMIT 전 실패만 꼬리를 복구한다", async (t) => {
  const x = await setup(t);
  x.db.fault.commitBefore = true;
  await assert.rejects(x.send(), /precommit/);
  assert.equal((await x.service.status(x.input.id)).offset, 0);
  assert.equal((await stat(join(x.root, `${x.input.id}.upload`))).size, 0);
  x.db.fault.commitResponse = true;
  await assert.rejects(x.send(), /lost commit/);
  const restarted = await createUploadService(x.options);
  assert.equal((await restarted.status(x.input.id)).offset, fixture.length);
  assert.equal(
    hash(await readFile(join(x.root, `${x.input.id}.upload`))),
    x.input.sha256,
  );
});

test("원본 객체 저장 뒤 응답 손실과 DB 실패는 같은 검사 ID로 복구하며 객체를 중복 쓰지 않는다", async (t) => {
  const x = await setup(t);
  await x.send();
  x.faults.putResponse = true;
  await assert.rejects(x.service.finish(x.input.id), /lost object/);
  assert.equal(x.db.state().entities.size, 0);
  x.db.fault.entity = true;
  await assert.rejects(x.service.finish(x.input.id), /entity write/);
  assert.equal(x.db.state().history.length, 0);
  const restarted = await createUploadService(x.options);
  const result = await restarted.finish(x.input.id);
  const retried = await restarted.finish(x.input.id);
  assert.equal(result.photo.id, x.initialized.inspectionId);
  assert.equal(retried.photo.id, result.photo.id);
  assert.equal(x.puts(), 1);
  assert.equal(x.db.state().entities.size, 1);
  assert.equal(x.db.state().history.length, 1);
  assert.equal(hash(x.objects.get(`uploads/${x.input.id}`)), x.input.sha256);
});

test("최종 COMMIT 응답 손실과 동시 완료 요청은 사진과 등록 이력을 한 번만 남긴다", async (t) => {
  const x = await setup(t);
  await x.send();
  x.db.fault.commitResponse = true;
  const [a, b] = await Promise.all([
    x.service.finish(x.input.id),
    x.service.finish(x.input.id),
  ]);
  assert.equal(a.photo.id, b.photo.id);
  assert.equal(x.db.state().history.length, 1);
  assert.equal(x.puts(), 1);
  assert.equal(
    (await readdir(x.root)).filter((name) => name.endsWith(".upload")).length,
    0,
  );
});

test("다른 내용의 기존 객체를 덮어쓰지 않으며 만료·재시작은 동일 검사 ID를 보존한다", async (t) => {
  const x = await setup(t);
  await x.send();
  x.objects.set(`uploads/${x.input.id}`, Buffer.alloc(fixture.length));
  await assert.rejects(x.service.finish(x.input.id), { status: 409 });
  assert.equal(x.puts(), 0);
  assert.equal(x.db.state().entities.size, 0);
  const y = await setup(t);
  await y.send();
  y.db.state().sessions.get(y.input.id).updatedAt = new Date(
    Date.now() - SESSION_TTL_MS - 1,
  ).toISOString();
  await y.service.cleanup();
  assert.equal((await y.service.status(y.input.id)).status, "expired");
  const reset = await y.service.restart(y.input.id, y.input.sha256);
  assert.equal(reset.inspectionId, y.initialized.inspectionId);
  assert.equal(reset.offset, 0);
  await y.send();
  assert.equal(
    (await y.service.finish(y.input.id)).photo.id,
    reset.inspectionId,
  );
});

test("원시 수신 도중 끊긴 스트림은 임시 파일을 지우고 성공한 파일은 호출자가 해제한다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plantpilot-raw-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = await diskInput(root);
  const broken = Readable.from(
    (async function* () {
      yield fixture.subarray(0, 100);
      throw new Error("disconnected");
    })(),
  );
  await assert.rejects(disk.receive(broken), /disconnected/);
  assert.deepEqual(await readdir(root), []);
  const file = await disk.receive(Readable.from([fixture]));
  assert.equal(hash(await readFile(file.path)), hash(fixture));
  await disk.remove(file.path);
  assert.deepEqual(await readdir(root), []);
});

test("수신을 시작한 직후 원본 스트림이 끊겨도 잡히지 않은 오류나 임시 파일을 남기지 않는다", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "plantpilot-early-disconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disk = await diskInput(root);
  for (const receive of [
    (stream) => disk.receive(stream),
    (stream) => receiveChunk(stream, root, 10, "0".repeat(64), randomUUID()),
  ]) {
    const source = new PassThrough();
    const pending = receive(source);
    source.destroy(new Error("early disconnect"));
    await assert.rejects(pending, /early disconnect/);
  }
  assert.deepEqual(await readdir(root), []);
});

test("느린 청크 네 개가 수신 중이면 추가 수신은 DB 연결을 점유하기 전에 503으로 재시도를 안내한다", async (t) => {
  const x = await setup(t);
  const sessions = [x.initialized];
  for (let i = 0; i < 4; i++)
    sessions.push(await x.service.initialize({ ...x.input, id: randomUUID() }));
  const sources = sessions.slice(0, 4).map(() => new PassThrough());
  const receiving = sources.map((source, index) =>
    x.service
      .chunk(sessions[index].id, 0, hash(fixture), source)
      .catch((error) => error),
  );
  await assert.rejects(
    x.service.chunk(sessions[4].id, 0, hash(fixture), Readable.from([fixture])),
    { status: 503 },
  );
  for (const source of sources) source.destroy(new Error("stop slow test"));
  for (const result of await Promise.all(receiving))
    assert.ok(result instanceof Error);
  const last = await x.service.chunk(
    sessions[4].id,
    0,
    hash(fixture),
    Readable.from([fixture]),
  );
  assert.equal(last.offset, fixture.length);
});

test("기록 목적은 전송 재시도 중 바뀌지 않고 기존 미분류 세션은 업무 검사로 이어진다", async (t) => {
  const x = await setup(t, fixture);
  delete x.db.state().sessions.get(x.input.id).recordPurpose;
  assert.equal(
    (await x.service.initialize({ ...x.input, recordPurpose: "inspection" }))
      .recordPurpose,
    "inspection",
  );
  await assert.rejects(
    x.service.initialize({ ...x.input, recordPurpose: "verification" }),
    { status: 409 },
  );
  await x.send();
  assert.equal(
    (await x.service.finish(x.input.id)).photo.recordPurpose,
    "inspection",
  );
  const input = { ...x.input, id: randomUUID(), recordPurpose: "verification" };
  await x.service.initialize(input);
  await x.service.chunk(input.id, 0, hash(fixture), Readable.from([fixture]));
  const saved = await x.service.finish(input.id);
  assert.equal(saved.photo.recordPurpose, "verification");
  assert.equal(saved.photo.visibility, "visible");
  assert.equal((await x.service.initialize(input)).photo.id, saved.photo.id);
  await assert.rejects(
    x.service.initialize({ ...input, recordPurpose: "presentation" }),
    { status: 409 },
  );
});
