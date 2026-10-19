"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  MaintenanceEditor,
  methodLabels,
  type MaintenanceDraft,
  type RepairStatus,
} from "./MaintenancePanel";
import styles from "./MaintenancePanel.module.css";
import {
  maintenanceApi,
  type Purpose,
  type SavedMaintenance,
} from "@/lib/maintenance";
import { usePhotoQuery } from "@/lib/photo-query";
import { finishMaintenanceSave, statusAfterMethod } from "@/lib/maintenance-save";
import { useAuth } from "./AuthProvider";

type Audit = {
  id: string;
  actor: string;
  reason: string;
  at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};
const fields = {
  repairStatus: "상태",
  repairMethod: "후속 조치",
  repairMethodMode: "분류 방식",
  inWorklist: "보수 대상 반영",
  ta: "TA 작업 포함",
  photoIds: "근거 사진",
  recordPurpose: "기록 목적",
  inclusionMode: "보수 대상 반영 방식",
  visibility: "표시 상태",
  reviewedEvidence: "확인한 근거",
};
const statusFilterLabels: Record<RepairStatus | "all", string> = {
  all: "전체",
  none: "등록 전",
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
};
const names: Record<string, string> = {
  none: "등록 전",
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
  undecided: "미정",
  monitor: "추적관리",
  paint: "도장교체",
  replace: "배관교체",
  auto: "자동",
  manual: "담당자 지정",
  inspection: "업무 검사",
  presentation: "발표용",
  verification: "검증용",
};
const value = (item: unknown) =>
  Array.isArray(item)
    ? `${item.length}개`
    : typeof item === "boolean"
      ? item
        ? "포함"
        : "해제"
      : item == null
        ? "미지정"
        : names[String(item)] || String(item);

function MaintenanceHistoryDetails({
  rows,
  error,
  loaded,
  emptyMessage,
  className,
}: {
  rows: Audit[];
  error: string;
  loaded: boolean;
  emptyMessage: string;
  className?: string;
}) {
  const summary = error
    ? "보수 변경 이력 조회 실패"
    : loaded
      ? `보수 변경 이력 ${rows.length}건`
      : "보수 변경 이력 조회 중";

  return (
    <details className={className ?? "audit"}>
      <summary>{summary}</summary>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!loaded && !error && (
        <p className="faint" role="status">
          이력을 불러오는 중입니다.
        </p>
      )}
      {loaded && !rows.length && !error && (
        <p className="faint">{emptyMessage}</p>
      )}
      {rows.map((row) => (
        <div className="audit-item" key={row.id}>
          <i />
          <div>
            <b>{row.actor}</b>
            <p>{row.reason}</p>
            {Object.entries(fields)
              .filter(
                ([key]) =>
                  JSON.stringify(row.before?.[key]) !==
                  JSON.stringify(row.after[key]),
              )
              .map(([key, label]) => (
                <small key={key}>
                  {label}: {key === "repairMethod" ? methodLabels[row.before?.[key] as keyof typeof methodLabels] ?? "미지정" : value(row.before?.[key])} → {key === "repairMethod" ? methodLabels[row.after[key] as keyof typeof methodLabels] ?? "미지정" : value(row.after[key])}
                </small>
              ))}
            <time>{new Date(row.at).toLocaleString("ko-KR")}</time>
          </div>
        </div>
      ))}
    </details>
  );
}

const initialDraft = (
  item: SavedMaintenance | null,
  photoId?: string,
): MaintenanceDraft => ({
  repairStatus: item?.repairStatus ?? "none",
  repairMethod: item?.repairMethod ?? "undecided",
  repairMethodMode: item?.repairMethodMode ?? "auto",
  inWorklist: item?.inWorklist ?? false,
  ta: item?.ta ?? false,
  photoIds: item?.targetType === "photo" ? [item.targetId!] : item?.photoIds ?? (photoId ? [photoId] : []),
  actor: "현업 엔지니어",
  reason: "",
  inclusionMode: item?.inclusionMode ?? "auto",
  visibility: item?.visibility ?? "visible",
});
const draftSignature = (draft: MaintenanceDraft) =>
  JSON.stringify([
    draft.repairStatus,
    draft.repairMethod,
    draft.repairMethodMode,
    draft.inWorklist,
    draft.ta,
    draft.photoIds,
    draft.actor,
    draft.reason,
    draft.inclusionMode,
    draft.visibility,
    Object.entries(draft.acknowledgedEvidence ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ]);
export default function MaintenanceContext({
  planId,
  pointId,
  targetType,
  targetId,
  planTitle,
  pointLabel,
  recordPurpose,
  photoId,
  onPrevious,
  onNext,
  canPrevious = false,
  canNext = false,
  done,
  visibleStatusFilter = "all",
  onEditStateChange,
  editingBlocked = false,
}: {
  planId: string | null;
  pointId: string | null;
  targetType?: "point" | "photo";
  targetId?: string;
  planTitle: string | null;
  pointLabel: string;
  recordPurpose: Purpose;
  photoId?: string;
  onPrevious?: () => void;
  onNext?: () => void;
  canPrevious?: boolean;
  canNext?: boolean;
  visibleStatusFilter?: RepairStatus | "all";
  onEditStateChange?: (state: { dirty: boolean; busy: boolean }) => void;
  editingBlocked?: boolean;
  done: (message: string) => Promise<void>;
}) {
  const { session, can } = useAuth();
  const canWrite = can("work.write");
  const canManageRecords = can("records.manage");
  const sessionActor = session?.authenticated ? session.user?.displayName : null;
  const [basis, setBasis] = useState<{ item: SavedMaintenance | null } | null>(
      null,
    ),
    [draft, setDraft] = useState<MaintenanceDraft>(initialDraft(null)),
    [baselineDraft, setBaselineDraft] =
      useState<MaintenanceDraft>(initialDraft(null)),
    [error, setError] = useState(""),
    [refreshWarning, setRefreshWarning] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Audit[]>([]),
    [historyError, setHistoryError] = useState(""),
    [historyLoaded, setHistoryLoaded] = useState(false),
    [page, setPage] = useState(1);
  const lock = useRef(false),
    active = useRef(true);
  const [selectedPhotoNames, setSelectedPhotoNames] = useState<
    Record<string, string>
  >({});
  const photos = usePhotoQuery({
    planId: targetType === "photo" ? "all" : planId ?? "unassigned",
    pointId: targetType === "photo" ? "all" : pointId ?? "unassigned",
    ...(targetType === "photo" || !pointId ? { photoId: photoId ?? targetId } : {}),
    recordPurpose,
    visibility: "all",
    page,
    pageSize: 50,
  });
  useEffect(() => {
    if (photos.data)
      setSelectedPhotoNames((previous) => ({
        ...previous,
        ...Object.fromEntries(
          photos.data!.items.map((photo) => [photo.id, photo.name]),
        ),
      }));
  }, [photos.data]);
  useEffect(() => {
    active.current = true;
    let current = true;
    const controller = new AbortController();
    void maintenanceApi<SavedMaintenance | null>(
      (photoId || (targetType === "photo" && targetId)) ? "/target?" + new URLSearchParams({ photoId: photoId ?? targetId! }) : "/pair?" + new URLSearchParams({ planId: planId ?? "unassigned", pointId: pointId! }),
      {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      },
    )
      .then((item) => {
        if (current && active.current) {
          const loadedDraft = initialDraft(item, photoId ?? targetId);
          setBasis({ item });
          setDraft(loadedDraft);
          setBaselineDraft(loadedDraft);
        }
      })
      .catch((e) => {
        if (current && active.current) setError(e.message);
      });
    return () => {
      current = false;
      active.current = false;
      controller.abort();
    };
  }, [planId, pointId, photoId, targetType, targetId, recordPurpose]);
  const photoTargetMode = targetType === "photo" && Boolean(photoId ?? targetId);
  const dirty = Boolean(
    basis && draftSignature(draft) !== draftSignature(baselineDraft),
  );
  useLayoutEffect(() => {
    onEditStateChange?.({ dirty, busy });
  }, [busy, dirty, onEditStateChange]);
  useEffect(() => {
    if (!basis) return;
    let current = true;
    setHistory([]);
    setHistoryError("");
    setHistoryLoaded(!basis.item);
    if (!basis.item) {
      return () => {
        current = false;
      };
    }
    void maintenanceApi<Audit[]>(`/${basis.item.id}/history`)
      .then((rows) => {
        if (current) {
          setHistory(rows);
          setHistoryLoaded(true);
        }
      })
      .catch((e) => {
        if (current) {
          setHistoryError(e.message);
          setHistoryLoaded(true);
        }
      });
    return () => {
      current = false;
    };
  }, [basis]);
  const save = async () => {
    if (!canWrite) {
      setError("조회 권한에서는 보수 기록을 변경할 수 없습니다.");
      return;
    }
    if (!basis || lock.current || editingBlocked) return;
    if (!draft.reason.trim()) { setError("변경 사유를 입력하세요."); return; }
    lock.current = true;
    setBusy(true);
    setError("");
    setRefreshWarning("");
    try {
      const payload: Record<string, unknown> = {
        ...draft,
        actor: sessionActor ?? draft.actor,
        ...(targetType === "photo" ? {
          actor: sessionActor ?? "현업 엔지니어",
          photoIds: [photoId ?? targetId!],
        } : {}),
        expectedVersion: basis.item?.persisted ? basis.item.editVersion : null,
        ...(basis.item?.persisted ? {} : { planId, pointId, targetType: basis.item?.targetType ?? targetType, targetId: basis.item?.targetId ?? targetId }),
      };
      if (!canManageRecords) {
        delete payload.visibility;
        delete payload.recordPurpose;
      }
      const saved = await maintenanceApi<SavedMaintenance>(
        basis.item?.persisted ? "/" + basis.item.id : "",
        {
          method: basis.item?.persisted ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      if (active.current) {
        const refreshErrors = await finishMaintenanceSave(saved, {
          onConfirmed: (item) => {
            if (!active.current) return;
            const confirmedItem = { ...basis.item, ...item, persisted: true };
            const savedDraft = {
              ...initialDraft(confirmedItem),
              actor: sessionActor ?? draft.actor,
            };
            setBasis({ item: confirmedItem });
            setDraft(savedDraft);
            setBaselineDraft(savedDraft);
          },
          readLatest: (id) => maintenanceApi<SavedMaintenance>("/" + id),
          refreshLists: async (readFailed) => {
            if (active.current)
              await done(readFailed
                ? "보수 기록은 저장됐습니다. 상세 재조회에 실패해 다시 확인이 필요합니다."
                : targetType === "photo" ? "보수 정보를 저장했습니다." : "보수 기록과 변경 이력을 저장했습니다.");
          },
        });
        if (active.current && refreshErrors.length)
          setRefreshWarning("보수 기록은 저장됐습니다. 화면 갱신에 실패했습니다. 창을 닫고 다시 열어 확인해 주세요.");
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      lock.current = false;
      if (active.current) setBusy(false);
    }
  };
  if (!basis)
    return (
      <p
        className={error ? "form-error" : "form-intro"}
        role={error ? "alert" : "status"}
      >
        {error || "보수 기록을 불러오는 중…"}
      </p>
    );
  if (photoTargetMode) {
    const photo = photos.data?.items[0];
    const statusLabels: Record<MaintenanceDraft["repairStatus"], string> = {
      none: "등록 전",
      review: "검토 필요",
      planned: "작업 예정",
      progress: "작업 중",
      done: "완료",
    };
    const statusWillLeaveFilter = Boolean(
      basis.item &&
        visibleStatusFilter !== "all" &&
        basis.item.repairStatus === visibleStatusFilter &&
        draft.repairStatus !== visibleStatusFilter,
    );
    return (
      <div className={styles.photoReview}>
        <section className={styles.photoReviewStage} aria-label="보수 대상 사진">
          {photo ? (
            <>
              <img src={`${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/inspections/${photo.id}/image`} alt={photo.name} />
              <p className={styles.photoReviewCaption}>{photo.name}</p>
              <div className={styles.photoReviewNav}>
                <button type="button" onClick={onPrevious} disabled={!canPrevious || busy || editingBlocked} aria-label="이전 사진"><ChevronLeft size={27} /></button>
                <button type="button" onClick={onNext} disabled={!canNext || busy || editingBlocked} aria-label="다음 사진"><ChevronRight size={27} /></button>
              </div>
              {(canPrevious || canNext) && (
                <p className={styles.photoReviewHint}>
                  {canPrevious && canNext
                    ? "키보드 ← → 로 이전·다음 사진 이동"
                    : canPrevious
                      ? "키보드 ← 로 이전 사진 이동"
                      : "키보드 → 로 다음 사진 이동"}
                </p>
              )}
            </>
          ) : (
            <p className={photos.error ? "form-error" : "form-intro"} role={photos.error ? "alert" : "status"}>
              {photos.error || "사진을 불러오는 중…"}
            </p>
          )}
        </section>
        <form className={styles.photoReviewForm} onSubmit={(event) => { event.preventDefault(); if (canWrite && dirty && draft.reason.trim() && !busy && !editingBlocked) void save(); }}>
          <p className={styles.photoReviewContext}>{planTitle || "계획 미지정"} · {pointLabel || "위치 미확인"}</p>
          {!canWrite && <p className={styles.help} role="status">조회 권한에서는 보수 기록을 변경할 수 없습니다.</p>}
          <div className={`${styles.photoReviewGrade} ${draft.repairStatus === "done" ? styles.green : draft.repairStatus === "progress" ? styles.blue : styles.amber}`}>
            <span>후속 조치</span><strong>{methodLabels[draft.repairMethod]}</strong>
            {Number.isInteger(photo?.humanGrade ?? photo?.ai?.grade) && <small>사진 등급 {photo?.humanGrade ?? photo?.ai?.grade}등급</small>}
          </div>
          <label className={styles.field}>
            후속 조치
            <select aria-label="후속 조치" value={draft.repairMethod} disabled={busy || editingBlocked || !canWrite} onChange={(event) => {
              const repairMethod = event.target.value as MaintenanceDraft["repairMethod"];
              setDraft((current) => ({ ...current, repairMethod, repairMethodMode: "manual", repairStatus: statusAfterMethod(current.repairStatus, repairMethod) }));
            }}>
              {Object.entries(methodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            진행 상태
            <select aria-label="진행 상태" value={draft.repairStatus} disabled={busy || editingBlocked || !canWrite} onChange={(event) => setDraft((current) => ({ ...current, repairStatus: event.target.value as MaintenanceDraft["repairStatus"] }))}>
              {Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            </select>
          </label>
          {statusWillLeaveFilter && (
            <p className={styles.warning} role="status">
              저장하면 현재 ‘{statusFilterLabels[visibleStatusFilter]}’ 상태 필터 결과에서는 보이지 않습니다.
            </p>
          )}
          <label className={styles.field}>
            변경 사유
            <textarea aria-label="변경 사유" required maxLength={1000} value={draft.reason} disabled={busy || editingBlocked || !canWrite} placeholder="조치·진행 상태 등을 변경하는 이유" onChange={(event) => setDraft((current) => ({ ...current, reason: event.target.value }))} />
          </label>
          <details className={styles.secondarySettings}>
            <summary>TA 포함 · 목록 설정</summary>
            <label className={styles.checkbox}>
              <input type="checkbox" checked={draft.ta} disabled={busy || editingBlocked || !canWrite} onChange={(event) => setDraft((current) => ({ ...current, ta: event.target.checked }))} /> TA 작업에 포함
            </label>
            <label className={styles.field}>목록 표시
              <select value={draft.inclusionMode} disabled={busy || editingBlocked || !canWrite} onChange={(event) => setDraft((current) => ({ ...current, inclusionMode: event.target.value as MaintenanceDraft["inclusionMode"] }))}>
                <option value="auto">등급에 따라 자동 반영</option>
                <option value="include">보수 대상에 포함</option>
                <option value="exclude">수동 제외 유지</option>
              </select>
            </label>
            <p className={styles.help}>1~2등급은 기본 목록에서 제외됩니다. 기존 기록과 이력은 보존됩니다.</p>
          </details>
          {refreshWarning && <p className={styles.warning} role="status">{refreshWarning}</p>}
          {error && <p className={styles.error} role="alert">{error}<span>입력 내용은 유지됩니다.</span></p>}
          <button type="submit" className={styles.primaryButton} disabled={!canWrite || !dirty || !draft.reason.trim() || busy || !photo || editingBlocked}>
            {busy ? "저장 중…" : dirty ? "변경 사항 저장" : "저장할 변경 사항 없음"}
          </button>
        </form>
        <MaintenanceHistoryDetails
          rows={history}
          error={historyError}
          loaded={historyLoaded}
          emptyMessage="아직 저장한 이력이 없습니다."
          className={`audit ${styles.photoReviewHistory}`}
        />
      </div>
    );
  }
  return (
    <>
      {photos.error && (
        <p className="form-error" role="alert">
          근거 사진 목록: {photos.error}
        </p>
      )}
      {!photos.data && (
        <p className="form-intro">
          근거 사진을 조회 중입니다. 기존 선택은 유지됩니다.
        </p>
      )}
      {refreshWarning && <p className="form-intro" role="status">{refreshWarning}</p>}
      <MaintenanceEditor
        selectedPhotoNames={selectedPhotoNames}
        saved={basis.item}
        draft={draft}
        editingBlocked={editingBlocked}
        onChange={setDraft}
        onSave={() => void save()}
        busy={busy}
        error={error || null}
        planTitle={planTitle}
        pointLabel={pointLabel}
        photos={(photos.data?.items ?? []).map((photo) => ({
          id: photo.id,
          name:
            photo.name + (photo.visibility === "hidden" ? " · 숨긴 사진" : ""),
          grade: photo.humanGrade ?? photo.ai?.grade,
        }))}
      />
      {photos.data && (
        <div className="list-toolbar">
          <span>
            같은 검사 대상의 사진 {photos.data.total}장 ·{" "}
            {photos.data.page}/{photos.data.pages}페이지
          </span>
          <button
            className="button secondary"
            disabled={busy || editingBlocked || photos.data.page <= 1}
            onClick={() => setPage(photos.data!.page - 1)}
          >
            근거 사진 이전
          </button>
          <button
            className="button secondary"
            disabled={busy || editingBlocked || photos.data.page >= photos.data.pages}
            onClick={() => setPage(photos.data!.page + 1)}
          >
            근거 사진 다음
          </button>
        </div>
      )}
      <MaintenanceHistoryDetails
        rows={history}
        error={historyError}
        loaded={historyLoaded}
        emptyMessage="아직 저장한 이력이 없습니다."
      />
    </>
  );
}
