import test from "node:test";
import assert from "node:assert/strict";
import { insertBatch, pool } from "../server/store.mjs";

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
