import { createHash } from "node:crypto";
import locations from "../src/lib/virtual-locations.json" with { type: "json" };

export { locations };
export const planPointIds = (plan) => [
  ...new Set(plan.pointIds ?? (plan.pointId ? [plan.pointId] : [])),
];

// Persist this virtual position when a point is first assigned to a rack.
// New points or list ordering never recalculate another point's position.
export function pointLocation(rackId, identity, legacyRack = "") {
  if (!rackId)
    return {
      rackId: null,
      rack: legacyRack,
      virtualPosition: null,
      locationSource: "unconfirmed",
    };
  const rack = locations.racks.find((rack) => rack.id === rackId);
  if (!rack)
    throw Object.assign(new Error("팀과 파이프랙을 다시 선택하세요."), {
      status: 422,
    });
  const hash = createHash("sha256").update(identity).digest();
  return {
    rackId: rack.id,
    rack: rack.name,
    virtualPosition: {
      x: rack.x + (hash[0] / 255 - 0.5) * 0.06,
      y: rack.y + (hash[1] / 255 - 0.5) * 0.04,
    },
    locationSource: "virtual",
  };
}
