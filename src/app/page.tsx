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
import HomeDashboard from "@/components/HomeDashboard";
import PlantDashboard from "@/components/PlantDashboard";
import RoiPanel from "@/components/RoiPanel";
import MaintenanceContext from "@/components/MaintenanceContext";
import { useAuth } from "@/components/AuthProvider";
import { AuthAccountButton } from "@/components/AuthPanel";
import {
  MaintenanceWorklist,
  type MaintenanceWorklistRow,
  type RepairMethod,
  type RepairStatus,
} from "@/components/MaintenancePanel";
import {
  MaintenanceBundleComposer,
  MaintenanceBundleWorkspace,
} from "@/components/MaintenanceBundleWorkspace";
import {
  useMaintenanceBundles,
  useMaintenanceQuery,
  type MaintenancePage,
  type Purpose,
  type SavedMaintenance,
} from "@/lib/maintenance";
import {
  defaultPhotoScope,
  usePhotoQuery,
  usePhotoRecord,
  type Photo,
  type PhotoScope,
  type PhotoPage,
} from "@/lib/photo-query";
import { requestJson } from "@/lib/api";
import { getAuthUserId } from "@/lib/auth";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type DragEvent,
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
  ChevronDown,
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
  Menu,
  Moon,
  Plus,
  RefreshCw,
  Search,
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
const planStatusOrder: Record<Plan["status"], number> = {
  planned: 0,
  done: 1,
  cancelled: 2,
};
const plansPerPage = 10;
type PlanPhotoPreviewState = {
  items: Photo[];
  total: number;
  pages: number;
  loading: boolean;
  error: string;
};
type MaintenanceBundleSelection = {
  editVersion: number;
  photoName: string;
  planTitle: string | null;
  pointLabel: string;
};
type MaintenanceTarget = {
  planId: string | null;
  pointId: string | null;
  pointLabel?: string;
  targetType?: "point" | "photo";
  targetId?: string;
  recordPurpose: Purpose;
  photoId?: string;
};
type PendingMaintenanceLeave =
  | { kind: "saving" }
  | { kind: "transitioning" }
  | {
      kind: "worklist-navigation";
      message: string;
      actionLabel: string;
      direction: -1 | 1;
    }
  | {
      kind: "discard";
      message: string;
      actionLabel: string;
      action: () => void;
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
  model: {
    ready: boolean;
    model_version?: string;
    preprocessing_version?: string;
    checkpoint_sha256?: string;
    message?: string;
  };
};
type Tab =
  | "home"
  | "dashboard"
  | "plans"
  | "photos"
  | "points"
  | "worklist"
  | "taWorklist"
  | "labels"
  | "models";
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
const navGroups: {
  label: string;
  items: { id: Tab; label: string; icon: typeof Compass }[];
}[] = [
  { label: "현황", items: [{ id: "home", label: "홈", icon: Layers3 }] },
  {
    label: "검사 대상",
    items: [
      { id: "points", label: "포인트 조회", icon: MapPin },
      { id: "dashboard", label: "공장 3D 탐색", icon: Compass },
    ],
  },
  {
    label: "검사 계획 · 사진",
    items: [
      { id: "plans", label: "검사 계획", icon: CalendarDays },
      { id: "photos", label: "사진 · 판독", icon: Camera },
    ],
  },
  {
    label: "보수 작업",
    items: [
      { id: "worklist", label: "보수 관리", icon: FolderKanban },
      { id: "taWorklist", label: "워크리스트 관리", icon: Wrench },
    ],
  },
  {
    label: "학습 관리",
    items: [
      { id: "models", label: "AI 모델 관리", icon: Activity },
      { id: "labels", label: "라벨링 후보", icon: Tag },
    ],
  },
] as const;
const nav = navGroups.flatMap((group) => group.items);
function pageNumberWindow(page: number, pages: number) {
  const count = Math.min(5, pages);
  const start = Math.max(1, Math.min(page - 2, pages - count + 1));
  return Array.from({ length: count }, (_, index) => start + index);
}
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
  const names = rackIds
    .slice(0, 2)
    .map(
      (id) =>
        locations.racks.find((rack) => rack.id === id)?.name ?? "랙 확인 필요",
    );
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
  return <span className="badge muted">등급 없음</span>;
}
function Empty({
  text,
  action,
  role,
}: {
  text: string;
  action?: React.ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className="empty" role={role}>
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
  const { session, can } = useAuth();
  const canWrite = can("work.write");
  const canManageRecords = can("records.manage");
  const actor = (session?.authenticated ? session.user?.displayName : null) ?? "현업 엔지니어";
  const [tab, setTab] = useState<Tab>("home");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const errorRetryTabRef = useRef<Tab | null>(null);
  const planResultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const planCountRetryFocusedRef = useRef(false);
  const isMaintenanceTab = tab === "worklist" || tab === "taWorklist";
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [points, setPoints] = useState<Point[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoaded, setPlansLoaded] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [pointsError, setPointsError] = useState("");
  const [plansError, setPlansError] = useState("");
  const [healthError, setHealthError] = useState("");
  const plansUnavailable = !plansLoaded || Boolean(plansError);
  const error = [
    plansError && "검사계획",
    pointsError && "포인트",
    healthError && "모델 상태",
  ]
    .filter(Boolean)
    .join(" · ");
  const recordsError = [plansError && "검사계획", pointsError && "포인트"]
    .filter(Boolean)
    .join(" · ");
  useLayoutEffect(() => {
    if (!errorRetryTabRef.current) return;
    if (errorRetryTabRef.current !== tab || tab === "dashboard") {
      errorRetryTabRef.current = null;
      return;
    }
    if (error) return;
    errorRetryTabRef.current = null;
    if (document.activeElement === document.body)
      pageHeadingRef.current?.focus({ preventScroll: true });
  }, [error, tab]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [scope, setScope] = useState<PhotoScope>(defaultPhotoScope);
  const [filter, setFilter] = useState("all");
  const [workClassificationFilter, setWorkClassificationFilter] = useState<
    "all" | "repair" | "retake"
  >("all");
  const [page, setPage] = useState(1);
  const [pointPage, setPointPage] = useState(1);
  const [pointPageSize, setPointPageSize] = useState(10);
  const [selectedPhotoPlanIds, setSelectedPhotoPlanIds] = useState<
    string[] | null
  >(null);
  const [selectedMaintenancePhotos, setSelectedMaintenancePhotos] = useState<
    Record<string, Photo>
  >({});
  const [bulkMaintenanceOpen, setBulkMaintenanceOpen] = useState(false);
  const [bulkMaintenanceBusy, setBulkMaintenanceBusy] = useState(false);
  const [bulkMaintenanceError, setBulkMaintenanceError] = useState("");
  const [bulkMaintenanceMethod, setBulkMaintenanceMethod] =
    useState<RepairMethod>("undecided");
  const [bulkMaintenanceTa, setBulkMaintenanceTa] = useState(false);
  const [photoPageSize, setPhotoPageSize] = useState(10);
  const photoList = usePhotoQuery({
    ...scope,
    ...(tab === "photos"
      ? {
          planId: "all",
          ...(selectedPhotoPlanIds !== null
            ? { planIds: selectedPhotoPlanIds }
            : {}),
        }
      : {}),
    ...(tab === "plans"
      ? {
          planId: "all",
          teamId: "all",
          rackId: "all",
          visibility: "visible",
          search: "",
        }
      : {}),
    ...(tab === "labels"
      ? {
          planId: "all",
          recordPurpose: "inspection",
          visibility: "visible",
          search: "",
        }
      : {}),
    classification: "all",
    aiStatus: tab === "photos" ? (filter as Photo["status"] | "all") : "all",
    workClassification: tab === "photos" ? workClassificationFilter : "all",
    labeling: tab === "labels" ? "true" : "all",
    page: tab === "plans" ? 1 : page,
    ...(tab === "plans"
      ? { pageSize: 1 }
      : tab === "photos"
        ? { pageSize: photoPageSize }
        : {}),
  });
  useLayoutEffect(() => {
    if (!planCountRetryFocusedRef.current) return;
    if (tab !== "plans") {
      planCountRetryFocusedRef.current = false;
      return;
    }
    if (photoList.error) return;
    planCountRetryFocusedRef.current = false;
    if (document.activeElement === document.body)
      planResultsHeadingRef.current?.focus({ preventScroll: true });
  }, [photoList.error, tab]);
  const [workPage, setWorkPage] = useState(1);
  const [workPageSize, setWorkPageSize] = useState(10);
  const maintenanceBundles = useMaintenanceBundles(tab === "taWorklist");
  const [selectedBundleMembers, setSelectedBundleMembers] = useState<
    Record<string, MaintenanceBundleSelection>
  >({});
  const [bundleComposerOpen, setBundleComposerOpen] = useState(false);
  const [bundleComposerCloseInViewport, setBundleComposerCloseInViewport] =
    useState(false);
  const bundleSelectionActionRef = useRef<HTMLButtonElement>(null);
  const bundleSelectionStartRef = useRef<HTMLInputElement>(null);
  const focusBundleSelectionActionOnClose = useRef(false);
  const [maintenanceBundleName, setMaintenanceBundleName] = useState("");
  const [maintenanceBundleBusy, setMaintenanceBundleBusy] = useState(false);
  const [pendingBundleMembership, setPendingBundleMembership] = useState<{
    maintenanceIds: string[];
    queryRevision: number;
  } | null>(null);
  const [maintenanceBundleError, setMaintenanceBundleError] = useState("");
  const [pendingBundleNavigation, setPendingBundleNavigation] =
    useState<Tab | null>(null);
  const [workStatus, setWorkStatus] = useState<RepairStatus | "all">("all");
  const [workMethod, setWorkMethod] = useState("all");
  const [workTa, setWorkTa] = useState("all");
  const [worklistStatusSnapshot, setWorklistStatusSnapshot] = useState<{
    scopeKey: string;
    counts: MaintenancePage["statusCounts"];
  } | null>(null);
  const [maintenanceTarget, setMaintenanceTarget] =
    useState<MaintenanceTarget | null>(null);
  const [pendingMaintenanceLeave, setPendingMaintenanceLeave] =
    useState<PendingMaintenanceLeave | null>(null);
  const maintenanceEditStateRef = useRef({ dirty: false, busy: false });
  const pendingWorklistNavigation = useRef<{
    edge: "first" | "last";
    fromPage: number;
  } | null>(null);
  const pendingPhotoNavigation = useRef<"first" | "last" | null>(null);
  const [workVisibility, setWorkVisibility] = useState("visible");
  const [showAllWork, setShowAllWork] = useState(false);
  const worklistCountScopeKey = JSON.stringify([
    tab === "taWorklist" ? "unassigned-ta" : "maintenance",
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
      recordPurpose: tab === "taWorklist" ? "inspection" : scope.recordPurpose,
      ...(isMaintenanceTab ? { targetType: "photo" as const } : {}),
      inWorklist:
        tab === "taWorklist" ||
        (isMaintenanceTab && !showAllWork && workVisibility === "visible")
          ? "true"
          : "all",
      unbundledOnly: tab === "taWorklist" ? "true" : "false",
      visibility: (tab === "dashboard" || tab === "taWorklist"
        ? "visible"
        : workVisibility) as "visible" | "hidden" | "all",
      ...(isMaintenanceTab || (tab === "dashboard" && scope.teamId !== "all")
        ? {
            teamId: scope.teamId,
            rackId: scope.rackId,
            search: isMaintenanceTab ? scope.search : "",
            repairStatus: isMaintenanceTab ? workStatus : "all",
            repairMethod: isMaintenanceTab ? workMethod : "all",
            ta: isMaintenanceTab
              ? tab === "taWorklist"
                ? "true"
                : workTa
              : "all",
            page: isMaintenanceTab ? workPage : 1,
            pageSize: isMaintenanceTab ? workPageSize : 50,
          }
        : {}),
    },
    isMaintenanceTab ||
      tab === "points" ||
      (tab === "dashboard" && scope.teamId !== "all"),
  );
  useEffect(() => {
    if (isMaintenanceTab && maintenance.data) {
      setWorklistStatusSnapshot({
        scopeKey: worklistCountScopeKey,
        counts: maintenance.data.statusCounts,
      });
    }
  }, [isMaintenanceTab, maintenance.data, worklistCountScopeKey]);
  useEffect(() => {
    if (
      !pendingBundleMembership ||
      !maintenanceBundles.data ||
      maintenance.loadedRevision < pendingBundleMembership.queryRevision
    )
      return;
    const bundledIds = new Set(
      maintenanceBundles.data.flatMap((bundle) => bundle.maintenanceIds),
    );
    if (
      pendingBundleMembership.maintenanceIds.every((id) => bundledIds.has(id))
    )
      setPendingBundleMembership(null);
  }, [
    maintenance.loadedRevision,
    maintenanceBundles.data,
    pendingBundleMembership,
  ]);
  const bundleMembershipRefreshPending =
    tab === "taWorklist" && pendingBundleMembership !== null;
  const worklistStatusCounts = bundleMembershipRefreshPending
    ? null
    : worklistStatusSnapshot?.scopeKey === worklistCountScopeKey
      ? worklistStatusSnapshot.counts
      : (maintenance.data?.statusCounts ?? null);
  const worklistItems = isMaintenanceTab ? (maintenance.data?.items ?? []) : [];
  const bundleSearch = scope.search.trim().toLocaleLowerCase("ko-KR");
  const visibleMaintenanceBundles = (maintenanceBundles.data ?? []).flatMap(
    (bundle) => {
      const matchingMembers = bundle.members.filter((item) => {
        const inTeam = scope.teamId === "all" || item.teamId === scope.teamId;
        const inRack = scope.rackId === "all" || item.rackId === scope.rackId;
        const inPlan =
          scope.planId === "all" ||
          (scope.planId === "unassigned"
            ? !item.planId
            : item.planId === scope.planId);
        const matchesSearch =
          !bundleSearch ||
          `${item.planTitle ?? ""} ${item.pointLabel ?? ""} ${item.photoName ?? ""}`
            .toLocaleLowerCase("ko-KR")
            .includes(bundleSearch);
        const matchesMethod =
          workMethod === "all" || item.repairMethod === workMethod;
        return inTeam && inRack && inPlan && matchesSearch && matchesMethod;
      });
      return matchingMembers.length
        ? [
            {
              bundle,
              matchingMemberIds: new Set(
                matchingMembers.map((member) => member.id),
              ),
            },
          ]
        : [];
    },
  );
  const maintenanceItemTarget = useCallback(
    (item: MaintenanceWorklistRow): MaintenanceTarget => ({
      planId: item.planId,
      pointId: item.pointId,
      pointLabel: item.pointLabel,
      recordPurpose: item.recordPurpose ?? "inspection",
      targetType: item.targetType,
      targetId: item.targetId,
      ...(item.targetType === "photo" ? { photoId: item.targetId } : {}),
    }),
    [],
  );
  const worklistItemIndex =
    maintenanceTarget?.targetType === "photo"
      ? worklistItems.findIndex(
          (item) => item.targetId === maintenanceTarget.targetId,
        )
      : -1;
  const canNavigateWorklist = (direction: -1 | 1) => {
    if (worklistItemIndex < 0 || !maintenance.data) return false;
    const nextIndex = worklistItemIndex + direction;
    if (nextIndex >= 0 && nextIndex < worklistItems.length) return true;
    return direction < 0
      ? maintenance.data.page > 1
      : maintenance.data.page < maintenance.data.pages;
  };
  const performNavigateWorklist = (direction: -1 | 1) => {
    if (!canNavigateWorklist(direction) || !maintenance.data) return false;
    const nextIndex = worklistItemIndex + direction;
    const nextItem = worklistItems[nextIndex];
    if (nextItem) {
      maintenanceEditStateRef.current = { dirty: false, busy: false };
      setPendingMaintenanceLeave(null);
      setMaintenanceTarget(maintenanceItemTarget(nextItem));
      return true;
    }
    const nextPage = maintenance.data.page + direction;
    if (nextPage < 1 || nextPage > maintenance.data.pages) return false;
    pendingWorklistNavigation.current = {
      edge: direction > 0 ? "first" : "last",
      fromPage: maintenance.data.page,
    };
    setPendingMaintenanceLeave({ kind: "transitioning" });
    setWorkPage(nextPage);
    return true;
  };
  const requestMaintenanceLeave = (
    message: string,
    actionLabel: string,
    action: () => void,
  ) => {
    if (pendingMaintenanceLeave) return;
    if (maintenanceEditStateRef.current.busy) {
      setPendingMaintenanceLeave({ kind: "saving" });
      return;
    }
    if (maintenanceEditStateRef.current.dirty) {
      setPendingMaintenanceLeave({
        kind: "discard",
        message,
        actionLabel,
        action,
      });
      return;
    }
    setPendingMaintenanceLeave(null);
    action();
  };
  const navigateWorklist = (direction: -1 | 1) => {
    if (!canNavigateWorklist(direction) || pendingMaintenanceLeave) return;
    const message = `저장하지 않은 보수 변경이 있습니다. ${direction < 0 ? "이전" : "다음"} 사진으로 이동하면 변경 내용이 사라집니다.`;
    const actionLabel =
      direction < 0 ? "변경을 버리고 이전 사진" : "변경을 버리고 다음 사진";
    if (maintenanceEditStateRef.current.busy) {
      setPendingMaintenanceLeave({ kind: "saving" });
      return;
    }
    if (maintenanceEditStateRef.current.dirty) {
      setPendingMaintenanceLeave({
        kind: "worklist-navigation",
        message,
        actionLabel,
        direction,
      });
      return;
    }
    void performNavigateWorklist(direction);
  };
  useEffect(() => {
    const navigation = pendingWorklistNavigation.current;
    if (!isMaintenanceTab || !navigation) return;
    const restoreCurrentItem = (message: string) => {
      pendingWorklistNavigation.current = null;
      setPendingMaintenanceLeave(null);
      setWorkPage(navigation.fromPage);
      setToast({ tone: "info", message });
    };
    if (maintenance.error) {
      restoreCurrentItem(
        "다음 사진을 불러오지 못했습니다. 현재 사진과 수정 내용을 유지했습니다.",
      );
      return;
    }
    if (!maintenance.data || maintenance.data.page !== workPage) return;
    if (!maintenance.data.items.length) {
      restoreCurrentItem(
        "이동할 사진이 목록에 없습니다. 현재 사진과 수정 내용을 유지했습니다.",
      );
      return;
    }
    const item =
      navigation.edge === "first"
        ? maintenance.data.items[0]
        : maintenance.data.items[maintenance.data.items.length - 1];
    pendingWorklistNavigation.current = null;
    maintenanceEditStateRef.current = { dirty: false, busy: false };
    setPendingMaintenanceLeave(null);
    setMaintenanceTarget(maintenanceItemTarget(item));
  }, [
    isMaintenanceTab,
    maintenance.data,
    maintenance.error,
    workPage,
    maintenanceItemTarget,
  ]);
  const needsMaintenanceReviewQuery =
    tab === "dashboard" &&
    scope.rackId !== "all" &&
    Boolean(
      maintenance.data &&
      maintenance.data.total > maintenance.data.items.length,
    );
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
    maintenanceEditStateRef.current = { dirty: false, busy: false };
    setPendingMaintenanceLeave(null);
    setDetail(null);
    setPointDetail(null);
    setMaintenanceTarget(target);
  };
  const createMaintenanceBundle = async () => {
    const maintenanceIds = Object.keys(selectedBundleMembers);
    if (
      !canWrite ||
      maintenanceBundleBusy ||
      maintenanceIds.length < 2 ||
      !maintenanceBundleName.trim()
    )
      return;
    setMaintenanceBundleBusy(true);
    setMaintenanceBundleError("");
    try {
      await api("/maintenance/bundles", {
        method: "POST",
        body: JSON.stringify({
          name: maintenanceBundleName,
          maintenanceIds,
          expectedVersions: Object.fromEntries(
            Object.entries(selectedBundleMembers).map(([id, member]) => [
              id,
              member.editVersion,
            ]),
          ),
          actor,
          reason: `TA 작업 묶음 구성: ${maintenanceBundleName.trim()}`,
        }),
      });
      setPendingBundleMembership({
        maintenanceIds,
        queryRevision: maintenance.requestRevision + 1,
      });
      setSelectedBundleMembers({});
      setMaintenanceBundleName("");
      focusBundleSelectionActionOnClose.current = true;
      setBundleComposerOpen(false);
      maintenanceBundles.refresh();
      await notify("TA 작업 묶음을 만들었습니다.");
    } catch (error) {
      setMaintenanceBundleError((error as Error).message);
    } finally {
      setMaintenanceBundleBusy(false);
    }
  };
  const photos = photoList.data?.items ?? [];
  const changeScope = (next: PhotoScope) => {
    setScope(next);
    setPage(1);
    setPointPage(1);
    setWorkPage(1);
    setSelectedMaintenancePhotos({});
  };
  const [newPointRack, setNewPointRack] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadContext, setUploadContext] = useState<{
    plan: Plan;
    point?: Point;
    rackId?: string;
    files?: File[];
  } | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [mapPlanSeed, setMapPlanSeed] = useState<{
    teamId: string;
    rackIds: string[];
  } | null>(null);
  const [planVisibility, setPlanVisibility] = useState("visible");
  const [planStatus, setPlanStatus] = useState<"all" | Plan["status"]>(
    "planned",
  );
  const [planSearch, setPlanSearch] = useState("");
  const [planPage, setPlanPage] = useState(1);
  const [planSort, setPlanSort] = useState<"created" | "date">("created");
  const [planPhotoPreviews, setPlanPhotoPreviews] = useState<
    Record<string, PlanPhotoPreviewState>
  >({});
  const [expandedPlanPreviewId, setExpandedPlanPreviewId] = useState<
    string | null
  >(null);
  const [planPhotoRevision, setPlanPhotoRevision] = useState(0);
  const [draggingPhotoPlanId, setDraggingPhotoPlanId] = useState<string | null>(
    null,
  );

  const resetFilters = (target: Tab, nextScope = defaultPhotoScope) => {
    changeScope(nextScope);
    setFilter("all");
    if (target === "photos" || target === "labels") {
      setSelectedPhotoPlanIds(null);
      setPhotoPageSize(10);
    }
    setWorkClassificationFilter("all");
    setSelectedMaintenancePhotos({});
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

  const [planManagement, setPlanManagement] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<Photo | null>(null);
  const photoDetailIndex = detail
    ? photos.findIndex((photo) => photo.id === detail.id)
    : -1;
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
    )
      return;
    pendingPhotoNavigation.current = null;
    setDetail(
      edge === "first" ? data.items[0] : data.items[data.items.length - 1],
    );
  }, [detail, page, photoList.data, tab]);
  const [photoVisibilityTarget, setPhotoVisibilityTarget] =
    useState<Photo | null>(null);
  const [pointDetail, setPointDetail] = useState<Point | null>(null);
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  useEffect(() => {
    if (!sidebarOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSidebarOpen(false);
      window.requestAnimationFrame(() => sidebarToggleRef.current?.focus());
    };
    const closeOnWideViewport = () => {
      if (window.innerWidth > 900) setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnWideViewport);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnWideViewport);
    };
  }, [sidebarOpen]);
  const selectedPlan = plans.find((plan) => plan.id === scope.planId);
  const plansForVisibility = plans.filter(
    (plan) =>
      plan.recordPurpose === "inspection" && plan.visibility === planVisibility,
  );
  const scopedPlans = plansForVisibility.filter(
    (plan) =>
      (scope.teamId === "all" || plan.teamId === scope.teamId) &&
      (scope.rackId === "all" || plan.rackIds.includes(scope.rackId)),
  );
  const searchText = planSearch.trim().toLocaleLowerCase("ko-KR");
  const searchDigits = searchText.replace(/\D/g, "");
  const searchedPlans = scopedPlans.filter((plan) => {
    if (!searchText) return true;
    const titleMatches = plan.title
      .toLocaleLowerCase("ko-KR")
      .includes(searchText);
    const date = plan.date ?? "";
    const dateDigits = date.replace(/\D/g, "");
    const shortDateDigits =
      dateDigits.length === 8 ? dateDigits.slice(2) : dateDigits;
    const dateMatches =
      date.toLocaleLowerCase("ko-KR").includes(searchText) ||
      (searchDigits.length >= 4 &&
        (dateDigits.includes(searchDigits) ||
          shortDateDigits.includes(searchDigits)));
    return titleMatches || dateMatches;
  });
  const filteredPlans = searchedPlans.filter(
    (plan) => planStatus === "all" || plan.status === planStatus,
  );
  const visiblePlans =
    planSort === "date"
      ? [...filteredPlans].sort((a, b) => {
          const dateOrder = (a.date || "9999-12-31").localeCompare(
            b.date || "9999-12-31",
          );
          return (
            dateOrder || planStatusOrder[a.status] - planStatusOrder[b.status]
          );
        })
      : filteredPlans;
  const planOptionsSummary = [
    ...(planVisibility === "hidden" ? ["삭제한 계획 보기"] : []),
    ...(planSort === "date" ? ["예정일 빠른 순"] : []),
  ].join(" · ");
  const planPageCount = Math.max(
    1,
    Math.ceil(visiblePlans.length / plansPerPage),
  );
  const pagePlans = visiblePlans.slice(
    (planPage - 1) * plansPerPage,
    planPage * plansPerPage,
  );
  const pagePlanIds = pagePlans.map((plan) => plan.id).join(",");
  useEffect(() => {
    if (tab !== "plans" || !pagePlanIds) return;
    const planIds = pagePlanIds.split(",");
    let active = true;
    let loading = false;
    const controller = new AbortController();
    setPlanPhotoPreviews((previous) => ({
      ...previous,
      ...Object.fromEntries(
        planIds.map((id) => [
          id,
          {
            ...(previous[id] ?? { items: [], total: 0, pages: 1 }),
            loading: true,
            error: "",
          },
        ]),
      ),
    }));
    const load = async () => {
      if (!active || loading) return;
      loading = true;
      try {
        const results = await Promise.all(
          planIds.map(async (planId) => {
            try {
              const data = await api<PhotoPage>(
                `/inspections/query?planId=${encodeURIComponent(planId)}&page=1&pageSize=4`,
                {
                  signal: AbortSignal.any([
                    controller.signal,
                    AbortSignal.timeout(10000),
                  ]),
                },
              );
              return [
                planId,
                {
                  items: data.items,
                  total: data.total,
                  pages: data.pages,
                  loading: false,
                  error: "",
                },
              ] as const;
            } catch (cause) {
              return [
                planId,
                {
                  items: [],
                  total: 0,
                  pages: 1,
                  loading: false,
                  error: (cause as Error).message,
                },
              ] as const;
            }
          }),
        );
        if (active)
          setPlanPhotoPreviews((previous) => ({
            ...previous,
            ...Object.fromEntries(results),
          }));
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => {
      active = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [tab, pagePlanIds, planPhotoRevision]);
  useEffect(() => {
    setExpandedPlanPreviewId(null);
  }, [pagePlanIds, tab]);
  useEffect(() => {
    setPlanPage((current) => (current === 1 ? current : 1));
  }, [
    scope.teamId,
    scope.rackId,
    planVisibility,
    planStatus,
    planSort,
    planSearch,
  ]);
  useEffect(() => {
    setPlanPage((current) => Math.min(current, planPageCount));
  }, [planPageCount]);
  const filteredPoints = points.filter((point) => {
    if ((point.recordPurpose ?? "inspection") !== "inspection") return false;
    if (scope.rackId !== "all" && point.rackId !== scope.rackId) return false;
    const pointTeamId = locations.racks.find(
      (rack) => rack.id === point.rackId,
    )?.teamId;
    if (scope.teamId !== "all" && pointTeamId !== scope.teamId) return false;
    const needle = scope.search.trim().toLocaleLowerCase("ko-KR");
    if (!needle) return true;
    return [point.equipment, point.rack, point.name, pointName(point)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase("ko-KR").includes(needle));
  });
  const pointPageCount = Math.max(
    1,
    Math.ceil(filteredPoints.length / pointPageSize),
  );
  const pagePoints = filteredPoints.slice(
    (pointPage - 1) * pointPageSize,
    pointPage * pointPageSize,
  );
  useEffect(
    () => setPointPage((current) => Math.min(current, pointPageCount)),
    [pointPageCount],
  );
  const loading = useRef(false);
  const refreshQueued = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const pointsRequest = api<Point[]>("/points?recordPurpose=all")
        .then((data) => {
          setPoints(data);
          setPointsError("");
        })
        .catch((cause: unknown) => {
          setPointsError(
            cause instanceof Error ? cause.message : "다시 조회하세요.",
          );
        });
      const plansRequest = api<Plan[]>("/plans?visibility=all")
        .then((data) => {
          setPlans(data);
          setPlansLoaded(true);
          setPlansError("");
        })
        .catch((cause: unknown) => {
          setPlansError(
            cause instanceof Error ? cause.message : "다시 조회하세요.",
          );
        });
      const healthRequest = api<Health>("/health")
        .then((data) => {
          setHealth(data);
          setHealthError("");
        })
        .catch((cause: unknown) => {
          setHealthError(
            cause instanceof Error ? cause.message : "다시 조회하세요.",
          );
        });
      await Promise.all([pointsRequest, plansRequest, healthRequest]);
    } finally {
      loading.current = false;
      if (refreshQueued.current) {
        refreshQueued.current = false;
        void refresh();
      }
    }
  }, []);
  const retryRefresh = () => {
    if (loading.current) {
      refreshQueued.current = true;
      setToast({
        tone: "info",
        message: "조회 중입니다. 현재 조회가 끝나면 다시 조회합니다.",
      });
      return;
    }
    void refresh();
  };
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
  useEffect(() => {
    if (
      bundleComposerOpen || bundleMembershipRefreshPending ||
      maintenanceBundleBusy || !focusBundleSelectionActionOnClose.current
    )
      return;
    focusBundleSelectionActionOnClose.current = false;
    if (document.activeElement === document.body)
      bundleSelectionActionRef.current?.focus();
  }, [bundleComposerOpen, bundleMembershipRefreshPending, maintenanceBundleBusy]);
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
  const pageTitle =
    tab === "taWorklist"
      ? "워크리스트 관리"
      : nav.find((item) => item.id === tab)?.label;
  const daysInMonth = new Date(
    month.getFullYear(),
    month.getMonth() + 1,
    0,
  ).getDate();
  const dateKey = (day: number) =>
    `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const performTabNavigation = (target: Tab) => {
    setSidebarOpen(false);
    setPendingBundleNavigation(null);
    setSelectedBundleMembers({});
    setMaintenanceBundleName("");
    setMaintenanceBundleError("");
    setBundleComposerOpen(false);
    setDetail(null);
    setPointDetail(null);
    pendingWorklistNavigation.current = null;
    maintenanceEditStateRef.current = { dirty: false, busy: false };
    setPendingMaintenanceLeave(null);
    setMaintenanceTarget(null);
    setTab(target);
    resetFilters(
      target,
      target === "labels" || target === "models" || target === "photos"
        ? defaultPhotoScope
        : {
            ...defaultPhotoScope,
            teamId: scope.teamId,
            rackId: scope.rackId,
          },
    );
  };
  const requestTabNavigation = (target: Tab) => {
    if (target === tab) {
      setSidebarOpen(false);
      return;
    }
    if (tab === "taWorklist" && maintenanceBundleBusy) {
      setToast({
        tone: "info",
        message: "작업 묶음을 등록하고 있습니다. 완료된 뒤 이동할 수 있습니다.",
      });
      return;
    }
    const hasBundleDraft =
      Object.keys(selectedBundleMembers).length > 0 ||
      Boolean(maintenanceBundleName.trim());
    if (tab === "taWorklist" && hasBundleDraft) {
      setPendingBundleNavigation(target);
      return;
    }
    performTabNavigation(target);
  };
  const go = (target: Tab) => {
    if (!maintenanceTarget) {
      requestTabNavigation(target);
      return;
    }
    if (tab === "taWorklist" && maintenanceBundleBusy) {
      setToast({
        tone: "info",
        message: "작업 묶음을 등록하고 있습니다. 완료된 뒤 이동할 수 있습니다.",
      });
      return;
    }
    requestMaintenanceLeave(
      "저장하지 않은 보수 변경이 있습니다. 화면을 이동하면 변경 내용이 사라집니다.",
      "변경을 버리고 화면 이동",
      () => {
        closeMaintenance();
        requestTabNavigation(target);
      },
    );
  };
  const closeMaintenance = () => {
    pendingWorklistNavigation.current = null;
    maintenanceEditStateRef.current = { dirty: false, busy: false };
    setPendingMaintenanceLeave(null);
    setMaintenanceTarget(null);
  };
  const closeMaintenanceRequest = () =>
    requestMaintenanceLeave(
      "저장하지 않은 보수 변경이 있습니다. 창을 닫으면 변경 내용이 사라집니다.",
      "변경을 버리고 닫기",
      closeMaintenance,
    );
  const handleMaintenanceClose = () => {
    if (
      pendingMaintenanceLeave?.kind === "saving" ||
      pendingMaintenanceLeave?.kind === "transitioning"
    )
      return;
    if (pendingMaintenanceLeave) {
      setPendingMaintenanceLeave(null);
      return;
    }
    closeMaintenanceRequest();
  };
  const confirmMaintenanceLeave = () => {
    if (pendingMaintenanceLeave?.kind === "worklist-navigation") {
      const { direction } = pendingMaintenanceLeave;
      if (!canNavigateWorklist(direction)) {
        setPendingMaintenanceLeave(null);
        setToast({
          tone: "info",
          message:
            "사진 목록이 변경되어 이동할 수 없습니다. 수정 내용은 유지했습니다.",
        });
        return;
      }
      if (!performNavigateWorklist(direction)) {
        setPendingMaintenanceLeave(null);
        setToast({
          tone: "info",
          message:
            "사진 목록이 변경되어 이동할 수 없습니다. 수정 내용은 유지했습니다.",
        });
      }
      return;
    }
    if (pendingMaintenanceLeave?.kind !== "discard") return;
    const { action } = pendingMaintenanceLeave;
    maintenanceEditStateRef.current = { dirty: false, busy: false };
    setPendingMaintenanceLeave({ kind: "transitioning" });
    action();
    if (!pendingWorklistNavigation.current) setPendingMaintenanceLeave(null);
  };
  const updateMaintenanceEditState = useCallback(
    (state: { dirty: boolean; busy: boolean }) => {
      maintenanceEditStateRef.current = state;
      if (!state.busy)
        setPendingMaintenanceLeave((current) =>
          current?.kind === "saving" ? null : current,
        );
    },
    [],
  );
  const createMaintenanceForSelectedPhotos = async () => {
    const chosen = Object.values(selectedMaintenancePhotos);
    if (!canWrite || !chosen.length || bulkMaintenanceBusy) return;
    setBulkMaintenanceBusy(true);
    setBulkMaintenanceError("");
    const savedIds = new Set<string>();
    const failures: string[] = [];
    for (const photo of chosen) {
      try {
        const current = await api<SavedMaintenance | null>(
          `/maintenance/target?photoId=${encodeURIComponent(photo.id)}`,
        );
        if (
          current?.persisted &&
          (current.repairStatus === "progress" ||
            current.repairStatus === "done")
        ) {
          failures.push(`${photo.name}: 이미 작업 중이거나 완료된 항목`);
          continue;
        }
        const payload = {
          actor,
          reason: "사진 판독에서 선택한 보수 대상을 작업 예정으로 등록",
          expectedVersion: current?.persisted ? current.editVersion : null,
          repairStatus: "planned" as const,
          repairMethod: bulkMaintenanceMethod,
          inWorklist: true,
          ta: bulkMaintenanceTa,
          inclusionMode: "auto" as const,
          ...(canManageRecords ? { visibility: current?.visibility ?? "visible" } : {}),
          photoIds: [photo.id],
          ...(!current?.persisted
            ? {
                planId: photo.planId,
                pointId: null,
                targetType: "photo" as const,
                targetId: photo.id,
              }
            : {}),
        };
        await api<SavedMaintenance>(
          current?.persisted ? `/maintenance/${current.id}` : "/maintenance",
          {
            method: current?.persisted ? "PATCH" : "POST",
            body: JSON.stringify(payload),
          },
        );
        savedIds.add(photo.id);
      } catch (cause) {
        failures.push(`${photo.name}: ${(cause as Error).message}`);
      }
    }
    const remaining = Object.fromEntries(
      Object.entries(selectedMaintenancePhotos).filter(
        ([id]) => !savedIds.has(id),
      ),
    );
    setSelectedMaintenancePhotos(remaining);
    setBulkMaintenanceBusy(false);
    if (savedIds.size) {
      await notify(
        `${savedIds.size}장의 사진별 보수 항목을 작업 예정으로 등록했습니다.`,
      );
      if (!failures.length) {
        setBulkMaintenanceOpen(false);
        go("worklist");
        setWorkStatus("planned");
      }
    }
    if (failures.length) setBulkMaintenanceError(failures.join("\n"));
  };
  const openPlanDialog = (
    seed: { teamId: string; rackIds: string[] } | null,
  ) => {
    if (!canWrite) return;
    if (plansUnavailable) {
      setToast({
        tone: "info",
        message: plansError
          ? "검사계획 조회가 복구되면 계획을 추가할 수 있습니다."
          : "검사계획 목록 확인이 끝나면 계획을 추가할 수 있습니다.",
      });
      return;
    }
    setMapPlanSeed(seed);
    setPlanOpen(true);
  };
  const openPlanFromScope = () =>
    openPlanDialog(
      scope.teamId === "all"
        ? null
        : {
            teamId: scope.teamId,
            rackIds: scope.rackId === "all" ? [] : [scope.rackId],
          },
    );
  const uploadForPlan = (
    plan: Plan,
    point?: Point,
    rackId?: string,
    files?: File[],
  ) => {
    if (!canWrite) return;
    if (plansUnavailable) {
      setToast({
        tone: "info",
        message: plansError
          ? "검사계획 조회가 복구되면 사진을 추가할 수 있습니다."
          : "검사계획 목록 확인이 끝나면 사진을 추가할 수 있습니다.",
      });
      return;
    }
    setPlanManagement(null);
    setUploadContext({ plan, point, rackId, files });
    setUploadOpen(true);
  };
  const planAcceptsPhotoDrop = (plan: Plan) =>
    plan.status === "planned" && plan.visibility === "visible";
  const selectedPhotoPlan =
    selectedPhotoPlanIds?.length === 1
      ? plans.find((plan) => plan.id === selectedPhotoPlanIds[0])
      : undefined;
  const selectedPhotoPlanNeedsManagement = Boolean(
    selectedPhotoPlan && !planAcceptsPhotoDrop(selectedPhotoPlan),
  );
  const hasDraggedFiles = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes("Files");
  const handlePlanPhotoDrop = (event: DragEvent<HTMLElement>, plan: Plan) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDraggingPhotoPlanId(null);
    if (!canWrite) return;
    if (plansUnavailable) {
      setToast({
        tone: "info",
        message: plansError
          ? "검사계획 조회가 복구되면 사진을 추가할 수 있습니다."
          : "검사계획 목록 확인이 끝나면 사진을 추가할 수 있습니다.",
      });
      return;
    }
    if (!planAcceptsPhotoDrop(plan)) return;
    const files = Array.from(event.dataTransfer.files).filter(
      (file) =>
        ["image/jpeg", "image/png"].includes(file.type) ||
        /\.(jpe?g|png)$/i.test(file.name),
    );
    if (!files.length) {
      void notify("JPG 또는 PNG 사진을 끌어 놓으세요.", "error");
      return;
    }
    uploadForPlan(plan, undefined, undefined, files);
  };
  const viewPlanPhotos = (plan: Plan, rackId?: string) => {
    setPlanManagement(null);
    go("photos");
    setSelectedPhotoPlanIds([plan.id]);
    changeScope({
      ...defaultPhotoScope,
      planId: plan.id,
      teamId: plan.teamId ?? "all",
      rackId: rackId ?? "all",
    });
  };

  return (
    <div className="app-shell">
      <aside className={sidebarOpen ? "sidebar sidebar-expanded" : "sidebar"}>
        <button className="brand" style={{ border: 0, background: "transparent", textAlign: "left", cursor: "pointer", width: "100%" }} aria-label="홈으로 이동" onClick={() => go("home")}>
          <span className="brand-mark">
            <img src="/flare-stack-mark.png" alt="" />
          </span>
          <span>Drone Inspection Platform</span>
        </button>
        <button
          ref={sidebarToggleRef}
          className="sidebar-menu-toggle"
          type="button"
          aria-label={sidebarOpen ? "업무 메뉴 닫기" : "업무 메뉴 펼치기"}
          aria-expanded={sidebarOpen}
          aria-controls="primary-work-navigation"
          title={sidebarOpen ? "업무 메뉴 닫기" : "업무 메뉴 펼치기"}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
          <span>{sidebarOpen ? "메뉴 닫기" : "메뉴"}</span>
        </button>
        <nav id="primary-work-navigation" aria-label="업무 메뉴">
          {navGroups.map((group) => (
            <section
              className="nav-group"
              key={group.label}
              aria-label={group.label}
            >
              <p className="nav-caption">{group.label}</p>
              {group.items.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  aria-label={label}
                  title={label}
                  aria-current={tab === id ? "page" : undefined}
                  className={tab === id ? "nav-item selected" : "nav-item"}
                  onClick={() => go(id)}
                >
                  <Icon size={19} />
                  <span>{label}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="메뉴 닫기"
          tabIndex={-1}
          onClick={() => {
            setSidebarOpen(false);
            window.requestAnimationFrame(() =>
              sidebarToggleRef.current?.focus(),
            );
          }}
        />
      )}
      <div className="main-shell" inert={sidebarOpen}>
        {tab !== "dashboard" && (
          <header className="topbar">
            <div className="top-actions">
              <button
                className="icon-button theme-toggle"
                onClick={toggleTheme}
                aria-label={
                  isDarkMode ? "밝은 모드로 전환" : "어두운 모드로 전환"
                }
                aria-pressed={isDarkMode}
                title={isDarkMode ? "밝은 모드" : "어두운 모드"}
              >
                {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <AuthAccountButton />
            </div>
          </header>
        )}
        <main className={tab === "dashboard" ? "dashboard-main" : undefined}>
          {tab !== "dashboard" && tab !== "home" && (
            <div className="page-heading">
              <div>
                <h1 ref={pageHeadingRef} tabIndex={-1}>
                  {pageTitle}
                </h1>
                {tab === "plans" && <p>팀·랙별 계획과 사진 판독 현황</p>}
                {tab === "worklist" && (
                  <p>사진별 보수 상태·이력을 관리합니다.</p>
                )}
                {tab === "taWorklist" && (
                  <p>TA 작업 묶음 관리 · 보수 기록은 사진별로 유지</p>
                )}
              </div>
              <div className="heading-actions">
                {tab === "plans" && (
                  <button
                    className="button primary"
                    disabled={!canWrite || plansUnavailable}
                    onClick={openPlanFromScope}
                  >
                    <CalendarDays size={16} />
                    검사계획 만들기
                  </button>
                )}
                {tab === "photos" && (
                  <button
                    className="button primary"
                    disabled={!canWrite || plansUnavailable}
                    onClick={() => {
                      if (!canWrite) return;
                      if (selectedPhotoPlan) {
                        if (planAcceptsPhotoDrop(selectedPhotoPlan))
                          uploadForPlan(selectedPhotoPlan);
                        else setPlanManagement(selectedPhotoPlan);
                        return;
                      }
                      setUploadContext(null);
                      if (plans.some(planAcceptsPhotoDrop)) setUploadOpen(true);
                      else openPlanDialog(null);
                    }}
                  >
                    {plansUnavailable ? (
                      plansError ? (
                        "계획 조회 실패"
                      ) : (
                        "계획 확인 중…"
                      )
                    ) : (
                      <>
                        {selectedPhotoPlanNeedsManagement ? (
                          <SlidersHorizontal size={16} />
                        ) : (
                          <Plus size={18} />
                        )}
                        {selectedPhotoPlanNeedsManagement
                          ? "계획 관리"
                          : "사진 추가"}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}
          {error && tab !== "dashboard" && (
            <div className="notice error" role="alert">
              <Activity size={18} />
              <span>
                일부 자료를 조회하지 못했습니다.{" "}
                <small>{error} 조회 실패</small>
              </span>
              <button
                onFocus={() => {
                  errorRetryTabRef.current = tab;
                }}
                onBlur={() => {
                  errorRetryTabRef.current = null;
                }}
                onClick={() => {
                  photoList.refresh();
                  if (isMaintenanceTab) maintenance.refresh();
                  if (tab === "taWorklist") maintenanceBundles.refresh();
                  retryRefresh();
                }}
              >
                다시 조회
              </button>
            </div>
          )}
          {!health?.model?.ready && !healthError && tab !== "dashboard" && (
            <div className="notice">
              <Clock3 size={17} />
              <span>
                AI 모델 연결 대기 중입니다. 사진 업로드와 업무 기록은 계속할 수
                있으며, 판독은 모델 준비 후 시작됩니다.
              </span>
            </div>
          )}
          {tab !== "dashboard" &&
            tab !== "home" &&
            tab !== "plans" &&
            tab !== "labels" &&
            tab !== "models" && (
              <PhotoScopeFields
                context={tab === "taWorklist" ? "worklist" : tab}
                taOnly={tab === "taWorklist"}
                scope={scope}
                plans={plans}
                change={(next) => {
                  changeScope(next);
                }}
                reset={() => resetFilters(tab)}
                selectedPlanIds={selectedPhotoPlanIds}
                changePlanIds={(ids) => {
                  setSelectedPhotoPlanIds(ids);
                  setPage(1);
                  setSelectedMaintenancePhotos({});
                }}
                worklistFilters={
                  isMaintenanceTab
                    ? {
                        method: workMethod,
                        ta: tab === "taWorklist" ? "true" : workTa,
                        visibility: workVisibility,
                        showAll: showAllWork,
                        changeMethod: (value) => {
                          setWorkMethod(value);
                          setWorkPage(1);
                        },
                        changeTa: (value) => {
                          setWorkTa(value);
                          setWorkPage(1);
                        },
                        changeVisibility: (value) => {
                          setWorkVisibility(value);
                          setWorkPage(1);
                          if (scope.planId !== "all")
                            changeScope({ ...scope, planId: "all" });
                        },
                        changeShowAll: (value) => {
                          setShowAllWork(value);
                          setWorkPage(1);
                        },
                      }
                    : undefined
                }
              />
            )}
          {photoList.error && ["photos", "labels", "points"].includes(tab) && (
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
          {tab === "home" && <HomeDashboard
            onNavigate={(target, status) => {
              go(target);
              if (target !== "dashboard") changeScope(defaultPhotoScope);
              if (target === "photos" && status) setFilter(status);
              if (target === "worklist" && status) setWorkStatus(status);
            }}
            onTeamPhotos={(teamId) => {
              go("photos");
              changeScope({ ...defaultPhotoScope, teamId });
            }}
          />}
          <div hidden={tab !== "dashboard"}>
            <PlantDashboard
              paused={
                tab !== "dashboard" ||
                Boolean(
                  uploadOpen ||
                  planOpen ||
                  detail ||
                  newPointRack ||
                  planManagement ||
                  pointDetail ||
                  maintenanceTarget,
                )
              }
              teamId={scope.teamId === "all" ? null : scope.teamId}
              rackId={scope.rackId === "all" ? null : scope.rackId}
              plansLoaded={plansLoaded}
              plans={plans.filter(
                (plan) => plan.recordPurpose === "inspection",
              )}
              points={points.filter(
                (point) =>
                  (point.recordPurpose ?? "inspection") === "inspection",
              )}
              photos={photos}
              photoTotal={photoList.data?.total ?? null}
              photoSummary={photoList.data?.summary ?? null}
              photoError={photoList.error}
              maintenance={maintenance.data?.items ?? []}
              maintenanceTotal={maintenance.data?.total ?? null}
              maintenanceReviewTotal={
                maintenance.data &&
                maintenance.data.total <= maintenance.data.items.length
                  ? maintenance.data.items.filter(
                      (item) => item.repairStatus === "review",
                    ).length
                  : (maintenanceReview.data?.total ?? null)
              }
              maintenanceWorklistTotal={
                maintenance.data?.summary?.worklist ?? null
              }
              maintenanceError={
                maintenance.error ||
                (needsMaintenanceReviewQuery ? maintenanceReview.error : "")
              }
              error={recordsError ? `${recordsError} 조회 실패` : ""}
              onRetryData={() => {
                retryRefresh();
              }}
              onRetryPhotos={photoList.refresh}
              onRetryMaintenance={() => {
                maintenance.refresh();
                maintenanceReview.refresh();
              }}
              onScopeChange={(teamId, rackId) =>
                changeScope({
                  ...defaultPhotoScope,
                  teamId: teamId ?? "all",
                  rackId: rackId ?? "all",
                })
              }
              onCreatePlan={(teamId, rackIds) => {
                openPlanDialog({ teamId, rackIds });
              }}
              onStartPlan={openPlanFromScope}
              onOpenPlan={(id) => {
                const plan = plans.find((item) => item.id === id);
                if (plan) setPlanManagement(plan);
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
                const item = maintenance.data?.items.find(
                  (row) => row.id === id,
                );
                if (item)
                  openMaintenance({
                    planId: item.planId,
                    pointId: item.pointId,
                    recordPurpose: item.recordPurpose,
                    targetType: item.targetType,
                    targetId: item.targetId,
                    ...(item.targetType === "photo"
                      ? { photoId: item.targetId }
                      : {}),
                  });
              }}
              onOpenPhotos={() => go("photos")}
              onOpenWorklist={() => {
                go("worklist");
                setShowAllWork(true);
              }}
              onOpenReviewWorklist={() => {
                go("worklist");
                setShowAllWork(true);
                setWorkStatus("review");
              }}
            />
          </div>
          {(tab === "photos" || tab === "labels") && (
            <section className="panel">
              {tab === "photos" && (
                <>
                  <div className="list-toolbar photo-list-toolbar">
                    <label className="filter-control">
                      AI 판독 상태
                      <select
                        aria-label="AI 판독 상태 필터"
                        value={filter}
                        onChange={(event) => {
                          setFilter(event.target.value);
                          setPage(1);
                          setSelectedMaintenancePhotos({});
                        }}
                      >
                        <option value="all">전체 상태</option>
                        <option value="pending">판독 대기</option>
                        <option value="processing">판독 중</option>
                        <option value="done">판독 완료</option>
                        <option value="error">판독 실패</option>
                        <option value="unread">미판독</option>
                      </select>
                    </label>
                    <label className="filter-control">
                      업무 분류
                      <select
                        aria-label="업무 분류 필터"
                        value={workClassificationFilter}
                        onChange={(event) => {
                          setWorkClassificationFilter(
                            event.target.value as "all" | "repair" | "retake",
                          );
                          setPage(1);
                          setSelectedMaintenancePhotos({});
                        }}
                      >
                        <option value="all">전체 분류</option>
                        <option value="repair">보수 필요</option>
                        <option value="retake">재촬영 필요</option>
                      </select>
                    </label>
                  </div>
                  {Object.keys(selectedMaintenancePhotos).length > 0 && (
                    <div className="photo-selection-bar">
                      <span>
                        <strong>
                          {Object.keys(selectedMaintenancePhotos).length}장
                        </strong>{" "}
                        선택
                      </span>
                      <button
                        className="text-button"
                        type="button"
                        disabled={!canWrite}
                        onClick={() => { if (canWrite) setSelectedMaintenancePhotos({}); }}
                      >
                        선택 해제
                      </button>
                      <button
                        className="button primary"
                        type="button"
                        disabled={!canWrite}
                        onClick={() => {
                          if (!canWrite) return;
                          setBulkMaintenanceError("");
                          setBulkMaintenanceOpen(true);
                        }}
                      >
                        <Wrench size={16} /> 사진별 보수 등록
                      </button>
                    </div>
                  )}
                </>
              )}
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
                  onVisibilityChange={(photo) => { if (canManageRecords) setPhotoVisibilityTarget(photo); }}
                  compact={tab === "photos"}
                  selectedPhotoIds={
                    new Set(Object.keys(selectedMaintenancePhotos))
                  }
                  onTogglePhoto={(photo) => {
                    if (!canWrite) return;
                    setSelectedMaintenancePhotos((current) => {
                      const next = { ...current };
                      if (next[photo.id]) delete next[photo.id];
                      else next[photo.id] = photo;
                      return next;
                    });
                  }}
                  onTogglePage={(eligiblePhotos, checked) => {
                    if (!canWrite) return;
                    setSelectedMaintenancePhotos((current) => {
                      const next = { ...current };
                      for (const photo of eligiblePhotos) {
                        if (checked) next[photo.id] = photo;
                        else delete next[photo.id];
                      }
                      return next;
                    });
                  }}
                  selectable={tab === "photos"}
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
                onPageSizeChange={
                  tab === "photos"
                    ? (value) => {
                        setPhotoPageSize(value);
                        setPage(1);
                      }
                    : undefined
                }
              />
            </section>
          )}
          {isMaintenanceTab && (
            <>
              {tab === "taWorklist" && (
                <MaintenanceBundleWorkspace
                  bundles={visibleMaintenanceBundles}
                  loading={
                    !maintenanceBundles.data && !maintenanceBundles.error
                  }
                  error={maintenanceBundles.error || null}
                  hasCachedData={maintenanceBundles.data !== null}
                  onRetry={maintenanceBundles.refresh}
                  retryScopeKey={worklistCountScopeKey}
                  onOpen={(item) =>
                    openMaintenance(maintenanceItemTarget(item))
                  }
                />
              )}
              {tab === "taWorklist" && bundleComposerOpen && (
                <MaintenanceBundleComposer
                  selectedMembers={Object.entries(selectedBundleMembers).map(
                    ([id, member]) => ({ id, ...member }),
                  )}
                  selectedCount={Object.keys(selectedBundleMembers).length}
                  selectionStartRef={bundleSelectionStartRef}
                  name={maintenanceBundleName}
                  busy={maintenanceBundleBusy}
                  error={maintenanceBundleError}
                  onNameChange={(name) => { if (canWrite) setMaintenanceBundleName(name); }}
                  onClear={() => { if (canWrite) setSelectedBundleMembers({}); }}
                  onRemove={(id) => {
                    if (!canWrite) return;
                    setSelectedBundleMembers((current) => {
                      const next = { ...current };
                      delete next[id];
                      return next;
                    });
                  }}
                  onCloseActionVisibilityChange={
                    setBundleComposerCloseInViewport
                  }
                  onClose={() => {
                    focusBundleSelectionActionOnClose.current = true;
                    setBundleComposerOpen(false);
                  }}
                  onCreate={() => void createMaintenanceBundle()}
                />
              )}
              <MaintenanceWorklist
                items={maintenance.data?.items ?? []}
                total={maintenance.data?.total ?? null}
                page={maintenance.data?.page}
                pages={maintenance.data?.pages}
                pageSize={workPageSize}
                onPageSizeChange={(value) => {
                  setWorkPageSize(value);
                  setWorkPage(1);
                }}
                title={
                  tab === "taWorklist" ? "미배정 TA 사진" : "보수 대상 사진"
                }
                showTaIndicator={tab === "worklist"}
                busyMessage={
                  bundleMembershipRefreshPending
                    ? maintenance.error || maintenanceBundles.error
                      ? "작업 묶음은 저장됐습니다. 실패한 목록을 다시 조회해 반영을 확인하세요."
                      : "작업 묶음은 저장됐습니다. 목록을 갱신하고 있습니다."
                    : undefined
                }
                statusFilter={
                  <>
                    <p className="worklist-status-label">상태</p>
                    <div
                      className="worklist-status-bar"
                      role="group"
                      aria-label={
                        tab === "taWorklist"
                          ? "미배정 TA 사진 상태 필터"
                          : "보수 대상 사진 상태 필터"
                      }
                    >
                      <button
                        type="button"
                        className={`worklist-status-chip${workStatus === "all" ? " is-selected" : ""}`}
                        aria-pressed={workStatus === "all"}
                        disabled={!worklistStatusCounts}
                        onClick={() => {
                          setWorkStatus("all");
                          setWorkPage(1);
                        }}
                      >
                        <span>전체</span>
                        <strong>
                          {worklistStatusCounts
                            ? Object.values(worklistStatusCounts).reduce(
                                (sum, count) => sum + count,
                                0,
                              )
                            : "—"}
                        </strong>
                      </button>
                      {workStatusStages.map(({ id, label }) => (
                        <button
                          type="button"
                          key={id}
                          className={`worklist-status-chip${workStatus === id ? " is-selected" : ""}`}
                          aria-pressed={workStatus === id}
                          disabled={!worklistStatusCounts}
                          onClick={() => {
                            setWorkStatus(id);
                            setWorkPage(1);
                          }}
                        >
                          <span>{label}</span>
                          <strong>{worklistStatusCounts?.[id] ?? "—"}</strong>
                        </button>
                      ))}
                      {(workStatus === "none" ||
                        !!worklistStatusCounts?.none) && (
                        <button
                          type="button"
                          className={`worklist-status-chip${workStatus === "none" ? " is-selected" : ""}`}
                          aria-pressed={workStatus === "none"}
                          disabled={!worklistStatusCounts}
                          onClick={() => {
                            setWorkStatus("none");
                            setWorkPage(1);
                          }}
                        >
                          <span>등록 전</span>
                          <strong>{worklistStatusCounts?.none ?? "—"}</strong>
                        </button>
                      )}
                    </div>
                  </>
                }
                selectionActionLabel={
                  bundleComposerOpen
                    ? "작성 접기"
                    : Object.keys(selectedBundleMembers).length > 0
                      ? "선택한 사진 묶기"
                      : maintenanceBundleName.trim()
                        ? "작성 계속"
                        : "새 작업 묶음"
                }
                selectionActionExpanded={bundleComposerOpen}
                selectionActionRef={bundleSelectionActionRef}
                selectionStartRef={
                  tab === "taWorklist"
                    ? bundleSelectionStartRef
                    : undefined
                }
                selectionActionHidden={
                  bundleComposerOpen && bundleComposerCloseInViewport
                }
                onSelectionAction={
                  tab === "taWorklist"
                    ? () => {
                        if (!canWrite) return;
                        setMaintenanceBundleError("");
                        setBundleComposerOpen((open) => !open);
                      }
                    : undefined
                }
                onPageChange={setWorkPage}
                busy={
                  maintenanceBundleBusy ||
                  bundleMembershipRefreshPending ||
                  (!maintenance.data && !maintenance.error)
                }
                error={maintenance.error || null}
                onRetry={maintenance.refresh}
                retryScopeKey={maintenance.queryKey}
                onOpen={(item) => openMaintenance(maintenanceItemTarget(item))}
                selectedIds={
                  tab === "taWorklist"
                    ? new Set(Object.keys(selectedBundleMembers))
                    : undefined
                }
                onSelectionChange={
                  tab === "taWorklist"
                    ? (item, selected) => {
                        if (!canWrite) return;
                        setSelectedBundleMembers((current) => {
                          const next = { ...current };
                          if (selected)
                            next[item.id] = {
                              editVersion: item.editVersion,
                              photoName: item.photoName || "사진 이름 미조회",
                              planTitle: item.planTitle,
                              pointLabel: item.pointLabel || "위치 미확인",
                            };
                          else delete next[item.id];
                          return next;
                        });
                      }
                    : undefined
                }
              />
            </>
          )}
          {tab === "plans" && (
            <section className="panel plan-panel">
              <div className="plan-query-area">
                <PhotoScopeFields
                  context={tab}
                  scope={scope}
                  plans={plans}
                  change={changeScope}
                  reset={() => resetFilters(tab)}
                  selectedPlanIds={selectedPhotoPlanIds}
                  changePlanIds={(ids) => {
                    setSelectedPhotoPlanIds(ids);
                    setPage(1);
                  }}
                />
                <div className="plan-list-toolbar">
                  <div className="plan-status-section">
                    <span className="plan-filter-label">상태</span>
                    <div
                      className="plan-status-filters"
                      role="group"
                      aria-label="계획 상태"
                      aria-busy={!plansLoaded}
                    >
                      {(
                        [
                          ["planned", "진행 중"],
                          ["all", "전체"],
                          ["done", "완료"],
                          ["cancelled", "취소"],
                        ] as const
                      ).map(([status, label]) => (
                        <button
                          key={status}
                          type="button"
                          className={planStatus === status ? "selected" : ""}
                          aria-pressed={planStatus === status}
                          disabled={!plansLoaded}
                          onClick={() => {
                            setPlanStatus(status);
                            setPlanPage(1);
                          }}
                        >
                          {label}{" "}
                          <span>
                            {plansLoaded
                              ? status === "all"
                                ? searchedPlans.length
                                : searchedPlans.filter(
                                    (plan) => plan.status === status,
                                  ).length
                              : "—"}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="plan-list-controls">
                    <label className="filter-control plan-search-control">
                      계획 검색
                      <span className="plan-list-search">
                        <Search size={17} aria-hidden="true" />
                        <input
                          type="search"
                          value={planSearch}
                          onChange={(event) => {
                            setPlanSearch(event.target.value);
                            setPlanPage(1);
                          }}
                          placeholder="계획명 · 예정일"
                          title="계획 이름, 261001 또는 2026-10-01로 검색"
                        />
                      </span>
                    </label>
                    <details className="plan-list-options">
                      <summary>
                        목록 옵션
                        {planOptionsSummary ? ` · ${planOptionsSummary}` : ""}
                      </summary>
                      <div className="plan-list-tools">
                        <label className="filter-control plan-visibility">
                          계획 범위
                          <select
                            value={planVisibility}
                            onChange={(event) => {
                              const next = event.target.value;
                              setPlanVisibility(next);
                              setPlanStatus(
                                next === "visible" ? "planned" : "all",
                              );
                              setPlanPage(1);
                            }}
                          >
                            <option value="visible">현재 계획</option>
                            <option value="hidden">삭제한 계획 보기</option>
                          </select>
                        </label>
                        <label className="filter-control plan-sort">
                          정렬
                          <select
                            value={planSort}
                            onChange={(event) => {
                              setPlanSort(
                                event.target.value as "created" | "date",
                              );
                              setPlanPage(1);
                            }}
                          >
                            <option value="created">최근 등록 순</option>
                            <option value="date">예정일 빠른 순</option>
                          </select>
                        </label>
                      </div>
                    </details>
                  </div>
                </div>
              </div>
              {photoList.error && (
                <div className="plan-count-error" role="alert">
                  사진 장수를 조회하지 못했습니다.{" "}
                  <button
                    type="button"
                    className="text-button"
                    aria-label="검사계획 사진 장수 다시 조회"
                    onFocus={() => {
                      planCountRetryFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      planCountRetryFocusedRef.current = false;
                    }}
                    onClick={photoList.refresh}
                  >
                    다시 조회
                  </button>
                </div>
              )}
              <div className="plan-results-heading">
                <h2 ref={planResultsHeadingRef} tabIndex={-1}>
                  계획 목록
                </h2>
                {(!plansLoaded || plansError) && (
                  <span>
                    {plansError
                      ? plansLoaded
                        ? `조회 실패 · 마지막 정상 목록 ${visiblePlans.length}건 · 읽기 전용`
                        : "조회 실패"
                      : "조회 중"}
                  </span>
                )}
              </div>
              {!plansLoaded ? (
                <Empty
                  role={plansError ? undefined : "status"}
                  text={
                    plansError
                      ? "계획 목록을 조회하지 못했습니다. 위쪽 안내에서 다시 조회하세요."
                      : "검사계획을 불러오는 중입니다."
                  }
                />
              ) : !visiblePlans.length ? (
                <Empty
                  role="status"
                  text={
                    plansError
                      ? "마지막 정상 조회에서는 조건에 맞는 계획이 없습니다."
                      : planVisibility === "hidden"
                        ? "조건에 맞는 삭제한 계획이 없습니다."
                        : planStatus === "planned" &&
                            !planSearch &&
                            scopedPlans.length
                          ? "진행 중인 계획이 없습니다."
                          : scopedPlans.length
                            ? "조건에 맞는 계획이 없습니다."
                            : plansForVisibility.length
                              ? "선택한 팀·랙 범위에 계획이 없습니다."
                              : "검사계획이 없습니다."
                  }
                  action={
                    planVisibility === "visible" &&
                    planStatus === "planned" &&
                    !planSearch ? (
                      <button
                        className="button primary"
                        type="button"
                        disabled={!canWrite || plansUnavailable}
                        onClick={openPlanFromScope}
                      >
                        검사계획 만들기
                      </button>
                    ) : scopedPlans.length ? (
                      <button
                        className="button secondary"
                        type="button"
                        onClick={() => {
                          setPlanStatus("all");
                          setPlanSearch("");
                        }}
                      >
                        상태·검색 초기화
                      </button>
                    ) : undefined
                  }
                />
              ) : null}
              {pagePlans.length > 0 && (
                <div className="plan-table-wrap">
                  <table className="v3-plan-table">
                    <thead>
                      <tr>
                        <th scope="col">검사계획</th>
                        <th scope="col">생산팀</th>
                        <th scope="col">검사 범위</th>
                        <th scope="col">예정일</th>
                        <th scope="col">등록 사진 · 판독</th>
                        <th scope="col">
                          <span className="sr-only">계획 관리</span>
                        </th>
                      </tr>
                    </thead>
                    {pagePlans.map((plan) => {
                      const planPhotoCount = photoList.error
                        ? undefined
                        : photoList.data?.planCounts
                          ? (photoList.data.planCounts[plan.id] ?? 0)
                          : undefined;
                      const photoStatus = photoList.error
                        ? undefined
                        : photoList.data?.planStatusCounts?.[plan.id];
                      const waiting =
                        (photoStatus?.pending ?? 0) +
                        (photoStatus?.processing ?? 0);
                      const finishedPercent = photoStatus?.total
                        ? Math.round(
                            (photoStatus.done / photoStatus.total) * 100,
                          )
                        : 0;
                      const preview = planPhotoPreviews[plan.id];
                      return (
                        <tbody key={plan.id} className="plan-row-group">
                          <tr
                            className="plan-data-row"
                            onClick={(event) => {
                              if (
                                (event.target as HTMLElement).closest(
                                  "button, a, input, select, textarea",
                                )
                              )
                                return;
                              viewPlanPhotos(plan);
                            }}
                          >
                            <td data-label="검사계획">
                              <button
                                className="plan-card-open"
                                type="button"
                                onClick={() => viewPlanPhotos(plan)}
                                aria-label={`${plan.title}, 사진·판독 목록 보기`}
                              >
                                <span className="plan-list-title">
                                  <strong className="plan-list-name">
                                    {plan.title}
                                  </strong>
                                  <span
                                    className={`badge ${plan.status === "done" ? "green" : "muted"}`}
                                  >
                                    {plan.visibility === "hidden"
                                      ? "삭제됨"
                                      : plan.status === "planned"
                                        ? "진행 중"
                                        : plan.status === "done"
                                          ? "완료"
                                          : "취소"}
                                  </span>
                                </span>
                                <span className="plan-card-open-label">
                                  사진·판독 목록{" "}
                                  <ChevronRight size={14} aria-hidden="true" />
                                </span>
                              </button>
                            </td>
                            <td data-label="생산팀">
                              {locations.teams.find(
                                (team) => team.id === plan.teamId,
                              )?.name ?? "생산팀 확인 필요"}
                            </td>
                            <td
                              data-label="검사 범위"
                              title={plan.rackIds
                                .map(
                                  (id) =>
                                    locations.racks.find(
                                      (rack) => rack.id === id,
                                    )?.name ?? "랙 확인 필요",
                                )
                                .join(", ")}
                            >
                              {planRackSummary(plan.rackIds)}
                            </td>
                            <td data-label="예정일">{plan.date || "미지정"}</td>
                            <td data-label="등록 사진 · 판독">
                              <span className="plan-photo-total">
                                {photoList.error
                                  ? "조회 실패"
                                  : photoList.data?.planCounts
                                    ? `${photoList.data.planCounts[plan.id] ?? 0}장`
                                    : "조회 중"}
                              </span>
                              {photoStatus &&
                              photoStatus.total > 0 &&
                              photoStatus.done === photoStatus.total ? (
                                <span className="plan-photo-done">
                                  판독 완료
                                </span>
                              ) : (
                                photoStatus &&
                                photoStatus.total > 0 && (
                                  <span className="plan-card-inference">
                                    <span className="plan-card-statuses">
                                      <span>
                                        판독 완료 {photoStatus.done}/
                                        {photoStatus.total}
                                      </span>
                                      {waiting > 0 && (
                                        <span>대기·진행 {waiting}</span>
                                      )}
                                      {photoStatus.error > 0 && (
                                        <span className="status-error">
                                          오류 {photoStatus.error}
                                        </span>
                                      )}
                                      {photoStatus.unread > 0 && (
                                        <span>미판독 {photoStatus.unread}</span>
                                      )}
                                    </span>
                                    <span
                                      className="plan-card-progress"
                                      role="progressbar"
                                      aria-label={`${plan.title} AI 판독 진행률`}
                                      aria-valuemin={0}
                                      aria-valuemax={photoStatus.total}
                                      aria-valuenow={photoStatus.done}
                                    >
                                      <span
                                        style={{ width: `${finishedPercent}%` }}
                                      />
                                    </span>
                                  </span>
                                )
                              )}
                              <div className="plan-inline-actions">
                                {planPhotoCount !== 0 && (
                                  <button
                                    className="plan-preview-toggle"
                                    type="button"
                                    aria-expanded={
                                      expandedPlanPreviewId === plan.id
                                    }
                                    aria-controls={
                                      expandedPlanPreviewId === plan.id
                                        ? `plan-photo-preview-${plan.id}`
                                        : undefined
                                    }
                                    aria-label={`${plan.title} 사진 미리보기 ${expandedPlanPreviewId === plan.id ? "닫기" : "열기"}`}
                                    onClick={() =>
                                      setExpandedPlanPreviewId((current) =>
                                        current === plan.id ? null : plan.id,
                                      )
                                    }
                                  >
                                    {expandedPlanPreviewId === plan.id
                                      ? "닫기"
                                      : "미리보기"}
                                    <ChevronDown size={12} aria-hidden="true" />
                                  </button>
                                )}
                                {planAcceptsPhotoDrop(plan) && (
                                  <button
                                    className="button secondary plan-inline-add"
                                    type="button"
                                    disabled={!canWrite || plansUnavailable}
                                    onClick={() => uploadForPlan(plan)}
                                    aria-label={`${plan.title} 사진 추가`}
                                  >
                                    <ImagePlus size={13} aria-hidden="true" />
                                    추가
                                  </button>
                                )}
                              </div>
                            </td>
                            <td data-label="관리">
                              <button
                                className="button secondary plan-card-manage plan-table-manage"
                                type="button"
                                onClick={() => setPlanManagement(plan)}
                                aria-label={`${plan.title} 계획 관리`}
                              >
                                <SlidersHorizontal
                                  size={14}
                                  aria-hidden="true"
                                />
                                계획 관리
                              </button>
                            </td>
                          </tr>
                          {expandedPlanPreviewId === plan.id && (
                            <tr className="plan-photo-row">
                              <td colSpan={6}>
                                <section
                                  id={`plan-photo-preview-${plan.id}`}
                                  className={`plan-card-photos${draggingPhotoPlanId === plan.id && !plansError ? " is-drop-active" : ""}${planAcceptsPhotoDrop(plan) && !plansError ? " can-add-photos" : ""}`}
                                  aria-label={`${plan.title} 등록 사진 미리보기`}
                                  onDragEnter={(event) => {
                                    if (!canWrite) return;
                                    if (!hasDraggedFiles(event)) return;
                                    event.preventDefault();
                                    if (
                                      plansError ||
                                      !planAcceptsPhotoDrop(plan)
                                    ) {
                                      setDraggingPhotoPlanId(null);
                                      return;
                                    }
                                    setDraggingPhotoPlanId(plan.id);
                                  }}
                                  onDragOver={(event) => {
                                    if (!canWrite) return;
                                    if (!hasDraggedFiles(event)) return;
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect =
                                      plansError || !planAcceptsPhotoDrop(plan)
                                        ? "none"
                                        : "copy";
                                  }}
                                  onDragLeave={(event) => {
                                    if (
                                      event.currentTarget.contains(
                                        event.relatedTarget as Node | null,
                                      )
                                    )
                                      return;
                                    setDraggingPhotoPlanId(null);
                                  }}
                                  onDrop={(event) =>
                                    handlePlanPhotoDrop(event, plan)
                                  }
                                >
                                  {draggingPhotoPlanId === plan.id && (
                                    <div
                                      className="plan-photo-drop-overlay"
                                      aria-live="polite"
                                    >
                                      <CloudUpload size={22} /> 이 계획에 사진
                                      추가
                                    </div>
                                  )}
                                  {preview?.error ? (
                                    <div
                                      className="plan-photo-inline-message"
                                      role="alert"
                                    >
                                      사진을 불러오지 못했습니다.{" "}
                                      <button
                                        className="text-button"
                                        type="button"
                                        onClick={() =>
                                          setPlanPhotoRevision(
                                            (revision) => revision + 1,
                                          )
                                        }
                                      >
                                        다시 불러오기
                                      </button>
                                    </div>
                                  ) : preview?.loading && !preview.total ? (
                                    <div
                                      className="plan-photo-skeleton-grid"
                                      aria-label="사진 불러오는 중"
                                    >
                                      {Array.from({ length: 4 }, (_, index) => (
                                        <span key={index} />
                                      ))}
                                    </div>
                                  ) : preview?.total ? (
                                    <div className="plan-photo-grid">
                                      {preview.items.map((photo) => {
                                        const status =
                                          photo.status === "done"
                                            ? "판독 완료"
                                            : photo.status === "processing"
                                              ? "판독 중"
                                              : photo.status === "pending"
                                                ? "판독 대기"
                                                : photo.status === "error"
                                                  ? "판독 오류"
                                                  : "미판독";
                                        const isWaiting =
                                          photo.status === "pending" ||
                                          photo.status === "processing";
                                        return (
                                          <figure
                                            className={`plan-photo-card${isWaiting ? " is-waiting" : ""}${photo.status === "done" ? " is-done" : ""}${photo.status === "error" ? " is-error" : ""}`}
                                            key={photo.id}
                                          >
                                            <span className="plan-photo-image">
                                              <img
                                                src={`${apiBase}/api/inspections/${photo.id}/thumbnail`}
                                                alt=""
                                                loading="lazy"
                                              />
                                              {isWaiting && (
                                                <span
                                                  className="plan-photo-waiting-overlay"
                                                  aria-hidden="true"
                                                >
                                                  {photo.status ===
                                                  "processing" ? (
                                                    <LoaderCircle size={20} />
                                                  ) : (
                                                    <Clock3 size={20} />
                                                  )}
                                                </span>
                                              )}
                                            </span>
                                            <figcaption className="plan-photo-caption">
                                              <strong title={photo.name}>
                                                {photo.name}
                                              </strong>
                                              <small>{status}</small>
                                            </figcaption>
                                          </figure>
                                        );
                                      })}
                                    </div>
                                  ) : (
                                    preview && (
                                      <div className="plan-photo-inline-message">
                                        {planAcceptsPhotoDrop(plan)
                                          ? "등록 사진이 없습니다."
                                          : plan.visibility === "hidden"
                                            ? "삭제된 계획은 복원 후 상태를 확인하세요."
                                            : "계획 관리에서 재개 후 사진을 추가할 수 있습니다."}
                                      </div>
                                    )
                                  )}
                                </section>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      );
                    })}
                  </table>
                </div>
              )}
              {visiblePlans.length > plansPerPage && (
                <nav className="plan-pagination" aria-label="검사계획 페이지">
                  <span>
                    전체 {visiblePlans.length}개 · {planPage}/{planPageCount}
                    페이지
                  </span>
                  <button
                    className="button secondary"
                    disabled={planPage <= 1}
                    onClick={() => setPlanPage(1)}
                  >
                    처음
                  </button>
                  <button
                    className="button secondary"
                    disabled={planPage <= 1}
                    onClick={() =>
                      setPlanPage((current) => Math.max(1, current - 1))
                    }
                  >
                    이전
                  </button>
                  {planPageCount > 5 && planPage > 3 && (
                    <span className="page-ellipsis" aria-hidden="true">
                      …
                    </span>
                  )}
                  {pageNumberWindow(planPage, planPageCount).map(
                    (pageNumber) => (
                      <button
                        key={pageNumber}
                        className={`button page-number${planPage === pageNumber ? " selected" : ""}`}
                        aria-current={
                          planPage === pageNumber ? "page" : undefined
                        }
                        disabled={planPage === pageNumber}
                        onClick={() => setPlanPage(pageNumber)}
                      >
                        {pageNumber}
                      </button>
                    ),
                  )}
                  {planPageCount > 5 && planPage < planPageCount - 2 && (
                    <span className="page-ellipsis" aria-hidden="true">
                      …
                    </span>
                  )}
                  <button
                    className="button secondary"
                    disabled={planPage >= planPageCount}
                    onClick={() =>
                      setPlanPage((current) =>
                        Math.min(planPageCount, current + 1),
                      )
                    }
                  >
                    다음
                  </button>
                  <button
                    className="button secondary"
                    disabled={planPage >= planPageCount}
                    onClick={() => setPlanPage(planPageCount)}
                  >
                    마지막
                  </button>
                </nav>
              )}
            </section>
          )}
          {tab === "points" && (
            <section className="panel point-list-panel">
              <div className="point-list-heading">
                <h2>포인트 목록</h2>
                <span>조회 결과 {filteredPoints.length}개</span>
              </div>
              {!filteredPoints.length ? (
                <Empty text="조건에 맞는 검사 포인트가 없습니다." />
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">설비</th>
                        <th scope="col">생산팀 · 파이프랙</th>
                        <th scope="col">포인트</th>
                        <th scope="col">연결 사진</th>
                        <th scope="col">보수 상태</th>
                        <th scope="col">
                          <span className="sr-only">상세</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagePoints.map((point) => {
                        const count =
                          photoList.data?.pointCounts?.[point.id] ?? 0;
                        return (
                          <tr
                            key={point.id}
                            tabIndex={0}
                            onClick={(event) => {
                              if (
                                (event.target as HTMLElement).closest("button")
                              )
                                return;
                              void selectPoint(point);
                            }}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                void selectPoint(point);
                              }
                            }}
                          >
                            <td>{point.equipment || "설비 미확인"}</td>
                            <td>
                              {point.rackId
                                ? rackName(point.rackId)
                                : point.rack || "위치 미확인"}
                            </td>
                            <td>{point.name || "포인트 미확인"}</td>
                            <td>{count}장</td>
                            <td>
                              {point.repairStatus === "progress"
                                ? "작업 중"
                                : point.repairStatus === "done"
                                  ? "완료"
                                  : point.repairStatus === "review"
                                    ? "검토 필요"
                                    : "미등록"}
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                type="button"
                                aria-label={`${pointName(point)} 상세 보기`}
                                onClick={() => void selectPoint(point)}
                              >
                                <ChevronRight size={17} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {filteredPoints.length > 0 && (
                <nav className="photo-pagination" aria-label="포인트 페이지">
                  <span>
                    전체 {filteredPoints.length}개 · {pointPage}/
                    {pointPageCount}페이지
                  </span>
                  <div className="photo-pagination-controls">
                    <label className="page-size-control">
                      <span>한 화면에 보기</span>
                      <select
                        aria-label="한 화면에 보일 포인트 수"
                        value={pointPageSize}
                        onChange={(event) => {
                          setPointPageSize(Number(event.target.value));
                          setPointPage(1);
                        }}
                      >
                        <option value={10}>10개</option>
                        <option value={25}>25개</option>
                        <option value={50}>50개</option>
                      </select>
                    </label>
                    <div className="photo-pagination-buttons">
                      <button
                        className="button secondary"
                        disabled={pointPage <= 1}
                        onClick={() => setPointPage(1)}
                      >
                        처음
                      </button>
                      <button
                        className="button secondary"
                        disabled={pointPage <= 1}
                        onClick={() => setPointPage(pointPage - 1)}
                      >
                        이전
                      </button>
                      {pointPageCount > 5 && pointPage > 3 && (
                        <span className="page-ellipsis" aria-hidden="true">
                          …
                        </span>
                      )}
                      {pageNumberWindow(pointPage, pointPageCount).map(
                        (pageNumber) => (
                          <button
                            key={pageNumber}
                            className={`button page-number${pointPage === pageNumber ? " selected" : ""}`}
                            aria-current={
                              pointPage === pageNumber ? "page" : undefined
                            }
                            disabled={pointPage === pageNumber}
                            onClick={() => setPointPage(pageNumber)}
                          >
                            {pageNumber}
                          </button>
                        ),
                      )}
                      {pointPageCount > 5 && pointPage < pointPageCount - 2 && (
                        <span className="page-ellipsis" aria-hidden="true">
                          …
                        </span>
                      )}
                      <button
                        className="button secondary"
                        disabled={pointPage >= pointPageCount}
                        onClick={() => setPointPage(pointPage + 1)}
                      >
                        다음
                      </button>
                      <button
                        className="button secondary"
                        disabled={pointPage >= pointPageCount}
                        onClick={() => setPointPage(pointPageCount)}
                      >
                        마지막
                      </button>
                    </div>
                  </div>
                </nav>
              )}
            </section>
          )}
          {tab === "models" && (
            <section className="panel model-management-panel">
              <div className="model-status-heading">
                <div>
                  <h2>판독 모델 연결</h2>
                  <p>현재 판독에 연결된 모델 상태와 식별 정보를 보여줍니다.</p>
                </div>
                <span
                  className={`badge ${health?.model.ready ? "green" : "amber"}`}
                >
                  {health?.model.ready
                    ? "연결됨"
                    : healthError
                      ? "확인 필요"
                      : "연결 대기"}
                </span>
              </div>
              <dl className="model-metadata">
                <div>
                  <dt>모델 버전</dt>
                  <dd>{health?.model.model_version || "확인되지 않음"}</dd>
                </div>
                <div>
                  <dt>전처리 버전</dt>
                  <dd>
                    {health?.model.preprocessing_version || "확인되지 않음"}
                  </dd>
                </div>
                <div>
                  <dt>체크포인트 식별값</dt>
                  <dd>{health?.model.checkpoint_sha256 || "확인되지 않음"}</dd>
                </div>
                <div>
                  <dt>서비스 상태</dt>
                  <dd>
                    {health?.model.message ||
                      (health?.model.ready
                        ? "모델 서비스 연결됨"
                        : "모델 상태를 불러오는 중")}
                  </dd>
                </div>
              </dl>
              <div className="model-management-note">
                <Info size={17} />
                <span>
                  이 화면은 현재 연결 상태를 조회합니다. 모델 교체·재학습·배포
                  기능은 아직 제공하지 않습니다.
                </span>
              </div>
              <button
                className="button secondary"
                type="button"
                onClick={retryRefresh}
              >
                <RefreshCw size={15} /> 상태 새로고침
              </button>
            </section>
          )}
        </main>
      </div>
      {planManagement && (
        <PlanManagementDialog
          key={planManagement.id}
          initialPlan={planManagement}
          readOnly={plansUnavailable}
          close={() => setPlanManagement(null)}
          done={notify}
          reportHistoryError={reportHistoryError}
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
          plansUnavailable={plansUnavailable}
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
          plansUnavailable={plansUnavailable}
          initialTeamId={
            mapPlanSeed?.teamId ?? (scope.teamId === "all" ? "" : scope.teamId)
          }
          initialRackIds={mapPlanSeed?.rackIds ?? []}
          close={() => {
            setPlanOpen(false);
            setMapPlanSeed(null);
          }}
          done={notify}
          created={(plan) => {
            setMapPlanSeed(null);
            viewPlanPhotos(plan);
          }}
        />
      )}
      {detail && (
        <PhotoDialog
          key={detail.id}
          photo={photos.find((p) => p.id === detail.id) || detail}
          reportHistoryError={reportHistoryError}
          close={() => setDetail(null)}
          done={notify}
          onNavigate={
            tab === "photos" || tab === "labels" ? navigatePhoto : undefined
          }
          canNavigatePrevious={canNavigatePhoto(-1)}
          canNavigateNext={canNavigatePhoto(1)}
          createRetakePlan={(photo) => {
            const rack = locations.racks.find(
              (item) => item.id === photo.rackId,
            );
            openPlanDialog({
              teamId: photo.teamId ?? rack?.teamId ?? "",
              rackIds: photo.rackId ? [photo.rackId] : [],
            });
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
      {bulkMaintenanceOpen && (
        <Modal
          title="보수 항목 일괄 등록"
          wide
          close={() => {
            if (!bulkMaintenanceBusy) setBulkMaintenanceOpen(false);
          }}
        >
          <div className="bulk-maintenance-dialog">
            <div className="bulk-maintenance-summary">
              <strong>
                {Object.keys(selectedMaintenancePhotos).length}장 선택
              </strong>
              <span>
                사진마다 보수 항목을 따로 만들고 작업 예정으로 설정합니다.
              </span>
            </div>
            <p className="bulk-maintenance-note">
              작업 방법과 TA 설정은 모든 사진에 적용됩니다. 작업 묶음은
              워크리스트 관리에서 별도로 만듭니다.
            </p>
            <ul className="bulk-maintenance-list">
              {Object.values(selectedMaintenancePhotos).map((photo) => (
                <li key={photo.id}>
                  <img
                    src={`${apiBase}/api/inspections/${photo.id}/thumbnail`}
                    alt=""
                  />
                  <strong>{photo.name}</strong>
                  <span>{gradeOf(photo)}등급</span>
                </li>
              ))}
            </ul>
            <div className="bulk-maintenance-fields">
              <label className="field">
                작업 방법
                <select
                  value={bulkMaintenanceMethod}
                  disabled={!canWrite || bulkMaintenanceBusy}
                  onChange={(event) => {
                    if (canWrite && !bulkMaintenanceBusy)
                      setBulkMaintenanceMethod(event.target.value as RepairMethod);
                  }}
                >
                  <option value="undecided">방법 미정</option>
                  <option value="paint">도장</option>
                  <option value="replace">교체</option>
                </select>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={bulkMaintenanceTa}
                  disabled={!canWrite || bulkMaintenanceBusy}
                  onChange={(event) => {
                    if (canWrite && !bulkMaintenanceBusy) setBulkMaintenanceTa(event.target.checked);
                  }}
                />
                TA 작업에 포함
              </label>
            </div>
            <p className="bulk-maintenance-note">
              이미 작업 중이거나 완료된 사진은 건너뜁니다.
            </p>
            {bulkMaintenanceError && (
              <p className="form-error" role="alert">
                일부 사진을 등록하지 못했습니다.
                <br />
                {bulkMaintenanceError}
              </p>
            )}
            <div className="form-actions">
              <button
                className="button secondary"
                type="button"
                disabled={bulkMaintenanceBusy}
                onClick={() => setBulkMaintenanceOpen(false)}
              >
                취소
              </button>
              <button
                className="button primary"
                type="button"
                disabled={
                  !canWrite ||
                  bulkMaintenanceBusy ||
                  !Object.keys(selectedMaintenancePhotos).length
                }
                onClick={() => void createMaintenanceForSelectedPhotos()}
              >
                {bulkMaintenanceBusy ? "등록 중…" : "사진별 보수 항목 만들기"}
              </button>
            </div>
          </div>
        </Modal>
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
      {pendingBundleNavigation && (
        <Modal
          title="작업 묶음 작성 중"
          descriptionId="bundle-navigation-description"
          close={() => setPendingBundleNavigation(null)}
        >
          <p id="bundle-navigation-description" className="form-intro">
            {Object.keys(selectedBundleMembers).length > 0 &&
              `${Object.keys(selectedBundleMembers).length}장의 사진을 선택했고 `}
            {maintenanceBundleName.trim() &&
              `작업명 ‘${maintenanceBundleName.trim()}’을 입력했습니다. `}
            아직 저장하지 않은 내용입니다. 화면을 이동하면 초안이 사라집니다.
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              type="button"
              onClick={() => setPendingBundleNavigation(null)}
            >
              작성 계속
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => {
                const target = pendingBundleNavigation;
                if (target) performTabNavigation(target);
              }}
            >
              초안을 버리고 이동
            </button>
          </div>
        </Modal>
      )}
      {maintenanceTarget && (
        <Modal
          title={
            maintenanceTarget.targetType === "photo" ? "보수 관리" : "보수 기록"
          }
          wide
          close={handleMaintenanceClose}
          onNavigate={
            maintenanceTarget.targetType === "photo"
              ? navigateWorklist
              : undefined
          }
        >
          <MaintenanceContext
            key={`${maintenanceTarget.planId}/${maintenanceTarget.pointId}/${maintenanceTarget.photoId ?? maintenanceTarget.targetId}/${maintenanceTarget.targetType}/${maintenanceTarget.recordPurpose}`}
            {...maintenanceTarget}
            planTitle={
              maintenanceTarget.planId
                ? plans.find((plan) => plan.id === maintenanceTarget.planId)
                    ?.title || ""
                : null
            }
            pointLabel={
              maintenanceTarget.pointLabel ??
              pointName(
                points.find((point) => point.id === maintenanceTarget.pointId),
              )
            }
            onPrevious={() => navigateWorklist(-1)}
            onNext={() => navigateWorklist(1)}
            canPrevious={canNavigateWorklist(-1)}
            canNext={canNavigateWorklist(1)}
            visibleStatusFilter={isMaintenanceTab ? workStatus : "all"}
            onEditStateChange={updateMaintenanceEditState}
            editingBlocked={pendingMaintenanceLeave !== null}
            done={notify}
          />
          {pendingMaintenanceLeave && (
            <div
              className="form-error"
              role={
                pendingMaintenanceLeave.kind === "discard" ||
                pendingMaintenanceLeave.kind === "worklist-navigation"
                  ? "alert"
                  : "status"
              }
            >
              {pendingMaintenanceLeave.kind === "saving" ? (
                <p>저장 중에는 사진을 이동하거나 창을 닫을 수 없습니다.</p>
              ) : pendingMaintenanceLeave.kind === "transitioning" ? (
                <p>선택한 사진을 불러오는 중입니다.</p>
              ) : (
                <>
                  <p>{pendingMaintenanceLeave.message}</p>
                  <div className="form-actions">
                    <button
                      className="button secondary"
                      type="button"
                      autoFocus
                      onClick={() => setPendingMaintenanceLeave(null)}
                    >
                      계속 편집
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={confirmMaintenanceLeave}
                    >
                      {pendingMaintenanceLeave.actionLabel}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
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
  const searchUsesDebounce = context === "worklist";
  const [searchDraft, setSearchDraft] = useState(scope.search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scopeRef = useRef(scope);
  const changeRef = useRef(change);
  scopeRef.current = scope;
  changeRef.current = change;
  useEffect(() => {
    setSearchDraft(scope.search);
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
  }, [context, scope.search]);
  useEffect(() => {
    return () => {
      if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    };
  }, []);
  const updateSearch = (value: string) => {
    setSearchDraft(value);
    if (!searchUsesDebounce) {
      set({ search: value });
      return;
    }
    if (searchTimer.current !== null) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchTimer.current = null;
      changeRef.current({ ...scopeRef.current, search: value });
    }, 300);
  };
  const resetScope = () => {
    if (searchTimer.current !== null) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
    setSearchDraft("");
    reset();
  };
  const hasAdvancedFilters = context !== "plans";
  const hasVisibilityFilter = context !== "worklist";
  const inspectionPlans = plans.filter(
    (plan) => plan.recordPurpose === "inspection",
  );
  const activeAdvancedFilterLabels: string[] = [];
  if (context !== "photos" && scope.planId !== "all") {
    activeAdvancedFilterLabels.push("계획");
  }
  if (scope.search) activeAdvancedFilterLabels.push("검색");
  if (hasVisibilityFilter && scope.visibility !== "visible") {
    activeAdvancedFilterLabels.push("사진 표시");
  }
  if (context === "worklist" && worklistFilters) {
    if (worklistFilters.method !== "all") {
      activeAdvancedFilterLabels.push("작업 방법");
    }
    if (!taOnly && worklistFilters.ta === "true") {
      activeAdvancedFilterLabels.push("TA 포함");
    } else if (!taOnly && worklistFilters.ta === "false") {
      activeAdvancedFilterLabels.push("TA 미포함");
    }
    if (!taOnly && worklistFilters.visibility !== "visible") {
      activeAdvancedFilterLabels.push("표시 상태");
    }
    if (!taOnly && worklistFilters.showAll) {
      activeAdvancedFilterLabels.push("수동 제외·하향 포함");
    }
  }
  const hasActiveAdvancedFilter = activeAdvancedFilterLabels.length > 0;
  const activeAdvancedFilterSummary = hasActiveAdvancedFilter
    ? ` · ${activeAdvancedFilterLabels.join(" · ")}`
    : "";
  const detailSummary = context === "worklist" ? "검색·상세 조건" : "상세 조건";
  const worklistPlans = inspectionPlans.filter(
    (plan) =>
      (scope.teamId === "all" || plan.teamId === scope.teamId) &&
      (scope.rackId === "all" || plan.rackIds.includes(scope.rackId)) &&
      (!worklistFilters ||
        worklistFilters.visibility === "all" ||
        plan.visibility === worklistFilters.visibility),
  );

  if (context === "points") {
    return (
      <section className="common-scope" aria-label="포인트 조회 조건">
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
          <label className="field point-search-field">
            포인트 검색
            <input
              type="search"
              value={scope.search}
              maxLength={200}
              placeholder="설비·랙·포인트 이름"
              onChange={(event) => set({ search: event.target.value })}
            />
          </label>
          <button
            className="text-button scope-reset"
            type="button"
            onClick={resetScope}
          >
            조회 초기화
          </button>
        </div>
      </section>
    );
  }

  if (context === "photos") {
    const scopedPlans = inspectionPlans.filter(
      (plan) =>
        (scope.teamId === "all" || plan.teamId === scope.teamId) &&
        (scope.rackId === "all" || plan.rackIds.includes(scope.rackId)),
    );
    return (
      <section className="common-scope" aria-label="사진 조회 조건">
        <div className="scope-primary photo-plan-scope">
          <PhotoPlanFilter
            plans={scopedPlans}
            selectedIds={selectedPlanIds}
            change={changePlanIds}
          />
          <button
            className="text-button scope-reset"
            type="button"
            onClick={resetScope}
          >
            조회 초기화
          </button>
        </div>
        <details className="scope-details">
          <summary>상세 조건{activeAdvancedFilterSummary}</summary>
          <div className="photo-scope">
            <label>
              사진 표시
              <select
                value={scope.visibility}
                onChange={(event) =>
                  set({
                    visibility: event.target.value as PhotoScope["visibility"],
                  })
                }
              >
                <option value="visible">현재 사진</option>
                <option value="hidden">삭제한 사진</option>
                <option value="all">전체 사진</option>
              </select>
            </label>
            <label className="photo-search">
              검색
              <input
                type="search"
                maxLength={200}
                value={scope.search}
                onChange={(event) => set({ search: event.target.value })}
                placeholder="사진명 또는 검사계획"
              />
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
              set({
                teamId: event.target.value,
                rackId: "all",
                ...(context === "worklist" ? { planId: "all" } : {}),
              })
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
                ...(context === "worklist" ? { planId: "all" } : {}),
              });
            }}
          >
            <option value="all">모든 랙</option>
            {scope.teamId === "all"
              ? locations.teams.map((team) => (
                  <optgroup key={team.id} label={team.name}>
                    {locations.racks
                      .filter((rack) => rack.teamId === team.id)
                      .map((rack) => (
                        <option key={rack.id} value={rack.id}>
                          {rack.name}
                        </option>
                      ))}
                  </optgroup>
                ))
              : locations.racks
                  .filter((rack) => rack.teamId === scope.teamId)
                  .map((rack) => (
                    <option key={rack.id} value={rack.id}>
                      {rack.name}
                    </option>
                  ))}
          </select>
        </label>
        <button
          className="text-button scope-reset"
          type="button"
          onClick={resetScope}
        >
          조회 초기화
        </button>
      </div>
      {hasAdvancedFilters && (
        <details className="scope-details">
          <summary>
            {detailSummary}
            {activeAdvancedFilterSummary}
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
                {(context === "worklist" ? worklistPlans : inspectionPlans).map(
                  (plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.title}
                      {plan.visibility === "hidden" ? " (삭제됨)" : ""}
                    </option>
                  ),
                )}
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
                value={searchUsesDebounce ? searchDraft : scope.search}
                onChange={(event) => updateSearch(event.target.value)}
                placeholder={
                  context === "worklist"
                    ? "계획명, 포인트 또는 사진명"
                    : "사진명, 계획 또는 위치"
                }
                title={
                  context === "worklist"
                    ? "검사계획명, 포인트 이름 또는 사진 파일명으로 검색"
                    : undefined
                }
              />
            </label>
            {context === "worklist" && worklistFilters && (
              <>
                <label>
                  작업 방법
                  <select
                    aria-label="보수 방법 필터"
                    value={worklistFilters.method}
                    onChange={(event) =>
                      worklistFilters.changeMethod(event.target.value)
                    }
                  >
                    <option value="all">모든 방법</option>
                    <option value="undecided">미정</option>
                    <option value="paint">도장</option>
                    <option value="replace">교체</option>
                  </select>
                </label>
                {!taOnly && (
                  <label>
                    TA
                    <select
                      aria-label="보수 TA 필터"
                      value={worklistFilters.ta}
                      onChange={(event) =>
                        worklistFilters.changeTa(event.target.value)
                      }
                    >
                      <option value="all">전체</option>
                      <option value="true">포함</option>
                      <option value="false">미포함</option>
                    </select>
                  </label>
                )}
                {!taOnly && (
                  <label>
                    표시 상태
                    <select
                      value={worklistFilters.visibility}
                      onChange={(event) =>
                        worklistFilters.changeVisibility(event.target.value)
                      }
                    >
                      <option value="visible">현재 항목</option>
                      <option value="hidden">삭제한 항목</option>
                      <option value="all">전체 이력 항목</option>
                    </select>
                  </label>
                )}
                {!taOnly && (
                  <label className="worklist-show-all-filter">
                    <input
                      type="checkbox"
                      checked={worklistFilters.showAll}
                      onChange={(event) =>
                        worklistFilters.changeShowAll(event.target.checked)
                      }
                    />
                    수동 제외·등급 하향 항목도 보기
                  </label>
                )}
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
  const [search, setSearch] = useState("");
  const normalizedSearch = search.trim().toLocaleLowerCase("ko-KR");
  const planIds = new Set(plans.map((plan) => plan.id));
  const selected =
    selectedIds === null
      ? planIds
      : new Set(selectedIds.filter((id) => planIds.has(id)));
  const selectedCount = selected.size;
  const allSelected = plans.length > 0 && selectedCount === plans.length;
  const selectedPlan =
    selectedCount === 1
      ? plans.find((plan) => selected.has(plan.id))
      : undefined;
  const selectedTeamName = selectedPlan
    ? locations.teams.find((team) => team.id === selectedPlan.teamId)?.name
    : undefined;
  const singleSelectedLabel = selectedPlan
    ? selectedTeamName && !selectedPlan.title.includes(selectedTeamName)
      ? `${selectedPlan.title} · ${selectedTeamName}`
      : selectedPlan.title
    : undefined;
  const label =
    selectedIds === null || allSelected
      ? "모든 검사계획"
      : selectedCount === 0
        ? "검사계획 0개 선택"
        : selectedCount === 1
          ? singleSelectedLabel ?? "검사계획 1개 선택"
          : `${selectedCount}개 검사계획 선택`;
  const matchingPlans = normalizedSearch
    ? plans.filter((plan) => {
        const teamName =
          locations.teams.find((team) => team.id === plan.teamId)?.name ??
          "생산팀 미확인";
        const rackNames = plan.rackIds.map(
          (id) =>
            locations.racks.find((rack) => rack.id === id)?.name ??
            "랙 확인 필요",
        );
        const searchableText = [plan.title, plan.date, teamName, ...rackNames]
          .join(" ")
          .toLocaleLowerCase("ko-KR");
        return searchableText.includes(normalizedSearch);
      })
    : plans;
  const groupedPlans = locations.teams
    .map((team) => ({
      id: team.id,
      name: team.name,
      plans: matchingPlans.filter((plan) => plan.teamId === team.id),
    }))
    .filter((group) => group.plans.length > 0);
  const unassignedPlans = matchingPlans.filter(
    (plan) => !locations.teams.some((team) => team.id === plan.teamId),
  );
  if (unassignedPlans.length)
    groupedPlans.push({
      id: "unassigned",
      name: "생산팀 미확인",
      plans: unassignedPlans,
    });

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
        <label className="photo-plan-search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            aria-label="검사계획 검색"
            placeholder="계획명, 생산팀, 날짜 또는 랙 검색"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="photo-plan-option photo-plan-all">
          <input
            type="checkbox"
            aria-label="전체 검사계획 선택"
            checked={allSelected}
            onChange={() => change(allSelected ? [] : null)}
          />
          <span>전체 검사계획</span>
          <small>{plans.length}개</small>
        </label>
        {!plans.length ? (
          <p className="photo-plan-empty">조회할 검사계획이 없습니다.</p>
        ) : !matchingPlans.length ? (
          <p className="photo-plan-empty">일치하는 검사계획이 없습니다.</p>
        ) : (
          groupedPlans.map((group) => {
            const groupSelected = group.plans.filter((plan) =>
              selected.has(plan.id),
            ).length;
            const checked = groupSelected === group.plans.length;
            return (
              <section className="photo-plan-group" key={group.id}>
                <label className="photo-plan-option photo-plan-team">
                  <input
                    type="checkbox"
                    aria-label={`${group.name} ${normalizedSearch ? "검색 결과 " : ""}검사계획 전체 선택`}
                    checked={checked}
                    onChange={() =>
                      togglePlans(group.plans.map((plan) => plan.id))
                    }
                  />
                  <strong>{group.name}</strong>
                  <small>
                    {groupSelected}/{group.plans.length}
                  </small>
                </label>
                {group.plans.map((plan) => (
                  <label
                    className="photo-plan-option photo-plan-item"
                    key={plan.id}
                  >
                    <input
                      type="checkbox"
                      aria-label={`${group.name} ${plan.title} 선택`}
                      checked={selected.has(plan.id)}
                      onChange={() => togglePlans([plan.id])}
                    />
                    <span>{plan.title}</span>
                    <small>
                      {plan.date || "날짜 미지정"}
                      {plan.visibility === "hidden" ? " · 삭제됨" : ""}
                    </small>
                  </label>
                ))}
              </section>
            );
          })
        )}
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
          {data.pages > 5 && data.page > 3 && (
            <span className="page-ellipsis" aria-hidden="true">
              …
            </span>
          )}
          {pageNumberWindow(data.page, data.pages).map((pageNumber) => (
            <button
              type="button"
              key={pageNumber}
              className={`button page-number${data.page === pageNumber ? " selected" : ""}`}
              aria-current={data.page === pageNumber ? "page" : undefined}
              aria-label={`${pageNumber}페이지`}
              disabled={data.page === pageNumber}
              onClick={() => change(pageNumber)}
            >
              {pageNumber}
            </button>
          ))}
          {data.pages > 5 && data.page < data.pages - 2 && (
            <span className="page-ellipsis" aria-hidden="true">
              …
            </span>
          )}
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
  const { session, can } = useAuth();
  const canManageRecords = can("records.manage");
  const sessionActor = session?.authenticated ? session.user?.displayName : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hidden = photo.visibility === "hidden";
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title={hidden ? "사진 복원" : "사진 숨기기"} close={close}>
      <p className="form-intro">
        <strong>{photo.name}</strong>
        <br />
        숨김은 원본과 변경 이력을 보존합니다. 숨긴 사진은 목록의 표시 조건에서
        다시 찾을 수 있습니다.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canManageRecords || busy) return;
          const form = new FormData(event.currentTarget);
          setBusy(true);
          setError("");
          try {
            await api(`/inspections/${photo.id}/visibility`, {
              method: "PATCH",
              body: JSON.stringify({
                expectedVersion: photo.editVersion,
                actor: sessionActor ?? form.get("actor"),
                reason: form.get("reason"),
                visibility: hidden ? "visible" : "hidden",
              }),
            });
            await complete(
              hidden
                ? "사진을 복원했습니다. 원본과 이력은 그대로 유지됩니다."
                : "사진을 숨겼습니다. 숨긴 사진 조건에서 복원할 수 있습니다.",
            );
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          작업자
          <input
            name="actor"
            required
            maxLength={60}
            defaultValue={sessionActor ?? "현업 엔지니어"}
            readOnly={Boolean(session?.authenticated)}
            disabled={!canManageRecords || busy}
          />
        </label>
        <label className="field">
          사유
          <textarea name="reason" required maxLength={1000} rows={2} disabled={!canManageRecords || busy} />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            onClick={close}
            disabled={busy}
          >
            취소
          </button>
          <button className="button primary" disabled={!canManageRecords || busy}>
            {busy ? "저장 중…" : hidden ? "복원" : "숨기기"}
          </button>
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
  const { session, can } = useAuth();
  const canWrite = can("work.write"), canManageRecords = can("records.manage");
  const sessionActor = session?.authenticated ? session.user?.displayName : null;
  const purpose = canManageRecords ? recordPurpose : "inspection";
  const [saved, setSaved] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title="가상 랙에 새 포인트 등록" close={close}>
      <p className="form-intro">
        {purposeName[purpose]} · {rackName(rackId)}
        {plan ? ` · ${plan.title}에 연결` : " · 계획은 미지정"}
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canWrite || busy) return;
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
                  ...(canManageRecords ? { recordPurpose } : {}),
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
                    actor: sessionActor ?? "현업 엔지니어",
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
          <input name="equipment" maxLength={120} disabled={!canWrite || !!saved || busy} />
        </label>
        <label className="field">
          포인트 이름
          <input
            name="name"
            required
            maxLength={120}
            disabled={!canWrite || !!saved || busy}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary full-width" disabled={!canWrite || busy}>
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
  selectedPhotoIds,
  onTogglePhoto,
  onTogglePage,
  selectable = false,
  compact = false,
}: {
  photos: Photo[];
  points: Point[];
  plans: Plan[];
  onSelect: (p: Photo) => void;
  onVisibilityChange?: (photo: Photo) => void;
  selectedPhotoIds?: ReadonlySet<string>;
  onTogglePhoto?: (photo: Photo) => void;
  onTogglePage?: (eligiblePhotos: Photo[], checked: boolean) => void;
  selectable?: boolean;
  compact?: boolean;
}) {
  const { can } = useAuth();
  const canWrite = can("work.write"), canManageRecords = can("records.manage");
  const eligiblePhotos = photos.filter((photo) => {
    const grade = gradeOf(photo);
    return (
      photo.visibility === "visible" &&
      !photo.retake &&
      grade !== null &&
      grade !== undefined &&
      grade >= 3 &&
      grade <= 5
    );
  });
  const selectedCount = eligiblePhotos.filter((photo) =>
    selectedPhotoIds?.has(photo.id),
  ).length;
  const allSelected =
    eligiblePhotos.length > 0 && selectedCount === eligiblePhotos.length;
  return (
    <div className={`table-wrap${compact ? " photo-table-wrap" : ""}`}>
      <table className={compact ? "photo-list-table" : undefined}>
        {compact && (
          <colgroup>
            <col className="photo-select-column" />
            <col className="photo-image-column" />
            <col className="photo-plan-column" />
            <col className="photo-context-column" />
            <col className="photo-reading-column" />
            <col className="photo-followup-column" />
            <col className="photo-created-column" />
            <col className="photo-manage-column" />
          </colgroup>
        )}
        <thead>
          <tr>
            {selectable && (
              <th scope="col">
                <input
                  type="checkbox"
                  aria-label="현재 페이지 보수 대상 전체 선택"
                  checked={allSelected}
                  disabled={!canWrite || !eligiblePhotos.length}
                  onChange={(event) => {
                    if (canWrite) onTogglePage?.(eligiblePhotos, event.target.checked);
                  }}
                />
              </th>
            )}
            <th scope="col">검사 사진</th>
            <th scope="col">검사계획</th>
            {compact ? (
              <>
                <th scope="col">팀 · 랙 · 포인트</th>
                <th scope="col">AI 판독 · 현재 분류</th>
                <th scope="col">후속 표시</th>
                <th scope="col">등록</th>
              </>
            ) : (
              <>
                <th scope="col">생산팀</th>
                <th scope="col">파이프랙</th>
                <th scope="col">검사 포인트</th>
                <th scope="col">AI 판독</th>
                <th scope="col">현재 분류</th>
                <th scope="col">후속 표시</th>
                <th scope="col">등록 일시</th>
              </>
            )}
            {onVisibilityChange && (
              <th scope="col">
                <span className="sr-only">사진 관리</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {photos.map((photo) =>
            (() => {
              const rack = locations.racks.find(
                (item) => item.id === photo.rackId,
              );
              const point = points.find((item) => item.id === photo.pointId);
              const team = locations.teams.find(
                (item) => item.id === (photo.teamId ?? rack?.teamId),
              );
              const planTitle =
                plans.find((plan) => plan.id === photo.planId)?.title ||
                (photo.planId ? "계획 정보 확인 필요" : "계획 미지정");
              const selectableForRepair = eligiblePhotos.some(
                (eligible) => eligible.id === photo.id,
              );
              return (
                <tr
                  key={photo.id}
                  className="photo-clickable-row"
                  onClick={(event) => {
                    if (
                      (event.target as HTMLElement).closest(
                        "button, a, input, select, textarea",
                      )
                    )
                      return;
                    onSelect(photo);
                  }}
                >
                  {selectable && (
                    <td
                      className={compact ? "photo-select-cell" : undefined}
                      data-label={compact ? "보수 선택" : undefined}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${photo.name} 보수 작업 대상 선택`}
                        checked={selectedPhotoIds?.has(photo.id) ?? false}
                        disabled={!canWrite || !selectableForRepair}
                        onChange={() => { if (canWrite) onTogglePhoto?.(photo); }}
                        title={
                          !canWrite
                            ? "조회 권한에서는 보수 작업 대상을 선택할 수 없습니다."
                            : photo.visibility !== "visible"
                            ? "숨김 사진은 선택할 수 없습니다."
                            : photo.retake
                              ? "재촬영 결과를 확인한 뒤 보수 계획을 만들 수 있습니다."
                              : !selectableForRepair
                                ? "현재 보수 필요 등급이 아닙니다."
                                : undefined
                        }
                      />
                    </td>
                  )}
                  <td
                    className={compact ? "photo-image-cell" : undefined}
                    data-label={compact ? "검사 사진" : undefined}
                  >
                    <button
                      className={`photo-name${compact ? " photo-list-name" : ""}`}
                      type="button"
                      aria-label={`${photo.name} 상세 보기`}
                      onClick={() => onSelect(photo)}
                    >
                      {photo.visibility === "hidden" ? (
                        <span className="hidden-image">숨김</span>
                      ) : (
                        <img
                          src={`${apiBase}/api/inspections/${photo.id}/thumbnail`}
                          alt="검사 사진 축소 이미지"
                        />
                      )}
                      <span>{photo.name}</span>
                    </button>
                  </td>
                  {compact ? (
                    <>
                      <td className="photo-plan-cell" data-label="검사계획">
                        <b className="photo-plan-name">{planTitle}</b>
                      </td>
                      <td
                        className="photo-context-cell"
                        data-label="팀 · 랙 · 포인트"
                      >
                        <span>
                          {team?.name ?? "팀 미확인"} ·{" "}
                          {rack?.name ?? "랙 미확인"}
                        </span>
                        <small>
                          {point?.name ?? "포인트 미연결"} ·{" "}
                          {point?.equipment || "설비 미확인"}
                        </small>
                      </td>
                      <td
                        className="photo-reading-cell"
                        data-label="AI 판독 · 현재 분류"
                      >
                        <PhotoStatus photo={photo} />
                        <Grade photo={photo} />
                        {photo.humanGrade !== null &&
                          photo.humanGrade !== photo.ai?.grade && (
                            <small>
                              AI {photo.ai?.grade ?? "미판독"}등급에서 수정
                            </small>
                          )}
                      </td>
                      <td
                        className="photo-followup-cell"
                        data-label="후속 표시"
                      >
                        <div className="photo-followup-badges">
                          {photo.retake && (
                            <span className="badge amber">재촬영</span>
                          )}
                          {photo.labeling && (
                            <span className="badge muted">라벨링 후보</span>
                          )}
                          {!photo.retake && !photo.labeling && (
                            <span className="faint">—</span>
                          )}
                        </div>
                      </td>
                      <td className="photo-created-cell" data-label="등록">
                        {new Date(photo.createdAt).toLocaleString("ko-KR", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </>
                  ) : (
                    <>
                      <td>
                        <b className="photo-plan-name">{planTitle}</b>
                      </td>
                      <td>{team?.name ?? "팀 미확인"}</td>
                      <td>{rack?.name ?? "랙 미확인"}</td>
                      <td>
                        <span>{point?.name ?? "포인트 미연결"}</span>
                        <small>{point?.equipment || "설비 미확인"}</small>
                      </td>
                      <td>
                        <PhotoStatus photo={photo} />
                      </td>
                      <td>
                        <Grade photo={photo} />
                        {photo.humanGrade !== null &&
                          photo.humanGrade !== photo.ai?.grade && (
                            <small>
                              AI {photo.ai?.grade ?? "미판독"}등급에서 수정
                            </small>
                          )}
                      </td>
                      <td>
                        {photo.retake && (
                          <span className="badge amber">재촬영</span>
                        )}{" "}
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
                    </>
                  )}
                  {onVisibilityChange && (
                    <td
                      className={compact ? "photo-manage-cell" : undefined}
                      data-label={compact ? "사진 관리" : undefined}
                    >
                      <div className="photo-row-actions">
                        <button
                          type="button"
                          className="icon-button"
                          disabled={!canManageRecords}
                          aria-label={`${photo.name} ${photo.visibility === "hidden" ? "복원" : "숨기기"}`}
                          title={
                            !canManageRecords
                              ? "사진 숨김·복원은 관리자만 할 수 있습니다."
                              : photo.visibility === "hidden"
                                ? "사진 복원"
                                : "사진 숨기기"
                          }
                          onClick={() => { if (canManageRecords) onVisibilityChange(photo); }}
                        >
                          {photo.visibility === "hidden" ? (
                            <RotateCcw size={16} />
                          ) : (
                            <EyeOff size={16} />
                          )}
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })(),
          )}
        </tbody>
      </table>
    </div>
  );
}
function Modal({
  title,
  descriptionId,
  children,
  close,
  wide = false,
  onNavigate,
}: {
  title: string;
  descriptionId?: string;
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
        aria-describedby={descriptionId}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          if (onNavigate && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            const target = e.target as HTMLElement;
            if (
              !target.matches(
                "input, select, textarea, [contenteditable='true']",
              )
            ) {
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
            const activeElement = document.activeElement;
            if (
              e.shiftKey &&
              (activeElement === ref.current || activeElement === first)
            ) {
              e.preventDefault();
              last.focus();
            } else if (
              !e.shiftKey &&
              (activeElement === ref.current || activeElement === last)
            ) {
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
  plansUnavailable,
  context,
  close,
  viewPhotos,
  done,
  publicUploadsAllowed,
}: {
  publicUploadsAllowed: boolean;
  plansUnavailable: boolean;
  points: Point[];
  plans: Plan[];
  context: {
    plan: Plan;
    point?: Point;
    rackId?: string;
    files?: File[];
  } | null;
  close: () => void;
  viewPhotos: (plan: Plan, rackId?: string) => void;
  done: (s: string, tone?: ToastTone) => Promise<void>;
}) {
  const { can } = useAuth();
  const canWrite = can("work.write");
  const canWriteRef = useRef(canWrite);
  canWriteRef.current = canWrite;
  const [files, setFiles] = useState<File[]>(context?.files ?? []);
  const [planId, setPlanId] = useState(context?.plan.id || "");
  const [pointId, setPointId] = useState(context?.point?.id || "");
  const [rackId, setRackId] = useState(
    context?.rackId || context?.point?.rackId || "",
  );
  const [queue, setQueue] = useState<UploadEntry[]>([]);
  const queueOwner = useRef(getAuthUserId());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarning] = useState(false);
  const rows = useRef<UploadEntry[]>([]);
  const handles = useRef(new Map<string, File>());
  const activeTransferIds = useRef<string[]>([]);
  const alive = useRef(true);
  const operation = useRef<AbortController | null>(null);
  const selectedPlan =
    context?.plan.id === planId
      ? context.plan
      : plans.find((plan) => plan.id === planId);
  const lastStored = [...queue]
    .reverse()
    .find(
      (entry) =>
        entry.state === "stored" &&
        entry.planId === planId &&
        (!rackId || entry.rackId === rackId),
    );
  const storedPlan = lastStored ? selectedPlan : null;
  const knownPoints = points;
  const availablePoints = points.filter(
    (point) => point.rackId === rackId && point.recordPurpose === "inspection",
  );

  function saveQueue(next: UploadEntry[]) {
    if (!alive.current || queueOwner.current !== getAuthUserId()) {
      operation.current?.abort();
      return;
    }
    rows.current = next;
    setQueue(next);
    setStorageWarning(!persistUploadQueue(next, queueOwner.current));
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
    if (session.status === "finalizing") {
      if (!canWriteRef.current) return session;
      if (plansUnavailable || signal.aborted) {
        if (!signal.aborted)
          patch(entry.id, {
            state: "failed",
            error:
              "저장 완료 여부를 확인 중입니다. 계획 조회가 복구되면 다시 확인하세요.",
          });
      } else {
        session = await uploadRequest(
          `/${entry.id}/complete`,
          { method: "POST" },
          signal,
        );
      }
    }
    if (!signal.aborted && session.status !== "finalizing")
      applySession(entry.id, session);
    return session;
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    operation.current = controller;
    const saved = readUploadQueue(queueOwner.current);
    const stopOnAccountChange = () => {
      if (queueOwner.current === getAuthUserId()) return;
      alive.current = false;
      controller.abort();
      operation.current?.abort();
    };
    window.addEventListener("inspection-auth-owner-changed", stopOnAccountChange);
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
      window.removeEventListener("inspection-auth-owner-changed", stopOnAccountChange);
    };
    // Restore once; later prop refreshes must not restart an active transfer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!plansUnavailable) return;
    operation.current?.abort();
    operation.current = null;
    setBusy(false);
    for (const id of activeTransferIds.current) {
      const entry = rows.current.find((row) => row.id === id);
      if (!entry || entry.state === "stored") continue;
      patch(id, {
        state: "failed",
        error:
          "전송 응답이 중단됐습니다. 계획 조회가 복구되면 저장 상태를 확인하세요.",
      });
    }
    activeTransferIds.current = [];
  }, [plansUnavailable]);
  useEffect(() => {
    if (!canWrite) operation.current?.abort();
  }, [canWrite]);

  async function run(ids: string[], restart = false) {
    if (!canWrite || operation.current || plansUnavailable) return;
    const controller = new AbortController();
    operation.current = controller;
    activeTransferIds.current = ids;
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
      if (operation.current === controller) {
        operation.current = null;
        activeTransferIds.current = [];
        if (alive.current) setBusy(false);
      }
    }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canWrite || operation.current) return;
    setError("");
    if (plansUnavailable)
      return setError(
        "검사계획 목록을 확인할 수 없습니다. 조회가 복구된 뒤 사진을 전송하세요.",
      );
    if (!files.length) return setError("추가할 사진을 선택하세요.");
    if (!selectedPlan) return setError("사진을 추가할 검사계획을 선택하세요.");
    if (!rackId || !selectedPlan.rackIds.includes(rackId))
      return setError("사진이 속한 랙을 선택하세요.");
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
        rackId,
        batchId,
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
      if (!operation.current && alive.current) setBusy(false);
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
      if (operation.current === null && alive.current) setBusy(false);
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
        {plansUnavailable && (
          <p className="form-error" role="status">
            계획 조회 중에는 새 사진 전송과 이어 보내기를 잠급니다. 이미 전송
            중이던 요청은 중단하며, 조회 복구 후 저장 상태를 확인할 수 있습니다.
          </p>
        )}
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
            disabled={!canWrite || busy || plansUnavailable}
            onChange={(event) => {
              if (!canWrite || busy || plansUnavailable) return;
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
        <label className="field">
          검사계획
          <select
            required
            aria-label="업로드 검사계획"
            value={planId}
            disabled={!canWrite || busy || plansUnavailable}
            onChange={(event) => {
              if (!canWrite || busy || plansUnavailable) return;
              setPlanId(event.target.value);
              setRackId("");
              setPointId("");
            }}
          >
            <option value="">검사계획 선택</option>
            {plans
              .filter(
                (plan) =>
                  plan.recordPurpose === "inspection" &&
                  plan.visibility === "visible" &&
                  plan.status === "planned",
              )
              .map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.title} ·{" "}
                  {
                    locations.teams.find((team) => team.id === plan.teamId)
                      ?.name
                  }
                </option>
              ))}
          </select>
        </label>
        {selectedPlan && (
          <p className="form-intro">
            {locations.teams.find((team) => team.id === selectedPlan.teamId)
              ?.name ?? "생산팀 확인 필요"}{" "}
            · 계획의 랙 {selectedPlan.rackIds.length}개
          </p>
        )}
        <label className="field">
          이번 사진의 랙
          <select
            required
            aria-label="업로드 파이프랙"
            disabled={!canWrite || busy || plansUnavailable || !selectedPlan}
            value={rackId}
            onChange={(event) => {
              if (!canWrite || busy || plansUnavailable) return;
              setRackId(event.target.value);
              setPointId("");
            }}
          >
            <option value="">랙 선택</option>
            {locations.racks
              .filter((rack) => selectedPlan?.rackIds.includes(rack.id))
              .map((rack) => (
                <option key={rack.id} value={rack.id}>
                  {rack.name}
                </option>
              ))}
          </select>
          <small>
            선택한 사진은 이 랙에 각각 한 번 저장됩니다. 다른 랙 사진은 다음
            묶음으로 추가하세요.
          </small>
        </label>
        <details>
          <summary>기존 포인트 연결 (선택)</summary>
          <label className="field">
            연결할 포인트
            <select
              value={pointId}
              disabled={!canWrite || busy || !rackId}
              onChange={(event) => { if (canWrite && !busy) setPointId(event.target.value); }}
            >
              <option value="">포인트 없이 저장</option>
              {availablePoints.map((point) => (
                <option key={point.id} value={point.id}>
                  {pointName(point)}
                </option>
              ))}
            </select>
          </label>
        </details>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="button primary"
            disabled={!canWrite || busy || plansUnavailable || !files.length}
          >
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
                        disabled={!canWrite || busy || plansUnavailable}
                        onChange={(event) => {
                          if (!canWrite || busy || plansUnavailable) return;
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
                      disabled={
                        !canWrite ||
                        busy ||
                        plansUnavailable ||
                        !handles.current.has(entry.id)
                      }
                      onClick={() => void run([entry.id])}
                    >
                      이어서 전송
                    </button>
                    {entry.sha256 && (
                      <button
                        type="button"
                        className="button secondary"
                        disabled={
                          !canWrite ||
                          busy ||
                          plansUnavailable ||
                          !handles.current.has(entry.id)
                        }
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
            {storedPlan && (
              <button
                type="button"
                className="button primary"
                disabled={busy}
                onClick={() =>
                  viewPhotos(storedPlan, lastStored?.rackId ?? undefined)
                }
              >
                저장된 사진·판독 보기
              </button>
            )}
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
                !canWrite ||
                busy ||
                plansUnavailable ||
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
function PlanScopeEditor({
  teamId,
  rackIds,
  change,
  disabled = false,
  compact = false,
  lockTeam = false,
}: {
  teamId: string;
  rackIds: string[];
  change: (teamId: string, rackIds: string[]) => void;
  disabled?: boolean;
  compact?: boolean;
  lockTeam?: boolean;
}) {
  const { can } = useAuth();
  const canWrite = can("work.write");
  const update = (team: string, racks: string[]) => {
    if (canWrite && !disabled) change(team, racks);
  };
  const [rackEditOpen, setRackEditOpen] = useState(!compact && !rackIds.length);
  const racks = locations.racks.filter((rack) => rack.teamId === teamId);
  const selectedRacks = racks.filter((rack) => rackIds.includes(rack.id));
  return (
    <fieldset className="plan-scope-editor" disabled={!canWrite || disabled}>
      <legend>검사 범위</legend>
      <label className="field">
        생산팀
        <select
          required
          aria-label="계획 생산팀"
          value={teamId}
          disabled={lockTeam}
          onChange={(e) => update(e.target.value, [])}
        >
          <option value="">생산팀 선택</option>
          {locations.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>
      {teamId && (
        <>
          <p className="plan-selected-label">선택한 랙 {rackIds.length}개</p>
          <div className="plan-selected-racks">
            {selectedRacks.length ? (
              <>
                {selectedRacks.slice(0, 3).map((rack) => (
                  <span key={rack.id}>{rack.name}</span>
                ))}
                {selectedRacks.length > 3 && (
                  <span>외 {selectedRacks.length - 3}개</span>
                )}
              </>
            ) : (
              <span>랙을 선택하세요</span>
            )}
          </div>
          <details
            className="plan-rack-edit"
            open={rackEditOpen}
            onToggle={(e) => setRackEditOpen(e.currentTarget.open)}
          >
            <summary>랙 선택 수정 · 전체 30개 보기</summary>
            <div className="list-toolbar">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  update(
                    teamId,
                    racks.map((rack) => rack.id),
                  )
                }
              >
                전체 선택
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => update(teamId, [])}
              >
                전체 해제
              </button>
            </div>
            <div className="rack-checks">
              {racks.map((rack, index) => (
                <label
                  key={rack.id}
                  className={rackIds.includes(rack.id) ? "selected" : ""}
                >
                  <input
                    type="checkbox"
                    aria-label={`${rack.name} 선택`}
                    checked={rackIds.includes(rack.id)}
                    onChange={(e) =>
                      update(
                        teamId,
                        e.target.checked
                          ? [...new Set([...rackIds, rack.id])]
                          : rackIds.filter((id) => id !== rack.id),
                      )
                    }
                  />
                  <span>랙 {index + 1}</span>
                </label>
              ))}
            </div>
          </details>
        </>
      )}
    </fieldset>
  );
}
const planMemoSuggestions = [
  "보온재 이음부 확인",
  "누설 흔적 확인",
  "촬영 방향 기록",
];
function shortPlanDate(value: string) {
  return value
    ? `${value.slice(2, 4)}${value.slice(5, 7)}${value.slice(8, 10)}`
    : "";
}
function parsePlanDate(value: string) {
  if (!/^\d{6}$/.test(value)) return null;
  const year = 2000 + Number(value.slice(0, 2));
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    return null;
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
  const [dateText, setDateText] = useState(
    plan?.date ? shortPlanDate(plan.date) : "",
  );
  const [memo, setMemo] = useState(plan?.note ?? "");
  const isoDate = parsePlanDate(dateText);
  useEffect(() => {
    if (!plan && !titleEdited) setTitle(suggestion);
  }, [plan, suggestion, titleEdited]);
  return (
    <>
      <label className="field">
        계획 이름
        <input
          name="title"
          required
          maxLength={120}
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setTitleEdited(true);
          }}
        />
      </label>
      <div className="field">
        <label htmlFor={dateInputId}>검사 예정일</label>
        <span className="plan-date-row">
          <input
            id={dateInputId}
            name="dateText"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            required={!plan}
            maxLength={6}
            pattern="[0-9]{6}"
            placeholder="예: 261010"
            aria-describedby={dateHelpId}
            aria-invalid={dateText.length === 6 && !isoDate}
            value={dateText}
            onChange={(event) =>
              setDateText(event.target.value.replace(/\D/g, "").slice(0, 6))
            }
          />
          <input
            type="date"
            className="plan-calendar-picker"
            aria-label="달력에서 검사 예정일 선택"
            value={isoDate ?? ""}
            onChange={(event) => setDateText(shortPlanDate(event.target.value))}
          />
        </span>
        <small id={dateHelpId}>
          6자리 숫자로 입력하거나 달력에서 선택하세요.{" "}
          {isoDate && `선택 날짜: ${isoDate}`}
        </small>
        {dateText.length === 6 && !isoDate && (
          <small className="plan-date-error">존재하는 날짜를 입력하세요.</small>
        )}
      </div>
      <label className="field">
        메모
        <textarea
          name="note"
          rows={2}
          maxLength={1000}
          value={memo}
          onChange={(event) => setMemo(event.target.value)}
          placeholder="촬영 조건이나 확인할 사항"
        />
      </label>
      <div className="plan-memo-suggestions" role="group" aria-label="메모 빠른 입력">
        {planMemoSuggestions.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() =>
              setMemo((current) =>
                current.includes(example)
                  ? current
                  : [current.trim(), example]
                      .filter(Boolean)
                      .join("\n")
                      .slice(0, 1000),
              )
            }
          >
            {example} +
          </button>
        ))}
      </div>
    </>
  );
}
function PlanDialog({
  plansUnavailable,
  initialTeamId,
  initialRackIds,
  close,
  done,
  created,
}: {
  plansUnavailable: boolean;
  initialTeamId: string;
  initialRackIds: string[];
  close: () => void;
  done: (s: string) => Promise<void>;
  created: (plan: Plan) => void;
}) {
  const { can } = useAuth();
  const canWrite = can("work.write");
  const [teamId, setTeamId] = useState(initialTeamId);
  const [rackIds, setRackIds] = useState<string[]>(initialRackIds);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false);
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title="검사계획 만들기" close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!canWrite || lock.current || plansUnavailable) return;
          if (!rackIds.length)
            return setError("검사할 랙을 하나 이상 선택하세요.");
          lock.current = true;
          setBusy(true);
          setError("");
          const data = new FormData(event.currentTarget);
          const date = parsePlanDate(String(data.get("dateText") ?? ""));
          if (!date) {
            lock.current = false;
            setBusy(false);
            return setError("검사 예정일을 6자리의 실제 날짜로 입력하세요.");
          }
          try {
            const plan = await api<Plan>("/plans", {
              method: "POST",
              body: JSON.stringify({
                title: data.get("title"),
                date,
                note: data.get("note"),
                teamId,
                rackIds,
                pointIds: [],
              }),
            });
            await complete(
              "검사계획을 저장했습니다. 이제 이 계획에 사진을 추가하세요.",
              () => created(plan),
            );
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            lock.current = false;
            setBusy(false);
          }
        }}
      >
        {plansUnavailable && (
          <p className="form-error" role="status">
            계획 목록을 확인한 뒤 저장할 수 있습니다.
          </p>
        )}
        <fieldset
          disabled={!canWrite || busy || plansUnavailable}
          style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
        >
          <PlanFields teamId={teamId} />
          <PlanScopeEditor
            teamId={teamId}
            rackIds={rackIds}
            change={(team, racks) => {
              setTeamId(team);
              setRackIds(racks);
            }}
            disabled={!canWrite || busy || plansUnavailable}
            compact={initialRackIds.length > 0}
            lockTeam={Boolean(initialTeamId && initialRackIds.length)}
          />
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={close}>
            취소
          </button>
          <button
            className="button primary"
            disabled={!canWrite || busy || plansUnavailable || !teamId || !rackIds.length}
          >
            {busy
              ? "저장 중…"
              : plansUnavailable
                ? "목록 확인 후 저장"
                : "계획 저장"}
          </button>
        </div>
      </form>
    </Modal>
  );
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

function PlanManagementDialog({
  initialPlan,
  readOnly,
  close,
  done,
  reportHistoryError,
}: {
  initialPlan: Plan;
  readOnly: boolean;
  close: () => void;
  done: (message: string) => Promise<void>;
  reportHistoryError: (message: string) => void;
}) {
  const { session, can } = useAuth();
  const canWrite = can("work.write"), canManageRecords = can("records.manage");
  const sessionActor = session?.authenticated ? session.user?.displayName : null;
  const plan = initialPlan;
  const [teamId, setTeamId] = useState(plan.teamId ?? ""),
    [rackIds, setRackIds] = useState(plan.rackIds);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const lock = useRef(false),
    history = useAuditHistory(`/plans/${plan.id}/history`, reportHistoryError);
  const complete = useDialogCompletion(done, close);
  const savePlan = async (
    action: "edit" | Plan["status"] | "visibility",
    data: FormData,
  ) => {
    if (!canWrite || lock.current || readOnly) return;
    if (action === "visibility" && !canManageRecords) return;
    const dateText = String(data.get("dateText") ?? "");
    const date = action === "edit" ? parsePlanDate(dateText) : null;
    if (action === "edit" && (dateText || plan.date) && !date)
      return setError("검사 예정일을 6자리의 실제 날짜로 입력하세요.");
    const patch =
      action === "edit"
        ? {
            title: data.get("title"),
            ...(date ? { date } : {}),
            note: data.get("note"),
            teamId,
            rackIds,
          }
        : action === "visibility"
          ? { visibility: plan.visibility === "hidden" ? "visible" : "hidden" }
          : { status: action };
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await api(`/plans/${plan.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...patch,
          expectedVersion: plan.editVersion,
          actor: sessionActor ?? data.get("actor"),
          reason: data.get("reason"),
        }),
      });
      await complete(
        action === "visibility"
          ? plan.visibility === "hidden"
            ? "계획을 복원했습니다. 기존 진행 상태는 유지됩니다."
            : "계획을 삭제했습니다. 사진·보수·이력은 보존되며 복원할 수 있습니다."
          : action === "edit"
            ? "계획 정보를 저장했습니다."
            : action === "planned"
              ? "계획을 재개했습니다. 사진을 추가할 수 있습니다."
              : action === "done"
                ? "검사계획을 완료로 기록했습니다."
                : "검사계획을 취소했습니다.",
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal title="계획 관리" close={close}>
      <div className="plan-manage-summary">
        <span className={`badge ${plan.status === "done" ? "green" : "muted"}`}>
          {plan.visibility === "hidden"
            ? "삭제됨"
            : plan.status === "planned"
              ? "진행 중"
              : plan.status === "done"
                ? "완료"
                : "취소"}
        </span>
        <h3>{plan.title}</h3>
        <p>
          {locations.teams.find((team) => team.id === plan.teamId)?.name ??
            "생산팀 미확인"}{" "}
          · {plan.date || "예정일 미지정"} · {planRackSummary(plan.rackIds)}
        </p>
      </div>
      {readOnly && (
        <p className="form-error" role="status">
          계획 목록을 확인할 때까지 변경 기능은 잠겨 있습니다.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {plan.visibility === "visible" && (
        <details className="plan-edit-details">
          <summary>계획 정보 수정</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void savePlan("edit", new FormData(event.currentTarget));
            }}
          >
            <fieldset
              disabled={!canWrite || busy || readOnly}
              style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
            >
              <PlanFields plan={plan} teamId={teamId} />
              <PlanScopeEditor
                teamId={teamId}
                rackIds={rackIds}
                change={(team, racks) => {
                  setTeamId(team);
                  setRackIds(racks);
                }}
                disabled={!canWrite || busy || readOnly}
                lockTeam={Boolean(plan.teamId)}
              />
              {plan.pointIds.length > 0 && (
                <details>
                  <summary>기존 위치 관계 {plan.pointIds.length}개</summary>
                  <p>
                    연결된 포인트와 사진의 원래 위치는 유지됩니다. 사용 중인
                    랙을 제외하려면 관련 기록을 먼저 확인하세요.
                  </p>
                </details>
              )}
              <label className="field">
                수정자
                <input
                  name="actor"
                  required
                  maxLength={60}
                  defaultValue={sessionActor ?? "현업 엔지니어"}
                  readOnly={Boolean(session?.authenticated)}
                />
              </label>
              <label className="field">
                변경 사유
                <textarea name="reason" required maxLength={1000} rows={2} />
              </label>
              <div className="form-actions">
                <button
                  className="button primary"
                  disabled={!teamId || !rackIds.length}
                >
                  변경 저장
                </button>
              </div>
            </fieldset>
          </form>
        </details>
      )}
      <details className="plan-edit-details plan-status-details">
        <summary>계획 상태 변경</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const action = (
              event.nativeEvent as SubmitEvent
            ).submitter?.getAttribute("value") as
              Plan["status"] | "visibility" | null;
            if (action)
              void savePlan(action, new FormData(event.currentTarget));
          }}
        >
          <p>
            현재 상태:{" "}
            {plan.visibility === "hidden"
              ? "삭제됨"
              : plan.status === "planned"
                ? "진행 중"
                : plan.status === "done"
                  ? "완료"
                  : "취소"}
          </p>
          <fieldset
            disabled={!canWrite || busy || readOnly}
            style={{ border: 0, margin: 0, minWidth: 0, padding: 0 }}
          >
            <label className="field">
              처리자
              <input
                name="actor"
                required
                maxLength={60}
                defaultValue={sessionActor ?? "현업 엔지니어"}
                readOnly={Boolean(session?.authenticated)}
              />
            </label>
            <label className="field">
              변경 사유
              <textarea name="reason" required maxLength={1000} rows={2} />
            </label>
            <div className="form-actions">
              {plan.visibility === "visible" &&
                (plan.status === "planned" ? (
                  <>
                    <button
                      value="done"
                      className="button secondary"
                      disabled={busy}
                    >
                      검사계획 완료
                    </button>
                    <button
                      value="cancelled"
                      className="button secondary"
                      disabled={busy}
                    >
                      계획 취소
                    </button>
                  </>
                ) : (
                  <button
                    value="planned"
                    className="button secondary"
                    disabled={busy}
                  >
                    계획 재개
                  </button>
                ))}
              <button
                value="visibility"
                className="button secondary"
                disabled={!canManageRecords || busy}
                title={!canManageRecords ? "계획 삭제·복원은 관리자만 할 수 있습니다." : undefined}
              >
                {plan.visibility === "hidden" ? "계획 복원" : "계획 삭제"}
              </button>
            </div>
          </fieldset>
        </form>
      </details>
      <AuditList history={history} />
    </Modal>
  );
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
    ta: "TA 작업 포함",
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
      none: "등록 전",
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
  const { session, can } = useAuth();
  const canWrite = can("work.write");
  const sessionActor = session?.authenticated ? session.user?.displayName : null;
  const { photo, error: readError } = usePhotoRecord(seed);
  const [initial] = useState(seed);
  const [savedJudgment, setSavedJudgment] = useState({
    humanGrade: initial.humanGrade,
    retake: initial.retake,
    retakeReason: initial.retakeReason,
    labeling: initial.labeling,
  });
  const [humanGrade, setHumanGrade] = useState<number | null>(
    initial.humanGrade,
  );
  const [retake, setRetake] = useState(initial.retake);
  const [reason, setReason] = useState(initial.retakeReason);
  const [labeling, setLabeling] = useState(initial.labeling);
  const [editVersion, setEditVersion] = useState(initial.editVersion);
  const [busy, setBusy] = useState(false);
  const actionLock = useRef(false);
  const begin = () => {
    if (!canWrite || actionLock.current) return false;
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
  const effectiveHumanGrade =
    humanGrade !== null && humanGrade === photo.ai?.grade ? null : humanGrade;
  const effectiveSavedHumanGrade =
    savedJudgment.humanGrade !== null &&
    savedJudgment.humanGrade === photo.ai?.grade
      ? null
      : savedJudgment.humanGrade;
  const humanGradeDirty = effectiveHumanGrade !== effectiveSavedHumanGrade;
  const judgmentDirty =
    humanGradeDirty ||
    retake !== savedJudgment.retake ||
    (retake && reason.trim() !== savedJudgment.retakeReason.trim());
  const humanCorrection =
    !retake &&
    effectiveHumanGrade !== null &&
    photo.ai !== null &&
    effectiveHumanGrade !== photo.ai.grade;
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
          actor: sessionActor ?? "현업 엔지니어",
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
          actor: sessionActor ?? "현업 엔지니어",
          reason: next
            ? "학습 라벨링 후보로 지정"
            : "학습 라벨링 후보에서 해제",
        }),
      });
      setEditVersion(updated.editVersion);
      setLabeling(updated.labeling);
      setSavedJudgment((current) => ({
        ...current,
        labeling: updated.labeling,
      }));
      await done(
        next
          ? "학습 라벨링 후보로 지정했습니다."
          : "학습 라벨링 후보에서 해제했습니다.",
      );
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
      onNavigate={
        onNavigate
          ? (direction) => {
              if (!judgmentDirty && !busy && !retakePlanPrompt)
                onNavigate(direction);
            }
          : undefined
      }
    >
      {readError && (
        <p className="form-error" role="alert">
          사진 상태 조회 실패: {readError} · 마지막 조회 결과입니다.
        </p>
      )}
      <div className="detail-grid photo-review-grid">
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
            {onNavigate && (
              <>
                <button
                  type="button"
                  className="photo-image-nav photo-image-nav-previous"
                  aria-label="이전 사진"
                  title="이전 사진 · ←"
                  disabled={
                    !canNavigatePrevious ||
                    judgmentDirty ||
                    busy ||
                    retakePlanPrompt
                  }
                  onClick={() => onNavigate(-1)}
                >
                  <ChevronLeft size={23} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="photo-image-nav photo-image-nav-next"
                  aria-label="다음 사진"
                  title="다음 사진 · →"
                  disabled={
                    !canNavigateNext ||
                    judgmentDirty ||
                    busy ||
                    retakePlanPrompt
                  }
                  onClick={() => onNavigate(1)}
                >
                  <ChevronRight size={23} aria-hidden="true" />
                </button>
              </>
            )}
          </div>
          <div className="image-caption">{photo.name}</div>
        </div>
        <form
          className="photo-judgment-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canWrite || !judgmentDirty) return;
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
            <span
              className="photo-grade-help"
              tabIndex={0}
              aria-label="등급 안내"
              aria-describedby="photo-grade-help-text"
            >
              <CircleHelp size={19} aria-hidden="true" />
              <span
                id="photo-grade-help-text"
                className="photo-grade-tooltip"
                role="tooltip"
              >
                등급은 사진에서 보이는 부식 분류입니다. 설비 안전성이나 실제
                보수 지시를 확정하지 않습니다.
              </span>
            </span>
            {photo.error && (
              <p className="form-error" role="alert">
                {photo.error}
              </p>
            )}
            {photo.status === "error" && (
              <button
                type="button"
                className="button secondary"
                disabled={!canWrite || busy}
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
          </section>
          <label className="field photo-human-grade">
            사람 판정
            <select
              name="grade"
              value={retake ? "retake" : (effectiveHumanGrade ?? "")}
              disabled={!canWrite || busy}
              onChange={(event) => {
                if (!canWrite || busy) return;
                const value = event.target.value;
                setRetake(value === "retake");
                setHumanGrade(
                  value && value !== "retake" ? Number(value) : null,
                );
              }}
            >
              <option value="">
                {photo.ai
                  ? `AI 결과 사용 · ${photo.ai.grade}등급 · ${photo.ai.grade >= 3 ? "보수 필요" : "보수 불필요"}`
                  : "등급 미지정"}
              </option>
              <option value="retake">재촬영 필요</option>
              {[1, 2, 3, 4, 5].map((grade) =>
                grade === photo.ai?.grade ? null : (
                  <option key={grade} value={grade}>
                    {grade}등급 · {grade >= 3 ? "보수 필요" : "보수 불필요"}
                  </option>
                ),
              )}
            </select>
          </label>
          <button
            type="button"
            className={`photo-labeling-toggle${labeling ? " is-selected" : ""}${humanGradeDirty ? " has-pending-change" : ""}${humanCorrection && !labeling ? " is-recommended" : ""}`}
            aria-pressed={labeling}
            disabled={!canWrite || busy}
            onClick={() => void toggleLabeling()}
          >
            <CloudUpload size={18} aria-hidden="true" />
            <span>
              {labeling ? "학습 후보에서 해제" : "학습 라벨링 후보로 지정"}
            </span>
            {labeling && <Check size={17} aria-hidden="true" />}
          </button>
          <label className="field photo-judgment-reason">
            {retake ? "재촬영 사유" : "판정 수정 사유"}
            <textarea
              name="reason"
              required={judgmentDirty}
              value={reason}
              disabled={!canWrite || busy}
              onChange={(event) => { if (canWrite && !busy) setReason(event.target.value); }}
              maxLength={1000}
              rows={3}
              placeholder={
                retake
                  ? "예: 사진 흔들림으로 재촬영"
                  : "예: 부식이 보여 4등급으로 수정"
              }
            />
            {judgmentDirty && !reason.trim() && (
              <small>사유를 입력하면 저장할 수 있습니다.</small>
            )}
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="photo-save-footer">
            {retakePlanPrompt ? (
              <section
                className="retake-plan-prompt"
                role="alertdialog"
                aria-labelledby="retake-plan-title"
              >
                <h3 id="retake-plan-title">새 재촬영 계획을 만들까요?</h3>
                <p>
                  판독 내용을 저장한 뒤 같은 생산팀·랙으로 검사계획 만들기를
                  엽니다.
                </p>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!canWrite || busy}
                    onClick={() => void saveJudgment(false)}
                  >
                    판독 변경만 저장
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    disabled={!canWrite || busy || !reason.trim()}
                    onClick={() => void saveJudgment(true)}
                  >
                    {busy ? "저장 중…" : "저장 후 새 계획 만들기"}
                  </button>
                </div>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setRetakePlanPrompt(false)}
                >
                  취소
                </button>
              </section>
            ) : (
              <button
                className={`button ${judgmentDirty ? "primary" : "secondary"} full-width photo-save-button`}
                disabled={!canWrite || busy || !judgmentDirty || !reason.trim()}
              >
                {busy
                  ? "저장 중…"
                  : judgmentDirty
                    ? "변경 사항 저장"
                    : "저장할 변경 사항 없음"}
              </button>
            )}
          </div>
        </form>
      </div>
      <RoiPanel
        key={`${photo.id}/${photo.sha256}/${photo.visibility}`}
        photo={photo}
      />
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
  const { session, can } = useAuth();
  const canWrite = can("work.write");
  const sessionActor = session?.authenticated ? session.user?.displayName : null;
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
          onChangeCapture={() => { if (canWrite) setMetadataDirty(true); }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!canWrite || busy) return;
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
                  actor: sessionActor ?? form.get("actor"),
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
                disabled={!canWrite || busy}
                defaultValue={initial.equipment}
                maxLength={120}
              />
            </label>
            <label className="field">
              랙 번호
              <input
                name="rack"
                disabled={!canWrite || busy}
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
            <input name="name" disabled={!canWrite || busy} defaultValue={initial.name} maxLength={120} />
          </label>
          <div className="divider" />
          <label className="field">
            수정자
            <input
              name="actor"
              disabled={!canWrite || busy}
              required
              maxLength={60}
              defaultValue={sessionActor ?? "현업 엔지니어"}
              readOnly={Boolean(session?.authenticated)}
            />
          </label>
          <label className="field">
            변경 사유
            <textarea
              name="reason"
              disabled={!canWrite || busy}
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
          <button className="button primary full-width" disabled={!canWrite || busy}>
            {busy ? "저장 중…" : "기본 정보·이력 저장"}
          </button>
        </form>
      </div>
    </Modal>
  );
}
