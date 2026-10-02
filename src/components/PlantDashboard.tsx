"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CalendarDays,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  HelpCircle,
  X,
} from "lucide-react";
import locations from "@/lib/virtual-locations.json";
import type { Photo, PhotoPage } from "@/lib/photo-query";
import { getRackGuidance, type RackActionKind } from "@/lib/rack-guidance";
import { useRackPlanPhotos } from "@/lib/rack-plan-photos";
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
  type: "boot" | "ready" | "selection" | "plan-racks" | "error";
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
  plansLoaded: boolean;
  plans: readonly Plan[];
  points: readonly Point[];
  photos: readonly Photo[];
  photoTotal: number | null;
  photoSummary: PhotoPage["summary"] | null;
  photoError: string;
  maintenance: readonly MaintenanceWorklistRow[];
  maintenanceTotal: number | null;
  maintenanceReviewTotal: number | null;
  maintenanceWorklistTotal: number | null;
  maintenanceError: string;
  error: string;
  onRetryData: () => void;
  onRetryPhotos: () => void;
  onRetryMaintenance: () => void;
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
  onOpenReviewWorklist: () => void;
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
const photoStatusLabel: Record<Photo["status"], string> = {
  pending: "판독 대기",
  processing: "AI 판독 중",
  done: "판독 완료",
  error: "판독 실패",
  unread: "미판독",
};

function HelpTip({ text, label }: { text: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.helpTip} data-open={open}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <HelpCircle size={17} />
      </button>
      <span role="tooltip">{text}</span>
    </span>
  );
}

export default function PlantDashboard({
  paused,
  teamId,
  rackId,
  plansLoaded,
  plans,
  points,
  photos,
  photoTotal,
  photoSummary,
  photoError,
  maintenance,
  maintenanceTotal,
  maintenanceReviewTotal,
  maintenanceWorklistTotal,
  maintenanceError,
  error,
  onRetryData,
  onRetryPhotos,
  onRetryMaintenance,
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
  onOpenReviewWorklist,
}: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const onScopeChangeRef = useRef(onScopeChange);
  onScopeChangeRef.current = onScopeChange;
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [frameLoaded, setFrameLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const retryCount = useRef(0);
  const [level, setLevel] = useState<Level>(
    rackId ? "rack" : teamId ? "team" : "plant",
  );
  const [offsiteRack, setOffsiteRack] = useState(4);
  const [planMode, setPlanMode] = useState(false);
  const [planTool, setPlanTool] = useState<"select" | "navigate">("select");
  const [teamPreview, setTeamPreview] = useState<"plans" | "photos" | "maintenance" | null>(null);
  const [expandedRackPlansFor, setExpandedRackPlansFor] = useState<string | null>(null);
  const [expandedRackRecordsFor, setExpandedRackRecordsFor] = useState<string | null>(null);
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
  const planPhotos = useRackPlanPhotos({
    rackId,
    planIds: rackPlans.map((plan) => plan.id),
    enabled: !paused && !photoError,
    changeKey: `${photoTotal ?? "?"}/${photoSummary?.pending ?? "?"}/${photoSummary?.error ?? "?"}/${photoSummary?.done ?? "?"}`,
  });
  const photoPlanCounts = planPhotos.counts;
  const rackPhotos = photos.filter((photo) => photo.rackId === rackId);
  const maintenanceRecords = maintenance.filter((item) => item.persisted || item.inWorklist);
  const worklistPreview = maintenance.filter((item) => item.inWorklist);
  const teamPlans = plans.filter(
    (plan) => plan.visibility === "visible" && plan.teamId === teamId,
  );
  const activeTeamPlans = teamPlans.filter((plan) => plan.status === "planned");
  const hasRackHistory = rackPoints.length > 0 || (photoTotal ?? 0) > 0;
  const hasRackMaintenance = maintenanceRecords.length > 0 || (maintenanceWorklistTotal ?? 0) > 0;
  const planPhotosKnown = photoPlanCounts !== null && !photoError;
  const rackPlansExpanded = expandedRackPlansFor === rackId;
  const rackRecordsExpanded = expandedRackRecordsFor === rackId;
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
      if (message.type === "boot") {
        setFrameLoaded(true);
        return;
      }
      if (message.type === "ready") {
        retryCount.current = 0;
        setReady(true);
        setFailed(false);
        setSlow(false);
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
        setSlow(false);
        if (retryCount.current < 2) {
          retryCount.current += 1;
          setFrameLoaded(false);
          setFrameVersion((version) => version + 1);
        } else {
          setFailed(true);
        }
        return;
      }
      if (message.type === "selection" && message.level) {
        setPanelCollapsed(false);
        setTeamPreview(null);
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
    const slowTimer = window.setTimeout(() => setSlow(true), 7000);
    // The inline boot signal separates HTML loading from WebGL setup.
    const timeout = window.setTimeout(() => {
      if (retryCount.current < 2) {
        retryCount.current += 1;
        setFrameLoaded(false);
        setSlow(false);
        setFrameVersion((version) => version + 1);
      } else {
        setFailed(true);
      }
    }, frameLoaded ? 20000 : 12000);
    return () => {
      window.clearInterval(handshake);
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeout);
    };
    // A new iframe is mounted for each frameVersion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, failed, frameLoaded, frameVersion]);

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
    setFrameLoaded(false);
    setSlow(false);
    setFrameVersion((version) => version + 1);
  };
  const togglePlanMode = () => {
    if (!teamId) return;
    setPanelCollapsed(false);
    setTeamPreview(null);
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
  const openRackPlans = () => setExpandedRackPlansFor(rackId);
  const uploadToActivePlan = () => {
    if (!selectedRack) return;
    if (activeRackPlans.length === 1) onUploadPlan(activeRackPlans[0].id, selectedRack.id);
    else openRackPlans();
  };
  const rackGuidance = getRackGuidance({
    plansLoaded,
    dataError: Boolean(error),
    plans: rackPlans,
    planPhotoCounts: photoPlanCounts,
    planPhotosError: Boolean(planPhotos.error),
    photoTotal,
    photoSummary,
    photosError: Boolean(photoError),
    maintenanceTotal: maintenanceTotal === null ? null : Math.max(maintenanceRecords.length, maintenanceWorklistTotal ?? 0),
    maintenanceReviewTotal,
    maintenanceError: Boolean(maintenanceError),
    hasPointHistory: rackPoints.length > 0,
  });
  const runRackAction = (kind: RackActionKind) => {
    switch (kind) {
      case "create-plan": togglePlanMode(); break;
      case "add-photo":
      case "choose-photo-plan": uploadToActivePlan(); break;
      case "review-maintenance": onOpenReviewWorklist(); break;
      case "inspect-photos": onOpenPhotos(); break;
      case "retry-data": onRetryData(); break;
      case "retry-photos": onRetryPhotos(); break;
      case "retry-maintenance": onRetryMaintenance(); break;
      case "retry-plan-photos": planPhotos.retry(); break;
    }
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
        onLoad={(event) => {
          try {
            if (
              event.currentTarget.contentWindow?.location.pathname !==
              "/plant-explorer.html"
            ) {
              return;
            }
          } catch {
            return;
          }
          setFrameLoaded(true);
          post({ type: "hello" });
        }}
        onError={() => {
          setReady(false);
          if (retryCount.current < 2) {
            retryCount.current += 1;
            setFrameLoaded(false);
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
            <div>
              <p>{frameLoaded
                ? "가상 공장 3D를 준비하는 중…"
                : "가상 공장 3D를 불러오는 중…"}</p>
              {slow && <button onClick={retryScene}>3D 다시 불러오기</button>}
            </div>
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
              <div className={styles.helpTitle}>
                <h2>검사할 랙 선택</h2>
                <HelpTip
                  label="랙 선택 방법 도움말"
                  text="3D에서 랙을 클릭하거나 범위를 드래그하세요. 같은 랙을 다시 클릭하면 해제됩니다. 시점을 바꾸려면 왼쪽 위의 ‘시점 이동’을 누르세요."
                />
              </div>
            </div>
            <div className={styles.cardTitleActions}>
              <button aria-label="범위 선택 취소" onClick={togglePlanMode}>
                <X size={17} />
              </button>
              <button
                className={styles.cardCollapse}
                aria-label={panelCollapsed ? "업무 패널 펼치기" : "업무 패널 접기"}
                onClick={() => setPanelCollapsed(!panelCollapsed)}
              >
                {panelCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
              </button>
            </div>
          </div>
          <strong>선택한 랙 {selectedNumbers.length}개</strong>
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
              <div className={styles.helpTitle}>
                <h2>{selectedRack?.name ?? selectedTeam.name}</h2>
                <HelpTip
                  key={selectedRack?.id ?? selectedTeam.id}
                  label={`${selectedRack?.name ?? selectedTeam.name} 화면 도움말`}
                  text={selectedRack
                    ? "이 랙에 연결된 검사계획, 사진·판독, 보수 기록을 확인하고 다음 업무로 이동합니다."
                    : "팀 전체를 살펴보며 랙을 선택하거나, 검사할 랙의 범위를 지정합니다."}
                />
              </div>
            </div>
            <div className={styles.cardTitleActions}>
              <button aria-label="공장 전체로" onClick={() => view("plant")}>
                <X size={17} />
              </button>
              <button
                className={styles.cardCollapse}
                aria-label={panelCollapsed ? "업무 패널 펼치기" : "업무 패널 접기"}
                onClick={() => setPanelCollapsed(!panelCollapsed)}
              >
                {panelCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
              </button>
            </div>
          </div>
          {selectedRack ? (
            <>
              <div className={styles.summary}>
                <span>
                  진행 중 계획 <b>{error ? "—" : plansLoaded ? activeRackPlans.length : "조회 중"}</b>
                </span>
                <span>
                  검사 사진 <b>{photoError ? "—" : (photoTotal ?? "조회 중")}</b>
                </span>
                <span>
                  보수 대상{" "}
                  <b>
                    {maintenanceError ? "—" : (maintenanceWorklistTotal ?? "조회 중")}
                  </b>
                </span>
              </div>
              <section className={`${styles.rackNext} ${rackGuidance.tone !== "attention" ? styles.rackCalm : ""}`} aria-label="이 랙의 현재 상태와 다음 작업">
                <small>{rackGuidance.tone === "attention" ? "다음 작업" : rackGuidance.tone === "loading" ? "확인 중" : "현재 상태"}</small>
                <p>{rackGuidance.message}</p>
                {rackGuidance.tone === "attention" ? (
                  <>
                    <button className={styles.primary} onClick={() => runRackAction(rackGuidance.actions[0].kind)}>
                      <ArrowRight size={16} /> {rackGuidance.actions[0].label}
                    </button>
                    {rackGuidance.actions.slice(1).map((action) => (
                      <button className={styles.rackSecondaryAction} key={action.kind} onClick={() => runRackAction(action.kind)}>
                        {action.label} <ArrowRight size={15} />
                      </button>
                    ))}
                  </>
                ) : rackGuidance.tone === "calm" && (
                  <div className={styles.rackQuietActions}>
                    {rackGuidance.actions.map((action) => <button key={action.kind} onClick={() => runRackAction(action.kind)}>{action.label}</button>)}
                  </div>
                )}
              </section>
              {plansLoaded && !error && rackPlans.length > 0 && (
                <section className={styles.rackGroup}>
                  <div className={styles.rackGroupHeader}>
                    <button aria-expanded={rackPlansExpanded} onClick={() => setExpandedRackPlansFor(rackPlansExpanded ? null : rackId)}>
                      <span>이 랙의 검사계획 <b>{rackPlans.length}개</b></span>
                      {rackPlansExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    {activeRackPlans.length > 0 && <button className={styles.rackNewPlan} onClick={togglePlanMode}>새 계획</button>}
                  </div>
                  {rackPlansExpanded && (
                    <div className={styles.rackPlanList}>
                      {rackPlans.length ? rackPlans.map((plan) => {
                        const count = planPhotosKnown ? (photoPlanCounts?.[plan.id]?.total ?? null) : null;
                        return (
                          <div className={styles.row} key={plan.id}>
                            <button onClick={() => onOpenPlan(plan.id)}>
                              {plan.title}
                              <small>
                                {plan.date || "날짜 미지정"} · {plan.status === "planned" ? "진행 중" : plan.status === "done" ? "완료" : "취소"} · {count === null ? planPhotos.error ? "사진 조회 실패" : "사진 조회 중" : `이 랙 사진 ${count}장`}
                              </small>
                            </button>
                            {plan.status === "planned" && selectedRack && (
                              <button className={styles.smallAction} onClick={() => onUploadPlan(plan.id, selectedRack.id)}>
                                사진 추가
                              </button>
                            )}
                          </div>
                        );
                      }) : <p>계획 목록을 조회하지 못했습니다.</p>}
                      {rackPlans.length > 0 && <button className={styles.link} onClick={onOpenPlans}>전체 계획 화면 보기 <ArrowRight size={15} /></button>}
                    </div>
                  )}
                </section>
              )}
              {(hasRackHistory || hasRackMaintenance || maintenanceError || photoTotal === null) && (
                <section className={styles.rackGroup}>
                  <button className={styles.rackRecordToggle} aria-expanded={rackRecordsExpanded} onClick={() => setExpandedRackRecordsFor(rackRecordsExpanded ? null : rackId)}>
                    <span>기존 기록 보기</span>
                    {rackRecordsExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>
                  {rackRecordsExpanded && (
                    <div className={styles.rackRecordContent}>
                      {(photoTotal === null || photoTotal > 0) && (
                        <div>
                          <h4>검사 사진</h4>
                          {rackPhotos.slice(0, 2).map((photo) => (
                            <button className={styles.rowButton} key={photo.id} onClick={() => onOpenPhoto(photo)}>
                              <span>{photo.name}<small>{photo.createdAt.slice(0, 10)} · {photoStatusLabel[photo.status]}</small></span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                          <button className={styles.link} onClick={onOpenPhotos}>사진 {photoTotal ?? "조회 중"}장 모두 보기 <ArrowRight size={15} /></button>
                        </div>
                      )}
                      {rackPoints.length > 0 && (
                        <div>
                          <h4>연결 포인트</h4>
                          {rackPoints.map((point) => (
                            <button className={styles.rowButton} key={point.id} onClick={() => onOpenPoint(point.id)}>
                              {point.name || point.equipment || "이름 미확인 포인트"}<ChevronRight size={15} />
                            </button>
                          ))}
                        </div>
                      )}
                      {(hasRackMaintenance || maintenanceError) && (
                        <div>
                          <h4>보수·TA 기록</h4>
                          {maintenanceError ? <p>{maintenanceError}</p> : maintenanceRecords.slice(0, 2).map((item) => (
                            <button className={styles.rowButton} key={item.id} onClick={() => onOpenMaintenance(item.id)}>
                              <span>{item.pointLabel || item.planTitle || "보수 항목"}<small>{maintenanceLabel[item.repairStatus] ?? "상태 미확인"}{item.ta ? " · TA 포함" : ""}</small></span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                          <button className={styles.link} onClick={onOpenWorklist}>보수 기록 모두 보기 <ArrowRight size={15} /></button>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}
            </>
          ) : (
            <>
              <div className={`${styles.summary} ${styles.summaryActions}`}>
                <button aria-expanded={teamPreview === "plans"} onClick={() => setTeamPreview(teamPreview === "plans" ? null : "plans")}>
                  진행 중 계획 <b>{error ? "—" : plansLoaded ? activeTeamPlans.length : "조회 중"}</b>
                </button>
                <button aria-expanded={teamPreview === "photos"} onClick={() => setTeamPreview(teamPreview === "photos" ? null : "photos")}>
                  검사 사진{" "}
                  <b>{photoError ? "—" : (photoTotal ?? "조회 중")}</b>
                </button>
                <button aria-expanded={teamPreview === "maintenance"} onClick={() => setTeamPreview(teamPreview === "maintenance" ? null : "maintenance")}>
                  보수 대상{" "}
                  <b>
                    {maintenanceError ? "—" : (maintenanceWorklistTotal ?? "조회 중")}
                  </b>
                </button>
              </div>
              {teamPreview && (
                <section className={styles.teamPreview} aria-label="생산팀 현황 미리보기">
                  <div className={styles.teamPreviewHeader}>
                    <h3>{teamPreview === "plans" ? "진행 중 계획" : teamPreview === "photos" ? "검사 사진" : "보수 대상"}</h3>
                    <button type="button" aria-label="미리보기 닫기" onClick={() => setTeamPreview(null)}><X size={15} /></button>
                  </div>
                  {teamPreview === "plans" && (error ? <p>검사계획을 조회하지 못했습니다.</p> : !plansLoaded ? <p>검사계획을 조회하는 중입니다.</p> : activeTeamPlans.length ? activeTeamPlans.slice(0, 3).map((plan) => (
                    <div className={styles.previewRow} key={plan.id}><strong>{plan.title}</strong><small>{plan.date || "날짜 미지정"} · 랙 {plan.rackIds.length}개</small></div>
                  )) : <p>진행 중인 계획이 없습니다.</p>)}
                  {teamPreview === "photos" && (photoError ? <p>사진을 조회하지 못했습니다.</p> : photoTotal === null ? <p>사진을 조회하는 중입니다.</p> : photos.length ? photos.slice(0, 3).map((photo) => (
                    <div className={styles.previewRow} key={photo.id}><strong>{photo.name}</strong><small>{photo.createdAt.slice(0, 10)} · {photoStatusLabel[photo.status]}</small></div>
                  )) : <p>등록된 사진이 없습니다.</p>)}
                  {teamPreview === "maintenance" && (maintenanceError ? <p>보수 대상을 조회하지 못했습니다.</p> : maintenanceWorklistTotal === null ? <p>보수 대상을 조회하는 중입니다.</p> : worklistPreview.length ? worklistPreview.slice(0, 3).map((item) => (
                    <div className={styles.previewRow} key={item.id}><strong>{item.pointLabel || item.planTitle || "보수 항목"}</strong><small>{maintenanceLabel[item.repairStatus] ?? "상태 미확인"}</small></div>
                  )) : <p>{maintenanceWorklistTotal ? "나머지 보수 대상은 전체 목록에서 확인하세요." : "보수 대상이 없습니다."}</p>)}
                  <button className={styles.link} onClick={teamPreview === "plans" ? onOpenPlans : teamPreview === "photos" ? onOpenPhotos : onOpenWorklist}>
                    전체 목록 보기 <ArrowRight size={15} />
                  </button>
                </section>
              )}
              <button className={styles.primary} onClick={togglePlanMode}>
                <CalendarDays size={16} /> 검사계획 범위 지정
              </button>
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
            <div className={styles.cardTitleActions}>
              <button aria-label="공장 전체로" onClick={() => view("plant")}>
                <X size={17} />
              </button>
              <button
                className={styles.cardCollapse}
                aria-label={panelCollapsed ? "업무 패널 펼치기" : "업무 패널 접기"}
                onClick={() => setPanelCollapsed(!panelCollapsed)}
              >
                {panelCollapsed ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
              </button>
            </div>
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
        <button onClick={onOpenPhotos}>
          <Camera size={15} /> 사진 일괄 등록·조회
        </button>
      </div>
    </section>
  );
}
