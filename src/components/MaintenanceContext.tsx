"use client";
import { useEffect, useRef, useState } from "react";
import { MaintenanceEditor, type MaintenanceDraft } from "./MaintenancePanel";
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
    planId: planId ?? "unassigned",
    pointId: pointId ?? "unassigned",
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
          setDraft(initialDraft(item, photoId));
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
        await done("보수 기록과 변경 이력을 저장했습니다.");
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
