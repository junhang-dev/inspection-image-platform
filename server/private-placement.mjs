import { createHash } from "node:crypto";

const orderKey = (value) =>
  createHash("sha256")
    .update(`private-rack-placement-v1:${value}`)
    .digest("hex");
// Rank only stable identity. No filename, grade, prediction or pixels participate.
export function planPrivatePlacement(entries) {
  const result = [];
  for (let team = 1; team <= 4; team++) {
    const originals = entries.filter(
      (entry) => entry.team === `virtual-team-0${team}`,
    );
    const groups = new Map();
    for (const entry of originals) {
      const key = entry.canonicalSourceId;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const counts = [0, 0, 0];
    const ordered = [...groups.entries()].sort(
      (a, b) =>
        b[1].length - a[1].length ||
        orderKey(a[0]).localeCompare(orderKey(b[0])),
    );
    for (const [canonical, members] of ordered) {
      const rack = [0, 1, 2]
        .filter((i) => counts[i] + members.length <= 25)
        .sort(
          (a, b) =>
            counts[a] - counts[b] ||
            orderKey(`${canonical}:${a}`).localeCompare(
              orderKey(`${canonical}:${b}`),
            ),
        )[0];
      if (rack === undefined)
        throw new Error("가상 랙별 보존 수량을 배치할 수 없습니다.");
      counts[rack] += members.length;
      for (const entry of members)
        result.push({
          sourceId: entry.sourceId,
          sha256: entry.sha256,
          canonicalSourceId: entry.canonicalSourceId,
          teamId: `team-${team}`,
          rackId: `team-${team}-rack-${rack + 1}`,
          planKey: `team-${team}`,
          pointKey: `team-${team}-rack-${rack + 1}`,
          recordPurpose: "inspection",
          locationSource: "virtual",
          locationVerified: false,
        });
    }
    if (counts.some((count) => count !== 25))
      throw new Error("팀75/가상랙25 배치 수량이 다릅니다.");
  }
  return result.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
