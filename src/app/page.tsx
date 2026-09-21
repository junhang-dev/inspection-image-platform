"use client";
import demoAllowlist from "@/lib/demo-allowlist.json";
import { conceptPosition, visibleMapPoints } from "@/lib/concept-map";
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
  equipment: string;
  rack: string;
  name: string;
  repairStatus: "none" | "review" | "progress" | "done";
  managed: boolean;
  ta: boolean;
};
type Photo = {
  id: string;
  name: string;
  pointId: string | null;
  status: "pending" | "processing" | "done" | "error";
  ai: {
    grade: number;
    confidence: number;
    model_version: string;
    preprocessing_version: string;
  } | null;
  humanGrade: number | null;
  retake: boolean;
  retakeReason: string;
  labeling: boolean;
  error: string | null;
  createdAt: string;
};
type Plan = {
  id: string;
  title: string;
  date: string;
  pointId: string | null;
  note: string;
  status: "planned" | "done" | "cancelled";
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
  publicUploadsAllowed: boolean;
  demoMode: boolean;
  ready: boolean;
  model: { ready: boolean };
};
type Tab = "dashboard" | "plans" | "photos" | "points" | "worklist" | "labels";
type ToastTone = "success" | "error" | "info";
type Toast = { tone: ToastTone; message: string };
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const publicDemo = process.env.NEXT_PUBLIC_DEMO_ONLY === "1";
const publicUploads = process.env.NEXT_PUBLIC_PUBLIC_UPLOADS_ALLOWED === "1";
const statusName = {
  none: "미지정",
  review: "보수 검토",
  progress: "보수 진행",
  done: "보수 완료",
};
const nav = [
  { id: "dashboard", label: "대시보드", icon: LayoutDashboard },
  { id: "plans", label: "검사 계획", icon: CalendarDays },
  { id: "photos", label: "사진·판독", icon: Camera },
  { id: "points", label: "포인트 관리", icon: Box },
  { id: "worklist", label: "관리·TA 워크리스트", icon: FolderKanban },
  { id: "labels", label: "라벨링 후보", icon: Tag },
] as const;
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return requestJson<T>(`${apiBase}/api${path}`, options);
}
const pointName = (point?: Point) =>
  point
    ? [
        point.equipment || "설비 미확인",
        point.rack && `${point.rack} 랙`,
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
  return async (message: string) => {
    if (!active.current) return;
    await done(message);
    if (active.current) close();
  };
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [points, setPoints] = useState<Point[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [detail, setDetail] = useState<Photo | null>(null);
  const [pointDetail, setPointDetail] = useState<Point | null>(null);
  const [planHistory, setPlanHistory] = useState<{
    title: string;
    events: Audit[];
  } | null>(null);
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const [mapPoint, setMapPoint] = useState("");
  const selectedMapPoint = points.find((point) => point.id === mapPoint);
  const displayedMapPoints = visibleMapPoints(points, mapPoint);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const [p, s, c, h] = await Promise.all([
        api<Photo[]>("/inspections"),
        api<Point[]>("/points"),
        api<Plan[]>("/plans"),
        api<Health>("/health"),
      ]);
      setPhotos(p);
      setPoints(s);
      setPlans(c);
      setHealth(h);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Mac API 연결을 확인하세요.",
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
  const active = photos.filter((p) => (gradeOf(p) || 0) >= 3);
  const pending = photos.filter((p) =>
    ["pending", "processing"].includes(p.status),
  );
  const retakes = photos.filter((p) => p.retake);
  const visible = photos
    .filter((p) =>
      `${p.name} ${pointName(points.find((x) => x.id === p.pointId))}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .filter((p) => tab !== "labels" || p.labeling)
    .filter(
      (p) =>
        filter === "all" ||
        (filter === "repair"
          ? (gradeOf(p) || 0) >= 3
          : filter === "retake"
            ? p.retake
            : p.status === filter),
    );
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
    setQuery("");
    setFilter("all");
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="InspectLoop 대시보드">
          <span className="brand-mark">
            <Layers3 size={25} />
          </span>
          <span>
            InspectLoop<small>검사 이미지 플랫폼</small>
          </span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">I</span>
          <div>
            검사 운영 워크스페이스<small>로컬 프로토타입</small>
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
              {id === "labels" &&
                photos.filter((p) => p.labeling).length > 0 && (
                  <b>{photos.filter((p) => p.labeling).length}</b>
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage-note">
            <ShieldCheck size={20} />
            <div>
              사진은 로컬에 보관<small>Mac · MySQL · MinIO</small>
            </div>
            <i className={health?.ready ? "dot" : "dot offline"} />
          </div>
          <div className="user">
            <span>J</span>
            <div>
              현업 엔지니어<small>로컬 작업자</small>
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
              {health?.ready ? "로컬 시스템 연결됨" : "연결 확인 중"}
            </span>
            <button
              className="icon-button"
              onClick={refresh}
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
              <div className="eyebrow">INSPECTION WORKSPACE</div>
              <h1>{tab === "dashboard" ? "검사 현황을 한눈에" : pageTitle}</h1>
              <p>
                {tab === "dashboard"
                  ? "사진 판독부터 후속 조치까지, 오늘의 검사 업무를 이어가세요."
                  : tab === "plans"
                    ? "다가오는 검사를 계획하고 포인트의 후속 관리로 연결하세요."
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
                검사 계획
              </button>
              <button
                className="button primary"
                onClick={() => setUploadOpen(true)}
              >
                <Plus size={18} />
                사진 업로드
              </button>
            </div>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <Activity size={18} />
              <span>
                로컬 API에 연결하지 못했습니다. API와 저장소 실행 상태를 확인한
                뒤 새로고침하세요. <small>{error}</small>
              </span>
              <button onClick={refresh}>다시 연결</button>
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
          <div className="notice">
            <ShieldCheck size={17} />
            <span>
              연결 모델의 최종 test 정확도 60% · 목표 70% 미달. 사진 판독 기능과
              모델 성능은 별도로 검증하며, 사람의 후속 판단을 함께 기록하세요.
            </span>
          </div>
          {tab === "dashboard" && (
            <>
              <div className="stats-grid">
                {[
                  {
                    name: "전체 검사 사진",
                    value: photos.length,
                    note: "로컬에 저장된 원본",
                    icon: Camera,
                    color: "teal",
                  },
                  {
                    name: "보수 필요 분류",
                    value: active.length,
                    note: "시각적 3~5등급",
                    icon: Wrench,
                    color: "orange",
                  },
                  {
                    name: "AI 판독 대기·진행",
                    value: pending.length,
                    note: "백그라운드 처리",
                    icon: Clock3,
                    color: "blue",
                  },
                  {
                    name: "재촬영 필요",
                    value: retakes.length,
                    note: "사유 확인 후 후속 관리",
                    icon: RefreshCw,
                    color: "purple",
                  },
                ].map(({ name, value, note, icon: Icon, color }) => (
                  <div className="stat-card" key={name}>
                    <span className={`stat-icon ${color}`}>
                      <Icon size={20} />
                    </span>
                    <p>{name}</p>
                    <strong>
                      {health?.ready ? value : "—"}
                      <small>{health?.ready ? "장" : "미조회"}</small>
                    </strong>
                    <span className="stat-note">{note}</span>
                  </div>
                ))}
              </div>
              <div className="dashboard-grid">
                <section className="panel map-panel">
                  <div className="panel-title">
                    <div>
                      <h2>
                        검사 포인트 맵{" "}
                        <span className="badge muted">예시 3D</span>
                      </h2>
                      <p>설비·랙별 모형 위치입니다. 실제 좌표가 아닙니다.</p>
                    </div>
                    <select
                      aria-label="맵 포인트 선택"
                      value={mapPoint}
                      onChange={(e) => setMapPoint(e.target.value)}
                    >
                      <option value="">전체 포인트</option>
                      {points.map((p) => (
                        <option value={p.id} key={p.id}>
                          {pointName(p)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="map-stage">
                    <div className="map-grid" />
                    <svg
                      viewBox="0 0 760 340"
                      role="group"
                      aria-label="실제 좌표와 무관한 검사 포인트 예시 3D 설비"
                    >
                      <defs>
                        <linearGradient id="tank" x1="0" x2="1">
                          <stop stopColor="#bdcecf" />
                          <stop offset="0.55" stopColor="#eef5f5" />
                          <stop offset="1" stopColor="#b3c7c9" />
                        </linearGradient>
                      </defs>
                      <g transform="translate(75 20)">
                        <path
                          d="M10 235 325 320 650 178 337 95Z"
                          fill="#e2ecea"
                          stroke="#ccdcd8"
                        />
                        {[0, 1, 2].map((n) => (
                          <g
                            key={n}
                            transform={`translate(${n * 100} ${n * 25})`}
                          >
                            <path
                              d="M180 76 246 94 247 194 180 178Z"
                              fill="#a6bdbb"
                            />
                            <path
                              d="M246 94 430 19 432 120 247 194Z"
                              fill="#d1dfdb"
                            />
                            <path
                              d="M180 76 365 1 430 19 246 94Z"
                              fill="#f0f5f2"
                            />
                            {[0, 1, 2, 3, 4].map((x) => (
                              <path
                                key={x}
                                d={`M${259 + x * 33} ${99 - x * 13}v82`}
                                stroke="#9eb7b1"
                                strokeWidth="3"
                              />
                            ))}
                            <path
                              d="M247 127 432 53M247 160 432 86"
                              stroke="#9ab2ad"
                              strokeWidth="3"
                            />
                          </g>
                        ))}
                        {[0, 1, 2].map((n) => (
                          <g
                            key={n}
                            transform={`translate(${63 + n * 64} ${145 + n * 17})`}
                          >
                            <path
                              d="M0 0v71c0 25 58 25 58 0V0"
                              fill="url(#tank)"
                              stroke="#b0c3c2"
                            />
                            <ellipse
                              cx="29"
                              cy="0"
                              rx="29"
                              ry="13"
                              fill="#eef3f2"
                              stroke="#b0c3c2"
                            />
                            <path
                              d="M18 15v55"
                              stroke="#f9fcfa"
                              strokeWidth="3"
                            />
                          </g>
                        ))}
                        <path
                          d="M70 246 70 204 258 252 389 199"
                          fill="none"
                          stroke="#91afaa"
                          strokeWidth="9"
                        />
                        <path
                          d="M70 246 70 204 258 252 389 199"
                          fill="none"
                          stroke="#d8e7e1"
                          strokeWidth="4"
                        />
                        {displayedMapPoints.map((point) => (
                          <g
                            key={point.id}
                            role="button"
                            tabIndex={0}
                            aria-label={`${pointName(point)} 상세 보기`}
                            onClick={() => {
                              setMapPoint(point.id);
                              void selectPoint(point);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setMapPoint(point.id);
                                void selectPoint(point);
                              }
                            }}
                            style={{ cursor: "pointer" }}
                            transform={`translate(${conceptPosition(point)!.x} ${conceptPosition(point)!.y})`}
                          >
                            <title>{pointName(point)} · 개념 위치</title>
                            <circle
                              r={mapPoint === point.id ? 18 : 13}
                              fill="#1a7c65"
                              opacity="0.15"
                            />
                            <circle
                              r="7"
                              fill={
                                point.repairStatus === "done"
                                  ? "#48897c"
                                  : "#ef9b45"
                              }
                              stroke="white"
                              strokeWidth="3"
                            />
                            <text
                              x="11"
                              y="-12"
                              fontSize="10"
                              fill="#244b42"
                              stroke="white"
                              strokeWidth="3"
                              paintOrder="stroke"
                            >
                              {point.equipment} · {point.rack} 랙
                            </text>
                          </g>
                        ))}
                      </g>
                    </svg>
                    <span className="map-corner">
                      <Box size={14} />
                      DUMMY 3D · 실제 공간 좌표 아님
                    </span>
                    <div className="map-legend">
                      <i />
                      표시 {displayedMapPoints.length}개 / 등록 {points.length}
                      개 · 선택으로 개별 조회
                    </div>
                  </div>
                  <div className="map-footer">
                    <MapPin size={16} />
                    <span>
                      {selectedMapPoint
                        ? `${pointName(selectedMapPoint)}${conceptPosition(selectedMapPoint) ? " · 모형 위치" : " · 설비·랙 위치 미확인"}`
                        : "최대 12개를 표시합니다. 설비·랙 미확인은 배치하지 않습니다."}
                    </span>
                    <button
                      onClick={() =>
                        selectedMapPoint
                          ? void selectPoint(selectedMapPoint)
                          : go("points")
                      }
                    >
                      {selectedMapPoint ? "선택 포인트 보기" : "포인트 보기"}{" "}
                      <ArrowRight size={14} />
                    </button>
                  </div>
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
                    {plans
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
                            <b>{p.title}</b>
                            <small>
                              {pointName(
                                points.find((x) => x.id === p.pointId),
                              )}
                            </small>
                            <span className="badge green">검사 예정</span>
                          </div>
                        </div>
                      ))}
                    {plans.filter((p) => p.status === "planned").length ===
                      0 && (
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
                    검사 캘린더 열기 <ArrowRight size={16} />
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
                    onSelect={selectPhoto}
                  />
                ) : (
                  <Empty
                    text={
                      error
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
                <div className="search-field">
                  <Search size={17} />
                  <input
                    aria-label="사진 검색"
                    placeholder="사진명, 설비, 포인트 검색"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <select
                  aria-label="판독 상태 필터"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">전체 상태</option>
                  <option value="repair">보수 필요</option>
                  <option value="pending">판독 대기</option>
                  <option value="error">판독 실패</option>
                  <option value="retake">재촬영 필요</option>
                </select>
                <span>{visible.length}장</span>
              </div>
              {visible.length ? (
                <PhotoTable
                  photos={visible}
                  points={points}
                  onSelect={selectPhoto}
                />
              ) : (
                <Empty
                  text={
                    tab === "labels"
                      ? "지정된 라벨링 후보가 없습니다. 사진 상세에서 지정할 수 있습니다."
                      : "표시할 사진이 없습니다. 업로드하거나 검색 조건을 바꿔 보세요."
                  }
                />
              )}
            </section>
          )}
          {(tab === "points" || tab === "worklist") && (
            <>
              <div className="section-hint">
                <MapPin size={17} />
                <span>
                  {tab === "points"
                    ? "사진 업로드 시 설비·랙·포인트를 등록합니다. 카드를 열어 상태와 사유를 기록하세요."
                    : "포인트 상세에서 관리 대상·TA 워크리스트 포함을 선택하세요."}
                </span>
              </div>
              <div className="point-grid">
                {points
                  .filter((p) => tab === "points" || p.managed || p.ta)
                  .map((p) => (
                    <button
                      className="point-card"
                      key={p.id}
                      onClick={() => selectPoint(p)}
                    >
                      <div>
                        <span className="point-icon">
                          <Box size={21} />
                        </span>
                        <span
                          className={`badge ${p.repairStatus === "done" ? "green" : "muted"}`}
                        >
                          {statusName[p.repairStatus]}
                        </span>
                      </div>
                      <h3>{p.equipment || "설비 미확인"}</h3>
                      <p>
                        {p.rack ? `${p.rack} 랙` : "랙 미확인"} ·{" "}
                        {p.name || "포인트 미확인"}
                      </p>
                      <div className="point-meta">
                        <span>
                          <Camera size={14} />
                          {photos.filter((x) => x.pointId === p.id).length}장
                        </span>
                        {p.managed && <span>관리 대상</span>}
                        {p.ta && <span className="teal-text">TA 포함</span>}
                        <ArrowRight size={15} />
                      </div>
                    </button>
                  ))}
              </div>
              {!points.filter((p) => tab === "points" || p.managed || p.ta)
                .length && (
                <section className="panel">
                  <Empty text="등록된 항목이 없습니다. 사진을 포인트에 연결해 업무를 시작하세요." />
                </section>
              )}
            </>
          )}
          {tab === "plans" && (
            <section className="panel">
              <div className="panel-title">
                <div className="month-nav">
                  <button
                    className="icon-button"
                    aria-label="이전 달"
                    onClick={() =>
                      setMonth(
                        new Date(month.getFullYear(), month.getMonth() - 1, 1),
                      )
                    }
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <h2>
                    {month.getFullYear()}년 {month.getMonth() + 1}월
                  </h2>
                  <button
                    className="icon-button"
                    aria-label="다음 달"
                    onClick={() =>
                      setMonth(
                        new Date(month.getFullYear(), month.getMonth() + 1, 1),
                      )
                    }
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
                <button
                  className="button primary"
                  onClick={() => setPlanOpen(true)}
                >
                  <Plus size={16} />
                  계획 추가
                </button>
              </div>
              <div className="calendar">
                {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
                  <div className="weekday" key={d}>
                    {d}
                  </div>
                ))}
                {Array.from({ length: month.getDay() }, (_, i) => (
                  <div className="calendar-cell outside" key={`blank${i}`} />
                ))}
                {Array.from({ length: daysInMonth }, (_, i) => (
                  <div className="calendar-cell" key={i}>
                    <span
                      className={
                        dateKey(i + 1) ===
                        new Date().toLocaleDateString("sv-SE")
                          ? "today"
                          : ""
                      }
                    >
                      {i + 1}
                    </span>
                    {plans
                      .filter((p) => p.date === dateKey(i + 1))
                      .map((p) => (
                        <button
                          key={p.id}
                          className={`calendar-event ${p.status}`}
                          onClick={async () => {
                            if (p.pointId) {
                              const point = points.find(
                                (x) => x.id === p.pointId,
                              );
                              if (point) await selectPoint(point);
                            } else
                              setToast({
                                tone: "info",
                                message: `${p.title} · ${p.note || "연결 포인트 미확인"}`,
                              });
                          }}
                        >
                          {p.status === "done" ? "✓ " : ""}
                          {p.title}
                        </button>
                      ))}
                  </div>
                ))}
              </div>
              <div className="plan-list">
                {plans.map((p) => (
                  <div key={p.id}>
                    <span className="badge muted">{p.date}</span>
                    <b>{p.title}</b>
                    <span>
                      {pointName(points.find((x) => x.id === p.pointId))}
                    </span>
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          setPlanHistory({
                            title: p.title,
                            events: await api<Audit[]>(
                              `/plans/${p.id}/history`,
                            ),
                          });
                        } catch {
                          setToast({
                            tone: "error",
                            message: "계획 이력을 불러오지 못했습니다.",
                          });
                        }
                      }}
                    >
                      변경 이력
                    </button>
                    {p.status === "planned" ? (
                      <button
                        className="text-button"
                        onClick={async () => {
                          try {
                            await api(`/plans/${p.id}`, {
                              method: "PATCH",
                              body: JSON.stringify({
                                status: "done",
                                actor: "현업 엔지니어",
                                reason: "검사 계획 이행 확인",
                              }),
                            });
                            await notify("검사 계획을 완료로 기록했습니다.");
                          } catch (cause) {
                            setToast({
                              tone: "error",
                              message: (cause as Error).message,
                            });
                          }
                        }}
                      >
                        <Check size={15} />
                        검사 완료 기록
                      </button>
                    ) : p.status === "done" ? (
                      <span className="badge green">완료</span>
                    ) : p.status === "cancelled" ? (
                      <span className="badge muted">취소</span>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          )}
          <footer>
            <ShieldCheck size={14} />
            <span>
              등급은 사진의 시각적 부식 분류입니다. 설비 안전성이나 실제 보수
              지시를 확정하지 않습니다.
            </span>
            <span>InspectLoop · 로컬 프로토타입</span>
          </footer>
        </main>
      </div>
      {planHistory && (
        <Modal
          title={planHistory.title + " · 계획 이력"}
          close={() => setPlanHistory(null)}
        >
          <AuditList history={planHistory.events} />
        </Modal>
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
          demoOnly={publicDemo || health?.demoMode === true}
          publicUploadsAllowed={
            publicUploads || health?.publicUploadsAllowed === true
          }
          openExisting={selectPhoto}
          points={points}
          close={() => setUploadOpen(false)}
          done={notify}
        />
      )}
      {planOpen && (
        <PlanDialog
          points={points}
          close={() => setPlanOpen(false)}
          done={notify}
        />
      )}
      {detail && (
        <PhotoDialog
          key={detail.id}
          photo={photos.find((p) => p.id === detail.id) || detail}
          points={points}
          reportHistoryError={reportHistoryError}
          close={() => setDetail(null)}
          done={notify}
        />
      )}
      {pointDetail && (
        <PointDialog
          key={pointDetail.id}
          point={pointDetail}
          photos={photos.filter((p) => p.pointId === pointDetail.id)}
          reportHistoryError={reportHistoryError}
          close={() => setPointDetail(null)}
          done={notify}
        />
      )}
    </div>
  );
}

function PhotoTable({
  photos,
  points,
  onSelect,
}: {
  photos: Photo[];
  points: Point[];
  onSelect: (p: Photo) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>검사 사진</th>
            <th>설비·포인트</th>
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
                  <img
                    src={`${apiBase}/api/inspections/${photo.id}/thumbnail`}
                    alt="검사 사진 축소 이미지"
                  />
                  <span>
                    {photo.name}
                    <small>{photo.id.slice(0, 8)}</small>
                  </span>
                </button>
              </td>
              <td>{pointName(points.find((p) => p.id === photo.pointId))}</td>
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
  close,
  done,
  demoOnly,
  publicUploadsAllowed,
  openExisting,
}: {
  publicUploadsAllowed: boolean;
  openExisting: (photo: Photo) => Promise<void>;
  demoOnly: boolean;
  points: Point[];
  close: () => void;
  done: (s: string, tone?: ToastTone) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [demoSelection, setDemoSelection] = useState(false);
  const [pointId, setPointId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const selectedNames = demoSelection
    ? demoAllowlist.map((demo) => demo.name)
    : files.map((file) => file.name);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    if (!selectedNames.length) return setError("업로드할 사진을 선택하세요.");
    if (files.length > 10 || files.some((f) => f.size > 20 * 1024 * 1024))
      return setError("한 번에 10장, 사진당 20MB까지 가능합니다.");
    const values = new FormData(e.currentTarget);
    setBusy(true);
    setProgress(0);
    setStage(
      demoSelection ? "시연 사진을 확인하는 중…" : "업로드를 준비하는 중…",
    );
    const started = performance.now();
    try {
      if (!demoSelection) {
        const mode = await api<Health>("/health", {
          signal: AbortSignal.timeout(10000),
        });
        if (demoOnly || mode.demoMode) {
          const hashes = await Promise.all(
            files.map(async (file) =>
              Array.from(
                new Uint8Array(
                  await crypto.subtle.digest(
                    "SHA-256",
                    await file.arrayBuffer(),
                  ),
                ),
              )
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(""),
            ),
          );
          if (
            hashes.some(
              (hash) => !demoAllowlist.some((demo) => demo.sha256 === hash),
            )
          )
            throw new Error(
              "공개 데모에서는 제공된 시연 사진만 업로드할 수 있습니다.",
            );
        }
      }
      let id = pointId;
      if (pointId === "new") {
        const point = await api<Point>("/points", {
          method: "POST",
          body: JSON.stringify({
            equipment: values.get("equipment"),
            rack: values.get("rack"),
            name: values.get("name"),
          }),
          signal: AbortSignal.timeout(15000),
        });
        id = point.id;
      }
      type UploadResult = Photo & { uploadOutcome?: "created" | "existing" };
      let results: UploadResult[];
      if (demoSelection) {
        results = await api<UploadResult[]>("/demo-inspections", {
          method: "POST",
          body: JSON.stringify({ pointId: id || null }),
          signal: AbortSignal.timeout(30000),
        });
      } else {
        const payload = new FormData();
        for (const file of files) payload.append("images", file);
        if (id) payload.append("pointId", id);
        if (demoOnly) payload.append("demo", "1");
        setStage("uploading");
        results = await new Promise<UploadResult[]>((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("POST", `${apiBase}/api/inspections`);
          request.timeout = 180000;
          request.upload.onprogress = (event) => {
            if (event.lengthComputable)
              setProgress(Math.round((event.loaded / event.total) * 100));
          };
          request.onload = () => {
            if (request.status >= 500) {
              reject(
                new Error(
                  `서버 처리 중 문제가 발생했습니다. (${request.status}) 저장된 목록에서 반영 여부를 확인한 후 다시 시도하세요.`,
                ),
              );
              return;
            }
            try {
              const data = JSON.parse(request.responseText);
              if (request.status >= 400) reject(new Error(data.error));
              else if (Array.isArray(data)) resolve(data);
              else throw new Error();
            } catch {
              reject(
                new Error(
                  "업로드 응답을 확인할 수 없습니다. 저장된 목록에서 반영 여부를 확인한 후 다시 시도하세요.",
                ),
              );
            }
          };
          request.onerror = () =>
            reject(
              new Error(
                "API 연결이 끊겼습니다. 저장된 목록을 확인한 후 다시 시도하세요.",
              ),
            );
          request.ontimeout = () =>
            reject(
              new Error(
                "응답이 지연되고 있습니다. 저장된 목록을 확인한 후 다시 시도하세요.",
              ),
            );
          request.send(payload);
        });
      }
      const created = results.filter(
        (photo) => photo.uploadOutcome !== "existing",
      );
      const reused = results.length - created.length;
      setStage("저장된 목록을 확인하는 중…");
      await done(
        created.length
          ? `${created.length}장 새로 저장 · ${reused ? `중복 ${reused}장 제외 · ` : ""}${((performance.now() - started) / 1000).toFixed(1)}초 · AI 판독은 백그라운드에서 진행됩니다.`
          : `이미 등록된 시연 사진 ${reused}장입니다. 새로 저장하지 않고 기존 사진과 결과를 엽니다.`,
        created.length ? "success" : "info",
      );
      close();
      if (!created.length && results[0]) await openExisting(results[0]);
    } catch (cause) {
      setError(
        (cause as Error).name === "TimeoutError"
          ? "응답이 지연되고 있습니다. 저장된 목록을 확인한 후 다시 시도하세요."
          : (cause as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="검사 사진 업로드" close={busy ? () => {} : close}>
      <form onSubmit={submit}>
        <p className="form-intro">
          {publicUploadsAllowed
            ? "공개 가능한 사진만 선택하세요. 선택한 사진은 링크를 가진 사람이 조회할 수 있습니다."
            : demoOnly
              ? "공개 demo에서는 제공된 시연 사진만 업로드할 수 있습니다."
              : "사진을 원본 그대로 저장하고 포인트에 연결합니다."}
        </p>
        {(demoOnly || publicUploadsAllowed) && (
          <div className="dropzone">
            <ShieldCheck size={28} />
            <strong>
              {demoOnly
                ? "공개 데모 · 제공된 시연 사진만 사용"
                : "시연 사진으로 먼저 둘러보기"}
            </strong>
            <span>
              {demoSelection
                ? "시연 사진 5장 선택됨"
                : "같은 포인트의 시연 사진은 기존 결과를 사용합니다."}
            </span>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => {
                setError("");
                setFiles([]);
                setDemoSelection(true);
              }}
            >
              시연 사진 5장 선택
            </button>
          </div>
        )}
        {!demoOnly && (
          <label className="dropzone">
            <Upload size={32} />
            <strong>
              {files.length
                ? `${files.length}장 선택됨`
                : "클릭하여 검사 사진 선택"}
            </strong>
            <span>JPG, PNG · 최대 10장 · 사진당 20MB</span>
            <input
              aria-label="검사 사진 선택"
              type="file"
              multiple
              accept="image/jpeg,image/png"
              onChange={(e) => {
                setFiles(Array.from(e.target.files || []));
                setDemoSelection(false);
              }}
              disabled={busy}
            />
          </label>
        )}
        {selectedNames.length > 0 && (
          <div className="file-list">
            {selectedNames.map((name, i) => (
              <span key={i}>{name}</span>
            ))}
          </div>
        )}
        <label className="field">
          연결할 포인트
          <select value={pointId} onChange={(e) => setPointId(e.target.value)}>
            <option value="">위치 미확인으로 저장</option>
            <option value="new">+ 새 포인트 등록</option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {pointName(p)}
              </option>
            ))}
          </select>
        </label>
        {pointId === "new" && (
          <div className="form-grid">
            <label className="field">
              설비번호
              <input
                name="equipment"
                placeholder="예: EQ-101"
                maxLength={120}
              />
            </label>
            <label className="field">
              랙 번호
              <input name="rack" placeholder="예: 2" maxLength={120} />
            </label>
            <label className="field full">
              포인트 이름
              <input
                name="name"
                placeholder="예: 상부 배관 P-01"
                maxLength={120}
              />
            </label>
          </div>
        )}
        <div className="form-note">
          <ShieldCheck size={16} />
          사진은 Mac의 MinIO에 저장됩니다. 위치를 모르면 빈칸으로 남기세요.
        </div>
        {busy && (
          <div className="upload-progress">
            <progress
              value={stage === "uploading" ? progress : undefined}
              max={100}
            />
            <span>
              {stage === "uploading"
                ? progress < 100
                  ? `업로드 ${progress}%`
                  : "이미지 확인·저장 중…"
                : stage}
            </span>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={close}
          >
            취소
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Upload size={16} />
            )}
            {busy
              ? demoSelection
                ? "불러오는 중"
                : "저장 중"
              : demoSelection
                ? "시연 사진 열기"
                : "업로드 시작"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function PlanDialog({
  points,
  close,
  done,
}: {
  points: Point[];
  close: () => void;
  done: (s: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title="검사 계획 만들기" close={close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await api("/plans", {
              method: "POST",
              body: JSON.stringify({
                title: data.get("title"),
                date: data.get("date"),
                pointId: data.get("pointId") || null,
                note: data.get("note"),
              }),
            });
            await complete("검사 계획을 저장했습니다.");
          } catch (cause) {
            setError((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          검사 제목
          <input
            name="title"
            required
            maxLength={120}
            placeholder="예: 2번 랙 정기 사진 검사"
          />
        </label>
        <label className="field">
          검사 예정일
          <input
            name="date"
            type="date"
            required
            defaultValue={new Date().toLocaleDateString("sv-SE")}
          />
        </label>
        <label className="field">
          검사 포인트
          <select name="pointId">
            <option value="">아직 정하지 않음</option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {pointName(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          메모
          <textarea
            name="note"
            maxLength={1000}
            rows={3}
            placeholder="촬영 조건이나 확인할 사항"
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={close}>
            취소
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "저장 중…" : "계획 저장"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function AuditList({ history }: { history: Audit[] }) {
  const labels: Record<string, string> = {
    humanGrade: "사람 수정 등급",
    retake: "재촬영",
    retakeReason: "재촬영 사유",
    labeling: "라벨링 후보",
    pointId: "연결 포인트",
    repairStatus: "보수 상태",
    managed: "관리 대상",
    ta: "TA 포함",
    status: "처리 상태",
    ai: "AI 결과",
    equipment: "설비번호",
    rack: "랙",
    name: "이름",
  };
  const value = (v: unknown) => {
    if (v === null || v === undefined) return "미지정";
    if (typeof v === "boolean") return v ? "포함" : "해제";
    if (typeof v === "object") {
      const result = v as {
        grade?: number;
        confidence?: number;
        model_version?: string;
      };
      return result.grade
        ? `${result.grade}등급 · 모델 점수(보정 전) ${((result.confidence || 0) * 100).toFixed(1)}% · 모델 ${result.model_version || "미확인"}`
        : "상세 정보 변경";
    }
    const states: Record<string, string> = {
      pending: "판독 대기",
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
    <section className="audit">
      <h3>변경 이력</h3>
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
    </section>
  );
}
function PhotoDialog({
  photo,
  points,
  reportHistoryError,
  close,
  done,
}: {
  photo: Photo;
  points: Point[];
  reportHistoryError: (message: string) => void;
  close: () => void;
  done: (s: string) => Promise<void>;
}) {
  const [retake, setRetake] = useState(photo.retake);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const history = useAuditHistory(
    `/inspections/${photo.id}/history`,
    reportHistoryError,
  );
  const complete = useDialogCompletion(done, close);
  return (
    <Modal title="사진 판독·후속 관리" wide close={close}>
      <div className="detail-grid">
        <div>
          <div className="detail-image">
            <img
              src={`${apiBase}/api/inspections/${photo.id}/image`}
              alt={photo.name}
            />
          </div>
          <div className="image-caption">{photo.name}</div>
          <div className="ai-result">
            <div>
              <span>현재 분류</span>
              <Grade photo={photo} />
            </div>
            <small>
              최종 test 60% · 목표 70% 미달 · 실제 사용 판단 별도 확인
            </small>
            <p>
              원래 AI 등급:{" "}
              {photo.ai
                ? `${photo.ai.grade}등급 · 모델 점수(보정 전) ${(photo.ai.confidence * 100).toFixed(1)}%`
                : "결과 없음"}
            </p>
            {photo.ai && (
              <small>
                모델 {photo.ai.model_version}
                <br />
                전처리 {photo.ai.preprocessing_version}
              </small>
            )}
            {photo.error && <p className="form-error">{photo.error}</p>}
            {photo.status === "error" && (
              <button
                className="button secondary"
                onClick={async () => {
                  try {
                    await api(`/inspections/${photo.id}/retry`, {
                      method: "POST",
                    });
                    await complete("판독을 다시 요청했습니다.");
                  } catch (cause) {
                    setError((cause as Error).message);
                  }
                }}
              >
                판독 다시 요청
              </button>
            )}
          </div>
          <AuditList history={history} />
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api(`/inspections/${photo.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  pointId: form.get("pointId") || null,
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
              setBusy(false);
            }
          }}
        >
          <label className="field">
            연결 포인트
            <select name="pointId" defaultValue={photo.pointId || ""}>
              <option value="">위치 미확인</option>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {pointName(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            사람 수정 등급
            <select name="grade" defaultValue={photo.humanGrade || ""}>
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
              defaultValue={photo.retakeReason}
              maxLength={1000}
              placeholder="흐림, 가림 등 구체적인 사유"
            />
          </label>
          <label className="checkbox">
            <input
              name="labeling"
              type="checkbox"
              defaultChecked={photo.labeling}
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
  photos,
  reportHistoryError,
  close,
  done,
}: {
  point: Point;
  photos: Photo[];
  reportHistoryError: (message: string) => void;
  close: () => void;
  done: (s: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
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
            <span className="badge muted">연결된 사진 {photos.length}장</span>
          </div>
          <div className="point-thumbnails">
            {photos.map((p) => (
              <div key={p.id}>
                <img
                  src={`${apiBase}/api/inspections/${p.id}/thumbnail`}
                  alt={p.name}
                />
                <Grade photo={p} />
              </div>
            ))}
          </div>
          <AuditList history={history} />
        </div>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              await api(`/points/${point.id}`, {
                method: "PATCH",
                body: JSON.stringify({
                  equipment: form.get("equipment"),
                  rack: form.get("rack"),
                  name: form.get("name"),
                  repairStatus: form.get("repairStatus"),
                  managed: form.get("managed") === "on",
                  ta: form.get("ta") === "on",
                  actor: form.get("actor"),
                  reason: form.get("reason"),
                }),
              });
              await complete("포인트 상태와 이력을 저장했습니다.");
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
                defaultValue={point.equipment}
                maxLength={120}
              />
            </label>
            <label className="field">
              랙 번호
              <input name="rack" defaultValue={point.rack} maxLength={120} />
            </label>
          </div>
          <label className="field">
            포인트 이름
            <input name="name" defaultValue={point.name} maxLength={120} />
          </label>
          <label className="field">
            보수 상태
            <select name="repairStatus" defaultValue={point.repairStatus}>
              {Object.entries(statusName).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              name="managed"
              defaultChecked={point.managed}
            />
            <span>관리 워크리스트에 포함</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" name="ta" defaultChecked={point.ta} />
            <span>TA 워크리스트에 포함</span>
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
            {busy ? "저장 중…" : "상태·이력 저장"}
          </button>
        </form>
      </div>
    </Modal>
  );
}
