"use client";

import { useEffect, useId, useRef, useState } from "react";
import locations from "../lib/virtual-locations.json";
import styles from "./InspectionMap.module.css";

export type InspectionMapPoint = {
  id: string;
  name: string;
  equipment: string;
  rackId: string | null;
  virtualPosition: { x: number; y: number } | null;
  locationSource: "virtual" | "unconfirmed";
};

export type InspectionMapSelection = {
  teamId: string | null;
  rackId: string | null;
  pointId: string | null;
};

export type InspectionMapProps = {
  /** Pass only points visible under the parent's current plan / visibility filters. */
  points: readonly InspectionMapPoint[];
  /** Photo counts from the server under those same filters. Missing is unknown, not zero. */
  pointCounts?: Readonly<Record<string, number>>;
  selectedTeamId: string | null;
  selectedRackId: string | null;
  selectedPointId: string | null;
  /** One atomic change clears dependent selections when navigating upward. */
  onSelectionChange: (selection: InspectionMapSelection) => void;
  onOpenPoint: (pointId: string) => void;
  onCreatePoint?: (location: { teamId: string; rackId: string }) => void;
  overviewImageUrl?: string;
  rackImageUrl?: string;
};

type Rack = (typeof locations.racks)[number];
const rackById = new Map(locations.racks.map((rack) => [rack.id, rack]));
const pointName = (point: InspectionMapPoint) => point.name.trim() || point.equipment.trim() || "이름 없는 포인트";
const finiteUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

function placedRack(point: InspectionMapPoint): Rack | undefined {
  const position = point.virtualPosition;
  return point.locationSource === "virtual" && position && finiteUnit(position.x) && finiteUnit(position.y)
    ? rackById.get(point.rackId ?? "")
    : undefined;
}

function projection(point: InspectionMapPoint, rack: Rack) {
  // A display-only projection of persisted coordinates, independent of list order/count.
  // The smooth bound keeps outlying, but valid, normalized coordinates on the image.
  const position = point.virtualPosition!;
  return {
    left: `${50 + Math.tanh((position.x - rack.x) / 0.03) * 40}%`,
    top: `${50 + Math.tanh((position.y - rack.y) / 0.02) * 36}%`,
  };
}

function teamFrame(racks: readonly Rack[]) {
  const xs = racks.map((rack) => rack.x), ys = racks.map((rack) => rack.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const size = Math.max(maxX - minX, maxY - minY) + 0.15;
  return {
    left: Math.max(0, Math.min(1 - size, (minX + maxX - size) / 2)),
    top: Math.max(0, Math.min(1 - size, (minY + maxY - size) / 2)),
    size,
  };
}

function photoTotal(points: readonly InspectionMapPoint[], counts: InspectionMapProps["pointCounts"]) {
  if (!counts || points.some((point) => !Number.isSafeInteger(counts[point.id]) || counts[point.id] < 0)) return null;
  return points.reduce((total, point) => total + counts[point.id], 0);
}

function Count({ points, counts }: { points: readonly InspectionMapPoint[]; counts: InspectionMapProps["pointCounts"] }) {
  const photos = photoTotal(points, counts);
  return <span className={styles.count}>포인트 {points.length}개{photos === null ? "" : ` · 사진 ${photos}장`}</span>;
}

export default function InspectionMap({
  points, pointCounts, selectedTeamId, selectedRackId, selectedPointId,
  onSelectionChange, onOpenPoint, onCreatePoint,
  overviewImageUrl = "/maps/refinery-overview-v1.png",
  rackImageUrl = "/maps/refinery-rack-v1.png",
}: InspectionMapProps) {
  const headingId = useId();
  const noticeId = useId();
  const [zoom, setZoom] = useState(1);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const backgroundRef = useRef<HTMLImageElement>(null);
  const pendingNavigationFocus = useRef(false);
  useEffect(() => {
    if (pendingNavigationFocus.current) {
      pendingNavigationFocus.current = false;
      listHeadingRef.current?.focus();
    }
  }, [selectedTeamId, selectedRackId]);
  const team = locations.teams.find((item) => item.id === selectedTeamId);
  const rack = locations.racks.find((item) => item.id === selectedRackId && item.teamId === team?.id);
  const teamRacks = locations.racks.filter((item) => item.teamId === team?.id);
  const frame = team && !rack ? teamFrame(teamRacks) : null;
  const rackPoints = rack ? points.filter((point) => point.rackId === rack.id) : [];
  const unknownPoints = points.filter((point) => !placedRack(point));
  const activePoint = points.find((point) => point.id === selectedPointId);
  const visibleActivePoint = activePoint && (rack ? activePoint.rackId === rack.id : !placedRack(activePoint)) ? activePoint : undefined;
  const imageUrl = rack ? rackImageUrl : overviewImageUrl;
  const imageFailed = failedImage === imageUrl;
  useEffect(() => {
    // An SSR image may fail before React attaches onError during hydration.
    const image = backgroundRef.current;
    if (image?.complete && image.naturalWidth === 0) setFailedImage(imageUrl);
  }, [imageUrl]);
  const select = (selection: InspectionMapSelection) => {
    pendingNavigationFocus.current = selection.teamId !== selectedTeamId || selection.rackId !== selectedRackId;
    setZoom(1);
    onSelectionChange(selection);
  };
  const selectPoint = (point: InspectionMapPoint) => {
    const pointRack = rackById.get(point.rackId ?? "");
    const next = { teamId: pointRack?.teamId ?? null, rackId: pointRack?.id ?? null, pointId: point.id };
    if (next.teamId !== selectedTeamId || next.rackId !== selectedRackId) select(next);
    else onSelectionChange(next);
  };
  const summary = rack ? `${team!.name} · ${rack.name}` : team ? `${team.name} · 파이프랙 선택` : "전체 공장 · 팀 선택";

  function renderPointList(items: readonly InspectionMapPoint[]) {
    return <ul className={styles.pointList}>
      {items.map((point) => {
        const selected = point.id === selectedPointId;
        const photos = photoTotal([point], pointCounts);
        return <li key={point.id}>
          <button type="button" className={`${styles.pointRow} ${selected ? styles.selectedRow : ""}`}
            aria-pressed={selected} onClick={() => selectPoint(point)}>
            <span className={styles.pointDot} aria-hidden="true" />
            <span className={styles.pointText}><strong>{pointName(point)}</strong>
              <span>{point.equipment || "설비 미지정"}{photos === null ? "" : ` · 사진 ${photos}장`}{!placedRack(point) ? " · 위치 미확인" : ""}</span>
            </span>
            <span aria-hidden="true">{selected ? "✓" : "›"}</span>
          </button>
        </li>;
      })}
    </ul>;
  }

  return <section className={styles.root} aria-labelledby={headingId}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>검사 위치</span><h2 id={headingId}>공장 지도</h2></div>
      <div className={styles.total}><strong>{points.length}</strong><span>개 포인트</span></div>
    </header>
    <nav className={styles.breadcrumb} aria-label="지도 위치 경로">
      <button type="button" aria-current={!team ? "location" : undefined} onClick={() => select({ teamId: null, rackId: null, pointId: null })}>전체 공장</button>
      {team && <><span aria-hidden="true">/</span><button type="button" aria-current={!rack ? "location" : undefined}
        onClick={() => select({ teamId: team.id, rackId: null, pointId: null })}>{team.name}</button></>}
      {rack && <><span aria-hidden="true">/</span><span aria-current="location">{rack.name}</span></>}
    </nav>
    <p className={styles.disclosure} id={noticeId}>가상 팀·위치 · AI 보강 이미지 · 실제 측량 위치가 아닌 시각 참고입니다.</p>
    {(selectedTeamId && !team || selectedRackId && !rack) && <p className={styles.notice} role="status">선택한 위치를 확인할 수 없습니다. 아래 팀 또는 랙을 다시 선택하세요.</p>}
    <div className={styles.layout}>
      <div className={styles.mapPanel}>
        <div className={styles.mapToolbar}>
          <span className={styles.viewTitle}>{summary}</span>
          <div className={styles.zoom} aria-label="지도 배율">
            <button type="button" aria-label="지도 축소" disabled={zoom === 1} onClick={() => setZoom((value) => Math.max(1, value - 0.5))}>−</button>
            <output aria-live="polite">{zoom * 100}%</output>
            <button type="button" aria-label="지도 확대" disabled={zoom === 2} onClick={() => setZoom((value) => Math.min(2, value + 0.5))}>+</button>
          </div>
        </div>
        <div className={styles.viewport} style={{ aspectRatio: rack ? "1403 / 1121" : "1189 / 1323" }} tabIndex={0} role="region" aria-label="확대 가능한 가상 지도" aria-describedby={noticeId}>
          {imageFailed ? <div className={styles.imageError} role="status">지도를 불러오지 못했습니다. 옆의 목록에서 모든 위치를 선택할 수 있습니다.</div> :
            <div className={`${styles.canvas} ${rack ? styles.rackCanvas : styles.overviewCanvas}`} style={{ width: `${zoom * 100}%` }}>
              {/* Native img preserves the full reference frame, including its source markings. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={imageUrl} ref={backgroundRef} className={styles.background} src={imageUrl}
                style={frame ? { width: `${100 / frame.size}%`, height: `${100 / frame.size}%`,
                  left: `${-frame.left * 100 / frame.size}%`, top: `${-frame.top * 100 / frame.size}%` } : undefined}
                alt={rack ? "파이프랙의 AI 보강 시각 참고 이미지" : "전체 공장의 AI 보강 시각 참고 이미지"}
                onError={() => setFailedImage(imageUrl)} draggable={false} />
              {!team && locations.teams.map((item) => {
                const racks = locations.racks.filter((itemRack) => itemRack.teamId === item.id);
                const xs = racks.map((itemRack) => itemRack.x), ys = racks.map((itemRack) => itemRack.y);
                const left = Math.min(...xs) - 0.065, top = Math.min(...ys) - 0.035;
                const width = Math.max(...xs) - left + 0.065, height = Math.max(...ys) - top + 0.035;
                return <button type="button" key={item.id} className={styles.teamZone}
                  style={{ left: `${left * 100}%`, top: `${top * 100}%`, width: `${width * 100}%`, height: `${height * 100}%` }}
                  onClick={() => select({ teamId: item.id, rackId: null, pointId: null })} aria-label={`${item.name} 가상 구역 선택`}>
                  <span>{item.name}<small>파이프랙 {racks.length}개</small></span>
                </button>;
              })}
              {team && frame && teamRacks.map((item, index) => <button type="button" key={item.id} className={styles.rackMarker}
                style={{ left: `${(item.x - frame.left) * 100 / frame.size}%`, top: `${(item.y - frame.top) * 100 / frame.size}%` }}
                onClick={() => select({ teamId: team.id, rackId: item.id, pointId: null })} aria-label={`${team.name} ${item.name} 선택`} title={item.name}>
                <strong aria-hidden="true">{index + 1}</strong>
              </button>)}
              {rack && rackPoints.filter((point) => placedRack(point)).map((point) => <button type="button" key={point.id}
                className={`${styles.pointMarker} ${point.id === selectedPointId ? styles.selectedMarker : ""}`}
                style={projection(point, rack)} aria-label={`${pointName(point)} 선택`} title={pointName(point)}
                aria-pressed={point.id === selectedPointId} onClick={() => selectPoint(point)}>
                <span aria-hidden="true">{point.id === selectedPointId ? "✓" : "•"}</span>
              </button>)}
            </div>}
        </div>
        <div className={styles.mapFooter}><span><i aria-hidden="true" />{rack ? "가상 포인트 · 겹친 위치는 목록에서 선택" : team ? "가상 팀 구역 · 파이프랙 번호를 눌러 선택" : "가상 구역 · 팀과 랙을 순서대로 선택"}</span>
          {zoom > 1 && <span>지도 안에서 스크롤하여 이동</span>}
        </div>
      </div>
      <aside className={styles.sidebar} aria-label="지도 대상 목록">
        <div className={styles.listHeading}><h3 ref={listHeadingRef} tabIndex={-1}>{rack ? rack.name : team ? `${team.name} 파이프랙` : "정유팀"}</h3>
          {team && <button type="button" className={styles.backButton} onClick={() => select(rack ? { teamId: team.id, rackId: null, pointId: null } : { teamId: null, rackId: null, pointId: null })}>← 뒤로</button>}
        </div>
        {!team && <ul className={styles.locationList}>{locations.teams.map((item, index) => {
          const racks = locations.racks.filter((itemRack) => itemRack.teamId === item.id);
          const ids = new Set(racks.map((itemRack) => itemRack.id));
          const teamPoints = points.filter((point) => point.rackId !== null && ids.has(point.rackId));
          return <li key={item.id}><button type="button" className={styles.locationRow} onClick={() => select({ teamId: item.id, rackId: null, pointId: null })}>
            <span className={styles.locationNumber} aria-hidden="true">0{index + 1}</span>
            <span><strong>{item.name}</strong><Count points={teamPoints} counts={pointCounts} /><small>파이프랙 {racks.length}개</small></span><span aria-hidden="true">›</span>
          </button></li>;
        })}</ul>}
        {team && !rack && <ul className={styles.locationList}>{teamRacks.map((item) => <li key={item.id}>
          <button type="button" className={styles.locationRow} onClick={() => select({ teamId: team.id, rackId: item.id, pointId: null })}>
            <span><strong>{item.name}</strong><Count points={points.filter((point) => point.rackId === item.id)} counts={pointCounts} /></span><span aria-hidden="true">›</span>
          </button></li>)}</ul>}
        {rack && <>
          <div className={styles.rackSummary}><Count points={rackPoints} counts={pointCounts} />{onCreatePoint && <button type="button" className={styles.addButton} onClick={() => onCreatePoint({ teamId: rack.teamId, rackId: rack.id })}>+ 새 포인트</button>}</div>
          {rackPoints.length ? renderPointList(rackPoints) : <p className={styles.empty}>등록된 포인트가 없습니다.{onCreatePoint ? " 새 포인트를 추가해 검사를 시작하세요." : ""}</p>}
        </>}
        {visibleActivePoint && <div className={styles.selectionDetail} aria-live="polite">
          <span className={styles.eyebrow}>선택한 포인트</span><strong>{pointName(visibleActivePoint)}</strong>
          {!placedRack(visibleActivePoint) && <span>위치 미확인</span>}
          <button type="button" className={styles.primaryButton} onClick={() => onOpenPoint(visibleActivePoint.id)}>포인트 상세 보기 <span aria-hidden="true">↗</span></button>
        </div>}
        {unknownPoints.length > 0 && <details className={styles.unconfirmed} open={Boolean(activePoint && !placedRack(activePoint))}>
          <summary>위치 미확인 <span>{unknownPoints.length}개</span></summary>
          <p>위치를 임의로 배치하지 않았습니다. 목록에서 선택해 상세 내용을 확인하세요.</p>
          {renderPointList(unknownPoints)}
        </details>}
      </aside>
    </div>
    <span className={styles.srOnly} role="status">{summary}{visibleActivePoint ? ` · ${pointName(visibleActivePoint)} 선택됨` : ""}</span>
  </section>;
}
