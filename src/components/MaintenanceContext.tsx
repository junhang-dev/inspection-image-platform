"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MaintenanceEditor, type MaintenanceDraft } from "./MaintenancePanel";
import styles from "./MaintenancePanel.module.css";
import {
  maintenanceApi,
  type Purpose,
  type SavedMaintenance,
} from "@/lib/maintenance";
import { usePhotoQuery } from "@/lib/photo-query";

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
  repairMethod: "방법",
  inWorklist: "워크리스트",
  ta: "TA",
  photoIds: "근거 사진",
  recordPurpose: "기록 목적",
  inclusionMode: "목록 반영 방식",
  visibility: "표시 상태",
  reviewedEvidence: "확인한 근거",
};
const names: Record<string, string> = {
  none: "등록 전",
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
  undecided: "미정",
  paint: "도장",
  replace: "교체",
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
const initialDraft = (
  item: SavedMaintenance | null,
  photoId?: string,
): MaintenanceDraft => ({
  repairStatus: item?.repairStatus ?? "none",
  repairMethod: item?.repairMethod ?? "undecided",
  inWorklist: item?.inWorklist ?? false,
  ta: item?.ta ?? false,
  photoIds: item?.targetType === "photo" ? [item.targetId!] : item?.photoIds ?? (photoId ? [photoId] : []),
  actor: "현업 엔지니어",
  reason: "",
  inclusionMode: item?.inclusionMode ?? "auto",
  visibility: item?.visibility ?? "visible",
});
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
  done: (message: string) => Promise<void>;
}) {
  const [basis, setBasis] = useState<{ item: SavedMaintenance | null } | null>(
      null,
    ),
    [draft, setDraft] = useState<MaintenanceDraft>(initialDraft(null)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [history, setHistory] = useState<Audit[]>([]),
    [historyError, setHistoryError] = useState(""),
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
          setBasis({ item });
          setDraft(initialDraft(item, photoId ?? targetId));
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
  useEffect(() => {
    if (!basis?.item) return;
    let current = true;
    setHistoryError("");
    void maintenanceApi<Audit[]>(`/${basis.item.id}/history`)
      .then((rows) => {
        if (current) setHistory(rows);
      })
      .catch((e) => {
        if (current) setHistoryError(e.message);
      });
    return () => {
      current = false;
    };
  }, [basis?.item?.id, basis?.item?.editVersion]);
  const save = async () => {
    if (!basis || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const payload = {
        ...draft,
        ...(targetType === "photo" ? {
          actor: "현업 엔지니어",
          reason: "보수 단계·작업 방법·TA 설정 변경",
          photoIds: [photoId ?? targetId!],
        } : {}),
        expectedVersion: basis.item?.persisted ? basis.item.editVersion : null,
        ...(basis.item?.persisted ? {} : { planId, pointId, targetType: basis.item?.targetType ?? targetType, targetId: basis.item?.targetId ?? targetId }),
      };
      const saved = await maintenanceApi<SavedMaintenance>(
        basis.item?.persisted ? "/" + basis.item.id : "",
        {
          method: basis.item?.persisted ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      if (active.current) {
        const latest = await maintenanceApi<SavedMaintenance>("/" + saved.id);
        setBasis({ item: latest });
        setDraft({ ...initialDraft(latest), actor: draft.actor });
        await done(targetType === "photo" ? "보수 정보를 저장했습니다." : "보수 기록과 변경 이력을 저장했습니다.");
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
  const photoTargetMode = targetType === "photo" && Boolean(photoId ?? targetId);
  if (photoTargetMode) {
    const photo = photos.data?.items[0];
    const statusValues: MaintenanceDraft["repairStatus"][] = ["review", "planned", "progress", "done"];
    const statusLabels: Record<MaintenanceDraft["repairStatus"], string> = {
      none: "미지정",
      review: "검토 필요",
      planned: "작업 예정",
      progress: "작업 중",
      done: "완료",
    };
    const dirty = Boolean(basis.item && (
      basis.item.repairStatus !== draft.repairStatus ||
      basis.item.repairMethod !== draft.repairMethod ||
      basis.item.ta !== draft.ta
    ));
    return (
      <div className={styles.photoReview}>
        <section className={styles.photoReviewStage} aria-label="보수 대상 사진">
          {photo ? (
            <>
              <img src={`${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/inspections/${photo.id}/image`} alt={photo.name} />
              <p className={styles.photoReviewCaption}>{photo.name}</p>
              <div className={styles.photoReviewNav}>
                <button type="button" onClick={onPrevious} disabled={!canPrevious} aria-label="이전 사진"><ChevronLeft size={27} /></button>
                <button type="button" onClick={onNext} disabled={!canNext} aria-label="다음 사진"><ChevronRight size={27} /></button>
              </div>
              <p className={styles.photoReviewHint}>키보드 ← → 로 이전·다음 사진 이동</p>
            </>
          ) : (
            <p className={photos.error ? "form-error" : "form-intro"} role={photos.error ? "alert" : "status"}>
              {photos.error || "사진을 불러오는 중…"}
            </p>
          )}
        </section>
        <form className={styles.photoReviewForm} onSubmit={(event) => { event.preventDefault(); if (dirty && !busy) void save(); }}>
          <p className={styles.photoReviewContext}>{planTitle || "계획 미지정"} · {pointLabel || "위치 미확인"}</p>
          <div className={`${styles.photoReviewGrade} ${draft.repairStatus === "done" ? styles.green : draft.repairStatus === "progress" ? styles.blue : styles.amber}`}>
            <span>진행 상태</span><strong>{statusLabels[draft.repairStatus]}</strong>
            {Number.isInteger(photo?.humanGrade ?? photo?.ai?.grade) && <small>사진 등급 {photo?.humanGrade ?? photo?.ai?.grade}등급</small>}
          </div>
          <fieldset className={styles.photoReviewStages} disabled={busy}>
            <legend>업무 단계</legend>
            {statusValues.map((status) => (
              <button key={status} type="button" className={draft.repairStatus === status ? styles.selectedStage : ""} aria-pressed={draft.repairStatus === status} onClick={() => setDraft((current) => ({ ...current, repairStatus: status }))}>{statusLabels[status]}</button>
            ))}
          </fieldset>
          <label className={styles.field}>
            작업 방법
            <select value={draft.repairMethod} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, repairMethod: event.target.value as MaintenanceDraft["repairMethod"] }))}>
              <option value="undecided">방법 미정</option>
              <option value="paint">도장</option>
              <option value="replace">교체</option>
            </select>
          </label>
          <button type="button" className={`${styles.taToggle} ${draft.ta ? styles.taSelected : ""}`} aria-pressed={draft.ta} disabled={busy} onClick={() => setDraft((current) => ({ ...current, ta: !current.ta }))}>
            <span className={styles.taCheck} aria-hidden="true">{draft.ta ? "✓" : ""}</span>
            TA 작업에 포함
          </button>
          {error && <p className={styles.error} role="alert">{error}<span>입력 내용은 유지됩니다.</span></p>}
          <button type="submit" className={styles.primaryButton} disabled={!dirty || busy || !photo}>
            {busy ? "저장 중…" : dirty ? "변경 사항 저장" : "저장할 변경 사항 없음"}
          </button>
        </form>
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
      <MaintenanceEditor
        selectedPhotoNames={selectedPhotoNames}
        saved={basis.item}
        draft={draft}
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
            disabled={busy || photos.data.page <= 1}
            onClick={() => setPage(photos.data!.page - 1)}
          >
            근거 사진 이전
          </button>
          <button
            className="button secondary"
            disabled={busy || photos.data.page >= photos.data.pages}
            onClick={() => setPage(photos.data!.page + 1)}
          >
            근거 사진 다음
          </button>
        </div>
      )}
      <details className="audit">
        <summary>보수 변경 이력 {history.length}건</summary>
        {historyError && (
          <p className="form-error" role="alert">
            {historyError}
          </p>
        )}
        {!history.length && !historyError && (
          <p className="faint">
            {basis.item ? "이력 조회 중…" : "아직 저장한 이력이 없습니다."}
          </p>
        )}
        {history.map((row) => (
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
                    {label}: {value(row.before?.[key])} →{" "}
                    {value(row.after[key])}
                  </small>
                ))}
              <time>{new Date(row.at).toLocaleString("ko-KR")}</time>
            </div>
          </div>
        ))}
      </details>
    </>
  );
}
