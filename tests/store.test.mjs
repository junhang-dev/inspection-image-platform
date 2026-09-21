import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntity, insertBatch, pool, update } from "../server/store.mjs";

test("목록 밖 기존 사진을 재사용하는 경로도 같은 초기 수정 버전을 반환한다", () => {
  assert.deepEqual(decodeEntity('{"id":"legacy"}'), {
    id: "legacy",
    editVersion: 0,
  });
  assert.deepEqual(decodeEntity({ id: "saved", editVersion: 4 }), {
    id: "saved",
    editVersion: 4,
  });
});

test("COMMIT 이전 실패만 안전한 보상 삭제 대상으로 구분한다", async () => {
  const original = pool.getConnection;
  let rolledBack = false;
  let released = false;
  pool.getConnection = async () => ({
    beginTransaction: async () => {},
    execute: async () => {
      throw new Error("injected statement failure");
    },
    commit: async () => {
      assert.fail("실패 후 COMMIT을 호출하면 안 됩니다.");
    },
    rollback: async () => {
      rolledBack = true;
    },
    release: () => {
      released = true;
    },
  });
  try {
    await assert.rejects(
      insertBatch(
        "inspection",
        [{ objectKey: "test-only" }],
        "검증",
        "트랜잭션 검증",
      ),
      (error) => error.commitUncertain === false,
    );
    assert.ok(rolledBack && released);
  } finally {
    pool.getConnection = original;
  }
});

test("COMMIT 응답이 끊기면 원본 보존을 위한 불확실 상태를 전달한다", async () => {
  const original = pool.getConnection;
  let released = false;
  pool.getConnection = async () => ({
    beginTransaction: async () => {},
    execute: async () => {},
    commit: async () => {
      throw new Error("injected lost commit response");
    },
    rollback: async () => {
      throw new Error("connection unavailable");
    },
    release: () => {
      released = true;
    },
  });
  try {
    await assert.rejects(
      insertBatch(
        "inspection",
        [{ objectKey: "test-only" }],
        "검증",
        "응답 손실 검증",
      ),
      (error) =>
        error.commitUncertain === true &&
        error.message === "injected lost commit response",
    );
    assert.ok(released);
  } finally {
    pool.getConnection = original;
  }
});

async function withStoredEntity(initial, check) {
  const original = pool.getConnection;
  const state = { entity: initial, history: [], commits: 0, rollbacks: 0 };
  pool.getConnection = async () => ({
    beginTransaction: async () => {},
    execute: async (sql, values) => {
      if (sql.startsWith("SELECT")) {
        assert.match(sql, /FOR UPDATE$/);
        return [[{ data: structuredClone(state.entity) }]];
      }
      if (sql.startsWith("UPDATE entities"))
        state.entity = JSON.parse(values[0]);
      else if (sql.startsWith("INSERT INTO history"))
        state.history.push(JSON.parse(values[2]));
      else assert.fail(`알 수 없는 쓰기: ${sql}`);
      return [{ affectedRows: 1 }];
    },
    commit: async () => {
      state.commits++;
    },
    rollback: async () => {
      state.rollbacks++;
    },
    release: () => {},
  });
  try {
    await check(state);
  } finally {
    pool.getConnection = original;
  }
}

test("잠긴 최신 버전과 다르면 actor 이름과 무관하게 데이터·이력을 쓰지 않는다", async () => {
  const before = { id: "test-photo", editVersion: 1, retake: true };
  await withStoredEntity(before, async (state) => {
    await assert.rejects(
      update(
        "inspection",
        before.id,
        { retake: false },
        "AI 서비스",
        "오래된 폼",
        { expectedVersion: 0 },
      ),
      (error) => error.status === 409,
    );
    assert.deepEqual(state.entity, before);
    assert.equal(state.history.length, 0);
    assert.equal(state.commits, 0);
    assert.equal(state.rollbacks, 1);
  });
});

test("기존 무버전 행은 0으로 저장하며 AI 갱신 전후 사람 값·버전을 보존한다", async () => {
  const before = {
    id: "test-photo",
    humanGrade: null,
    retake: false,
    status: "pending",
  };
  await withStoredEntity(before, async (state) => {
    await update(
      "inspection",
      before.id,
      { status: "processing" },
      "AI 서비스",
      "판독 시작",
      { inference: true },
    );
    assert.equal(state.entity.editVersion, 0);
    const saved = await update(
      "inspection",
      before.id,
      { humanGrade: 3, retake: true },
      "검증",
      "판독 중 사람 판단",
      { expectedVersion: 0 },
    );
    assert.equal(saved.editVersion, 1);
    const ai = { grade: 4, confidence: 0.8, model_version: "test" };
    await update(
      "inspection",
      before.id,
      { status: "done", ai, error: null },
      "AI 서비스",
      "판독 완료",
      { inference: true },
    );
    assert.equal(state.entity.editVersion, 1);
    assert.equal(state.entity.humanGrade, 3);
    assert.equal(state.entity.retake, true);
    assert.deepEqual(state.entity.ai, ai);
    assert.equal(state.history.length, 3);
    assert.equal(state.history[1].before.editVersion, 0);
    assert.equal(state.history[1].after.editVersion, 1);
    assert.equal(state.history[2].after.editVersion, 1);
    assert.ok(
      state.history.every((event) => !("expectedVersion" in event.after)),
    );
  });
});

test("버전 누락·잘못된 값·주입 및 내부 판독의 업무 필드 변경은 DB 접근 전에 거절한다", async () => {
  const original = pool.getConnection;
  pool.getConnection = async () =>
    assert.fail("잘못된 요청은 DB에 접근하면 안 됩니다.");
  try {
    for (const expectedVersion of [
      undefined,
      -1,
      0.5,
      "0",
      Number.MAX_SAFE_INTEGER,
    ])
      await assert.rejects(
        update("point", "test", { managed: true }, "검증", "버전 검증", {
          expectedVersion,
        }),
        (error) => error.status === 422,
      );
    for (const patch of [{ editVersion: 9 }, { expectedVersion: 0 }])
      await assert.rejects(
        update("point", "test", patch, "검증", "버전 주입", {
          expectedVersion: 0,
        }),
        (error) => error.status === 422,
      );
    await assert.rejects(
      update(
        "inspection",
        "test",
        { humanGrade: 5 },
        "AI 서비스",
        "업무 판단 주입",
        { inference: true },
      ),
      (error) => error.status === 422,
    );
    await assert.rejects(
      update("point", "test", { status: "done" }, "AI 서비스", "내부 우회", {
        inference: true,
      }),
      (error) => error.status === 422,
    );
  } finally {
    pool.getConnection = original;
  }
});
