import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const base = "http://127.0.0.1:4000/api";
const read = async (path) => {
  const response = await fetch(base + path);
  assert.ok(response.ok, `${path}: ${response.status}`);
  return response.json();
};
const state = {};
for (const kind of ["inspections", "points", "plans"]) {
  state[kind] = (await read(`/${kind}`)).sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  for (const item of state[kind]) {
    state[`history:${kind}:${item.id}`] = (
      await read(`/${kind}/${item.id}/history`)
    ).sort((a, b) => a.id.localeCompare(b.id));
    if (kind === "inspections") {
      const response = await fetch(`${base}/inspections/${item.id}/image`);
      assert.ok(response.ok);
      const hash = createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex");
      assert.equal(hash, item.sha256);
      state[`object:${item.id}`] = hash;
    }
  }
}
const file = "records/platform-persistence.local.json";
if (process.argv.includes("--capture")) {
  await writeFile(file, JSON.stringify(state, null, 2));
  console.log("재시작 전 사진·포인트·계획·전체 이력·원본 해시 저장 완료");
} else {
  const before = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(state, before);
  console.log(
    JSON.stringify({
      preserved: true,
      photos: state.inspections.length,
      points: state.points.length,
      plans: state.plans.length,
      comparisons: Object.keys(state).length,
    }),
  );
}
