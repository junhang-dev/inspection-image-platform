"use client";
import {
  readUploadQueue,
  persistUploadQueue,
  uploadRequest,
  transferFile,
  UploadError,
  type UploadEntry,
  type UploadSession,
} from "@/lib/upload";
import locations from "@/lib/virtual-locations.json";
import InspectionMap from "@/components/InspectionMap";
import RoiPanel from "@/components/RoiPanel";
import MaintenanceContext from "@/components/MaintenanceContext";
import { MaintenanceWorklist } from "@/components/MaintenancePanel";
import { useMaintenanceQuery, type Purpose } from "@/lib/maintenance";
import {
  defaultPhotoScope,
  usePhotoQuery,
  usePhotoRecord,
  type Photo,
  type PhotoScope,
  type PhotoPage,
} from "@/lib/photo-query";
import { requestJson } from "@/lib/api";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  Box,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  FolderKanban,
  ImagePlus,
  Info,
  Layers3,
  LayoutDashboard,
  LoaderCircle,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Tag,
  Upload,
  Wrench,
  X,
} from "lucide-react";

type Point = {
  id: string;
  recordPurpose: Photo["recordPurpose"];
  editVersion: number;
  equipment: string;
  rack: string;
  rackId: string | null;
  virtualPosition: { x: number; y: number } | null;
  locationSource: "virtual" | "unconfirmed";
  name: string;
  repairStatus: "none" | "review" | "progress" | "done";
  managed: boolean;
  ta: boolean;
};
type Plan = {
  id: string;
  recordPurpose: Photo["recordPurpose"];
  editVersion: number;
  title: string;
  date: string;
  pointId: string | null;
  pointIds: string[];
  note: string;
  status: "planned" | "done" | "cancelled";
  teamId: string | null;
  rackIds: string[];
  visibility: "visible" | "hidden";
  scopeNeedsReview?: boolean;
};
type MaintenanceTarget = {
  planId: string | null;
  pointId: string | null;
  targetType?: "point" | "photo";
  targetId?: string;
  recordPurpose: Purpose;
  photoId?: string;
};
type Audit = {
  id: string;
  actor: string;
  reason: string;
  action: string;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};
type Health = {
  dataScope?: "standard" | "shared" | "local-private";
  publicUploadsAllowed: boolean;
  demoMode: boolean;
  ready: boolean;
  model: { ready: boolean };
};
type Tab = "dashboard" | "plans" | "photos" | "points" | "worklist" | "labels";
type ToastTone = "success" | "error" | "info";
type Toast = { tone: ToastTone; message: string };
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const publicUploads = process.env.NEXT_PUBLIC_PUBLIC_UPLOADS_ALLOWED === "1";
const statusName = {
  none: "미지정",
  review: "보수 검토",
  planned: "작업 예정",
  progress: "보수 진행",
  done: "보수 완료",
};
const nav = [
  { id: "dashboard", label: "대시보드", icon: LayoutDashboard },
  { id: "plans", label: "검사 계획", icon: CalendarDays },
  { id: "photos", label: "사진·판독", icon: Camera },
  { id: "worklist", label: "관리·TA 워크리스트", icon: FolderKanban },
  { id: "labels", label: "라벨링 후보", icon: Tag },
] as const;
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return requestJson<T>(`${apiBase}/api${path}`, options);
}
const rackName = (rackId: string | null) => {
  const rack = locations.racks.find((rack) => rack.id === rackId);
  return rack
    ? `${locations.teams.find((team) => team.id === rack.teamId)?.name} · ${rack.name}`
    : "";
};
const pointName = (point?: Point) =>
  point
    ? [
        point.equipment || "설비 미확인",
        point.rackId
          ? rackName(point.rackId)
          : point.rack && `${point.rack} 랙`,
        point.name || "포인트 미확인",
      ]
        .filter(Boolean)
        .join(" · ")
    : "위치 미확인";
const gradeOf = (photo: Photo) => photo.humanGrade ?? photo.ai?.grade;
function Grade({ photo }: { photo: Photo }) {
  const grade = gradeOf(photo);
  if (grade)
    return (
      <span className={`badge ${grade >= 3 ? "amber" : "green"}`}>
        {grade >= 3 ? "보수 필요" : "보수 불필요"} ({grade}등급)
        {photo.humanGrade !== null && " · 수정"}
      </span>
    );
  return (
    <span className={`badge ${photo.status === "error" ? "red" : "muted"}`}>
      {photo.status === "error"
        ? "판독 실패"
        : photo.status === "unread"
          ? "미판독 · 자동 판독 안 함"
          : photo.status === "processing"
            ? "AI 판독 중"
            : "판독 대기"}
    </span>
  );
}
function Empty({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <Layers3 size={30} />
      <p>{text}</p>
      {action}
    </div>
  );
}

function useAuditHistory(path: string, reportError: (message: string) => void) {
  const [history, setHistory] = useState<Audit[]>([]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setHistory([]);
    void api<Audit[]>(path, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })
      .then((events) => {
        if (active) setHistory(events);
      })
      .catch(() => {
        if (active)
          reportError("이력을 불러오지 못했습니다. 다시 열어 주세요.");
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, reportError]);
  return history;
}

function useDialogCompletion(
  done: (message: string) => Promise<void>,
  close: () => void,
) {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return async (message: string, afterClose?: () => void) => {
    if (!active.current) return;
    await done(message);
    if (active.current) {
      close();
      afterClose?.();
    }
  };
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [points, setPoints] = useState<Point[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [scope, setScope] = useState<PhotoScope>(defaultPhotoScope);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const photoList = usePhotoQuery({
    ...scope,
    classification: filter,
    labeling: tab === "labels" ? "true" : "all",
    page,
  });
  const [workPage, setWorkPage] = useState(1);
  const [workStatus, setWorkStatus] = useState("all");
  const [workMethod, setWorkMethod] = useState("all");
  const [workTa, setWorkTa] = useState("all");
  const [maintenanceTarget, setMaintenanceTarget] =
    useState<MaintenanceTarget | null>(null);
  const [workVisibility, setWorkVisibility] = useState("visible");
  const [showAllWork, setShowAllWork] = useState(false);
  const maintenance = useMaintenanceQuery(
    {
      planId: scope.planId,
      recordPurpose: scope.recordPurpose,
      inWorklist: tab === "worklist" && !showAllWork && workVisibility === "visible" ? "true" : "all",
      visibility: workVisibility as "visible" | "hidden" | "all",
      ...(tab === "worklist"
        ? {
            teamId: scope.teamId,
            rackId: scope.rackId,
            search: scope.search,
            repairStatus: workStatus,
            repairMethod: workMethod,
            ta: workTa,
            page: workPage,
          }
        : {}),
    },
    tab === "worklist" || tab === "points",
  );
  const openMaintenance = (target: MaintenanceTarget) => {
    setDetail(null);
    setPointDetail(null);
    setMaintenanceTarget(target);
  };
  const photos = photoList.data?.items ?? [];
  const summary = photoList.data?.summary;
  const changeScope = (next: PhotoScope) => {
    setScope(next);
    setPage(1);
    setWorkPage(1);
    setMapPoint(null);
  };
  const [newPointRack, setNewPointRack] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadContext, setUploadContext] = useState<{
    plan: Plan;
    point?: Point;
  } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [planVisibility, setPlanVisibility] = useState("visible");

  const [planDetail, setPlanDetail] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<Photo | null>(null);
  const [pointDetail, setPointDetail] = useState<Point | null>(null);
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [mapPoint, setMapPoint] = useState<string | null>(null);
  const selectedPlan = plans.find((plan) => plan.id === scope.planId);
  const visiblePlans = plans.filter((plan) => plan.recordPurpose === "inspection" &&
    plan.visibility === planVisibility &&
    (scope.teamId === "all" || plan.teamId === scope.teamId) &&
    (scope.rackId === "all" || plan.rackIds.includes(scope.rackId)));
  const activePlans = visiblePlans.filter((plan) => plan.status === "planned" && plan.visibility === "visible");
  const scopePoints = points.filter((point) => {
    if (
      scope.recordPurpose !== "all" &&
      (point.recordPurpose ?? "inspection") !== scope.recordPurpose &&
      !photoList.data?.pointCounts[point.id]
    )
      return false;
    if (
      scope.planId !== "all" &&
      scope.planId !== "unassigned" &&
      !photoList.data?.pointCounts[point.id] && !selectedPlan?.pointIds.includes(point.id)
    )
      return false;
    if (scope.planId === "unassigned" && !photoList.data?.pointCounts[point.id])
      return false;
    if (scope.rackId !== "all" && point.rackId !== scope.rackId) return false;
    if (
      scope.teamId !== "all" &&
      !locations.racks.some(
        (rack) => rack.id === point.rackId && rack.teamId === scope.teamId,
      )
    )
      return false;
    if (
      (scope.search || scope.visibility !== "visible") &&
      !photoList.data?.pointCounts[point.id]
    )
      return false;
    return true;
  });
  const dependentMapScope =
    scope.planId === "unassigned" ||
    !!scope.search ||
    scope.recordPurpose !== "inspection" ||
    scope.visibility !== "visible" ||
    points.some((point) => point.recordPurpose !== "inspection");
  const mapScopePending = dependentMapScope && !photoList.loaded;
  const pointCounts = photoList.data
    ? Object.fromEntries(
        scopePoints.map((point) => [
          point.id,
          photoList.data!.pointCounts[point.id] ?? 0,
        ]),
      )
    : undefined;
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const [s, c, h] = await Promise.all([
        api<Point[]>("/points?recordPurpose=all"),
        api<Plan[]>("/plans?visibility=all"),
        api<Health>("/health"),
      ]);
      setPoints(s);
      setPlans(c);
      setHealth(h);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "서버 연결을 확인하세요.",
      );
    } finally {
      loading.current = false;
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  const notify = async (message: string, tone: ToastTone = "success") => {
    setToast({ tone, message });
    photoList.refresh();
    maintenance.refresh();
    await refresh();
  };
  const reportHistoryError = useCallback((message: string) => {
    setToast({ tone: "error", message });
  }, []);
  const selectPhoto = async (photo: Photo) => {
    setDetail(photo);
  };
  const selectPoint = async (point: Point) => {
    setPointDetail(point);
  };
  const pageTitle = nav.find((item) => item.id === tab)?.label;
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const dateKey = (day: number) =>
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const go = (target: Tab) => {
    setTab(target);
    setFilter("all");
    setPage(1);
  };
  const uploadForPlan = (plan: Plan, point?: Point) => {
    setPlanDetail(null);
    setUploadContext({ plan, point });
    setUploadOpen(true);
  };
  const viewPlanPhotos = (plan: Plan) => {
    setPlanDetail(null);
    go("photos");
    changeScope({ ...defaultPhotoScope, planId: plan.id });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Drone Inspection Platform 대시보드">
          <span className="brand-mark">
            <Layers3 size={25} />
          </span>
          <span>
            Drone Inspection Platform<small>검사·보수 통합 관제</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">P</span>
          <div>
            검사 운영 워크스페이스<small>드론 검사 플랫폼</small>
          </div>
          <ChevronRight size={16} />
        </div>
        <p className="nav-caption">워크스페이스</p>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              className={tab === id ? "nav-item selected" : "nav-item"}
              onClick={() => go(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-note">
            <ShieldCheck size={20} />
            <div>
              검사 기록 보관<small>원본과 변경 이력 유지</small>
            </div>
            <i className={health?.ready ? "dot" : "dot offline"} />
          </div>
          <div className="user">
            <span>J</span>
            <div>
              현업 엔지니어<small>검사·보수 담당</small>
            </div>
            <CircleHelp size={18} />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            워크스페이스 <ChevronRight size={13} />
            <strong>{pageTitle}</strong>
          </div>
          <div className="top-actions">
            <span className="connection">
              <i className={health?.ready ? "dot" : "dot offline"} />
              {health?.ready
                ? health.dataScope === "local-private"
                  ? "로컬 전용 · 연결됨"
                  : "연결됨"
                : "연결 확인 중"}
            </span>
            <button
              className="icon-button"
              onClick={() => {
                photoList.refresh();
                void refresh();
              }}
              aria-label="새로고침"
            >
              <RefreshCw size={18} />
            </button>
            <span className="avatar">J</span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">검사·보수 통합 관제</div>
              <h1>{tab === "dashboard" ? "검사 현황을 한눈에" : pageTitle}</h1>
              <p>
                {tab === "dashboard"
                  ? "사진 판독부터 후속 조치까지, 오늘의 검사 업무를 이어가세요."
                  : tab === "plans"
                    ? "생산팀과 검사할 랙을 정하고, 계획별로 사진을 추가하세요."
                    : tab === "photos"
                      ? "검사 사진과 AI 판독 결과, 사람의 판단을 함께 관리하세요."
                      : tab === "points"
                        ? "설비·랙·포인트별 검사 결과와 보수 이력을 확인하세요."
                        : tab === "worklist"
                          ? "관리 대상과 TA 작업 항목의 상태를 기록하세요."
                          : "학습 검토가 필요한 사진을 지정하고 다시 확인하세요."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                onClick={() => setPlanOpen(true)}
              >
                <CalendarDays size={16} />
                검사계획 만들기
              </button>
              <button
                className="button primary"
                onClick={() => { setUploadContext(null); if (plans.some((p) => p.status === "planned" && p.visibility === "visible")) setUploadOpen(true); else setPlanOpen(true); }}
              >
                <Plus size={18} />
                사진 추가
              </button>
            </div>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <Activity size={18} />
              <span>
                서버에 연결하지 못했습니다. 잠시 뒤 다시 연결하세요.{" "}
                <small>{error}</small>
              </span>
              <button
                onClick={() => {
                  photoList.refresh();
                  void refresh();
                }}
              >
                다시 연결
              </button>
            </div>
          )}
          {!health?.model?.ready && !error && (
            <div className="notice">
              <Clock3 size={17} />
              <span>
                AI 모델 연결 대기 중입니다. 사진 업로드와 업무 기록은 계속할 수
                있으며, 판독은 모델 준비 후 시작됩니다.
              </span>
            </div>
          )}
          <PhotoScopeFields maintenance={tab === "worklist"} scope={scope} plans={plans} change={changeScope} />
          {tab === "dashboard" && <section className="start-panel">
            <div><span className="eyebrow">오늘의 검사</span><h2>{activePlans.length ? "진행 중인 계획에서 이어가세요" : "생산팀의 검사계획을 만들어 보세요"}</h2><p>검사할 랙을 선택한 뒤 사진을 추가하면 판독과 보수 검토로 이어집니다.</p></div>
            <button className="button primary" onClick={() => setPlanOpen(true)}><Plus size={18}/>검사계획 만들기</button>
            {activePlans.slice(0, 3).map((plan) => <div className="active-plan" key={plan.id}><div><strong>{plan.title}</strong><small>{plan.date} · {locations.teams.find((team) => team.id === plan.teamId)?.name} · {plan.rackIds.length}개 랙</small></div><button className="button secondary" onClick={() => uploadForPlan(plan)}>사진 추가</button></div>)}
          </section>}
          {photoList.error &&
            ["dashboard", "photos", "labels", "points"].includes(tab) && (
              <div className="notice error" role="alert">
                <span>
                  사진 조회 실패: {photoList.error}
                  {photoList.loaded
                    ? " · 마지막 조회 결과입니다."
                    : " · 건수 미조회"}
                </span>
                <button onClick={photoList.refresh}>다시 조회</button>
              </div>
            )}
          {tab === "dashboard" && (
            <>
              <div className="stats-grid">
                {[
                  {
                    name: "전체 검사 사진",
                    value: summary?.total,
                    classification: "all",
                    note: "저장된 원본 사진",
                    icon: Camera,
                    color: "teal",
                  },
                  {
                    name: "보수 필요 분류",
                    value: summary?.repair,
                    classification: "repair",
                    note: "시각적 3~5등급",
                    icon: Wrench,
                    color: "orange",
                  },
                  {
                    name: "AI 판독 대기·진행",
                    value: summary?.pending,
                    classification: "pending",
                    note: "백그라운드 처리",
                    icon: Clock3,
                    color: "blue",
                  },
                  {
                    name: "재촬영 필요",
                    value: summary?.retake,
                    classification: "retake",
                    note: "사유 확인 후 후속 관리",
                    icon: RefreshCw,
                    color: "purple",
                  },
                ].map(
                  ({
                    name,
                    value,
                    note,
                    icon: Icon,
                    color,
                    classification,
                  }) => (
                    <button
                      className="stat-card"
                      key={name}
                      onClick={() => {
                        setTab("photos");
                        setFilter(classification);
                        setPage(1);
                      }}
                    >
                      <span className={`stat-icon ${color}`}>
                        <Icon size={20} />
                      </span>
                      <p>{name}</p>
                      <strong>
                        {value ?? "—"}
                        <small>
                          {value !== undefined
                            ? `장${photoList.error ? " · 마지막 조회" : ""}`
                            : "미조회"}
                        </small>
                      </strong>
                      <span className="stat-note">{note} · 목록 보기</span>
                    </button>
                  ),
                )}
              </div>
              <div className="dashboard-grid">
                <section className="panel map-panel">
                  <div className="panel-title">
                    <div>
                      <h2>검사 위치</h2>
                      <p>현재 조회 조건의 사진 수 · 가상 팀·랙 배치</p>
                    </div>
                  </div>
                  {mapScopePending ? (
                    <p className="form-intro">
                      {photoList.error
                        ? "현재 조건의 포인트는 아직 조회하지 못했습니다."
                        : "현재 조건의 포인트 조회 중…"}
                    </p>
                  ) : (
                    <InspectionMap
                      points={scopePoints}
                      pointCounts={pointCounts}
                      rackCounts={photoList.data?.rackCounts}
                      selectedTeamId={
                        scope.teamId === "all" ? null : scope.teamId
                      }
                      selectedRackId={
                        scope.rackId === "all" ? null : scope.rackId
                      }
                      selectedPointId={
                        scopePoints.some((point) => point.id === mapPoint)
                          ? mapPoint
                          : null
                      }
                      onSelectionChange={(selection) => {
                        setScope((current) => ({
                          ...current,
                          teamId: selection.teamId ?? "all",
                          rackId: selection.rackId ?? "all",
                        }));
                        setMapPoint(selection.pointId);
                        setPage(1);
                      }}
                      onOpenPoint={(id) => {
                        const point = points.find((point) => point.id === id);
                        if (point) void selectPoint(point);
                      }}
                    />
                  )}
                </section>
                <section className="panel next-panel">
                  <div className="panel-title">
                    <div>
                      <h2>다음 검사 계획</h2>
                      <p>예정된 업무를 놓치지 마세요.</p>
                    </div>
                    <CalendarDays size={19} />
                  </div>
                  <div className="upcoming-list">
                    {visiblePlans
                      .filter((p) => p.status === "planned")
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .slice(0, 4)
                      .map((p) => (
                        <div className="upcoming" key={p.id}>
                          <span className="date-box">
                            <small>{p.date.slice(5, 7)}월</small>
                            {p.date.slice(8)}
                          </span>
                          <div>
                            <button
                              className="text-button plan-title-link"
                              onClick={() => setPlanDetail(p)}
                            >
                              {p.title}
                            </button>
                            <small>{p.teamId ? locations.teams.find((team) => team.id === p.teamId)?.name : "생산팀 미확인"} · 검사 랙 {p.rackIds.length}개</small>
                            <span className="badge green">검사 예정</span>
                          </div>
                        </div>
                      ))}
                    {visiblePlans.filter((p) => p.status === "planned")
                      .length === 0 && (
                      <Empty
                        text={
                          error
                            ? "연결 후 검사 계획을 조회합니다."
                            : "예정된 검사 계획이 없습니다."
                        }
                        action={
                          <button
                            className="text-button"
                            onClick={() => setPlanOpen(true)}
                          >
                            첫 검사 계획 만들기 <Plus size={14} />
                          </button>
                        }
                      />
                    )}
                  </div>
                  <button className="panel-link" onClick={() => go("plans")}>
                    검사계획 목록 열기 <ArrowRight size={16} />
                  </button>
                </section>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <div>
                    <h2>최근 검사 사진</h2>
                    <p>새로 들어온 사진과 판독 상태를 확인하세요.</p>
                  </div>
                  <button className="text-button" onClick={() => go("photos")}>
                    전체 보기 <ArrowRight size={15} />
                  </button>
                </div>
                {photos.length ? (
                  <PhotoTable
                    photos={photos.slice(0, 5)}
                    points={points}
                    plans={plans}
                    onSelect={selectPhoto}
                  />
                ) : (
                  <Empty
                    text={
                      !photoList.loaded
                        ? "저장된 사진을 아직 조회하지 못했습니다. 연결을 확인하세요."
                        : "아직 검사 사진이 없습니다. 사진을 업로드하면 이곳에 결과가 표시됩니다."
                    }
                    action={
                      <button
                        className="button secondary"
                        onClick={() => setUploadOpen(true)}
                      >
                        <Upload size={16} />
                        사진 업로드
                      </button>
                    }
                  />
                )}
              </section>
            </>
          )}
          {(tab === "photos" || tab === "labels") && (
            <section className="panel">
              <div className="list-toolbar">
                <select
                  aria-label="판독 상태 필터"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value);
                    setPage(1);
                  }}
                >
                  <option value="all">전체 상태</option>
                  <option value="repair">보수 필요</option>
                  <option value="pending">AI 판독 대기·진행</option>
                  <option value="unread">미판독 · 자동 판독 안 함</option>
                  <option value="done">판독 완료</option>
                  <option value="error">판독 실패</option>
                  <option value="retake">재촬영 필요</option>
                </select>
                <span>
                  {photoList.data
                    ? `전체 ${photoList.data.total}장 · 현재 ${photos.length}장${photoList.error ? " (마지막 조회)" : ""}`
                    : "미조회"}
                </span>
              </div>
              {!photoList.loaded ? (
                <p className="form-intro">
                  {photoList.error
                    ? "사진을 조회하지 못했습니다."
                    : "사진 조회 중…"}
                </p>
              ) : photos.length ? (
                <PhotoTable
                  photos={photos}
                  points={points}
                  plans={plans}
                  onSelect={selectPhoto}
                />
              ) : (
                <Empty
                  text={
                    tab === "labels"
                      ? "조회 조건에 맞는 라벨링 후보가 없습니다."
                      : "표시할 사진이 없습니다. 조회 조건을 확인하세요."
                  }
                />
              )}
              <PhotoPagination data={photoList.data} change={setPage} />
            </section>
          )}
          {tab === "worklist" && (
            <>
              <details className="scope-details"><summary>보수 목록 상세 조건</summary><div className="list-toolbar">
                <label>
                  업무 상태{" "}
                  <select
                    aria-label="보수 상태 필터"
                    value={workStatus}
                    onChange={(event) => {
                      setWorkStatus(event.target.value);
                      setWorkPage(1);
                    }}
                  >
                    <option value="all">모든 상태</option>
                    {Object.entries(statusName).map(([key, name]) => (
                      <option key={key} value={key}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  작업 방법{" "}
                  <select
                    aria-label="보수 방법 필터"
                    value={workMethod}
                    onChange={(event) => {
                      setWorkMethod(event.target.value);
                      setWorkPage(1);
                    }}
                  >
                    <option value="all">모든 방법</option>
                    <option value="undecided">미정</option>
                    <option value="paint">도장</option>
                    <option value="replace">교체</option>
                  </select>
                </label>
                <label>
                  TA{" "}
                  <select
                    aria-label="보수 TA 필터"
                    value={workTa}
                    onChange={(event) => {
                      setWorkTa(event.target.value);
                      setWorkPage(1);
                    }}
                  >
                    <option value="all">전체</option>
                    <option value="true">포함</option>
                    <option value="false">미포함</option>
                  </select>
                </label>
                <label>표시 상태<select value={workVisibility} onChange={(event) => { setWorkVisibility(event.target.value); setWorkPage(1); }}><option value="visible">현재 항목</option><option value="hidden">삭제한 항목</option><option value="all">전체 이력 항목</option></select></label><label><input type="checkbox" checked={showAllWork} onChange={(event) => { setShowAllWork(event.target.checked); setWorkPage(1); }}/>수동 제외·등급 하향 항목도 보기</label>
              </div></details>
              <MaintenanceWorklist
                items={maintenance.data?.items ?? []}
                total={maintenance.data?.total ?? null}
                page={maintenance.data?.page}
                pages={maintenance.data?.pages}
                onPageChange={setWorkPage}
                busy={!maintenance.data && !maintenance.error}
                error={maintenance.error || null}
                onOpen={(id) => {
                  const item = maintenance.data?.items.find(
                    (item) => item.id === id,
                  );
                  if (item)
                    openMaintenance({
                      planId: item.planId,
                      pointId: item.pointId,
                      recordPurpose: item.recordPurpose,
                      targetType: item.targetType, targetId: item.targetId,
                      ...(item.targetType === "photo" ? { photoId: item.targetId } : {}),
                    });
                }}
                onOpenPlan={(id) => {
                  const plan = plans.find((plan) => plan.id === id);
                  if (plan) setPlanDetail(plan);
                }}
                onOpenPoint={(id) => {
                  const point = points.find((point) => point.id === id);
                  if (point) void selectPoint(point);
                }}
              />
            </>
          )}
          {tab === "plans" && <section className="panel">
            <div className="panel-title"><h2>검사계획 {visiblePlans.length}개</h2><label className="field">표시 상태<select value={planVisibility} onChange={(e) => setPlanVisibility(e.target.value)}><option value="visible">현재 계획</option><option value="hidden">삭제한 계획</option></select></label></div>
            {!visiblePlans.length && <Empty text="선택한 범위의 검사계획이 없습니다." action={<button className="button primary" onClick={() => setPlanOpen(true)}>검사계획 만들기</button>}/>}
            <div className="v3-plan-list">{visiblePlans.map((plan) => <article key={plan.id}><div><span className={`badge ${plan.status === "done" ? "green" : "muted"}`}>{plan.visibility === "hidden" ? "삭제됨" : plan.status === "planned" ? "진행 중" : plan.status === "done" ? "완료" : "취소"}</span><h3>{plan.title}</h3><p>{plan.date} · {locations.teams.find((team) => team.id === plan.teamId)?.name ?? "생산팀 확인 필요"} · {plan.rackIds.length}개 랙</p>{plan.note && <p>{plan.note}</p>}</div><div className="heading-actions"><button className="button secondary" onClick={() => setPlanDetail(plan)}>계획 상세·수정</button>{plan.status === "planned" && plan.visibility === "visible" && <button className="button primary" onClick={() => uploadForPlan(plan)}>사진 추가</button>}</div></article>)}</div>
          </section>}
          <footer>
            <ShieldCheck size={14} />
            <span>
              등급은 사진의 시각적 부식 분류입니다. 설비 안전성이나 실제 보수
              지시를 확정하지 않습니다.
            </span>
            <span>Drone Inspection Platform · 드론 검사 플랫폼</span>
          </footer>
        </main>
      </div>
      {planDetail && (
        <PlanDetailDialog
          key={planDetail.id}
          initialPlan={planDetail}
          scope={scope}
          points={points}
          close={() => setPlanDetail(null)}
          done={notify}
          refresh={refresh}
          reportHistoryError={reportHistoryError}
          upload={uploadForPlan}
          viewPhotos={viewPlanPhotos}
          selectPhoto={(photo) => {
            setPlanDetail(null);
            void selectPhoto(photo);
          }}
        />
      )}
      {toast && (
        <div
          className={`toast ${toast.tone}`}
          role={toast.tone === "error" ? "alert" : "status"}
        >
          {toast.tone === "error" ? (
            <CircleAlert size={18} aria-hidden="true" />
          ) : toast.tone === "info" ? (
            <Info size={18} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={18} aria-hidden="true" />
          )}
          <span>{toast.message}</span>
        </div>
      )}
      {uploadOpen && (
        <UploadDialog
          publicUploadsAllowed={
            publicUploads || health?.publicUploadsAllowed === true
          }
          points={
            uploadContext?.point &&
            !points.some((p) => p.id === uploadContext.point?.id)
              ? [...points, uploadContext.point]
              : points
          }
          plans={plans}
          context={uploadContext}
          close={() => {
            setUploadOpen(false);
            if (uploadContext) setPlanDetail(uploadContext.plan);
            setUploadContext(null);
          }}
          done={notify}
        />
      )}
      {planOpen && (
        <PlanDialog
          initialTeamId={scope.teamId === "all" ? "" : scope.teamId}
          close={() => setPlanOpen(false)}
          done={notify}
          created={setPlanDetail}
        />
      )}
      {detail && (
        <PhotoDialog
          key={detail.id}
          photo={photos.find((p) => p.id === detail.id) || detail}
          openMaintenance={openMaintenance}
          points={points}
          plans={plans}
          reportHistoryError={reportHistoryError}
          close={() => setDetail(null)}
          done={notify}
        />
      )}
      {newPointRack && (
        <NewMapPointDialog
          rackId={newPointRack}
          recordPurpose={
            scope.recordPurpose === "all" ? "inspection" : scope.recordPurpose
          }
          plan={selectedPlan}
          close={() => setNewPointRack(null)}
          done={notify}
          created={setPointDetail}
        />
      )}
      {maintenanceTarget && (
        <Modal
          title="보수 기록"
          wide
          close={() => setMaintenanceTarget(null)}
        >
          <MaintenanceContext
            key={`${maintenanceTarget.planId}/${maintenanceTarget.pointId}/${maintenanceTarget.photoId ?? maintenanceTarget.targetId}`}
            {...maintenanceTarget}
            planTitle={
              maintenanceTarget.planId
                ? plans.find((plan) => plan.id === maintenanceTarget.planId)
                    ?.title || ""
                : null
            }
            pointLabel={pointName(
              points.find((point) => point.id === maintenanceTarget.pointId),
            )}
            done={notify}
          />
        </Modal>
      )}
      {pointDetail && (
        <PointDialog
          key={pointDetail.id}
          point={pointDetail}
          openMaintenance={openMaintenance}
          scope={scope}
          plans={plans}
          points={points}
          selectPhoto={(photo) => {
            setPointDetail(null);
            void selectPhoto(photo);
          }}
          reportHistoryError={reportHistoryError}
          close={() => setPointDetail(null)}
          done={notify}
        />
      )}
    </div>
  );
}

const purposeName = {
  inspection: "업무 검사",
  presentation: "발표용",
  verification: "검증용",
};
function PhotoScopeFields({ scope, plans, change, maintenance = false }: { scope: PhotoScope; plans: Plan[]; change: (scope: PhotoScope) => void; maintenance?: boolean }) {
  const set = (patch: Partial<PhotoScope>) => change({ ...scope, ...patch });
  return <section className="common-scope" aria-label="공통 조회 조건"><div className="scope-primary">
    <label className="field">생산팀<select aria-label="생산팀 필터" value={scope.teamId} onChange={(event) => set({ teamId: event.target.value, rackId: "all" })}><option value="all">모든 생산팀</option>{locations.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
    <label className="field">파이프랙<select aria-label="파이프랙 필터" value={scope.rackId} onChange={(event) => { const rack = locations.racks.find((rack) => rack.id === event.target.value); set({ rackId: event.target.value, ...(rack ? { teamId: rack.teamId } : {}) }); }}><option value="all">모든 랙</option>{locations.racks.filter((rack) => scope.teamId === "all" || rack.teamId === scope.teamId).map((rack) => <option key={rack.id} value={rack.id}>{rackName(rack.id)}</option>)}</select></label>
    <button className="text-button" onClick={() => change(defaultPhotoScope)}>조회 초기화</button></div>
    <details className="scope-details"><summary>상세 조건{scope.planId !== "all" || scope.search || scope.visibility !== "visible" ? " · 적용 중" : ""}</summary><div className="photo-scope"><label>검사계획<select aria-label="검사 계획 필터" value={scope.planId} onChange={(event) => set({ planId: event.target.value })}><option value="all">모든 검사계획</option><option value="unassigned">계획 미지정</option>{plans.filter((plan) => plan.recordPurpose === "inspection").map((plan) => <option key={plan.id} value={plan.id}>{plan.title}{plan.visibility === "hidden" ? " (삭제됨)" : ""}</option>)}</select></label>{!maintenance && <label>사진 표시<select value={scope.visibility} onChange={(event) => set({ visibility: event.target.value as PhotoScope["visibility"] })}><option value="visible">현재 사진</option><option value="hidden">삭제한 사진</option><option value="all">전체 사진</option></select></label>}<label>검색<input type="search" maxLength={200} value={scope.search} onChange={(event) => set({ search: event.target.value })} placeholder="사진명, 계획 또는 위치"/></label></div></details>
  </section>;
}
function PhotoPagination({
  data,
  change,
}: {
  data: PhotoPage | null;
  change: (page: number) => void;
}) {
  if (!data) return null;
  return (
    <nav className="photo-pagination" aria-label="사진 페이지">
      <span>
        전체 {data.total}장 · {data.page}/{data.pages}페이지
      </span>
      <button
        className="button secondary"
        disabled={data.page <= 1}
        onClick={() => change(1)}
      >
        처음
      </button>
      <button
        className="button secondary"
        disabled={data.page <= 1}
        onClick={() => change(data.page - 1)}
      >
        이전
      </button>
      <button
        className="button secondary"
        disabled={data.page >= data.pages}
        onClick={() => change(data.page + 1)}
      >
        다음
      </button>
      <button
        className="button secondary"
        disabled={data.page >= data.pages}
        onClick={() => change(data.pages)}
      >
        마지막
      </button>
    </nav>
  );
}
function PhotoRecordActions({
  photo,
  done,
  busy,
  begin,
  finish,
}: {
  photo: Photo;
  done: (message: string) => Promise<void>;
  busy: boolean;
  begin: () => boolean;
  finish: () => void;
}) {
  const [error, setError] = useState("");
  const hidden = photo.visibility === "hidden";
  return (
    <details className="record-actions">
      <summary>사진 삭제·복원</summary>
      <p className="form-intro">
        숨김은 원본을 보존합니다. 숨긴 사진은 조회 조건에서 찾아 복원할 수
        있습니다. 아래 작업은 오른쪽 판단 입력을 저장하지 않습니다.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const action = (
            event.nativeEvent as SubmitEvent
          ).submitter?.getAttribute("value");
          if (!action) return;
          if (!begin()) return;
          setError("");
          try {
            await api(`/inspections/${photo.id}/${action}`, {
              method: "PATCH",
              body: JSON.stringify({
                expectedVersion: photo.editVersion,
                actor: form.get("actor"),
                reason: form.get("reason"),
                visibility: hidden ? "visible" : "hidden",
              }),
            });
            await done(
              action === "visibility"
                ? hidden
                  ? "같은 원본과 이력을 유지하여 사진을 복원했습니다."
                  : "사진을 숨겼습니다. 숨긴 사진 필터에서 복원할 수 있습니다."
                : "기록 목적을 변경했습니다.",
            );
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            finish();
          }
        }}
      >
        <label className="field">
          작업자
          <input
            name="actor"
            required
            maxLength={60}
            defaultValue="현업 엔지니어"
          />
        </label>
        <label className="field">
          작업 사유
          <textarea name="reason" required maxLength={1000} rows={2} />
        </label>
        <button
          className="button secondary full-width"
          name="action"
          value="visibility"
          disabled={busy}
        >
          {hidden ? "사진 복원" : "사진 숨기기"}
        </button>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </details>
  );
}
function NewMapPointDialog({
  rackId,
  recordPurpose,
  plan,
  close,
  done,
  created,
}: {
  rackId: string;
  recordPurpose: Photo["recordPurpose"];
  plan?: Plan;
  close: () => void;
  done: (message: string) => Promise<void>;
  created: (point: Point) => void;
}) {
  const [saved, setSaved] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title="가상 랙에 새 포인트 등록" close={close}>
      <p className="form-intro">
        {purposeName[recordPurpose]} · {rackName(rackId)}
        {plan ? ` · ${plan.title}에 연결` : " · 계획은 미지정"}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          let point = saved;
          try {
            if (!point) {
              point = await api<Point>("/points", {
                method: "POST",
                body: JSON.stringify({
                  rackId,
                  recordPurpose,
                  rack: "",
                  equipment: form.get("equipment"),
                  name: form.get("name"),
                }),
              });
              setSaved(point);
            }
            if (plan) {
              const latest = saved
                ? await api<Plan>(`/plans/${plan.id}`)
                : plan;
              if (!latest.pointIds.includes(point.id))
                await api(`/plans/${plan.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({
                    pointIds: [...latest.pointIds, point.id],
                    expectedVersion: latest.editVersion,
                    actor: "현업 엔지니어",
                    reason: "지도에서 검사 포인트 등록·연결",
                  }),
                });
            }
            const result = point;
            await complete(
              plan
                ? "포인트를 등록하고 검사 계획에 연결했습니다."
                : "포인트를 등록했습니다.",
              () => created(result),
            );
          } catch (cause) {
            setError(
              `${point ? "포인트는 등록됐습니다. 중복 등록 없이 연결을 다시 확인할 수 있습니다. " : ""}${(cause as Error).message}`,
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          설비번호
          <input name="equipment" maxLength={120} disabled={!!saved || busy} />
        </label>
        <label className="field">
          포인트 이름
          <input
            name="name"
            required
            maxLength={120}
            disabled={!!saved || busy}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full-width" disabled={busy}>
          {saved ? "등록된 포인트 연결 재시도" : "포인트 등록"}
        </button>
      </form>
    </Modal>
  );
}

function PhotoTable({
  photos,
  points,
  plans,
  onSelect,
}: {
  photos: Photo[];
  points: Point[];
  plans: Plan[];
  onSelect: (p: Photo) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>검사 사진</th>
            <th>검사 계획·포인트</th>
            <th>판독 결과</th>
            <th>후속 관리</th>
            <th>등록 일시</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {photos.map((photo) => (
            <tr key={photo.id}>
              <td>
                <button className="photo-name" onClick={() => onSelect(photo)}>
                  {photo.visibility === "hidden" ? (
                    <span className="hidden-image">숨김</span>
                  ) : (
                    <img
                      src={`${apiBase}/api/inspections/${photo.id}/thumbnail`}
                      alt="검사 사진 축소 이미지"
                    />
                  )}
                  <span>
                    {photo.name}
                    <small>
                      {photo.id.slice(0, 8)}
                    </small>
                  </span>
                </button>
              </td>
              <td>
                <b className="photo-plan-name">
                  {plans.find((plan) => plan.id === photo.planId)?.title ||
                    (photo.planId ? "계획 정보 확인 필요" : "계획 미지정")}
                </b>
                <small>
                  {photo.pointId ? pointName(points.find((p) => p.id === photo.pointId)) : rackName(photo.rackId ?? null) || "위치 미확인"}
                </small>
              </td>
              <td>
                <Grade photo={photo} />
              </td>
              <td>
                {photo.retake && <span className="badge amber">재촬영</span>}{" "}
                {photo.labeling && (
                  <span className="badge muted">라벨링 후보</span>
                )}
                {!photo.retake && !photo.labeling && (
                  <span className="faint">—</span>
                )}
              </td>
              <td className="faint">
                {new Date(photo.createdAt).toLocaleString("ko-KR", {
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </td>
              <td>
                <button
                  className="icon-button"
                  aria-label={`${photo.name} 상세 보기`}
                  onClick={() => onSelect(photo)}
                >
                  <ChevronRight size={17} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      old?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (e.key === "Tab") {
            const nodes = ref.current?.querySelectorAll<HTMLElement>(
              'button, input, select, textarea, [tabindex="0"]',
            );
            if (!nodes?.length) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button className="icon-button" aria-label="닫기" onClick={close}>
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function UploadDialog({
  points,
  plans,
  context,
  close,
  done,
  publicUploadsAllowed,
}: {
  publicUploadsAllowed: boolean;
  points: Point[];
  plans: Plan[];
  context: { plan: Plan; point?: Point } | null;
  close: () => void;
  done: (s: string, tone?: ToastTone) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [planId, setPlanId] = useState(context?.plan.id || "");
  const [pointId, setPointId] = useState(context?.point?.id || "");
  const [rackId, setRackId] = useState(context?.point?.rackId || "");
  const [queue, setQueue] = useState<UploadEntry[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const rows = useRef<UploadEntry[]>([]);
  const handles = useRef(new Map<string, File>());
  const alive = useRef(true);
  const operation = useRef<AbortController | null>(null);
  const selectedPlan =
    context?.plan.id === planId
      ? context.plan
      : plans.find((plan) => plan.id === planId);
  const knownPoints = points;
  const availablePoints = points.filter((point) => point.rackId === rackId && point.recordPurpose === "inspection");

  function saveQueue(next: UploadEntry[]) {
    if (!alive.current) return;
    rows.current = next;
    setQueue(next);
    setStorageWarning(!persistUploadQueue(next));
  }
  function patch(id: string, changes: Partial<UploadEntry>) {
    saveQueue(
      rows.current.map((row) => (row.id === id ? { ...row, ...changes } : row)),
    );
  }
  function applySession(id: string, session: UploadSession) {
    patch(id, {
      sha256: session.sha256,
      photo: session.photo,
      progress: Math.round((session.offset / session.size) * 100),
      state:
        session.status === "completed"
          ? "stored"
          : handles.current.has(id)
            ? "waiting"
            : "needs-file",
      error:
        session.status === "completed"
          ? ""
          : session.status === "expired"
            ? session.error ||
              "임시 전송이 만료됐습니다. 원래 파일을 선택하고 처음부터 전송하세요."
            : "전송을 이어가려면 원래 파일을 선택하세요.",
    });
  }
  async function checkEntry(entry: UploadEntry, signal: AbortSignal) {
    let session = await uploadRequest(`/${entry.id}`, {}, signal);
    // Finalization already verified the original, so it can recover without a File handle.
    if (session.status === "finalizing")
      session = await uploadRequest(
        `/${entry.id}/complete`,
        { method: "POST" },
        signal,
      );
    if (!signal.aborted) applySession(entry.id, session);
    return session;
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    operation.current = controller;
    const saved = readUploadQueue();
    rows.current = saved;
    setQueue(saved);
    void (async () => {
      for (const entry of saved) {
        if (controller.signal.aborted) return;
        try {
          await checkEntry(entry, controller.signal);
        } catch (cause) {
          if (controller.signal.aborted) return;
          patch(entry.id, {
            state: "needs-file",
            error:
              cause instanceof UploadError && cause.status === 404
                ? "전송을 시작하지 않은 사진입니다. 원래 파일을 다시 선택하세요."
                : (cause as Error).message,
          });
        }
      }
      if (!controller.signal.aborted) {
        operation.current = null;
        setBusy(false);
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
      operation.current?.abort();
    };
    // Restore once; later prop refreshes must not restart an active transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(ids: string[], restart = false) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError("");
    let stored = 0;
    try {
      for (const id of ids) {
        if (controller.signal.aborted) break;
        const entry = rows.current.find((row) => row.id === id);
        if (!entry || entry.state === "stored") continue;
        try {
          // Read before sending: a previous response may have been lost after commit.
          try {
            const state = await checkEntry(entry, controller.signal);
            if (state.status === "completed") {
              stored++;
              continue;
            }
          } catch (cause) {
            if (
              !(cause instanceof UploadError) ||
              ![404, 409].includes(cause.status || 0)
            )
              throw cause;
          }
          const file = handles.current.get(id);
          if (!file) {
            patch(id, {
              state: "needs-file",
              error:
                "원래 사진 파일을 다시 선택하세요. 받은 부분부터 이어서 전송합니다.",
            });
            continue;
          }
          const current = rows.current.find((row) => row.id === id)!;
          const session = await transferFile(
            current,
            file,
            controller.signal,
            (changes) => {
              if (!controller.signal.aborted) patch(id, changes);
            },
            restart,
          );
          if (controller.signal.aborted) break;
          applySession(id, session);
          if (session.status === "completed") {
            handles.current.delete(id);
            stored++;
          }
        } catch (cause) {
          if (controller.signal.aborted) break;
          let recovered = false;
          try {
            const status = await uploadRequest(`/${id}`, {}, controller.signal);
            if (status.status === "completed") {
              applySession(id, status);
              handles.current.delete(id);
              stored++;
              recovered = true;
            }
          } catch {
            /* Keep the original failure; a later status check can recover. */
          }
          if (!recovered && !controller.signal.aborted)
            patch(id, { state: "failed", error: (cause as Error).message });
        }
      }
      if (stored && alive.current && !controller.signal.aborted)
        await done(
          `${stored}장 저장 확인 · AI 판독 결과는 사진 목록에서 확인할 수 있습니다.`,
        );
    } finally {
      if (operation.current === controller) operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (operation.current) return;
    setError("");
    if (!files.length) return setError("추가할 사진을 선택하세요.");
    if (!selectedPlan) return setError("사진을 추가할 검사계획을 선택하세요.");
    if (!rackId || !selectedPlan.rackIds.includes(rackId)) return setError("사진이 속한 랙을 선택하세요.");
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      const id = pointId;
      const target = knownPoints.find((point) => point.id === id);
      const batchId = crypto.randomUUID();
      const added: UploadEntry[] = files.map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        sha256: null,
        pointId: id || null,
        planId: planId || null,
        recordPurpose: "inspection",
        rackId, batchId,
        targetLabel: `${selectedPlan.title} · ${rackName(rackId)}${target ? " · " + pointName(target) : ""}`,
        state: "waiting",
        progress: 0,
        error: "",
        photo: null,
      }));
      for (const [index, entry] of added.entries())
        handles.current.set(entry.id, files[index]);
      saveQueue([...rows.current, ...added]);
      setFiles([]);
      operation.current = null;
      await run(added.map((entry) => entry.id));
    } catch (cause) {
      if (!controller.signal.aborted && alive.current)
        setError((cause as Error).message);
    } finally {
      if (operation.current === controller) operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  async function checkOne(entry: UploadEntry) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    try {
      await checkEntry(entry, controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted)
        patch(entry.id, { state: "failed", error: (cause as Error).message });
    } finally {
      if (operation.current === controller) operation.current = null;
      if (alive.current) setBusy(false);
    }
  }
  const leave = () => {
    alive.current = false;
    operation.current?.abort();
    close();
  };
  const stateLabel: Record<UploadEntry["state"], string> = {
    waiting: "전송 대기",
    checking: "원본 확인 중",
    uploading: "전송 중",
    saving: "저장 확인 중",
    stored: "저장 완료",
    failed: "다시 시도 필요",
    "needs-file": "원래 파일 선택 필요",
  };
  return (
    <Modal title="검사 사진 업로드" close={leave}>
      <form onSubmit={submit}>
        <p className="form-intro">
          {publicUploadsAllowed
            ? "공개 가능한 사진만 선택하세요. 링크를 가진 사람이 사진을 조회할 수 있습니다."
            : "선택한 계획과 랙에 원본을 저장합니다. 같은 계획에 사진을 여러 번 추가할 수 있습니다."}
        </p>
        <label className="dropzone">
          <Upload size={32} />
          <strong>
            {files.length
              ? `${files.length}장 선택됨`
              : "클릭하여 검사 사진 선택"}
          </strong>
          <span>
            JPG, PNG · 파일별로 전송하며 중단된 사진은 이어 올릴 수 있습니다.
          </span>
          <input
            aria-label="검사 사진 선택"
            type="file"
            multiple
            accept="image/jpeg,image/png"
            disabled={busy}
            onChange={(event) => {
              setFiles(Array.from(event.target.files || []));
              event.target.value = "";
            }}
          />
        </label>
        {files.length > 0 && (
          <div className="file-list">
            {files.map((file, index) => (
              <span key={index}>{file.name}</span>
            ))}
          </div>
        )}
        <label className="field">검사계획<select required aria-label="업로드 검사계획" value={planId} disabled={busy} onChange={(event) => { setPlanId(event.target.value); setRackId(""); setPointId(""); }}><option value="">검사계획 선택</option>{plans.filter((plan) => plan.recordPurpose === "inspection" && plan.visibility === "visible" && plan.status === "planned").map((plan) => <option key={plan.id} value={plan.id}>{plan.title} · {locations.teams.find((team) => team.id === plan.teamId)?.name}</option>)}</select></label>
        {selectedPlan && <p className="form-intro">{locations.teams.find((team) => team.id === selectedPlan.teamId)?.name ?? "생산팀 확인 필요"} · 계획의 랙 {selectedPlan.rackIds.length}개</p>}
        <label className="field">이번 사진의 랙<select required aria-label="업로드 파이프랙" disabled={busy || !selectedPlan} value={rackId} onChange={(event) => { setRackId(event.target.value); setPointId(""); }}><option value="">랙 선택</option>{locations.racks.filter((rack) => selectedPlan?.rackIds.includes(rack.id)).map((rack) => <option key={rack.id} value={rack.id}>{rack.name}</option>)}</select><small>선택한 사진은 이 랙에 각각 한 번 저장됩니다. 다른 랙 사진은 다음 묶음으로 추가하세요.</small></label>
        <details><summary>기존 포인트 연결 (선택)</summary><label className="field">연결할 포인트<select value={pointId} disabled={busy || !rackId} onChange={(event) => setPointId(event.target.value)}><option value="">포인트 없이 저장</option>{availablePoints.map((point) => <option key={point.id} value={point.id}>{pointName(point)}</option>)}</select></label></details>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="button primary" disabled={busy || !files.length}>
            <Upload size={16} />
            선택한 사진 전송
          </button>
        </div>
      </form>
      {storageWarning && (
        <p className="form-error" role="alert">
          브라우저에 전송 목록을 보관하지 못했습니다. 저장 확인이 끝날 때까지 이
          창을 유지하세요.
        </p>
      )}
      {queue.length > 0 && (
        <>
          <p className="form-intro">
            전송 목록 · 저장{" "}
            {queue.filter((entry) => entry.state === "stored").length}/
            {queue.length}장. 새로고침 뒤에는 저장 상태를 먼저 확인하고, 남은
            사진만 다시 선택합니다.
          </p>
          <ul className="upload-queue">
            {queue.map((entry) => (
              <li className="upload-queue-item" key={entry.id}>
                <div className="upload-queue-heading">
                  <strong>{entry.name}</strong>
                  <span>{stateLabel[entry.state]}</span>
                </div>
                <small>
                  {entry.targetLabel} · {(entry.size / 1024 / 1024).toFixed(1)}{" "}
                  MB
                </small>
                {["checking", "uploading", "saving"].includes(entry.state) && (
                  <div className="upload-progress">
                    <progress
                      value={
                        entry.state === "saving" ? undefined : entry.progress
                      }
                      max={100}
                    />
                    <span>
                      {entry.state === "saving"
                        ? "원본 저장을 확인하고 있습니다."
                        : `${stateLabel[entry.state]} ${entry.progress}%`}
                    </span>
                  </div>
                )}
                {entry.state === "stored" && (
                  <p>
                    원본 저장 완료 · AI 판독 결과는 사진 목록에서 확인하세요.
                  </p>
                )}
                {entry.error && (
                  <p className="form-error" role="alert">
                    {entry.error}
                  </p>
                )}
                {entry.state !== "stored" && (
                  <div className="upload-queue-actions">
                    <label className="button secondary">
                      원래 파일 선택
                      <input
                        type="file"
                        accept="image/jpeg,image/png"
                        aria-label={`${entry.name} 원래 파일 선택`}
                        disabled={busy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) {
                            handles.current.set(entry.id, file);
                            patch(entry.id, {
                              state: "waiting",
                              error:
                                "전송할 때 원래 사진과 내용이 같은지 확인합니다.",
                            });
                          }
                          event.target.value = "";
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void checkOne(entry)}
                    >
                      저장 상태 확인
                    </button>
                    <button
                      type="button"
                      className="button primary"
                      disabled={busy || !handles.current.has(entry.id)}
                      onClick={() => void run([entry.id])}
                    >
                      이어서 전송
                    </button>
                    {entry.sha256 && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy || !handles.current.has(entry.id)}
                        onClick={() => void run([entry.id], true)}
                      >
                        처음부터 전송
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="form-actions">
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() =>
                saveQueue(
                  rows.current.filter((entry) => entry.state !== "stored"),
                )
              }
            >
              완료한 전송 목록 비우기
            </button>
            <button
              type="button"
              className="button primary"
              disabled={
                busy ||
                !queue.some(
                  (entry) =>
                    entry.state !== "stored" && handles.current.has(entry.id),
                )
              }
              onClick={() =>
                void run(
                  rows.current
                    .filter(
                      (entry) =>
                        entry.state !== "stored" &&
                        handles.current.has(entry.id),
                    )
                    .map((entry) => entry.id),
                )
              }
            >
              남은 사진 전송
            </button>
          </div>
        </>
      )}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={leave}>
          {busy ? "중단하고 닫기" : "닫기"}
        </button>
      </div>
    </Modal>
  );
}
function PlanScopeEditor({ teamId, rackIds, change, disabled = false }: {
  teamId: string; rackIds: string[]; change: (teamId: string, rackIds: string[]) => void; disabled?: boolean;
}) {
  const racks = locations.racks.filter((rack) => rack.teamId === teamId);
  return <fieldset className="plan-scope-editor" disabled={disabled}>
    <legend>검사 범위</legend>
    <label className="field">생산팀<select required aria-label="계획 생산팀" value={teamId} onChange={(e) => change(e.target.value, [])}><option value="">생산팀 선택</option>{locations.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
    {teamId && <><div className="list-toolbar"><strong>검사할 랙 {rackIds.length}개 선택</strong><button type="button" className="text-button" onClick={() => change(teamId, racks.map((rack) => rack.id))}>전체 선택</button><button type="button" className="text-button" onClick={() => change(teamId, [])}>전체 해제</button></div><div className="rack-checks">{racks.map((rack, index) => <label key={rack.id} className={rackIds.includes(rack.id) ? "selected" : ""}><input type="checkbox" aria-label={`${rack.name} 선택`} checked={rackIds.includes(rack.id)} onChange={(e) => change(teamId, e.target.checked ? [...new Set([...rackIds, rack.id])] : rackIds.filter((id) => id !== rack.id))}/><span>랙 {index + 1}</span></label>)}</div></>}
  </fieldset>;
}
function PlanFields({ plan }: { plan?: Plan }) {
  return <><label className="field">계획 이름<input name="title" required maxLength={120} defaultValue={plan?.title} placeholder="예: 정유 1팀 배관 정기 검사"/></label><label className="field">검사 예정일<input name="date" type="date" required defaultValue={plan?.date ?? new Date().toLocaleDateString("sv-SE")}/></label><label className="field">메모<textarea name="note" rows={2} maxLength={1000} defaultValue={plan?.note} placeholder="촬영 조건이나 확인할 사항"/></label></>;
}
function PlanDialog({ initialTeamId, close, done, created }: {
  initialTeamId: string; close: () => void; done: (s: string) => Promise<void>; created: (plan: Plan) => void;
}) {
  const [teamId, setTeamId] = useState(initialTeamId);
  const [rackIds, setRackIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const complete = useDialogCompletion(done, close);
  return <Modal title="검사계획 만들기" close={close}><form onSubmit={async (event) => {
    event.preventDefault(); if (lock.current) return;
    if (!rackIds.length) return setError("검사할 랙을 하나 이상 선택하세요.");
    lock.current = true; setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    try { const plan = await api<Plan>("/plans", { method: "POST", body: JSON.stringify({ title: data.get("title"), date: data.get("date"), note: data.get("note"), teamId, rackIds, pointIds: [] }) }); await complete("검사계획을 저장했습니다. 이제 이 계획에 사진을 추가하세요.", () => created(plan)); }
    catch (cause) { setError((cause as Error).message); } finally { lock.current = false; setBusy(false); }
  }}><PlanFields/><PlanScopeEditor teamId={teamId} rackIds={rackIds} change={(team, racks) => { setTeamId(team); setRackIds(racks); }} disabled={busy}/>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="button secondary" type="button" onClick={close}>취소</button><button className="button primary" disabled={busy || !teamId || !rackIds.length}>{busy ? "저장 중…" : "계획 저장"}</button></div></form></Modal>;
}
function RackFields({
  rackId,
  change,
}: {
  rackId: string;
  change: (rackId: string) => void;
}) {
  const [teamId, setTeamId] = useState(
    locations.racks.find((rack) => rack.id === rackId)?.teamId || "",
  );
  return (
    <div className="form-grid">
      <label className="field">
        팀 (가상 구역)
        <select
          aria-label="팀 선택"
          value={teamId}
          onChange={(e) => {
            setTeamId(e.target.value);
            change(
              locations.racks.find((rack) => rack.teamId === e.target.value)
                ?.id || "",
            );
          }}
        >
          <option value="">소속 미확인</option>
          {locations.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        파이프랙
        <select
          aria-label="파이프랙 선택"
          value={rackId}
          disabled={!teamId}
          onChange={(e) => change(e.target.value)}
        >
          {!teamId && <option value="">소속 미확인</option>}
          {locations.racks
            .filter((rack) => rack.teamId === teamId)
            .map((rack) => (
              <option key={rack.id} value={rack.id}>
                {rack.name}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}

function PlanDetailDialog({ initialPlan, close, done, reportHistoryError, upload, viewPhotos }: {
  initialPlan: Plan; scope: PhotoScope; points: Point[]; close: () => void; done: (message: string) => Promise<void>; refresh: () => Promise<void>; reportHistoryError: (message: string) => void; upload: (plan: Plan, point?: Point) => void; viewPhotos: (plan: Plan) => void; selectPhoto: (photo: Photo) => void;
}) {
  const plan = initialPlan;
  const [teamId, setTeamId] = useState(plan.teamId ?? ""), [rackIds, setRackIds] = useState(plan.rackIds);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), history = useAuditHistory(`/plans/${plan.id}/history`, reportHistoryError);
  const complete = useDialogCompletion(done, close);
  return <Modal title="검사계획 상세" close={close}>
    <div className="plan-next"><span className="badge muted">{plan.visibility === "hidden" ? "삭제됨" : plan.status === "planned" ? "진행 중" : plan.status === "done" ? "완료" : "취소"}</span><h3>{plan.title}</h3><div className="heading-actions">{plan.visibility === "visible" && plan.status === "planned" && <button className="button primary" onClick={() => upload(plan)}>이 계획에 사진 추가</button>}<button className="button secondary" onClick={() => viewPhotos(plan)}>저장된 사진 보기</button></div>{plan.status !== "planned" && <p>사진을 추가하려면 계획을 재개하세요.</p>}</div>
    <form onSubmit={async (event) => {
      event.preventDefault(); if (lock.current) return;
      const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "edit";
      const data = new FormData(event.currentTarget);
      const patch = action === "edit" ? { title: data.get("title"), date: data.get("date"), note: data.get("note"), teamId, rackIds } : action === "visibility" ? { visibility: plan.visibility === "hidden" ? "visible" : "hidden" } : { status: action };
      lock.current = true; setBusy(true); setError("");
      try { await api(`/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify({ ...patch, expectedVersion: plan.editVersion, actor: data.get("actor"), reason: data.get("reason") }) }); await complete(action === "visibility" ? plan.visibility === "hidden" ? "계획을 복원했습니다. 기존 진행 상태는 유지됩니다." : "계획을 삭제했습니다. 사진·보수·이력은 보존되며 복원할 수 있습니다." : action === "edit" ? "계획 정보를 저장했습니다." : action === "planned" ? "계획을 재개했습니다. 사진을 추가할 수 있습니다." : action === "done" ? "검사계획을 완료로 기록했습니다." : "검사계획을 취소했습니다."); }
      catch (cause) { setError((cause as Error).message); } finally { lock.current = false; setBusy(false); }
    }}><PlanFields plan={plan}/><PlanScopeEditor teamId={teamId} rackIds={rackIds} change={(team, racks) => { setTeamId(team); setRackIds(racks); }} disabled={busy}/>
    {plan.pointIds.length > 0 && <details><summary>기존 위치 관계 {plan.pointIds.length}개</summary><p>연결된 포인트와 사진의 원래 위치는 유지됩니다. 사용 중인 랙을 제외하려면 관련 기록을 먼저 확인하세요.</p></details>}
    <label className="field">수정자<input name="actor" required maxLength={60} defaultValue="현업 엔지니어"/></label><label className="field">변경 사유<textarea name="reason" required maxLength={1000} rows={2}/></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button value="edit" className="button primary" disabled={busy || !teamId || !rackIds.length}>변경 저장</button>{plan.status === "planned" ? <><button value="done" className="button secondary" disabled={busy}>검사계획 완료</button><button value="cancelled" className="button secondary" disabled={busy}>계획 취소</button></> : <button value="planned" className="button secondary" disabled={busy || plan.visibility === "hidden"}>계획 재개</button>}<button value="visibility" className="button secondary" disabled={busy}>{plan.visibility === "hidden" ? "계획 복원" : "계획 삭제"}</button></div></form><AuditList history={history}/>
  </Modal>;
}
function AuditList({ history }: { history: Audit[] }) {
  const labels: Record<string, string> = {
    humanGrade: "사람 수정 등급",
    title: "계획 이름",
    date: "검사 날짜",
    note: "계획 메모",
    teamId: "생산팀",
    rackIds: "계획 랙 범위",
    retake: "재촬영",
    retakeReason: "재촬영 사유",
    labeling: "라벨링 후보",
    pointId: "연결 포인트",
    pointIds: "계획 연결 포인트",
    planId: "검사 계획",
    rackId: "소속 파이프랙",
    repairStatus: "보수 상태",
    managed: "관리 대상",
    ta: "TA 포함",
    status: "처리 상태",
    ai: "AI 결과",
    equipment: "설비번호",
    rack: "랙",
    name: "이름",
    visibility: "표시 여부",
    recordPurpose: "기록 목적",
    hiddenReason: "숨김 사유",
  };
  const value = (v: unknown) => {
    if (v === null || v === undefined) return "미지정";
    if (typeof v === "boolean") return v ? "포함" : "해제";
    if (Array.isArray(v)) return v.join(", ");
    if (typeof v === "object") {
      const result = v as {
        grade?: number;
        confidence?: number;
        model_version?: string;
      };
      return result.grade
        ? `${result.grade}등급 · 모델 ${result.model_version || "미확인"}`
        : "상세 정보 변경";
    }
    const states: Record<string, string> = {
      visible: "표시",
      hidden: "숨김",
      inspection: "업무 검사",
      presentation: "발표용",
      verification: "검증용",
      pending: "판독 대기",
      unread: "미판독 · 자동 판독 안 함",
      processing: "판독 중",
      done: "완료",
      error: "판독 실패",
      planned: "검사 예정",
      cancelled: "취소",
      none: "미지정",
      review: "보수 검토",
      progress: "보수 진행",
    };
    return states[String(v)] || String(v);
  };
  return (
    <details className="audit">
      <summary>변경 이력 {history.length}건</summary>
      {history.length === 0 && <p className="faint">표시할 이력이 없습니다.</p>}
      {history.map((h) => (
        <div className="audit-item" key={h.id}>
          <i />
          <div>
            <b>
              {h.action} · {h.actor}
            </b>
            <p>{h.reason}</p>
            {h.before &&
              Object.keys(labels)
                .filter(
                  (key) =>
                    JSON.stringify(h.before?.[key]) !==
                    JSON.stringify(h.after[key]),
                )
                .map((key) => (
                  <small key={key}>
                    {labels[key]}: {value(h.before?.[key])} →{" "}
                    {value(h.after[key])}
                  </small>
                ))}
            <time>{new Date(h.at).toLocaleString("ko-KR")}</time>
          </div>
        </div>
      ))}
    </details>
  );
}
function PhotoDialog({
  photo: seed,
  openMaintenance,
  points,
  plans,
  reportHistoryError,
  close,
  done,
}: {
  photo: Photo;
  openMaintenance: (target: MaintenanceTarget) => void;
  points: Point[];
  plans: Plan[];
  reportHistoryError: (message: string) => void;
  close: () => void;
  done: (s: string) => Promise<void>;
}) {
  const { photo, error: readError } = usePhotoRecord(seed);
  // Keep the editable values and their version together while polling refreshes AI.
  const [initial] = useState(seed);
  const [pointId, setPointId] = useState(photo.pointId || "");
  const [planId, setPlanId] = useState(photo.planId || "");
  const [rackId, setRackId] = useState(photo.rackId || points.find((point) => point.id === photo.pointId)?.rackId || "");
  const [retake, setRetake] = useState(photo.retake);
  const [busy, setBusy] = useState(false);
  const [judgmentDirty, setJudgmentDirty] = useState(false);
  const actionLock = useRef(false);
  const begin = () => {
    if (actionLock.current) return false;
    actionLock.current = true;
    setBusy(true);
    return true;
  };
  const finish = () => {
    actionLock.current = false;
    setBusy(false);
  };
  const [error, setError] = useState("");
  const history = useAuditHistory(
    `/inspections/${photo.id}/history?version=${photo.editVersion}&status=${photo.status}`,
    reportHistoryError,
  );
  const complete = useDialogCompletion(done, close);
  const linkedPlan = plans.find((plan) => plan.id === planId);
  const availablePoints = points.filter((point) => !rackId || point.rackId === rackId);
  return (
    <Modal title="사진 판독·후속 관리" wide close={close}>
      {readError && (
        <p className="form-error" role="alert">
          사진 상태 조회 실패: {readError} · 마지막 조회 결과입니다.
        </p>
      )}
      <div
        className="detail-grid"
      >
        <div>
          <div className="detail-image">
            {photo.visibility === "hidden" ? (
              <p className="hidden-image">
                숨긴 사진입니다. 복원하면 원본을 다시 볼 수 있습니다.
              </p>
            ) : (
              <img
                src={`${apiBase}/api/inspections/${photo.id}/image`}
                alt={photo.name}
              />
            )}
          </div>
          <div className="image-caption">
            {photo.name}
          </div>
          <PhotoRecordActions
            photo={initial}
            done={complete}
            busy={busy}
            begin={begin}
            finish={finish}
          />
          <div className="ai-result">
            <div>
              <span>현재 분류</span>
              <Grade photo={photo} />
            </div>
            <p>
              원래 AI 등급:{" "}
              {photo.ai
                ? `${photo.ai.grade}등급`
                : "결과 없음"}
            </p>
            {photo.ai && (
              <>
                {photo.aiProvenance && (
                  <p className="faint">
                    {photo.aiProvenance.kind === "live_frozen_inference"
                      ? "실제 모델 판독"
                      : "보존된 기존 판독 결과"}
                    {" · "}
                    {photo.aiProvenance.predictedAt
                      ? new Date(photo.aiProvenance.predictedAt).toLocaleString(
                          "ko-KR",
                        )
                      : "기존 판독 시각 미확인"}
                  </p>
                )}
                <details>
                  <summary>AI 판독 정보</summary>
                  <small>
                    모델 {photo.ai.model_version}
                    <br />
                    전처리 {photo.ai.preprocessing_version}
                  </small>
                </details>
              </>
            )}
            {photo.error && <p className="form-error">{photo.error}</p>}
            {photo.status === "error" && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  if (!begin()) return;
                  setError("");
                  try {
                    await api(`/inspections/${photo.id}/retry`, {
                      method: "POST",
                    });
                    await complete("판독을 다시 요청했습니다.");
                  } catch (cause) {
                    setError((cause as Error).message);
                  } finally {
                    finish();
                  }
                }}
              >
                판독 다시 요청
              </button>
            )}
          </div>
          <button className="button secondary full-width" disabled={busy || judgmentDirty} onClick={() => openMaintenance({ planId: photo.planId, pointId: photo.pointId, targetType: photo.pointId ? "point" : "photo", targetId: photo.pointId ?? photo.id, recordPurpose: photo.recordPurpose, photoId: photo.id })}>보수 기록 열기</button>
          {judgmentDirty && (
            <p className="form-intro">
              입력한 사진 판단을 먼저 저장한 뒤 보수 기록을 여세요.
            </p>
          )}
          <RoiPanel key={`${photo.id}/${photo.sha256}/${photo.visibility}`} photo={photo} />
          <AuditList history={history} />
        </div>
        <form
          onChangeCapture={() => setJudgmentDirty(true)}
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            if (!begin()) return;
            setError("");
            try {
              await api(`/inspections/${photo.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  expectedVersion: initial.editVersion,
                  ...(pointId !== (initial.pointId || "") ? { pointId: pointId || null } : {}),
                  ...(planId !== (initial.planId || "") ? { planId: planId || null } : {}),
                  ...(rackId !== (initial.rackId || points.find((point) => point.id === initial.pointId)?.rackId || "") ? { rackId: rackId || null } : {}),
                  humanGrade: form.get("grade")
                    ? Number(form.get("grade"))
                    : null,
                  retake,
                  retakeReason: form.get("retakeReason"),
                  labeling: form.get("labeling") === "on",
                  actor: form.get("actor"),
                  reason: form.get("reason"),
                }),
              });
              await complete("사진 판단과 변경 이력을 저장했습니다.");
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              finish();
            }
          }}
        >
          <details className="relation-editor"><summary>계획·랙 연결 수정</summary><label className="field">검사계획<select value={planId} onChange={(event) => { setPlanId(event.target.value); setRackId(""); setPointId(""); }}><option value="">기존 계획 미지정</option>{plans.filter((plan) => plan.visibility === "visible" || plan.id === planId).map((plan) => <option key={plan.id} value={plan.id}>{plan.title}</option>)}</select></label><label className="field">사진의 랙<select value={rackId} onChange={(event) => { setRackId(event.target.value); setPointId(""); }}><option value="">기존 위치 미확인</option>{locations.racks.filter((rack) => !linkedPlan || linkedPlan.rackIds.includes(rack.id)).map((rack) => <option key={rack.id} value={rack.id}>{rackName(rack.id)}</option>)}</select></label></details>
          <p className="form-intro">{linkedPlan?.title ?? "계획 미지정"} · {rackName(rackId) || "위치 미확인"}</p>
          <label className="field">
            연결 포인트
            <select
              name="pointId"
              value={pointId}
              onChange={(e) => setPointId(e.target.value)}
            >
              <option value="">포인트 연결 없음</option>
              {pointId &&
                !availablePoints.some((point) => point.id === pointId) && (
                  <option value={pointId}>
                    {points.some((point) => point.id === pointId)
                      ? pointName(points.find((point) => point.id === pointId))
                      : "현재 연결 포인트 · 정보 확인 필요"}
                  </option>
                )}
              {availablePoints.map((p) => (
                <option key={p.id} value={p.id}>
                  {pointName(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            사람 수정 등급
            <select name="grade" defaultValue={initial.humanGrade || ""}>
              <option value="">AI 결과 그대로 사용</option>
              {[1, 2, 3, 4, 5].map((g) => (
                <option key={g} value={g}>
                  {g}등급 · {g >= 3 ? "보수 필요" : "보수 불필요"}
                </option>
              ))}
            </select>
            <small>원래 AI 결과는 별도로 보존됩니다.</small>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={retake}
              onChange={(e) => setRetake(e.target.checked)}
            />
            <span>재촬영 필요</span>
          </label>
          <label className="field">
            재촬영 사유
            <textarea
              name="retakeReason"
              rows={2}
              required={retake}
              defaultValue={initial.retakeReason}
              maxLength={1000}
              placeholder="흐림, 가림 등 구체적인 사유"
            />
          </label>
          <label className="checkbox">
            <input
              name="labeling"
              type="checkbox"
              defaultChecked={initial.labeling}
            />
            <span>학습 라벨링 후보로 지정</span>
          </label>
          <div className="divider" />
          <label className="field">
            수정자
            <input
              name="actor"
              required
              maxLength={60}
              defaultValue="현업 엔지니어"
            />
          </label>
          <label className="field">
            변경 사유
            <textarea
              name="reason"
              required
              maxLength={1000}
              rows={2}
              placeholder="이번 판단이나 수정의 이유"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full-width" disabled={busy}>
            {busy ? "저장 중…" : "판단·이력 저장"}
          </button>
        </form>
      </div>
    </Modal>
  );
}
function PointDialog({
  point,
  openMaintenance,
  scope,
  points,
  plans,
  selectPhoto,
  reportHistoryError,
  close,
  done,
}: {
  point: Point;
  openMaintenance: (target: MaintenanceTarget) => void;
  scope: PhotoScope;
  points: Point[];
  plans: Plan[];
  selectPhoto: (photo: Photo) => void;
  reportHistoryError: (message: string) => void;
  close: () => void;
  done: (s: string) => Promise<void>;
}) {
  const [initial] = useState(point);
  const [maintenancePlan, setMaintenancePlan] = useState(
    scope.planId === "all" ? "" : scope.planId,
  );
  const [page, setPage] = useState(1);
  const photoList = usePhotoQuery({ ...scope, pointId: point.id, page });
  const [busy, setBusy] = useState(false);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [error, setError] = useState("");
  const history = useAuditHistory(
    `/points/${point.id}/history`,
    reportHistoryError,
  );
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title="포인트 관리·보수 이력" wide close={close}>
      <div className="detail-grid">
        <div>
          <div className="point-detail-heading">
            <Box size={28} />
            <h3>{point.equipment || "설비 미확인"}</h3>
            <p>{pointName(point)}</p>
            <span className="badge muted">
              현재 조건의 사진{" "}
              {photoList.data ? `${photoList.data.total}장` : "미조회"}
            </span>
          </div>
          {photoList.error && (
            <p className="form-error" role="alert">
              {photoList.error} · 마지막 조회 여부를 확인하세요.
            </p>
          )}
          <PhotoTable
            photos={photoList.data?.items ?? []}
            points={points}
            plans={plans}
            onSelect={selectPhoto}
          />
          <PhotoPagination data={photoList.data} change={setPage} />
          <section className="form-intro">
            <h3>계획별 보수 기록</h3>
            <label className="field">
              보수 기록의 검사 계획
              <select
                aria-label="보수 기록의 검사 계획"
                value={maintenancePlan}
                onChange={(event) => setMaintenancePlan(event.target.value)}
              >
                <option value="">계획을 선택하세요</option>
                <option value="unassigned">계획 미지정</option>
                {plans
                  .filter((plan) => plan.pointIds.includes(point.id))
                  .map((plan) => (
                    <option value={plan.id} key={plan.id}>
                      {plan.title}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="button secondary"
              disabled={!maintenancePlan || busy || metadataDirty}
              onClick={() =>
                openMaintenance({
                  planId:
                    maintenancePlan === "unassigned" ? null : maintenancePlan,
                  pointId: point.id,
                  recordPurpose:
                    scope.recordPurpose === "all"
                      ? point.recordPurpose
                      : scope.recordPurpose,
                })
              }
            >
              선택한 계획의 보수 기록 열기
            </button>
            <p>
              포인트 기본 정보의 변경은 먼저 저장하세요. 계획별 상태·방법·TA와
              워크리스트 등록은 보수 기록에서 관리합니다.
            </p>
          </section>
          <AuditList history={history} />
        </div>
        <form
          onChangeCapture={() => setMetadataDirty(true)}
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api(`/points/${point.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  expectedVersion: initial.editVersion,
                  equipment: form.get("equipment"),
                  rack: form.get("rack"),
                  name: form.get("name"),
                  actor: form.get("actor"),
                  reason: form.get("reason"),
                }),
              });
              await complete("포인트 기본 정보와 이력을 저장했습니다.");
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            <label className="field">
              설비번호
              <input
                name="equipment"
                defaultValue={initial.equipment}
                maxLength={120}
              />
            </label>
            <label className="field">
              랙 번호
              <input
                name="rack"
                defaultValue={initial.rack}
                maxLength={120}
                readOnly={!!initial.rackId}
              />
              {initial.rackId && (
                <small>{rackName(initial.rackId)} · 소속 유지</small>
              )}
            </label>
          </div>
          <label className="field">
            포인트 이름
            <input name="name" defaultValue={initial.name} maxLength={120} />
          </label>
          <div className="divider" />
          <label className="field">
            수정자
            <input
              name="actor"
              required
              maxLength={60}
              defaultValue="현업 엔지니어"
            />
          </label>
          <label className="field">
            변경 사유
            <textarea
              name="reason"
              required
              rows={3}
              maxLength={1000}
              placeholder="상태 변경이나 대상 지정·해제 이유"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="button primary full-width" disabled={busy}>
            {busy ? "저장 중…" : "기본 정보·이력 저장"}
          </button>
        </form>
      </div>
    </Modal>
  );
}
