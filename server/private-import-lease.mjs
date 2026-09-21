// All import transactions use the very connection that owns the advisory lock.
// Losing it cannot silently continue through a replacement pool connection.
export async function withPrivateImportLease(pool, run) {
  const connection = await pool.getConnection();
  const controller = new AbortController();
  const emitter = connection.connection || connection;
  const lost = () =>
    controller.abort(new Error("가져오기 잠금 연결을 잃었습니다."));
  emitter.on("error", lost);
  emitter.on("end", lost);
  let acquired = false;
  const bound = new Proxy(connection, {
    get(target, key) {
      if (key === "release") return () => {};
      const value = target[key];
      if (typeof value !== "function") return value;
      return (...args) => {
        controller.signal.throwIfAborted();
        return value.apply(target, args);
      };
    },
  });
  const db = new Proxy(bound, {
    get(target, key) {
      if (key === "getConnection")
        return async () => {
          controller.signal.throwIfAborted();
          return bound;
        };
      return target[key];
    },
  });
  const assertOwned = async () => {
    controller.signal.throwIfAborted();
    const [rows] = await connection.query(
      "SELECT IS_USED_LOCK('private-import-complete-run') = CONNECTION_ID() AS owned",
    );
    if (rows[0].owned !== 1) lost();
    controller.signal.throwIfAborted();
  };
  try {
    const [rows] = await connection.query(
      "SELECT GET_LOCK('private-import-complete-run',0) AS acquired",
    );
    acquired = rows[0].acquired === 1;
    if (!acquired) throw new Error("다른 가져오기가 진행 중입니다.");
    return await run({ db, signal: controller.signal, assertOwned });
  } finally {
    if (acquired)
      await connection
        .query("SELECT RELEASE_LOCK('private-import-complete-run')")
        .catch(() => {});
    emitter.off("error", lost);
    emitter.off("end", lost);
    connection.release();
  }
}
