"use client";

import styles from "./InspectionLocation.module.css";

export type InspectionLocationProps = {
  teamName?: string | null;
  rackNames?: readonly string[];
  pointName?: string | null;
  equipmentName?: string | null;
};

export function InspectionLocation({
  teamName,
  rackNames = [],
  pointName,
  equipmentName,
}: InspectionLocationProps) {
  const racks = [...new Set(rackNames.filter(Boolean))];
  const teamLabel = teamName || (racks.length > 1 ? "팀 미확인" : null);
  const primary = [
    teamLabel,
    racks.length === 1 ? racks[0] : racks.length > 1 ? `${racks.length}개 랙` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const secondary = [
    racks.length > 1 ? racks.join(" · ") : null,
    pointName ? `포인트 · ${pointName}` : null,
    equipmentName ? `설비 · ${equipmentName}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span className={styles.location}>
      <strong>{primary || "위치 미확인"}</strong>
      {secondary && <small>{secondary}</small>}
    </span>
  );
}
