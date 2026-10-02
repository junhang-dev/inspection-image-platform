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
import PlantDashboard from "@/components/PlantDashboard";
import RoiPanel from "@/components/RoiPanel";
import MaintenanceContext from "@/components/MaintenanceContext";
import { MaintenanceWorklist, type MaintenanceWorklistRow } from "@/components/MaintenancePanel";
import { useMaintenanceQuery, type MaintenancePage, type Purpose } from "@/lib/maintenance";
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
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Box,
  CalendarDays,
  Camera,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Clock3,
  Compass,
  FolderKanban,
  ImagePlus,
  Info,
  Layers3,
  LoaderCircle,
  MapPin,
  Moon,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Tag,
  EyeOff,
  RotateCcw,
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
const planStatusOrder: Record<Plan["status"], number> = { planned: 0, done: 1, cancelled: 2 };
const plansPerPage = 10;
type MaintenanceTarget = {
  planId: string | null;
  pointId: string | null;
  pointLabel?: string;
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
type Tab = "dashboard" | "plans" | "photos" | "points" | "worklist" | "taWorklist" | "labels";
type ToastTone = "success" | "error" | "info";
type Toast = { tone: ToastTone; message: string };
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const publicUploads = process.env.NEXT_PUBLIC_PUBLIC_UPLOADS_ALLOWED === "1";
const workStatusStages = [
  { id: "review", label: "검토 필요" },
  { id: "planned", label: "작업 예정" },
  { id: "progress", label: "작업 중" },
  { id: "done", label: "완료" },
] as const;
const nav = [
  { id: "dashboard", label: "공장 탐색", icon: Compass },
  { id: "plans", label: "검사 계획", icon: CalendarDays },
  { id: "photos", label: "사진 · 판독", icon: Camera },
  { id: "worklist", label: "보수 관리", icon: FolderKanban },
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
const planRackSummary = (rackIds: string[]) => {
  if (!rackIds.length) return "랙 미지정";
  const names = rackIds.slice(0, 2).map((id) => locations.racks.find((rack) => rack.id === id)?.name ?? "랙 확인 필요");
  const summary = names.every((name) => name.startsWith("파이프랙 "))
    ? `파이프랙 ${names.map((name) => name.slice(5)).join("·")}`
    : names.join("·");
  return `${summary}${rackIds.length > 2 ? ` 외 ${rackIds.length - 2}개` : ""}`;
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
function PhotoStatus({ photo }: { photo: Photo }) {
  const status = {
    pending: { label: "AI 판독 대기", tone: "muted" },
    processing: { label: "AI 판독 중", tone: "amber" },
    done: { label: "AI 판독 완료", tone: "green" },
    error: { label: "AI 판독 실패", tone: "red" },
    unread: { label: "자동 판독 안 함", tone: "muted" },
  }[photo.status];
  return <span className={`badge ${status.tone}`}>{status.label}</span>;
}
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
    <span className="badge muted">등급 없음</span>
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
  const isMaintenanceTab = tab === "worklist" || tab === "taWorklist";
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [points, setPoints] = useState<Point[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [scope, setScope] = useState<PhotoScope>(defaultPhotoScope);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedPhotoPlanIds, setSelectedPhotoPlanIds] = useState<string[] | null>(null);
  const [photoPageSize, setPhotoPageSize] = useState(10);
  const photoList = usePhotoQuery({
    ...scope,
    ...(tab === "photos" ? {
      planId: "all",
      ...(selectedPhotoPlanIds !== null ? { planIds: selectedPhotoPlanIds } : {}),
      teamId: "all",
      rackId: "all",
    } : {}),
    ...(tab === "plans" ? { planId: "all", teamId: "all", rackId: "all", visibility: "visible", search: "" } : {}),
    ...(tab === "labels" ? {
      planId: "all",
      recordPurpose: "inspection",
      visibility: "visible",
      teamId: "all",
      rackId: "all",
      search: "",
    } : {}),
    classification: tab === "plans" || tab === "labels" ? "all" : filter,
    labeling: tab === "labels" ? "true" : "all",
    page: tab === "plans" ? 1 : page,
    ...(tab === "plans" ? { pageSize: 1 } : tab === "photos" ? { pageSize: photoPageSize } : {}),
  });
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState(10);
  const [workStatus, setWorkStatus] = useState("all");
  const [workMethod, setWorkMethod] = useState("all");
  const [workTa, setWorkTa] = useState("all");
  const [worklistStatusSnapshot, setWorklistStatusSnapshot] = useState<{
    scopeKey: string;
    counts: MaintenancePage["statusCounts"];
  } | null>(null);
  const [maintenanceTarget, setMaintenanceTarget] =
    useState<MaintenanceTarget | null>(null);
  const pendingWorklistNavigation = useRef<"first" | "last" | null>(null);
  const pendingPhotoNavigation = useRef<"first" | "last" | null>(null);
  const [workVisibility, setWorkVisibility] = useState("visible");
  const [showAllWork, setShowAllWork] = useState(false);
  const worklistCountScopeKey = JSON.stringify([
    scope.planId,
    scope.recordPurpose,
    scope.teamId,
    scope.rackId,
    scope.search,
    workVisibility,
    showAllWork,
    workMethod,
    workTa,
  ]);
  const maintenance = useMaintenanceQuery(
    {
      planId: scope.planId,
      recordPurpose: scope.recordPurpose,
      ...(isMaintenanceTab ? { targetType: "photo" as const } : {}),
      inWorklist: isMaintenanceTab && !showAllWork && workVisibility === "visible" ? "true" : "all",
      visibility: (tab === "dashboard" ? "visible" : workVisibility) as "visible" | "hidden" | "all",
      ...(isMaintenanceTab || (tab === "dashboard" && scope.teamId !== "all")
        ? {
            teamId: scope.teamId,
            rackId: scope.rackId,
            search: isMaintenanceTab ? scope.search : "",
            repairStatus: isMaintenanceTab ? workStatus : "all",
            repairMethod: isMaintenanceTab ? workMethod : "all",
            ta: isMaintenanceTab ? (tab === "taWorklist" ? "true" : workTa) : "all",
            page: isMaintenanceTab ? workPage : 1,
            pageSize: isMaintenanceTab ? workPageSize : 50,
          }
        : {}),
    },
    isMaintenanceTab || tab === "points" || (tab === "dashboard" && scope.teamId !== "all"),
  );
  useEffect(() => {
    if (isMaintenanceTab && maintenance.data) {
      setWorklistStatusSnapshot({ scopeKey: worklistCountScopeKey, counts: maintenance.data.statusCounts });
    }
  }, [isMaintenanceTab, maintenance.data, worklistCountScopeKey]);
  const worklistStatusCounts = worklistStatusSnapshot?.scopeKey === worklistCountScopeKey
    ? worklistStatusSnapshot.counts
    : maintenance.data?.statusCounts ?? null;
  const worklistItems = isMaintenanceTab ? maintenance.data?.items ?? [] : [];
  const maintenanceItemTarget = useCallback((item: MaintenanceWorklistRow): MaintenanceTarget => ({
    planId: item.planId,
    pointId: item.pointId,
    pointLabel: item.pointLabel,
    recordPurpose: item.recordPurpose ?? "inspection",
    targetType: item.targetType,
    targetId: item.targetId,
    ...(item.targetType === "photo" ? { photoId: item.targetId } : {}),
  }), []);
  const worklistItemIndex = maintenanceTarget?.targetType === "photo"
    ? worklistItems.findIndex((item) => item.targetId === maintenanceTarget.targetId)
    : -1;
  const canNavigateWorklist = (direction: -1 | 1) => {
    if (worklistItemIndex < 0 || !maintenance.data) return false;
    const nextIndex = worklistItemIndex + direction;
    if (nextIndex >= 0 && nextIndex < worklistItems.length) return true;
    return direction < 0
      ? maintenance.data.page > 1
      : maintenance.data.page < maintenance.data.pages;
  };
  const navigateWorklist = (direction: -1 | 1) => {
    if (worklistItemIndex < 0 || !maintenance.data) return;
    const nextIndex = worklistItemIndex + direction;
    const nextItem = worklistItems[nextIndex];
    if (nextItem) {
      setMaintenanceTarget(maintenanceItemTarget(nextItem));
      return;
    }
    const nextPage = maintenance.data.page + direction;
    if (nextPage < 1 || nextPage > maintenance.data.pages) return;
    pendingWorklistNavigation.current = direction > 0 ? "first" : "last";
    setWorkPage(nextPage);
  };
  useEffect(() => {
    const edge = pendingWorklistNavigation.current;
    if (!isMaintenanceTab || !edge || !maintenance.data || maintenance.data.page !== workPage || !maintenance.data.items.length) return;
    const item = edge === "first"
      ? maintenance.data.items[0]
      : maintenance.data.items[maintenance.data.items.length - 1];
    pendingWorklistNavigation.current = null;
    setMaintenanceTarget(maintenanceItemTarget(item));
  }, [isMaintenanceTab, maintenance.data, workPage, maintenanceItemTarget]);
  const needsMaintenanceReviewQuery = tab === "dashboard" && scope.rackId !== "all" &&
    Boolean(maintenance.data && maintenance.data.total > maintenance.data.items.length);
  const maintenanceReview = useMaintenanceQuery(
    {
      recordPurpose: "inspection",
      visibility: "visible",
      teamId: scope.teamId,
      rackId: scope.rackId,
      repairStatus: "review",
      pageSize: 1,
    },
    needsMaintenanceReviewQuery,
  );
  const openMaintenance = (target: MaintenanceTarget) => {
    pendingWorklistNavigation.current = null;
    setDetail(null);
    setPointDetail(null);
    setMaintenanceTarget(target);
  };
  const photos = photoList.data?.items ?? [];
  const changeScope = (next: PhotoScope) => {
    setScope(next);
    setPage(1);
    setWorkPage(1);
  };
  const [newPointRack, setNewPointRack] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadContext, setUploadContext] = useState<{
    plan: Plan;
    point?: Point;
    rackId?: string;
  } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [mapPlanSeed, setMapPlanSeed] = useState<{ teamId: string; rackIds: string[] } | null>(null);
  const [planVisibility, setPlanVisibility] = useState("visible");
  const [planStatus, setPlanStatus] = useState<"all" | Plan["status"]>("planned");
  const [planSearch, setPlanSearch] = useState("");
  const [planPage, setPlanPage] = useState(1);
  const [planSort, setPlanSort] = useState<"created" | "date">("created");

  const resetFilters = (target: Tab, nextScope = defaultPhotoScope) => {
    changeScope(nextScope);
    setFilter("all");
    if (target === "photos" || target === "labels") {
      setSelectedPhotoPlanIds(null);
      setPhotoPageSize(10);
    }
    if (target === "dashboard" || target === "plans") {
      setPlanVisibility("visible");
      setPlanStatus("planned");
      setPlanSearch("");
      setPlanPage(1);
      setPlanSort("created");
    }
    if (target === "worklist" || target === "taWorklist") {
      setWorkStatus("all");
      setWorkMethod("all");
      setWorkTa(target === "taWorklist" ? "true" : "all");
      setWorkVisibility("visible");
      setShowAllWork(false);
      setWorkPage(1);
      setWorkPageSize(10);
    }
  };

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("drone-inspection-theme");
    if (savedTheme === "dark") {
      document.documentElement.dataset.theme = "dark";
      setIsDarkMode(true);
    }
  }, []);

  const toggleTheme = () => {
    const nextIsDarkMode = !isDarkMode;
    document.documentElement.dataset.theme = nextIsDarkMode ? "dark" : "light";
    window.localStorage.setItem(
      "drone-inspection-theme",
      nextIsDarkMode ? "dark" : "light",
    );
    setIsDarkMode(nextIsDarkMode);
  };

  const [planDetail, setPlanDetail] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<Photo | null>(null);
  const photoDetailIndex = detail ? photos.findIndex((photo) => photo.id === detail.id) : -1;
  const canNavigatePhoto = (direction: -1 | 1) => {
    if (photoDetailIndex < 0 || !photoList.data) return false;
    const nextIndex = photoDetailIndex + direction;
    if (nextIndex >= 0 && nextIndex < photos.length) return true;
    return direction < 0
      ? photoList.data.page > 1
      : photoList.data.page < photoList.data.pages;
  };
  const navigatePhoto = (direction: -1 | 1) => {
    if (!canNavigatePhoto(direction)) return;
    const next = photos[photoDetailIndex + direction];
    if (next) {
      setDetail(next);
      return;
    }
    pendingPhotoNavigation.current = direction > 0 ? "first" : "last";
    setPage((current) => current + direction);
  };
  useEffect(() => {
    const edge = pendingPhotoNavigation.current;
    const data = photoList.data;
    if (
      !detail ||
      !(tab === "photos" || tab === "labels") ||
      !edge ||
      !data ||
      data.page !== page ||
      !data.items.length
    ) return;
    pendingPhotoNavigation.current = null;
    setDetail(edge === "first" ? data.items[0] : data.items[data.items.length - 1]);
  }, [detail, page, photoList.data, tab]);
  const [photoVisibilityTarget, setPhotoVisibilityTarget] = useState<Photo | null>(null);
  const [pointDetail, setPointDetail] = useState<Point | null>(null);
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const selectedPlan = plans.find((plan) => plan.id === scope.planId);
  const scopedPlans = plans.filter((plan) => plan.recordPurpose === "inspection" &&
    plan.visibility === planVisibility &&
    (scope.teamId === "all" || plan.teamId === scope.teamId) &&
    (scope.rackId === "all" || plan.rackIds.includes(scope.rackId)));
  const searchText = planSearch.trim().toLocaleLowerCase("ko-KR");
  const searchDigits = searchText.replace(/\D/g, "");
  const visiblePlans = scopedPlans.filter((plan) => {
    if (planStatus !== "all" && plan.status !== planStatus) return false;
    if (!searchText) return true;
    const titleMatches = plan.title.toLocaleLowerCase("ko-KR").includes(searchText);
    const date = plan.date ?? "";
    const dateDigits = date.replace(/\D/g, "");
    const shortDateDigits = dateDigits.length === 8 ? dateDigits.slice(2) : dateDigits;
    const dateMatches = date.toLocaleLowerCase("ko-KR").includes(searchText) ||
      (searchDigits.length >= 4 && (dateDigits.includes(searchDigits) || shortDateDigits.includes(searchDigits)));
    return titleMatches || dateMatches;
  })
    .sort((a, b) => planStatusOrder[a.status] - planStatusOrder[b.status] ||
      (planSort === "date" ? (a.date || "9999-12-31").localeCompare(b.date || "9999-12-31") : 0));
  const planPageCount = Math.max(1, Math.ceil(visiblePlans.length / plansPerPage));
  const pagePlans = visiblePlans.slice((planPage - 1) * plansPerPage, planPage * plansPerPage);
  useEffect(() => {
    setPlanPage((current) => current === 1 ? current : 1);
  }, [scope.teamId, scope.rackId, planVisibility, planStatus, planSort, planSearch]);
  useEffect(() => {
    setPlanPage((current) => Math.min(current, planPageCount));
  }, [planPageCount]);
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
      setPlansLoaded(true);
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
  const pageTitle = tab === "taWorklist" ? "TA 작업" : nav.find((item) => item.id === tab)?.label;
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const dateKey = (day: number) =>
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const go = (target: Tab) => {
    setTab(target);
    resetFilters(target, target === "labels" ? defaultPhotoScope : {
      ...defaultPhotoScope,
      teamId: scope.teamId,
      rackId: scope.rackId,
    });
  };
  const openPlanFromScope = () => {
    setMapPlanSeed(scope.teamId === "all" ? null : {
      teamId: scope.teamId,
      rackIds: scope.rackId === "all" ? [] : [scope.rackId],
    });
    setPlanOpen(true);
  };
  const uploadForPlan = (plan: Plan, point?: Point, rackId?: string) => {
    setPlanDetail(null);
    setUploadContext({ plan, point, rackId });
    setUploadOpen(true);
  };
  const viewPlanPhotos = (plan: Plan, rackId?: string) => {
    setPlanDetail(null);
    go("photos");
    setSelectedPhotoPlanIds([plan.id]);
    changeScope({ ...defaultPhotoScope, planId: plan.id, rackId: rackId ?? "all" });
  };

  return (
    <div className={`app-shell${tab === "dashboard" ? " dashboard-shell" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/flare-stack-mark.png" alt="" />
          </span>
          <span>Drone Inspection Platform</span>
        </div>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              aria-label={label}
              title={label}
              className={tab === id || (id === "worklist" && tab === "taWorklist") ? "nav-item selected" : "nav-item"}
              onClick={() => go(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom powered-by">
          Powered by Drone Inspection AI Backend
        </div>
      </aside>
      <div className={`main-shell${tab === "dashboard" ? " immersive-shell" : ""}`}>
        {tab !== "dashboard" && <header className="topbar">
          <div className="top-actions">
            <button
              className="icon-button theme-toggle"
              onClick={toggleTheme}
              aria-label={isDarkMode ? "밝은 모드로 전환" : "어두운 모드로 전환"}
              aria-pressed={isDarkMode}
              title={isDarkMode ? "밝은 모드" : "어두운 모드"}
            >
              {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              className="button secondary login-button"
              onClick={() =>
                setToast({
                  tone: "info",
                  message: "로그인 기능은 추후 연결 예정입니다.",
                })
              }
            >
              로그인
            </button>
          </div>
        </header>}
        <main className={tab === "dashboard" ? "dashboard-main" : undefined}>
          {tab !== "dashboard" && <div className="page-heading">
            <div>
              <h1>{pageTitle}</h1>
            </div>
            <div className="heading-actions">
              {tab === "worklist" && <button className="button secondary" onClick={() => go("taWorklist")}><Wrench size={16} />TA 작업 보기</button>}
              {tab === "taWorklist" && <button className="button secondary" onClick={() => go("worklist")}><ChevronLeft size={16} />보수 관리로 돌아가기</button>}
              {tab === "plans" && <button
                className="button primary"
                onClick={openPlanFromScope}
              >
                <CalendarDays size={16} />
                검사계획 만들기
              </button>}
              {tab === "photos" && <button
                className="button primary"
                onClick={() => { setUploadContext(null); if (plans.some((p) => p.status === "planned" && p.visibility === "visible")) setUploadOpen(true); else setPlanOpen(true); }}
              >
                <Plus size={18} />
                사진 추가
              </button>}
            </div>
          </div>}
          {error && tab !== "dashboard" && (
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
          {!health?.model?.ready && !error && tab !== "dashboard" && (
            <div className="notice">
              <Clock3 size={17} />
              <span>
                AI 모델 연결 대기 중입니다. 사진 업로드와 업무 기록은 계속할 수
                있으며, 판독은 모델 준비 후 시작됩니다.
              </span>
            </div>
          )}
          {tab !== "dashboard" && tab !== "labels" && <PhotoScopeFields
            context={tab === "taWorklist" ? "worklist" : tab}
            taOnly={tab === "taWorklist"}
            scope={scope}
            plans={plans}
            change={changeScope}
            reset={() => resetFilters(tab)}
            selectedPlanIds={selectedPhotoPlanIds}
            changePlanIds={(ids) => { setSelectedPhotoPlanIds(ids); setPage(1); }}
            worklistFilters={isMaintenanceTab ? {
              method: workMethod,
              ta: tab === "taWorklist" ? "true" : workTa,
              visibility: workVisibility,
              showAll: showAllWork,
              changeMethod: (value) => { setWorkMethod(value); setWorkPage(1); },
              changeTa: (value) => { setWorkTa(value); setWorkPage(1); },
              changeVisibility: (value) => { setWorkVisibility(value); setWorkPage(1); },
              changeShowAll: (value) => { setShowAllWork(value); setWorkPage(1); },
            } : undefined}
          />}
          {photoList.error &&
            ["photos", "labels", "points"].includes(tab) && (
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
          <div hidden={tab !== "dashboard"}>
            <PlantDashboard
              paused={tab !== "dashboard" || Boolean(uploadOpen || planOpen || detail || newPointRack || planDetail || pointDetail || maintenanceTarget)}
              teamId={scope.teamId === "all" ? null : scope.teamId}
              rackId={scope.rackId === "all" ? null : scope.rackId}
              plansLoaded={plansLoaded}
              plans={plans.filter((plan) => plan.recordPurpose === "inspection")}
              points={points.filter((point) => (point.recordPurpose ?? "inspection") === "inspection")}
              photos={photos}
              photoTotal={photoList.data?.total ?? null}
              photoSummary={photoList.data?.summary ?? null}
              photoError={photoList.error}
              maintenance={maintenance.data?.items ?? []}
              maintenanceTotal={maintenance.data?.total ?? null}
              maintenanceReviewTotal={maintenance.data && maintenance.data.total <= maintenance.data.items.length
                ? maintenance.data.items.filter((item) => item.repairStatus === "review").length
                : maintenanceReview.data?.total ?? null}
              maintenanceWorklistTotal={maintenance.data?.summary?.worklist ?? null}
              maintenanceError={maintenance.error || (needsMaintenanceReviewQuery ? maintenanceReview.error : "")}
              error={error}
              onRetryData={() => { void refresh(); }}
              onRetryPhotos={photoList.refresh}
              onRetryMaintenance={() => { maintenance.refresh(); maintenanceReview.refresh(); }}
              onScopeChange={(teamId, rackId) => changeScope({
                ...defaultPhotoScope,
                teamId: teamId ?? "all",
                rackId: rackId ?? "all",
              })}
              onCreatePlan={(teamId, rackIds) => {
                setMapPlanSeed({ teamId, rackIds });
                setPlanOpen(true);
              }}
              onOpenPlan={(id) => {
                const plan = plans.find((item) => item.id === id);
                if (plan) setPlanDetail(plan);
              }}
              onOpenPlans={() => go("plans")}
              onUploadPlan={(id, rackId) => {
                const plan = plans.find((item) => item.id === id);
                if (plan) uploadForPlan(plan, undefined, rackId);
              }}
              onOpenPhoto={selectPhoto}
              onOpenPoint={(id) => {
                const point = points.find((item) => item.id === id);
                if (point) void selectPoint(point);
              }}
              onOpenMaintenance={(id) => {
                const item = maintenance.data?.items.find((row) => row.id === id);
                if (item) openMaintenance({
                  planId: item.planId,
                  pointId: item.pointId,
                  recordPurpose: item.recordPurpose,
                  targetType: item.targetType,
                  targetId: item.targetId,
                  ...(item.targetType === "photo" ? { photoId: item.targetId } : {}),
                });
              }}
              onOpenPhotos={() => go("photos")}
              onOpenWorklist={() => { go("worklist"); setShowAllWork(true); }}
              onOpenReviewWorklist={() => { go("worklist"); setShowAllWork(true); setWorkStatus("review"); }}
            />
          </div>
          {(tab === "photos" || tab === "labels") && (
            <section className="panel">
              {tab === "photos" && <div className="list-toolbar photo-list-toolbar">
                <label className="filter-control">판독 상태<select
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
                </select></label>
              </div>}
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
                  onVisibilityChange={setPhotoVisibilityTarget}
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
              <PhotoPagination
                data={photoList.data}
                change={setPage}
                pageSize={tab === "photos" ? photoPageSize : undefined}
                onPageSizeChange={tab === "photos" ? (value) => {
                  setPhotoPageSize(value);
                  setPage(1);
                } : undefined}
              />
            </section>
          )}
          {isMaintenanceTab && (
            <>
              <div className="worklist-status-bar" role="group" aria-label={tab === "taWorklist" ? "TA 업무 상태별 필터" : "보수 업무 상태별 필터"}>
                <button
                  type="button"
                  className={`worklist-status-chip${workStatus === "all" ? " is-selected" : ""}`}
                  aria-pressed={workStatus === "all"}
                  disabled={!worklistStatusCounts}
                  onClick={() => { setWorkStatus("all"); setWorkPage(1); }}
                >
                  <span>{tab === "taWorklist" ? "TA 전체" : "전체"}</span><strong>{worklistStatusCounts ? Object.values(worklistStatusCounts).reduce((sum, count) => sum + count, 0) : "—"}</strong>
                </button>
                {workStatusStages.map(({ id, label }) => (
                  <button
                    type="button"
                    key={id}
                    className={`worklist-status-chip${workStatus === id ? " is-selected" : ""}`}
                    aria-pressed={workStatus === id}
                    disabled={!worklistStatusCounts}
                    onClick={() => { setWorkStatus(id); setWorkPage(1); }}
                  >
                    <span>{label}</span><strong>{worklistStatusCounts?.[id] ?? "—"}</strong>
                  </button>
                ))}
                {(workStatus === "none" || !!worklistStatusCounts?.none) && (
                  <button
                    type="button"
                    className={`worklist-status-chip${workStatus === "none" ? " is-selected" : ""}`}
                    aria-pressed={workStatus === "none"}
                    disabled={!worklistStatusCounts}
                    onClick={() => { setWorkStatus("none"); setWorkPage(1); }}
                  >
                    <span>상태 미지정</span><strong>{worklistStatusCounts?.none ?? "—"}</strong>
                  </button>
                )}
              </div>
              <MaintenanceWorklist
                items={maintenance.data?.items ?? []}
                total={maintenance.data?.total ?? null}
                page={maintenance.data?.page}
                pages={maintenance.data?.pages}
                pageSize={workPageSize}
                onPageSizeChange={(value) => { setWorkPageSize(value); setWorkPage(1); }}
                title={tab === "taWorklist" ? "TA 작업 목록" : "대상 목록"}
                emptyDescription={tab === "taWorklist" ? "보수 상세에서 TA 작업에 포함을 저장한 항목이 여기에 모입니다." : undefined}
                onPageChange={setWorkPage}
                busy={!maintenance.data && !maintenance.error}
                error={maintenance.error || null}
                onOpen={(item) => openMaintenance(maintenanceItemTarget(item))}
              />
            </>
          )}
          {tab === "plans" && <section className="panel plan-panel">
            <div className="panel-title">
              <h2>검사계획 <span className="plan-result-count">{visiblePlans.length}개</span></h2>
            </div>
            <div className="plan-list-toolbar">
              <div className="plan-status-filters" role="group" aria-label="계획 상태">
                {([ ["planned", "진행 중"], ["all", "전체"], ["done", "완료"], ["cancelled", "취소"] ] as const).map(([status, label]) =>
                  <button key={status} type="button" className={planStatus === status ? "selected" : ""} aria-pressed={planStatus === status} onClick={() => { setPlanStatus(status); setPlanPage(1); }}>{label} <span>{status === "all" ? scopedPlans.length : scopedPlans.filter((plan) => plan.status === status).length}</span></button>)}
              </div>
              <div className="plan-list-tools">
                <label className="filter-control plan-visibility">표시 상태
                  <select value={planVisibility} onChange={(event) => {
                    const next = event.target.value;
                    setPlanVisibility(next);
                    setPlanStatus(next === "visible" ? "planned" : "all");
                    setPlanPage(1);
                  }}><option value="visible">현재 계획</option><option value="hidden">삭제한 계획</option></select>
                </label>
                <label className="filter-control plan-sort">정렬
                  <select value={planSort} onChange={(event) => { setPlanSort(event.target.value as "created" | "date"); setPlanPage(1); }}> <option value="created">최근 등록 순</option><option value="date">예정일 빠른 순</option></select>
                </label>
                <label className="filter-control plan-search-control">계획 이름·예정일
                  <span className="plan-list-search"><Search size={17} aria-hidden="true"/><input type="search" value={planSearch} onChange={(event) => { setPlanSearch(event.target.value); setPlanPage(1); }} placeholder="이름 또는 예정일 검색" title="계획 이름, 261001 또는 2026-10-01로 검색"/></span>
                </label>
              </div>
            </div>
            {photoList.error && <div className="plan-count-error" role="alert">사진 장수를 조회하지 못했습니다. <button type="button" className="text-button" onClick={photoList.refresh}>다시 조회</button></div>}
            {!visiblePlans.length && <Empty text={planStatus === "planned" && !planSearch && scopedPlans.length ? "진행 중인 계획이 없습니다. 완료·취소 계획은 위 상태에서 확인하세요." : scopedPlans.length ? "조건에 맞는 검사계획이 없습니다." : "선택한 범위의 검사계획이 없습니다."} action={planVisibility === "visible" && planStatus === "planned" && !planSearch ? <button className="button primary" onClick={openPlanFromScope}>검사계획 만들기</button> : scopedPlans.length ? <button className="button secondary" onClick={() => { setPlanStatus("all"); setPlanSearch(""); }}>목록 조건 초기화</button> : undefined}/>}
            <div className="v3-plan-list">{pagePlans.map((plan) => <article key={plan.id}>
              <div className="plan-list-info">
                <div className="plan-list-title"><h3>{plan.title}</h3><span className={`badge ${plan.status === "done" ? "green" : "muted"}`}>{plan.visibility === "hidden" ? "삭제됨" : plan.status === "planned" ? "진행 중" : plan.status === "done" ? "완료" : "취소"}</span></div>
                <p>{plan.date || "예정일 미지정"} · {locations.teams.find((team) => team.id === plan.teamId)?.name ?? "생산팀 확인 필요"} · {planRackSummary(plan.rackIds)}{!photoList.error && photoList.data?.planCounts && <> · 등록 사진 {photoList.data.planCounts[plan.id] ?? 0}장</>}</p>
              </div>
              <div className="heading-actions"><button className="button secondary" onClick={() => setPlanDetail(plan)}>상세 보기</button>{plan.status === "planned" && plan.visibility === "visible" && <button className="button primary" onClick={() => uploadForPlan(plan)}>사진 추가</button>}</div>
            </article>)}</div>
            {visiblePlans.length > plansPerPage && <nav className="plan-pagination" aria-label="검사계획 페이지">
              <span>전체 {visiblePlans.length}개 · {planPage}/{planPageCount}페이지</span>
              <button className="button secondary" disabled={planPage <= 1} onClick={() => setPlanPage(1)}>처음</button>
              <button className="button secondary" disabled={planPage <= 1} onClick={() => setPlanPage((current) => Math.max(1, current - 1))}>이전</button>
              <button className="button secondary" disabled={planPage >= planPageCount} onClick={() => setPlanPage((current) => Math.min(planPageCount, current + 1))}>다음</button>
              <button className="button secondary" disabled={planPage >= planPageCount} onClick={() => setPlanPage(planPageCount)}>마지막</button>
            </nav>}
          </section>}
          {tab !== "dashboard" && tab !== "plans" && tab !== "photos" && tab !== "worklist" && tab !== "taWorklist" && tab !== "labels" && <footer>
            <ShieldCheck size={14} />
            <span>
              등급은 사진의 시각적 부식 분류입니다. 설비 안전성이나 실제 보수
              지시를 확정하지 않습니다.
            </span>
            <span>Drone Inspection Platform · 드론 검사 플랫폼</span>
          </footer>}
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
            if (uploadContext && !uploadContext.rackId) setPlanDetail(uploadContext.plan);
            setUploadContext(null);
          }}
          viewPhotos={(plan, rackId) => {
            setUploadOpen(false);
            setUploadContext(null);
            viewPlanPhotos(plan, rackId);
          }}
          done={notify}
        />
      )}
      {planOpen && (
        <PlanDialog
          initialTeamId={mapPlanSeed?.teamId ?? (scope.teamId === "all" ? "" : scope.teamId)}
          initialRackIds={mapPlanSeed?.rackIds ?? []}
          close={() => { setPlanOpen(false); setMapPlanSeed(null); }}
          done={notify}
          created={(plan) => { setMapPlanSeed(null); setPlanDetail(plan); }}
        />
      )}
      {detail && (
        <PhotoDialog
          key={detail.id}
          photo={photos.find((p) => p.id === detail.id) || detail}
          reportHistoryError={reportHistoryError}
          close={() => setDetail(null)}
          done={notify}
          onNavigate={tab === "photos" || tab === "labels" ? navigatePhoto : undefined}
          canNavigatePrevious={canNavigatePhoto(-1)}
          canNavigateNext={canNavigatePhoto(1)}
          createRetakePlan={(photo) => {
            const rack = locations.racks.find((item) => item.id === photo.rackId);
            setMapPlanSeed({
              teamId: photo.teamId ?? rack?.teamId ?? "",
              rackIds: photo.rackId ? [photo.rackId] : [],
            });
            setPlanOpen(true);
          }}
        />
      )}
      {photoVisibilityTarget && (
        <PhotoVisibilityDialog
          photo={photoVisibilityTarget}
          close={() => setPhotoVisibilityTarget(null)}
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
          title={maintenanceTarget.targetType === "photo" ? "보수 관리" : "보수 기록"}
          wide
          close={() => { pendingWorklistNavigation.current = null; setMaintenanceTarget(null); }}
          onNavigate={maintenanceTarget.targetType === "photo" ? navigateWorklist : undefined}
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
            pointLabel={maintenanceTarget.pointLabel ?? pointName(
              points.find((point) => point.id === maintenanceTarget.pointId),
            )}
            onPrevious={() => navigateWorklist(-1)}
            onNext={() => navigateWorklist(1)}
            canPrevious={canNavigateWorklist(-1)}
            canNext={canNavigateWorklist(1)}
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
function PhotoScopeFields({
  context,
  taOnly = false,
  scope,
  plans,
  change,
  reset,
  selectedPlanIds,
  changePlanIds,
  worklistFilters,
}: {
  context: Tab;
  taOnly?: boolean;
  scope: PhotoScope;
  plans: Plan[];
  change: (scope: PhotoScope) => void;
  reset: () => void;
  selectedPlanIds: string[] | null;
  changePlanIds: (ids: string[] | null) => void;
  worklistFilters?: {
    method: string;
    ta: string;
    visibility: string;
    showAll: boolean;
    changeMethod: (value: string) => void;
    changeTa: (value: string) => void;
    changeVisibility: (value: string) => void;
    changeShowAll: (value: boolean) => void;
  };
}) {
  const set = (patch: Partial<PhotoScope>) => change({ ...scope, ...patch });
  const hasAdvancedFilters = context !== "plans";
  const hasVisibilityFilter = context !== "worklist";
  const inspectionPlans = plans.filter((plan) => plan.recordPurpose === "inspection");
  const hasActiveAdvancedFilter =
    (context !== "photos" && scope.planId !== "all") ||
    scope.search !== "" ||
    (hasVisibilityFilter && scope.visibility !== "visible") ||
    (context === "worklist" && !!worklistFilters && (
      worklistFilters.method !== "all" ||
      (!taOnly && worklistFilters.ta !== "all") ||
      (!taOnly && worklistFilters.visibility !== "visible") ||
      (!taOnly && worklistFilters.showAll)
    ));
  const detailSummary = context === "worklist" ? "검사계획·검색 조건" : "상세 조건";

  if (context === "photos") {
    return (
      <section className="common-scope" aria-label="사진 조회 조건">
        <div className="scope-primary photo-plan-scope">
          <PhotoPlanFilter plans={inspectionPlans} selectedIds={selectedPlanIds} change={changePlanIds} />
          <button className="text-button scope-reset" type="button" onClick={reset}>조회 초기화</button>
        </div>
        <details className="scope-details">
          <summary>상세 조건{hasActiveAdvancedFilter ? " · 적용 중" : ""}</summary>
          <div className="photo-scope">
            <label>
              사진 표시
              <select value={scope.visibility} onChange={(event) => set({ visibility: event.target.value as PhotoScope["visibility"] })}>
                <option value="visible">현재 사진</option>
                <option value="hidden">삭제한 사진</option>
                <option value="all">전체 사진</option>
              </select>
            </label>
            <label className="photo-search">
              검색
              <input type="search" maxLength={200} value={scope.search} onChange={(event) => set({ search: event.target.value })} placeholder="사진명 또는 검사계획" />
            </label>
          </div>
        </details>
      </section>
    );
  }

  return (
    <section className="common-scope" aria-label="조회 조건">
      <div className="scope-primary">
        <label className="field">
          생산팀
          <select
            aria-label="생산팀 필터"
            value={scope.teamId}
            onChange={(event) =>
              set({ teamId: event.target.value, rackId: "all" })
            }
          >
            <option value="all">모든 생산팀</option>
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
            aria-label="파이프랙 필터"
            value={scope.rackId}
            onChange={(event) => {
              const rack = locations.racks.find(
                (item) => item.id === event.target.value,
              );
              set({
                rackId: event.target.value,
                ...(rack ? { teamId: rack.teamId } : {}),
              });
            }}
          >
            <option value="all">모든 랙</option>
            {locations.racks
              .filter(
                (rack) =>
                  scope.teamId === "all" || rack.teamId === scope.teamId,
              )
              .map((rack) => (
                <option key={rack.id} value={rack.id}>
                  {rackName(rack.id)}
                </option>
              ))}
          </select>
        </label>
        <button
          className="text-button scope-reset"
          type="button"
          onClick={reset}
        >
          조회 초기화
        </button>
      </div>
      {hasAdvancedFilters && (
        <details className="scope-details">
          <summary>
            {detailSummary}{hasActiveAdvancedFilter ? " · 적용 중" : ""}
          </summary>
          <div className="photo-scope">
            <label>
              검사계획
              <select
                aria-label="검사 계획 필터"
                value={scope.planId}
                onChange={(event) => set({ planId: event.target.value })}
              >
                <option value="all">모든 검사계획</option>
                <option value="unassigned">계획 미지정</option>
                {plans
                  .filter((plan) => plan.recordPurpose === "inspection")
                  .map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.title}
                      {plan.visibility === "hidden" ? " (삭제됨)" : ""}
                    </option>
                  ))}
              </select>
            </label>
            {hasVisibilityFilter && (
              <label>
                사진 표시
                <select
                  value={scope.visibility}
                  onChange={(event) =>
                    set({
                      visibility: event.target
                        .value as PhotoScope["visibility"],
                    })
                  }
                >
                  <option value="visible">현재 사진</option>
                  <option value="hidden">삭제한 사진</option>
                  <option value="all">전체 사진</option>
                </select>
              </label>
            )}
            <label className="photo-search">
              검색
              <input
                type="search"
                maxLength={200}
                value={scope.search}
                onChange={(event) => set({ search: event.target.value })}
                placeholder={context === "worklist" ? "계획명, 포인트 또는 사진명" : "사진명, 계획 또는 위치"}
                title={context === "worklist" ? "검사계획명, 포인트 이름 또는 사진 파일명으로 검색" : undefined}
              />
            </label>
            {context === "worklist" && worklistFilters && (
              <>
                <label>
                  작업 방법
                  <select aria-label="보수 방법 필터" value={worklistFilters.method} onChange={(event) => worklistFilters.changeMethod(event.target.value)}>
                    <option value="all">모든 방법</option>
                    <option value="undecided">미정</option>
                    <option value="paint">도장</option>
                    <option value="replace">교체</option>
                  </select>
                </label>
                {!taOnly && <label>
                  TA
                  <select aria-label="보수 TA 필터" value={worklistFilters.ta} onChange={(event) => worklistFilters.changeTa(event.target.value)}>
                    <option value="all">전체</option>
                    <option value="true">포함</option>
                    <option value="false">미포함</option>
                  </select>
                </label>}
                {!taOnly && <label>
                  표시 상태
                  <select value={worklistFilters.visibility} onChange={(event) => worklistFilters.changeVisibility(event.target.value)}>
                    <option value="visible">현재 항목</option>
                    <option value="hidden">삭제한 항목</option>
                    <option value="all">전체 이력 항목</option>
                  </select>
                </label>}
                {!taOnly && <label className="worklist-show-all-filter">
                  <input type="checkbox" checked={worklistFilters.showAll} onChange={(event) => worklistFilters.changeShowAll(event.target.checked)} />
                  수동 제외·등급 하향 항목도 보기
                </label>}
              </>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function PhotoPlanFilter({
  plans,
  selectedIds,
  change,
}: {
  plans: Plan[];
  selectedIds: string[] | null;
  change: (ids: string[] | null) => void;
}) {
  const planIds = new Set(plans.map((plan) => plan.id));
  const selected = selectedIds === null ? planIds : new Set(selectedIds.filter((id) => planIds.has(id)));
  const selectedCount = selected.size;
  const allSelected = plans.length > 0 && selectedCount === plans.length;
  const label = selectedIds === null || allSelected
    ? "모든 검사계획"
    : selectedCount === 0
      ? "검사계획 0개 선택"
      : `${selectedCount}개 검사계획 선택`;
  const groupedPlans = locations.teams.map((team) => ({
    id: team.id,
    name: team.name,
    plans: plans.filter((plan) => plan.teamId === team.id),
  })).filter((group) => group.plans.length > 0);
  const unassignedPlans = plans.filter((plan) => !locations.teams.some((team) => team.id === plan.teamId));
  if (unassignedPlans.length) groupedPlans.push({ id: "unassigned", name: "생산팀 미확인", plans: unassignedPlans });

  const togglePlans = (ids: string[]) => {
    const next = new Set(selected);
    const shouldSelect = ids.some((id) => !next.has(id));
    for (const id of ids) shouldSelect ? next.add(id) : next.delete(id);
    change(next.size === plans.length ? null : [...next]);
  };

  return (
    <details className="photo-plan-filter">
      <summary aria-label={`검사계획 필터: ${label}`}>
        <span className="photo-plan-filter-label">검사계획</span>
        <span className="photo-plan-filter-value">{label}</span>
        <ChevronRight size={17} aria-hidden="true" />
      </summary>
      <div className="photo-plan-menu">
        <label className="photo-plan-option photo-plan-all">
          <input type="checkbox" aria-label="전체 검사계획 선택" checked={allSelected} onChange={() => change(allSelected ? [] : null)} />
          <span>전체 검사계획</span>
          <small>{plans.length}개</small>
        </label>
        {!plans.length ? <p className="photo-plan-empty">조회할 검사계획이 없습니다.</p> : groupedPlans.map((group) => {
          const groupSelected = group.plans.filter((plan) => selected.has(plan.id)).length;
          const checked = groupSelected === group.plans.length;
          return (
            <section className="photo-plan-group" key={group.id}>
              <label className="photo-plan-option photo-plan-team">
                <input type="checkbox" aria-label={`${group.name} 검사계획 전체 선택`} checked={checked} onChange={() => togglePlans(group.plans.map((plan) => plan.id))} />
                <strong>{group.name}</strong>
                <small>{groupSelected}/{group.plans.length}</small>
              </label>
              {group.plans.map((plan) => (
                <label className="photo-plan-option photo-plan-item" key={plan.id}>
                  <input type="checkbox" aria-label={`${group.name} ${plan.title} 선택`} checked={selected.has(plan.id)} onChange={() => togglePlans([plan.id])} />
                  <span>{plan.title}</span>
                  <small>{plan.date || "날짜 미지정"}{plan.visibility === "hidden" ? " · 삭제됨" : ""}</small>
                </label>
              ))}
            </section>
          );
        })}
      </div>
    </details>
  );
}
function PhotoPagination({
  data,
  change,
  pageSize,
  onPageSizeChange,
}: {
  data: PhotoPage | null;
  change: (page: number) => void;
  pageSize?: number;
  onPageSizeChange?: (value: number) => void;
}) {
  if (!data) return null;
  if (data.pages <= 1 && pageSize === undefined) return null;
  return (
    <nav className="photo-pagination" aria-label="사진 페이지">
      <span>
        전체 {data.total}장 · {data.page}/{data.pages}페이지
      </span>
      <div className="photo-pagination-controls">
        {pageSize !== undefined && onPageSizeChange && (
          <label className="page-size-control">
            <span>한 화면에 보기</span>
            <select
              aria-label="한 화면에 보일 사진 수"
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              <option value={10}>10장</option>
              <option value={25}>25장</option>
              <option value={50}>50장</option>
            </select>
          </label>
        )}
        <div className="photo-pagination-buttons">
          <button
            type="button"
            className="button secondary"
            disabled={data.page <= 1}
            onClick={() => change(1)}
          >
            처음
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={data.page <= 1}
            onClick={() => change(data.page - 1)}
          >
            이전
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={data.page >= data.pages}
            onClick={() => change(data.page + 1)}
          >
            다음
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={data.page >= data.pages}
            onClick={() => change(data.pages)}
          >
            마지막
          </button>
        </div>
      </div>
    </nav>
  );
}
function PhotoVisibilityDialog({
  photo,
  done,
  close,
}: {
  photo: Photo;
  done: (message: string) => Promise<void>;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hidden = photo.visibility === "hidden";
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title={hidden ? "사진 복원" : "사진 숨기기"} close={close}>
      <p className="form-intro">
        <strong>{photo.name}</strong><br />
        숨김은 원본과 변경 이력을 보존합니다. 숨긴 사진은 목록의 표시 조건에서 다시 찾을 수 있습니다.
      </p>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          await api(`/inspections/${photo.id}/visibility`, {
            method: "PATCH",
            body: JSON.stringify({
              expectedVersion: photo.editVersion,
              actor: form.get("actor"),
              reason: form.get("reason"),
              visibility: hidden ? "visible" : "hidden",
            }),
          });
          await complete(hidden
            ? "사진을 복원했습니다. 원본과 이력은 그대로 유지됩니다."
            : "사진을 숨겼습니다. 숨긴 사진 조건에서 복원할 수 있습니다.");
        } catch (cause) {
          setError((cause as Error).message);
        } finally {
          setBusy(false);
        }
      }}>
        <label className="field">작업자<input name="actor" required maxLength={60} defaultValue="현업 엔지니어" /></label>
        <label className="field">사유<textarea name="reason" required maxLength={1000} rows={2} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={close} disabled={busy}>취소</button>
          <button className="button primary" disabled={busy}>{busy ? "저장 중…" : hidden ? "복원" : "숨기기"}</button>
        </div>
      </form>
    </Modal>
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
  onVisibilityChange,
}: {
  photos: Photo[];
  points: Point[];
  plans: Plan[];
  onSelect: (p: Photo) => void;
  onVisibilityChange?: (photo: Photo) => void;
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
            <tr
              key={photo.id}
              tabIndex={0}
              aria-label={`${photo.name} 상세 열기`}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
                onSelect(photo);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(photo);
                }
              }}
            >
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
                {(photo.status !== "done" || !photo.ai) && <PhotoStatus photo={photo} />} {" "}
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
                <div className="photo-row-actions">
                  {onVisibilityChange && <button
                    type="button"
                    className="icon-button"
                    aria-label={`${photo.name} ${photo.visibility === "hidden" ? "복원" : "숨기기"}`}
                    title={photo.visibility === "hidden" ? "사진 복원" : "사진 숨기기"}
                    onClick={() => onVisibilityChange(photo)}
                  >
                    {photo.visibility === "hidden" ? <RotateCcw size={16} /> : <EyeOff size={16} />}
                  </button>}
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`${photo.name} 상세 보기`}
                    onClick={() => onSelect(photo)}
                  >
                    <ChevronRight size={17} />
                  </button>
                </div>
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
  onNavigate,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
  onNavigate?: (direction: -1 | 1) => void;
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
          if (onNavigate && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            const target = e.target as HTMLElement;
            if (!target.matches("input, select, textarea, [contenteditable='true']")) {
              e.preventDefault();
              onNavigate(e.key === "ArrowLeft" ? -1 : 1);
            }
          }
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
  viewPhotos,
  done,
  publicUploadsAllowed,
}: {
  publicUploadsAllowed: boolean;
  points: Point[];
  plans: Plan[];
  context: { plan: Plan; point?: Point; rackId?: string } | null;
  close: () => void;
  viewPhotos: (plan: Plan, rackId?: string) => void;
  done: (s: string, tone?: ToastTone) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [planId, setPlanId] = useState(context?.plan.id || "");
  const [pointId, setPointId] = useState(context?.point?.id || "");
  const [rackId, setRackId] = useState(context?.rackId || context?.point?.rackId || "");
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
  const lastStored = [...queue].reverse().find((entry) =>
    entry.state === "stored" && entry.planId === planId && (!rackId || entry.rackId === rackId),
  );
  const storedPlan = lastStored ? selectedPlan : null;
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
          `${stored}장 저장 확인 · 사진 목록에서 AI 판독 상태와 결과를 확인하세요.`,
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
            {storedPlan && <button type="button" className="button primary" disabled={busy} onClick={() => viewPhotos(storedPlan, lastStored?.rackId ?? undefined)}>저장된 사진·판독 보기</button>}
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
function PlanScopeEditor({ teamId, rackIds, change, disabled = false, compact = false, lockTeam = false }: {
  teamId: string; rackIds: string[]; change: (teamId: string, rackIds: string[]) => void; disabled?: boolean; compact?: boolean; lockTeam?: boolean;
}) {
  const [rackEditOpen, setRackEditOpen] = useState(!compact && !rackIds.length);
  const racks = locations.racks.filter((rack) => rack.teamId === teamId);
  const selectedRacks = racks.filter((rack) => rackIds.includes(rack.id));
  return <fieldset className="plan-scope-editor" disabled={disabled}>
    <legend>검사 범위</legend>
    <label className="field">생산팀<select required aria-label="계획 생산팀" value={teamId} disabled={lockTeam} onChange={(e) => change(e.target.value, [])}><option value="">생산팀 선택</option>{locations.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
    {teamId && <><p className="plan-selected-label">선택한 랙 {rackIds.length}개</p><div className="plan-selected-racks">{selectedRacks.length ? <>{selectedRacks.slice(0, 3).map((rack) => <span key={rack.id}>{rack.name}</span>)}{selectedRacks.length > 3 && <span>외 {selectedRacks.length - 3}개</span>}</> : <span>랙을 선택하세요</span>}</div><details className="plan-rack-edit" open={rackEditOpen} onToggle={(e) => setRackEditOpen(e.currentTarget.open)}><summary>랙 선택 수정 · 전체 30개 보기</summary><div className="list-toolbar"><button type="button" className="text-button" onClick={() => change(teamId, racks.map((rack) => rack.id))}>전체 선택</button><button type="button" className="text-button" onClick={() => change(teamId, [])}>전체 해제</button></div><div className="rack-checks">{racks.map((rack, index) => <label key={rack.id} className={rackIds.includes(rack.id) ? "selected" : ""}><input type="checkbox" aria-label={`${rack.name} 선택`} checked={rackIds.includes(rack.id)} onChange={(e) => change(teamId, e.target.checked ? [...new Set([...rackIds, rack.id])] : rackIds.filter((id) => id !== rack.id))}/><span>랙 {index + 1}</span></label>)}</div></details></>}
  </fieldset>;
}
const planMemoSuggestions = ["보온재 이음부 확인", "누설 흔적 확인", "촬영 방향 기록"];
function shortPlanDate(value: string) {
  return value ? `${value.slice(2, 4)}${value.slice(5, 7)}${value.slice(8, 10)}` : "";
}
function parsePlanDate(value: string) {
  if (!/^\d{6}$/.test(value)) return null;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${value.slice(2, 4)}-${value.slice(4, 6)}`;
}
function suggestedPlanTitle(teamId: string) {
  const today = new Date();
  const code = `${String(today.getFullYear()).slice(-2)}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  const team = locations.teams.find((item) => item.id === teamId)?.name;
  return `${code} ${team ? `${team} ` : ""}검사계획`;
}
function PlanFields({ plan, teamId }: { plan?: Plan; teamId: string }) {
  const dateInputId = useId();
  const dateHelpId = useId();
  const suggestion = suggestedPlanTitle(teamId);
  const [title, setTitle] = useState(plan?.title ?? suggestion);
  const [titleEdited, setTitleEdited] = useState(false);
  const [dateText, setDateText] = useState(plan?.date ? shortPlanDate(plan.date) : "");
  const [memo, setMemo] = useState(plan?.note ?? "");
  const isoDate = parsePlanDate(dateText);
  useEffect(() => { if (!plan && !titleEdited) setTitle(suggestion); }, [plan, suggestion, titleEdited]);
  return <>
    <label className="field">계획 이름<input name="title" required maxLength={120} value={title} onChange={(event) => { setTitle(event.target.value); setTitleEdited(true); }} /></label>
    <div className="field"><label htmlFor={dateInputId}>검사 예정일</label>
      <span className="plan-date-row">
        <input id={dateInputId} name="dateText" type="text" inputMode="numeric" autoComplete="off" required={!plan} maxLength={6} pattern="[0-9]{6}" placeholder="예: 261010" aria-describedby={dateHelpId} aria-invalid={dateText.length === 6 && !isoDate} value={dateText} onChange={(event) => setDateText(event.target.value.replace(/\D/g, "").slice(0, 6))} />
        <input type="date" className="plan-calendar-picker" aria-label="달력에서 검사 예정일 선택" value={isoDate ?? ""} onChange={(event) => setDateText(shortPlanDate(event.target.value))} />
      </span>
      <small id={dateHelpId}>6자리 숫자로 입력하거나 달력에서 선택하세요. {isoDate && `선택 날짜: ${isoDate}`}</small>
      {dateText.length === 6 && !isoDate && <small className="plan-date-error">존재하는 날짜를 입력하세요.</small>}
    </div>
    <label className="field">메모<textarea name="note" rows={2} maxLength={1000} value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="촬영 조건이나 확인할 사항" /></label>
    <div className="plan-memo-suggestions" aria-label="메모 빠른 입력">
      {planMemoSuggestions.map((example) => <button key={example} type="button" onClick={() => setMemo((current) => current.includes(example) ? current : [current.trim(), example].filter(Boolean).join("\n").slice(0, 1000))}>{example} +</button>)}
    </div>
  </>;
}
function PlanDialog({ initialTeamId, initialRackIds, close, done, created }: {
  initialTeamId: string; initialRackIds: string[]; close: () => void; done: (s: string) => Promise<void>; created: (plan: Plan) => void;
}) {
  const [teamId, setTeamId] = useState(initialTeamId);
  const [rackIds, setRackIds] = useState<string[]>(initialRackIds);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const lock = useRef(false);
  const complete = useDialogCompletion(done, close);
  return <Modal title="검사계획 만들기" close={close}><form onSubmit={async (event) => {
    event.preventDefault(); if (lock.current) return;
    if (!rackIds.length) return setError("검사할 랙을 하나 이상 선택하세요.");
    lock.current = true; setBusy(true); setError("");
    const data = new FormData(event.currentTarget);
    const date = parsePlanDate(String(data.get("dateText") ?? ""));
    if (!date) { lock.current = false; setBusy(false); return setError("검사 예정일을 6자리의 실제 날짜로 입력하세요."); }
    try { const plan = await api<Plan>("/plans", { method: "POST", body: JSON.stringify({ title: data.get("title"), date, note: data.get("note"), teamId, rackIds, pointIds: [] }) }); await complete("검사계획을 저장했습니다. 이제 이 계획에 사진을 추가하세요.", () => created(plan)); }
    catch (cause) { setError((cause as Error).message); } finally { lock.current = false; setBusy(false); }
  }}><PlanFields teamId={teamId}/><PlanScopeEditor teamId={teamId} rackIds={rackIds} change={(team, racks) => { setTeamId(team); setRackIds(racks); }} disabled={busy} compact={initialRackIds.length > 0} lockTeam={Boolean(initialTeamId && initialRackIds.length)}/>{error && <p className="form-error" role="alert">{error}</p>}<div className="form-actions"><button className="button secondary" type="button" onClick={close}>취소</button><button className="button primary" disabled={busy || !teamId || !rackIds.length}>{busy ? "저장 중…" : "계획 저장"}</button></div></form></Modal>;
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

function PlanDetailDialog({ initialPlan, close, done, reportHistoryError, upload, viewPhotos, selectPhoto }: {
  initialPlan: Plan; scope: PhotoScope; points: Point[]; close: () => void; done: (message: string) => Promise<void>; refresh: () => Promise<void>; reportHistoryError: (message: string) => void; upload: (plan: Plan, point?: Point) => void; viewPhotos: (plan: Plan) => void; selectPhoto: (photo: Photo) => void;
}) {
  const plan = initialPlan;
  const [teamId, setTeamId] = useState(plan.teamId ?? ""), [rackIds, setRackIds] = useState(plan.rackIds);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [showPhotoPreview, setShowPhotoPreview] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<PhotoPage | null>(null);
  const [photoPreviewError, setPhotoPreviewError] = useState("");
  const [photoPreviewRevision, setPhotoPreviewRevision] = useState(0);
  const lock = useRef(false), history = useAuditHistory(`/plans/${plan.id}/history`, reportHistoryError);
  const complete = useDialogCompletion(done, close);
  useEffect(() => {
    if (!showPhotoPreview) return;
    let active = true;
    const controller = new AbortController();
    void api<PhotoPage>(`/inspections/query?planId=${encodeURIComponent(plan.id)}&pageSize=6`, { signal: controller.signal })
      .then((result) => { if (active) { setPhotoPreview(result); setPhotoPreviewError(""); } })
      .catch((cause) => { if (active) setPhotoPreviewError((cause as Error).message); });
    return () => { active = false; controller.abort(); };
  }, [showPhotoPreview, plan.id, photoPreviewRevision]);
  const savePlan = async (action: "edit" | Plan["status"] | "visibility", data: FormData) => {
    if (lock.current) return;
    const dateText = String(data.get("dateText") ?? "");
    const date = action === "edit" ? parsePlanDate(dateText) : null;
    if (action === "edit" && (dateText || plan.date) && !date) return setError("검사 예정일을 6자리의 실제 날짜로 입력하세요.");
    const patch = action === "edit"
      ? { title: data.get("title"), ...(date ? { date } : {}), note: data.get("note"), teamId, rackIds }
      : action === "visibility"
        ? { visibility: plan.visibility === "hidden" ? "visible" : "hidden" }
        : { status: action };
    lock.current = true; setBusy(true); setError("");
    try {
      await api(`/plans/${plan.id}`, { method: "PATCH", body: JSON.stringify({ ...patch, expectedVersion: plan.editVersion, actor: data.get("actor"), reason: data.get("reason") }) });
      await complete(action === "visibility" ? plan.visibility === "hidden" ? "계획을 복원했습니다. 기존 진행 상태는 유지됩니다." : "계획을 삭제했습니다. 사진·보수·이력은 보존되며 복원할 수 있습니다." : action === "edit" ? "계획 정보를 저장했습니다." : action === "planned" ? "계획을 재개했습니다. 사진을 추가할 수 있습니다." : action === "done" ? "검사계획을 완료로 기록했습니다." : "검사계획을 취소했습니다.");
    } catch (cause) { setError((cause as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <Modal title="검사계획 상세" close={close}>
    <div className="plan-next"><span className="badge muted">{plan.visibility === "hidden" ? "삭제됨" : plan.status === "planned" ? "진행 중" : plan.status === "done" ? "완료" : "취소"}</span><h3>{plan.title}</h3><p>{locations.teams.find((team) => team.id === plan.teamId)?.name ?? "생산팀 미확인"} · {plan.date || "예정일 미지정"}</p><p>검사 범위: {plan.rackIds.length ? plan.rackIds.slice(0, 3).map((id) => locations.racks.find((rack) => rack.id === id)?.name ?? "랙 확인 필요").join(", ") : "랙 미지정"}{plan.rackIds.length > 3 && ` 외 ${plan.rackIds.length - 3}개`}</p><div className="heading-actions">{plan.visibility === "visible" && plan.status === "planned" && <button className="button primary" onClick={() => upload(plan)}>이 계획에 사진 추가</button>}<button className="button secondary" aria-expanded={showPhotoPreview} onClick={() => setShowPhotoPreview((current) => !current)}>{showPhotoPreview ? "사진 미리보기 닫기" : "저장된 사진 미리보기"}</button></div>{plan.visibility === "hidden" ? <p>사진을 추가하려면 먼저 계획을 복원하세요.</p> : plan.status !== "planned" && <p>사진을 추가하려면 계획을 재개하세요.</p>}</div>
    {showPhotoPreview && <section className="plan-photo-preview" aria-label="이 계획의 사진 미리보기">
      <div className="plan-photo-preview-heading"><h3>이 계획의 사진{photoPreview && <span>{photoPreview.total}장</span>}</h3>{photoPreview && photoPreview.total > 0 && <button type="button" className="text-button" onClick={() => viewPhotos(plan)}>전체 {photoPreview.total}장 사진·판독 목록 보기 →</button>}</div>
      {photoPreviewError ? <><p role="alert">사진 조회 실패: {photoPreviewError}</p><button type="button" className="text-button" onClick={() => { setPhotoPreview(null); setPhotoPreviewError(""); setPhotoPreviewRevision((revision) => revision + 1); }}>다시 조회</button></> : photoPreview ? photoPreview.items.length ? <div className="plan-photo-grid">{photoPreview.items.map((photo) => {
        const status = photo.status === "done" ? "판독 완료" : photo.status === "processing" ? "판독 중" : photo.status === "pending" ? "판독 대기" : photo.status === "error" ? "판독 오류" : "미판독";
        return <button type="button" className="plan-photo-card" key={photo.id} onClick={() => selectPhoto(photo)} aria-label={`${photo.name}, ${status}. 사진 판독 상세 보기`}>
          <img src={`${apiBase}/api/inspections/${photo.id}/thumbnail`} alt="" loading="lazy" />
          <span className="plan-photo-caption"><strong title={photo.name}>{photo.name}</strong><small>{status}</small></span>
        </button>;
      })}</div> : <p>저장된 사진이 없습니다.</p> : <p>사진을 불러오는 중…</p>}
    </section>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {plan.visibility === "visible" && <details className="plan-edit-details"><summary>계획 정보 수정</summary>
      <form onSubmit={(event) => { event.preventDefault(); void savePlan("edit", new FormData(event.currentTarget)); }}>
        <PlanFields plan={plan} teamId={teamId}/>
        <PlanScopeEditor teamId={teamId} rackIds={rackIds} change={(team, racks) => { setTeamId(team); setRackIds(racks); }} disabled={busy} lockTeam={Boolean(plan.teamId)}/>
        {plan.pointIds.length > 0 && <details><summary>기존 위치 관계 {plan.pointIds.length}개</summary><p>연결된 포인트와 사진의 원래 위치는 유지됩니다. 사용 중인 랙을 제외하려면 관련 기록을 먼저 확인하세요.</p></details>}
        <label className="field">수정자<input name="actor" required maxLength={60} defaultValue="현업 엔지니어"/></label>
        <label className="field">변경 사유<textarea name="reason" required maxLength={1000} rows={2}/></label>
        <div className="form-actions"><button className="button primary" disabled={busy || !teamId || !rackIds.length}>변경 저장</button></div>
      </form>
    </details>}
    <details className="plan-edit-details plan-status-details"><summary>상태 관리</summary>
      <form onSubmit={(event) => {
        event.preventDefault();
        const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") as Plan["status"] | "visibility" | null;
        if (action) void savePlan(action, new FormData(event.currentTarget));
      }}>
        <p>현재 상태: {plan.visibility === "hidden" ? "삭제됨" : plan.status === "planned" ? "진행 중" : plan.status === "done" ? "완료" : "취소"}</p>
        <label className="field">처리자<input name="actor" required maxLength={60} defaultValue="현업 엔지니어"/></label>
        <label className="field">변경 사유<textarea name="reason" required maxLength={1000} rows={2}/></label>
        <div className="form-actions">
          {plan.visibility === "visible" && (plan.status === "planned" ? <><button value="done" className="button secondary" disabled={busy}>검사계획 완료</button><button value="cancelled" className="button secondary" disabled={busy}>계획 취소</button></> : <button value="planned" className="button secondary" disabled={busy}>계획 재개</button>)}
          <button value="visibility" className="button secondary" disabled={busy}>{plan.visibility === "hidden" ? "계획 복원" : "계획 삭제"}</button>
        </div>
      </form>
    </details>
    <AuditList history={history}/>
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
  reportHistoryError,
  close,
  done,
  createRetakePlan,
  onNavigate,
  canNavigatePrevious,
  canNavigateNext,
}: {
  photo: Photo;
  reportHistoryError: (message: string) => void;
  close: () => void;
  done: (s: string) => Promise<void>;
  createRetakePlan: (photo: Photo) => void;
  onNavigate?: (direction: -1 | 1) => void;
  canNavigatePrevious: boolean;
  canNavigateNext: boolean;
}) {
  const { photo, error: readError } = usePhotoRecord(seed);
  const [initial] = useState(seed);
  const [savedJudgment, setSavedJudgment] = useState({
    humanGrade: initial.humanGrade,
    retake: initial.retake,
    retakeReason: initial.retakeReason,
    labeling: initial.labeling,
  });
  const [humanGrade, setHumanGrade] = useState<number | null>(initial.humanGrade);
  const [retake, setRetake] = useState(initial.retake);
  const [reason, setReason] = useState(initial.retakeReason);
  const [labeling, setLabeling] = useState(initial.labeling);
  const [editVersion, setEditVersion] = useState(initial.editVersion);
  const [busy, setBusy] = useState(false);
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
  const [retakePlanPrompt, setRetakePlanPrompt] = useState(false);
  const effectiveHumanGrade = humanGrade !== null && humanGrade === photo.ai?.grade ? null : humanGrade;
  const effectiveSavedHumanGrade = savedJudgment.humanGrade !== null && savedJudgment.humanGrade === photo.ai?.grade
    ? null
    : savedJudgment.humanGrade;
  const humanGradeDirty = effectiveHumanGrade !== effectiveSavedHumanGrade;
  const judgmentDirty = humanGradeDirty ||
    retake !== savedJudgment.retake ||
    (retake && reason.trim() !== savedJudgment.retakeReason.trim());
  const humanCorrection = !retake && effectiveHumanGrade !== null && photo.ai !== null && effectiveHumanGrade !== photo.ai.grade;
  const history = useAuditHistory(
    `/inspections/${photo.id}/history?version=${photo.editVersion}&status=${photo.status}`,
    reportHistoryError,
  );
  const complete = useDialogCompletion(done, close);
  const saveJudgment = async (createPlan: boolean) => {
    if (!judgmentDirty || !reason.trim() || !begin()) return;
    setError("");
    try {
      const updated = await api<Photo>(`/inspections/${photo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: editVersion,
          humanGrade: effectiveHumanGrade,
          retake,
          retakeReason: retake ? reason : "",
          actor: "현업 엔지니어",
          reason: reason.trim(),
        }),
      });
      setEditVersion(updated.editVersion);
      setSavedJudgment({
        humanGrade: updated.humanGrade,
        retake: updated.retake,
        retakeReason: updated.retakeReason,
        labeling: updated.labeling,
      });
      setRetakePlanPrompt(false);
      await done("판독 변경과 이력을 저장했습니다.");
      if (createPlan) {
        close();
        createRetakePlan(initial);
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      finish();
    }
  };
  const toggleLabeling = async () => {
    if (!begin()) return;
    const next = !labeling;
    setError("");
    try {
      const updated = await api<Photo>(`/inspections/${photo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersion: editVersion,
          labeling: next,
          actor: "현업 엔지니어",
          reason: next ? "학습 라벨링 후보로 지정" : "학습 라벨링 후보에서 해제",
        }),
      });
      setEditVersion(updated.editVersion);
      setLabeling(updated.labeling);
      setSavedJudgment((current) => ({ ...current, labeling: updated.labeling }));
      await done(next ? "학습 라벨링 후보로 지정했습니다." : "학습 라벨링 후보에서 해제했습니다.");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      finish();
    }
  };
  return (
    <Modal
      title="사진 판독"
      wide
      close={close}
      onNavigate={onNavigate ? (direction) => {
        if (!judgmentDirty && !busy && !retakePlanPrompt) onNavigate(direction);
      } : undefined}
    >
      {readError && (
        <p className="form-error" role="alert">
          사진 상태 조회 실패: {readError} · 마지막 조회 결과입니다.
        </p>
      )}
      <div
        className="detail-grid photo-review-grid"
      >
        <div>
          <div className="detail-image photo-image-stage">
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
            {onNavigate && <>
              <button
                type="button"
                className="photo-image-nav photo-image-nav-previous"
                aria-label="이전 사진"
                title="이전 사진 · ←"
                disabled={!canNavigatePrevious || judgmentDirty || busy || retakePlanPrompt}
                onClick={() => onNavigate(-1)}
              >
                <ChevronLeft size={23} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="photo-image-nav photo-image-nav-next"
                aria-label="다음 사진"
                title="다음 사진 · →"
                disabled={!canNavigateNext || judgmentDirty || busy || retakePlanPrompt}
                onClick={() => onNavigate(1)}
              >
                <ChevronRight size={23} aria-hidden="true" />
              </button>
            </>}
          </div>
          <div className="image-caption">
            {photo.name}
          </div>
        </div>
        <form
          className="photo-judgment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!judgmentDirty) return;
            if (retake && !savedJudgment.retake) {
              setRetakePlanPrompt(true);
            } else {
              void saveJudgment(false);
            }
          }}
        >
          <section className="photo-result-summary" aria-label="사진 판독 결과">
            <div className="photo-result-status">
              <span>AI 판독 상태</span>
              <PhotoStatus photo={photo} />
            </div>
            <div className="photo-result-grade">
              <span>현재 분류</span>
              <Grade photo={photo} />
            </div>
            <span className="photo-grade-help" tabIndex={0} aria-label="등급 안내" aria-describedby="photo-grade-help-text">
              <CircleHelp size={19} aria-hidden="true" />
              <span id="photo-grade-help-text" className="photo-grade-tooltip" role="tooltip">
                등급은 사진에서 보이는 부식 분류입니다. 설비 안전성이나 실제 보수 지시를 확정하지 않습니다.
              </span>
            </span>
            {photo.error && <p className="form-error" role="alert">{photo.error}</p>}
            {photo.status === "error" && (
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={async () => {
                  if (!begin()) return;
                  setError("");
                  try {
                    await api(`/inspections/${photo.id}/retry`, { method: "POST" });
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
          </section>
          <label className="field photo-human-grade">
            사람 판정
            <select
              name="grade"
              value={retake ? "retake" : effectiveHumanGrade ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                setRetake(value === "retake");
                setHumanGrade(value && value !== "retake" ? Number(value) : null);
              }}
            >
              <option value="">
                {photo.ai
                  ? `AI 결과 사용 · ${photo.ai.grade}등급 · ${photo.ai.grade >= 3 ? "보수 필요" : "보수 불필요"}`
                  : "등급 미지정"}
              </option>
              <option value="retake">재촬영 필요</option>
              {[1, 2, 3, 4, 5].map((grade) => (
                grade === photo.ai?.grade ? null : (
                  <option key={grade} value={grade}>
                    {grade}등급 · {grade >= 3 ? "보수 필요" : "보수 불필요"}
                  </option>
                )
              ))}
            </select>
          </label>
          <button
            type="button"
            className={`photo-labeling-toggle${labeling ? " is-selected" : ""}${humanGradeDirty ? " has-pending-change" : ""}${humanCorrection && !labeling ? " is-recommended" : ""}`}
            aria-pressed={labeling}
            disabled={busy}
            onClick={() => void toggleLabeling()}
          >
            <CloudUpload size={18} aria-hidden="true" />
            <span>{labeling ? "학습 후보에서 해제" : "학습 라벨링 후보로 지정"}</span>
            {labeling && <Check size={17} aria-hidden="true" />}
          </button>
          <label className="field photo-judgment-reason">
            {retake ? "재촬영 사유" : "판정 수정 사유"}
            <textarea
              name="reason"
              required={judgmentDirty}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={1000}
              rows={3}
              placeholder={retake ? "예: 사진 흔들림으로 재촬영" : "예: 부식이 보여 4등급으로 수정"}
            />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="photo-save-footer">
            {retakePlanPrompt ? (
              <section className="retake-plan-prompt" role="alertdialog" aria-labelledby="retake-plan-title">
                <h3 id="retake-plan-title">새 재촬영 계획을 만들까요?</h3>
                <p>판독 내용을 저장한 뒤 같은 생산팀·랙으로 검사계획 만들기를 엽니다.</p>
                <div className="form-actions">
                  <button type="button" className="button secondary" disabled={busy} onClick={() => void saveJudgment(false)}>판독 변경만 저장</button>
                  <button type="button" className="button primary" disabled={busy || !reason.trim()} onClick={() => void saveJudgment(true)}>{busy ? "저장 중…" : "저장 후 새 계획 만들기"}</button>
                </div>
                <button type="button" className="text-button" disabled={busy} onClick={() => setRetakePlanPrompt(false)}>취소</button>
              </section>
            ) : (
              <button
                className={`button ${judgmentDirty ? "primary" : "secondary"} full-width photo-save-button`}
                disabled={busy || !judgmentDirty}
              >
                {busy ? "저장 중…" : judgmentDirty ? "변경 사항 저장" : "저장할 변경 사항 없음"}
              </button>
            )}
          </div>
        </form>
      </div>
      <details className="photo-evidence">
        <summary>AI 판독 근거</summary>
        <p className="photo-evidence-intro">AI 원본 결과와 관심 영역(ROI)·SHAP 분석을 확인할 수 있습니다.</p>
        <section className="photo-ai-source" aria-label="AI 원본 판독 결과">
          <h3>AI 원본 결과</h3>
          {photo.ai ? (
            <>
              <p>원래 AI 등급: {photo.ai.grade}등급</p>
              {photo.aiProvenance && (
                <small>
                  {photo.aiProvenance.kind === "live_frozen_inference"
                    ? "실제 모델 판독"
                    : "보존된 기존 판독 결과"}
                  {" · "}
                  {photo.aiProvenance.predictedAt
                    ? new Date(photo.aiProvenance.predictedAt).toLocaleString("ko-KR")
                    : "기존 판독 시각 미확인"}
                </small>
              )}
              <small>
                모델 {photo.ai.model_version}
                <br />
                전처리 {photo.ai.preprocessing_version}
              </small>
            </>
          ) : <p>AI 원본 판독 결과가 없습니다.</p>}
        </section>
        <RoiPanel key={`${photo.id}/${photo.sha256}/${photo.visibility}`} photo={photo} />
      </details>
      <AuditList history={history} />
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
