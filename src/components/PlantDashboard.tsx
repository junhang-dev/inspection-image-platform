"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  X,
} from "lucide-react";
import locations from "@/lib/virtual-locations.json";
import type { Photo } from "@/lib/photo-query";
import type { MaintenanceWorklistRow } from "./MaintenancePanel";
import styles from "./PlantDashboard.module.css";

type Level = "plant" | "team" | "rack" | "offsite" | "point";
type Plan = {
  id: string;
  title: string;
  date: string;
  teamId: string | null;
  rackIds: string[];
  status: "planned" | "done" | "cancelled";
  visibility: "visible" | "hidden";
};
type Point = {
  id: string;
  name: string;
  equipment: string;
  rackId: string | null;
};
type PlantMessage = {
  source: "plant-explorer";
  type: "ready" | "selection" | "plan-racks" | "error";
  level?: Level;
  teamIndex?: number;
  rackNumber?: number;
  offsiteRackNumber?: number;
  racks?: number[];
};
type Props = {
  paused: boolean;
  teamId: string | null;
  rackId: string | null;
  plans: readonly Plan[];
  points: readonly Point[];
  photos: readonly Photo[];
  photoTotal: number | null;
  rackPhotoCounts: Readonly<Record<string, number>>;
  photoError: string;
  maintenance: readonly MaintenanceWorklistRow[];
  maintenanceTotal: number | null;
  maintenanceError: string;
  error: string;
  onScopeChange: (teamId: string | null, rackId: string | null) => void;
  onCreatePlan: (teamId: string, rackIds: string[]) => void;
  onOpenPlan: (id: string) => void;
  onOpenPlans: () => void;
  onUploadPlan: (id: string, rackId: string) => void;
  onOpenPhoto: (photo: Photo) => void;
  onOpenPoint: (id: string) => void;
  onOpenMaintenance: (id: string) => void;
  onOpenPhotos: () => void;
  onOpenWorklist: () => void;
};

const teamByIndex = locations.teams;
const rackByNumber = (teamId: string, number: number) =>
  locations.racks.find(
    (rack) => rack.teamId === teamId && rack.name === `파이프랙 ${number}`,
  );
const numberFromRack = (rackId: string) => {
  const rack = locations.racks.find((item) => item.id === rackId);
  return rack ? Number(rack.name.replace("파이프랙 ", "")) : null;
};
const maintenanceLabel: Record<string, string> = {
  none: "등록 전",
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
};

export default function PlantDashboard({
  paused,
  teamId,
  rackId,
  plans,
  points,
  photos,
  photoTotal,
  rackPhotoCounts,
  photoError,
  maintenance,
  maintenanceTotal,
  maintenanceError,
  error,
  onScopeChange,
  onCreatePlan,
  onOpenPlan,
  onOpenPlans,
  onUploadPlan,
  onOpenPhoto,
  onOpenPoint,
  onOpenMaintenance,
  onOpenPhotos,
  onOpenWorklist,
}: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const onScopeChangeRef = useRef(onScopeChange);
  onScopeChangeRef.current = onScopeChange;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const retryCount = useRef(0);
  const [level, setLevel] = useState<Level>(
    rackId ? "rack" : teamId ? "team" : "plant",
  );
  const [offsiteRack, setOffsiteRack] = useState(4);
  const [planMode, setPlanMode] = useState(false);
  const [planTool, setPlanTool] = useState<"select" | "navigate">("select");
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [selectedNumbers, setSelectedNumbers] = useState<number[]>([]);
  const sceneStateRef = useRef({ level, teamId, rackId, offsiteRack, planMode, planTool, selectedNumbers });
  sceneStateRef.current = { level, teamId, rackId, offsiteRack, planMode, planTool, selectedNumbers };
  const selectedTeam = teamId
    ? locations.teams.find((team) => team.id === teamId)
    : null;
  const selectedRack = rackId
    ? locations.racks.find((rack) => rack.id === rackId)
    : null;
  const rackPoints = points.filter((point) => point.rackId === rackId);
  const rackPlans = plans.filter(
    (plan) =>
      plan.visibility === "visible" && rackId && plan.rackIds.includes(rackId),
  );
  const activeRackPlans = rackPlans.filter((plan) => plan.status === "planned");
  const rackPhotos = photos.filter((photo) => photo.rackId === rackId);
  const teamPlans = plans.filter(
    (plan) => plan.visibility === "visible" && plan.teamId === teamId,
  );
  const activeTeamPlans = teamPlans.filter((plan) => plan.status === "planned");
  const selectedInActivePlans = selectedNumbers.filter((number) => {
    const id = teamId ? rackByNumber(teamId, number)?.id : null;
    return id && activeTeamPlans.some((plan) => plan.rackIds.includes(id));
  }).length;
  const teamPhotoRacks = locations.racks
    .filter(
      (rack) => rack.teamId === teamId && (rackPhotoCounts[rack.id] ?? 0) > 0,
    )
    .sort(
      (a, b) => (rackPhotoCounts[b.id] ?? 0) - (rackPhotoCounts[a.id] ?? 0),
    );
  const unassignedTeamPhotos =
    photoTotal === null
      ? 0
      : Math.max(
          0,
          photoTotal -
            teamPhotoRacks.reduce(
              (sum, rack) => sum + (rackPhotoCounts[rack.id] ?? 0),
              0,
            ),
        );
  const hasRackHistory = rackPoints.length > 0 || (photoTotal ?? 0) > 0;
  const hasRackMaintenance = maintenanceTotal !== null && maintenanceTotal > 0;
  const hasReviewWork = maintenance.some((item) => item.repairStatus === "review");
  const hasPanel = Boolean(
    (selectedTeam && level !== "plant") ||
    level === "offsite" ||
    level === "point",
  );
  const inOffsite = level === "offsite" || level === "point";
  const areaValue = inOffsite ? "offsite" : (teamId ?? "");
  const rackValue =
    level === "point"
      ? `offsite-${offsiteRack}`
      : level === "rack"
        ? (rackId ?? "")
        : "";

  const post = (message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(
      { source: "dashboard", ...message },
      window.location.origin,
    );
  };

  useEffect(() => {
    const receive = (event: MessageEvent<PlantMessage>) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow
      )
        return;
      const message = event.data;
      if (message?.source !== "plant-explorer") return;
      if (message.type === "ready") {
        retryCount.current = 0;
        setReady(true);
        setFailed(false);
        const scene = sceneStateRef.current;
        if (scene.level !== "plant") {
          frame.current?.contentWindow?.postMessage({
            source: "dashboard",
            type: "view",
            level: scene.level,
            teamIndex: teamByIndex.findIndex((team) => team.id === scene.teamId),
            rackNumber: scene.rackId ? numberFromRack(scene.rackId) : null,
            offsiteRackNumber: scene.offsiteRack,
          }, window.location.origin);
        }
        if (scene.planMode) {
          frame.current?.contentWindow?.postMessage({
            source: "dashboard",
            type: "plan-mode",
            enabled: true,
            racks: scene.selectedNumbers,
            tool: scene.planTool,
          }, window.location.origin);
        }
        return;
      }
      if (message.type === "error") {
        setReady(false);
        if (retryCount.current < 2) {
          retryCount.current += 1;
          setFrameVersion((version) => version + 1);
        } else {
          setFailed(true);
        }
        return;
      }
      if (message.type === "selection" && message.level) {
        setPanelCollapsed(false);
        setLevel(message.level);
        setOffsiteRack(message.offsiteRackNumber ?? 4);
        if (
          message.level === "plant" ||
          message.level === "offsite" ||
          message.level === "point"
        ) {
          onScopeChangeRef.current(null, null);
          return;
        }
        const team = teamByIndex[message.teamIndex ?? -1];
        const rack =
          team && message.level === "rack"
            ? rackByNumber(team.id, message.rackNumber ?? -1)
            : null;
        onScopeChangeRef.current(team?.id ?? null, rack?.id ?? null);
      }
      if (message.type === "plan-racks" && Array.isArray(message.racks)) {
        setSelectedNumbers(
          message.racks.filter(
            (number) => Number.isInteger(number) && number >= 1 && number <= 30,
          ),
        );
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
    // The iframe is mounted once for this dashboard visit. Scope changes arrive through its messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready || failed) return;
    // The iframe can load before the message listener is ready. Repeat the handshake.
    post({ type: "hello" });
    const handshake = window.setInterval(() => post({ type: "hello" }), 1000);
    const timeout = window.setTimeout(() => {
      if (retryCount.current < 2) {
        retryCount.current += 1;
        setFrameVersion((version) => version + 1);
      } else {
        setFailed(true);
      }
    }, 10000);
    return () => {
      window.clearInterval(handshake);
      window.clearTimeout(timeout);
    };
    // A new iframe is mounted for each frameVersion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, failed, frameVersion]);

  useEffect(() => {
    if (ready) post({ type: "render-pause", paused });
  }, [paused, ready, frameVersion]);

  const view = (
    nextLevel: "plant" | "team" | "rack" | "offsite" | "point",
    nextTeamId = teamId,
    nextRackId = rackId,
    nextOffsiteRack = offsiteRack,
  ) => {
    if (
      planMode &&
      (nextLevel === "plant" ||
        nextTeamId !== teamId ||
        nextLevel === "offsite" ||
        nextLevel === "point")
    ) {
      setPlanMode(false);
      setSelectedNumbers([]);
      post({ type: "plan-mode", enabled: false });
    }
    const teamIndex = teamByIndex.findIndex((team) => team.id === nextTeamId);
    post({
      type: "view",
      level: nextLevel,
      teamIndex,
      rackNumber: nextRackId ? numberFromRack(nextRackId) : null,
      offsiteRackNumber: nextOffsiteRack,
    });
  };
  const retryScene = () => {
    retryCount.current = 0;
    setReady(false);
    setFailed(false);
    setFrameVersion((version) => version + 1);
  };
  const togglePlanMode = () => {
    if (!teamId) return;
    setPanelCollapsed(false);
    const next = !planMode;
    const initialNumbers =
      next && rackId
        ? [numberFromRack(rackId)].filter(
            (number): number is number => number !== null,
          )
        : [];
    setPlanMode(next);
    if (next) setPlanTool("select");
    setSelectedNumbers(initialNumbers);
    post({
      type: "plan-mode",
      enabled: next,
      racks: initialNumbers,
      tool: "select",
    });
  };
  const changePlanTool = (tool: "select" | "navigate") => {
    setPlanTool(tool);
    post({ type: "plan-tool", tool });
  };
  const changeSelected = (number: number) => {
    const next = selectedNumbers.includes(number)
      ? selectedNumbers.filter((item) => item !== number)
      : [...selectedNumbers, number].sort((a, b) => a - b);
    setSelectedNumbers(next);
    post({ type: "plan-racks", racks: next });
  };
  const createPlan = () => {
    if (!teamId || !selectedNumbers.length) return;
    const rackIds = selectedNumbers
      .map((number) => rackByNumber(teamId, number)?.id)
      .filter((id): id is string => Boolean(id));
    if (!rackIds.length) return;
    setPlanMode(false);
    post({ type: "plan-mode", enabled: false });
    onCreatePlan(teamId, rackIds);
  };

  return (
    <section
      className={`${styles.stage} ${hasPanel ? styles.hasPanel : ""}`}
      aria-label="가상 공장 3D 대시보드"
    >
      <iframe
        key={frameVersion}
        ref={frame}
        className={styles.scene}
        src="/plant-explorer.html"
        title="가상 정유공장 3D 탐색"
        onLoad={() => post({ type: "hello" })}
        onError={() => {
          if (retryCount.current < 2) {
            retryCount.current += 1;
            setFrameVersion((version) => version + 1);
          } else {
            setFailed(true);
          }
        }}
      />
      {!ready && (
        <div className={styles.loading}>
          {failed ? (
            <div>
              <p>3D 화면을 불러오지 못했습니다.</p>
              <button onClick={retryScene}>3D 다시 불러오기</button>
            </div>
          ) : (
            "가상 공장 3D를 불러오는 중…"
          )}
        </div>
      )}
      <div className={styles.top}>
        <div className={styles.breadcrumb} aria-label="현재 3D 위치">
          <button disabled={!ready} onClick={() => view("plant")}>
            공장 전체
          </button>
          <ChevronRight size={15} />
          <select
            aria-label="3D 생산 구역 선택"
            className={`${styles.areaSelect} ${areaValue === "offsite" ? styles.offsiteSelect : !areaValue ? styles.emptySelect : ""}`}
            value={areaValue}
            disabled={!ready}
            onChange={(event) =>
              event.target.value === "offsite"
                ? view("offsite", null, null)
                : event.target.value
                  ? view("team", event.target.value, null)
                  : view("plant")
            }
          >
            <option value="">생산팀 선택</option>
            {locations.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
            <option value="offsite">오프사이트 (가상)</option>
          </select>
          <ChevronRight size={15} />
          <select
            aria-label="3D 랙 선택"
            className={styles.rackSelect}
            value={rackValue}
            disabled={!ready || !areaValue}
            onChange={(event) => {
              if (areaValue === "offsite") {
                const number = Number(
                  event.target.value.replace("offsite-", ""),
                );
                if (number >= 1 && number <= 8)
                  view("point", null, null, number);
                else view("offsite", null, null);
              } else if (event.target.value) {
                view("rack", areaValue, event.target.value);
              } else {
                view("team", areaValue, null);
              }
            }}
          >
            <option value="">
              {inOffsite ? "전체 구간" : areaValue ? "전체 랙" : "랙"}
            </option>
            {inOffsite
              ? Array.from({ length: 8 }, (_, index) => (
                  <option key={index} value={`offsite-${index + 1}`}>
                    O-{String(index + 1).padStart(2, "0")}
                  </option>
                ))
              : locations.racks
                  .filter((rack) => rack.teamId === areaValue)
                  .map((rack) => (
                    <option key={rack.id} value={rack.id}>
                      {rack.name}
                    </option>
                  ))}
          </select>
        </div>
      </div>
      {planMode && selectedTeam && (
        <div
          className={styles.planToolbar}
          role="group"
          aria-label="검사 랙 선택 모드"
        >
          <div className={styles.planToolbarHeader}>
            <strong>검사 범위 지정 중</strong>
            <span>{selectedNumbers.length}개 선택</span>
          </div>
          <div className={styles.planToolButtons}>
            <button
              aria-pressed={planTool === "select"}
              onClick={() => changePlanTool("select")}
            >
              랙 선택
            </button>
            <button
              aria-pressed={planTool === "navigate"}
              onClick={() => changePlanTool("navigate")}
            >
              시점 이동
            </button>
          </div>
          <small>
            {planTool === "select"
              ? "클릭: 선택·해제 · 드래그: 범위 추가 · 휠: 확대 · 우클릭 드래그: 이동"
              : "드래그: 회전 · 우클릭 드래그: 이동 · 휠: 확대"}
          </small>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          업무 기록 연결 실패: {error}
        </div>
      )}
      {!error && photoError && (
        <div className={styles.error} role="alert">
          사진 조회 실패: {photoError}
        </div>
      )}
      {planMode && selectedTeam ? (
        <div
          className={`${styles.card} ${panelCollapsed ? styles.collapsed : ""}`}
        >
          <div className={styles.cardTitle}>
            <div>
              <small>{selectedTeam.name}</small>
              <h2>검사할 랙 선택</h2>
            </div>
            <button aria-label="범위 선택 취소" onClick={togglePlanMode}>
              <X size={17} />
            </button>
            <button
              className={styles.cardCollapse}
              aria-label={
                panelCollapsed ? "업무 패널 펼치기" : "업무 패널 접기"
              }
              onClick={() => setPanelCollapsed(!panelCollapsed)}
            >
              {panelCollapsed ? (
                <ChevronUp size={17} />
              ) : (
                <ChevronDown size={17} />
              )}
            </button>
          </div>
          <p>
            3D에서 랙을 클릭하거나 범위를 드래그하세요. 같은 랙을 다시 클릭하면
            해제됩니다. 시점을 바꾸려면 왼쪽 위의 ‘시점 이동’을 누르세요.
          </p>
          <p className={styles.planScopeNote}>
            계획은 한 생산팀 기준입니다. 다른 팀으로 이동하면 현재 선택이
            초기화됩니다.
          </p>
          <strong>선택한 랙 {selectedNumbers.length}개</strong>
          {selectedInActivePlans > 0 && (
            <p className={styles.planScopeNote}>
              선택한 랙 중 {selectedInActivePlans}개는 진행 중인 계획에도
              있습니다. 추가 검사계획을 만들 수 있습니다.
            </p>
          )}
          <div className={styles.rackChecks} aria-label="선택된 검사 랙 확인">
            {Array.from({ length: 30 }, (_, index) => index + 1).map(
              (number) => (
                <label
                  key={number}
                  className={
                    selectedNumbers.includes(number) ? styles.checked : ""
                  }
                >
                  <input
                    type="checkbox"
                    checked={selectedNumbers.includes(number)}
                    onChange={() => changeSelected(number)}
                  />
                  {number}
                </label>
              ),
            )}
          </div>
          <button
            className={styles.primary}
            disabled={!selectedNumbers.length}
            onClick={createPlan}
          >
            선택한 {selectedNumbers.length}개 랙으로 계획 만들기{" "}
            <ArrowRight size={16} />
          </button>
        </div>
      ) : selectedTeam && level !== "plant" ? (
        <div
          className={`${styles.card} ${panelCollapsed ? styles.collapsed : ""}`}
        >
          <div className={styles.cardTitle}>
            <div>
              <small>{selectedRack ? selectedTeam.name : "생산팀"}</small>
              <h2>{selectedRack?.name ?? selectedTeam.name}</h2>
            </div>
            <button aria-label="공장 전체로" onClick={() => view("plant")}>
              <X size={17} />
            </button>
            <button
              className={styles.cardCollapse}
              aria-label={
                panelCollapsed ? "업무 패널 펼치기" : "업무 패널 접기"
              }
              onClick={() => setPanelCollapsed(!panelCollapsed)}
            >
              {panelCollapsed ? (
                <ChevronUp size={17} />
              ) : (
                <ChevronDown size={17} />
              )}
            </button>
          </div>
          {selectedRack ? (
            <>
              <p>가상 위치 · 업무 기록은 이 랙 ID를 기준으로 조회합니다.</p>
              <div className={styles.summary}>
                <span>
                  검사 사진{" "}
                  <b>{photoError ? "—" : (photoTotal ?? "조회 중")}</b>
                </span>
                <span>
                  연결된 포인트 <b>{rackPoints.length}</b>
                </span>
                <span>
                  보수 항목{" "}
                  <b>
                    {maintenanceError ? "—" : (maintenanceTotal ?? "조회 중")}
                  </b>
                </span>
              </div>
              <section className={styles.workflow} aria-label="이 랙의 업무 흐름">
                <h3>이 랙의 업무 흐름</h3>
                <ol>
                  <li><span>검사계획</span><strong>{activeRackPlans.length ? `진행 중 ${activeRackPlans.length}건` : rackPlans.length ? "진행 중인 계획 없음" : "계획 없음"}</strong></li>
                  <li><span>사진·판독</span><strong>{photoError ? "조회 실패" : photoTotal === null ? "조회 중" : `${photoTotal}장 · 판독 상태 확인`}</strong></li>
                  <li><span>보수·TA</span><strong>{maintenanceError ? "조회 실패" : maintenanceTotal === null ? "조회 중" : hasReviewWork ? `검토 필요 · 전체 ${maintenanceTotal}건` : `${maintenanceTotal}건`}</strong></li>
                </ol>
                {hasReviewWork ? (
                  <button className={styles.workflowAction} onClick={onOpenWorklist}>검토 필요 항목 확인 <ArrowRight size={15} /></button>
                ) : activeRackPlans.length === 1 && photoTotal === 0 && selectedRack ? (
                  <button className={styles.workflowAction} onClick={() => onUploadPlan(activeRackPlans[0].id, selectedRack.id)}>이 계획에 사진 추가 <ArrowRight size={15} /></button>
                ) : photoTotal !== null && photoTotal > 0 ? (
                  <button className={styles.workflowAction} onClick={onOpenPhotos}>사진·판독 확인 <ArrowRight size={15} /></button>
                ) : activeRackPlans.length > 1 ? (
                  <p>아래 계획을 선택해 사진을 추가하세요.</p>
                ) : null}
              </section>
              <button className={styles.primary} onClick={togglePlanMode}>
                <CalendarDays size={16} />{" "}
                {activeRackPlans.length
                  ? "이 랙에 새 검사계획 만들기"
                  : "이 랙으로 검사계획 만들기"}
              </button>
              <section>
                <h3>검사계획</h3>
                {rackPlans.length ? (
                  rackPlans.slice(0, 4).map((plan) => (
                    <div className={styles.row} key={plan.id}>
                      <button onClick={() => onOpenPlan(plan.id)}>
                        {plan.title}
                        <small>
                          {plan.date} ·{" "}
                          {plan.status === "planned"
                            ? "진행 중"
                            : plan.status === "done"
                              ? "완료"
                              : "취소"}
                        </small>
                      </button>
                      {plan.status === "planned" && selectedRack && (
                        <button
                          className={styles.smallAction}
                          onClick={() => onUploadPlan(plan.id, selectedRack.id)}
                        >
                          사진 추가
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <p>연결된 검사계획이 없습니다.</p>
                )}
              </section>
              {(hasRackHistory || photoTotal === null) && (
                <section>
                  <h3>포인트·사진 이력</h3>
                  {rackPoints.slice(0, 4).map((point) => (
                    <button
                      className={styles.rowButton}
                      key={point.id}
                      onClick={() => onOpenPoint(point.id)}
                    >
                      {point.name || point.equipment || "이름 미확인 포인트"}
                      <ChevronRight size={15} />
                    </button>
                  ))}
                  {rackPhotos.slice(0, 3).map((photo) => (
                    <button
                      className={styles.rowButton}
                      key={photo.id}
                      onClick={() => onOpenPhoto(photo)}
                    >
                      <span>
                        {photo.name}
                        <small>
                          {photo.createdAt.slice(0, 10)} ·{" "}
                          {photo.status === "done"
                            ? "판독 완료"
                            : "판독 " + photo.status}
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                  <button className={styles.link} onClick={onOpenPhotos}>
                    이 랙의 사진 목록 <ArrowRight size={15} />
                  </button>
                </section>
              )}
              {photoTotal === 0 && rackPoints.length === 0 && (
                <p className={styles.emptyNote}>
                  아직 이 랙의 사진·포인트 기록이 없습니다. 검사계획을 만든 뒤
                  사진을 추가할 수 있습니다.
                </p>
              )}
              {(hasRackMaintenance || maintenanceError) && (
                <section>
                  <h3>보수·TA 업무</h3>
                  {maintenanceError ? (
                    <p>{maintenanceError}</p>
                  ) : (
                    maintenance.slice(0, 3).map((item) => (
                      <button
                        className={styles.rowButton}
                        key={item.id}
                        onClick={() => onOpenMaintenance(item.id)}
                      >
                        <span>
                          {item.pointLabel || item.planTitle || "보수 항목"}
                          <small>
                            {maintenanceLabel[item.repairStatus] ??
                              "상태 미확인"}
                            {item.ta ? " · TA 포함" : ""}
                          </small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                  )}
                  <button className={styles.link} onClick={onOpenWorklist}>
                    워크리스트 열기 <ArrowRight size={15} />
                  </button>
                </section>
              )}
            </>
          ) : (
            <>
              <p>
                이 팀에서 검사 범위를 정하거나, 기존 기록이 있는 랙을 찾으세요.
              </p>
              <div className={styles.summary}>
                <span>
                  진행 중 계획 <b>{activeTeamPlans.length}</b>
                </span>
                <span>
                  검사 사진{" "}
                  <b>{photoError ? "—" : (photoTotal ?? "조회 중")}</b>
                </span>
                <span>
                  보수 항목{" "}
                  <b>
                    {maintenanceError ? "—" : (maintenanceTotal ?? "조회 중")}
                  </b>
                </span>
              </div>
              <button className={styles.primary} onClick={togglePlanMode}>
                <CalendarDays size={16} /> 검사계획 범위 지정
              </button>
              <section>
                <h3>이 팀의 검사계획</h3>
                {teamPlans.length ? (
                  teamPlans.slice(0, 3).map((plan) => (
                    <button
                      className={styles.rowButton}
                      key={plan.id}
                      onClick={() => onOpenPlan(plan.id)}
                    >
                      <span>
                        {plan.title}
                        <small>
                          {plan.date} ·{" "}
                          {plan.status === "planned"
                            ? "진행 중"
                            : plan.status === "done"
                              ? "완료"
                              : "취소"}{" "}
                          · 랙 {plan.rackIds.length}개
                        </small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))
                ) : (
                  <p>저장된 검사계획이 없습니다.</p>
                )}
                {teamPlans.length > 0 && (
                  <button className={styles.link} onClick={onOpenPlans}>
                    이 팀의 계획 모두 보기 <ArrowRight size={15} />
                  </button>
                )}
              </section>
              {(teamPhotoRacks.length > 0 ||
                photoTotal === null ||
                unassignedTeamPhotos > 0) && (
                <section>
                  <h3>사진이 있는 랙</h3>
                  {teamPhotoRacks.slice(0, 3).map((rack) => (
                    <button
                      className={styles.rowButton}
                      key={rack.id}
                      onClick={() => view("rack", selectedTeam.id, rack.id)}
                    >
                      <span>
                        {rack.name}
                        <small>검사 사진 {rackPhotoCounts[rack.id]}장</small>
                      </span>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                  {teamPhotoRacks.length === 0 && photoTotal === null && (
                    <p>랙별 사진을 조회하고 있습니다.</p>
                  )}
                  {unassignedTeamPhotos > 0 && (
                    <p>랙 위치 미확인 사진 {unassignedTeamPhotos}장</p>
                  )}
                  {photoTotal !== null && photoTotal > 0 && (
                    <button className={styles.link} onClick={onOpenPhotos}>
                      이 팀의 사진 모두 보기 <ArrowRight size={15} />
                    </button>
                  )}
                </section>
              )}
              {maintenanceTotal !== null && maintenanceTotal > 0 && (
                <button className={styles.link} onClick={onOpenWorklist}>
                  이 팀의 보수·TA 업무 보기 <ArrowRight size={15} />
                </button>
              )}
            </>
          )}
        </div>
      ) : level === "offsite" || level === "point" ? (
        <div
          className={`${styles.card} ${panelCollapsed ? styles.collapsed : ""}`}
        >
          <div className={styles.cardTitle}>
            <div>
              <small>가상 생산 구역</small>
              <h2>
                {level === "point"
                  ? `오프사이트 O-${String(offsiteRack).padStart(2, "0")}`
                  : "오프사이트"}
              </h2>
            </div>
            <button aria-label="공장 전체로" onClick={() => view("plant")}>
              <X size={17} />
            </button>
            <button
              className={styles.cardCollapse}
              aria-label={
                panelCollapsed ? "업무 패널 펼치기" : "업무 패널 접기"
              }
              onClick={() => setPanelCollapsed(!panelCollapsed)}
            >
              {panelCollapsed ? (
                <ChevronUp size={17} />
              ) : (
                <ChevronDown size={17} />
              )}
            </button>
          </div>
          <p>
            고소 배관과 접촉부를 보여주는 가상 구역입니다. 실제 검사계획·사진과
            연결된 랙 ID는 아직 없습니다.
          </p>
          {level === "offsite" && (
            <div
              className={styles.offsiteRacks}
              aria-label="오프사이트 구간 이동"
            >
              {Array.from({ length: 8 }, (_, index) => (
                <button
                  key={index}
                  onClick={() => view("point", null, null, index + 1)}
                >
                  O-{String(index + 1).padStart(2, "0")}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.startHint}>
          생산팀을 클릭해 검사할 랙과 기록을 찾으세요.{" "}
          <span>드래그: 시점 변경 · 휠: 확대</span>
        </div>
      )}
      <div className={styles.bottom}>
        <span>공정·오프사이트 구조는 설명용 가상 모델입니다.</span>
        <button onClick={onOpenPhotos}>
          <Camera size={15} /> 사진 일괄 등록·조회
        </button>
      </div>
    </section>
  );
}
