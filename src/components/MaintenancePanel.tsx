"use client";

import { useId } from "react";
import styles from "./MaintenancePanel.module.css";

export type RepairStatus = "none" | "review" | "planned" | "progress" | "done";
export type RepairMethod = "undecided" | "paint" | "replace";
export type MaintenanceItem = {
  id: string;
  planId: string | null;
  pointId: string | null;
  targetType?: "point" | "photo";
  targetId?: string;
  sourcePointId?: string | null;
  photoName?: string;
  photoGrade?: number | null;
  planTitle?: string | null;
  pointLabel?: string;
  persisted?: boolean;
  inclusionMode?: "auto" | "include" | "exclude";
  visibility?: "visible" | "hidden";
  evidenceVersions?: Record<string, string>;
  newEvidenceCount?: number;
  photoIds: readonly string[];
  repairStatus: RepairStatus;
  repairMethod: RepairMethod;
  inWorklist: boolean;
  ta: boolean;
  editVersion: number;
};
export type MaintenanceDraft = Pick<
  MaintenanceItem,
  "repairStatus" | "repairMethod" | "inWorklist" | "ta" | "photoIds"
> & {
  actor: string;
  reason: string;
  inclusionMode: "auto" | "include" | "exclude";
  visibility: "visible" | "hidden";
  acknowledgedEvidence?: Record<string, string>;
};
export type MaintenancePhoto = {
  id: string;
  name: string;
  grade?: number | null;
};

const statusLabels: Record<RepairStatus, string> = {
  none: "등록 전",
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
};
const methodLabels: Record<RepairMethod, string> = {
  undecided: "미정",
  paint: "도장",
  replace: "교체",
};
const statusClass: Record<RepairStatus, string> = {
  none: styles.muted,
  review: styles.amber,
  planned: styles.blue,
  progress: styles.blue,
  done: styles.green,
};
function pageNumberWindow(page: number, pages: number) {
  const count = Math.min(5, pages);
  const start = Math.max(1, Math.min(page - 2, pages - count + 1));
  return Array.from({ length: count }, (_, index) => start + index);
}

export type MaintenanceEditorProps = {
  /** Opening-basis item, not a poll-refreshed replacement for the parent's CAS version. */
  saved: MaintenanceItem | null;
  draft: MaintenanceDraft;
  onChange: (draft: MaintenanceDraft) => void;
  /** Parent owns API errors, expectedVersion, and the synchronous action lock. */
  onSave: () => void;
  busy: boolean;
  error: string | null;
  /** null means unassigned; an empty title means the known plan's name is unavailable. */
  planTitle: string | null;
  pointLabel: string;
  photos: readonly MaintenancePhoto[];
  selectedPhotoNames?: Readonly<Record<string, string>>;
};

/**
 * Controlled editor: never resets the draft on success, failure, polling, or item
 * changes. The parent owns draft/basis lifetime. Mount outside another form.
 * Membership buttons stage a change; only the final submit invokes onSave.
 */
export function MaintenanceEditor({
  saved,
  draft,
  onChange,
  onSave,
  busy,
  error,
  planTitle,
  pointLabel,
  photos,
  selectedPhotoNames = {},
}: MaintenanceEditorProps) {
  const uid = useId();
  const titleId = `${uid}-heading`,
    errorId = `${uid}-error`,
    membershipId = `${uid}-membership`;
  const update = (patch: Partial<MaintenanceDraft>) => {
    if (!busy) onChange({ ...draft, ...patch });
  };
  const uniquePhotos = [
    ...new Map(photos.map((photo) => [photo.id, photo])).values(),
  ];
  const availableIds = new Set(uniquePhotos.map((photo) => photo.id));
  const missingSelected = draft.photoIds.filter((id) => !availableIds.has(id));
  const membershipChanged = (saved?.inWorklist ?? false) !== draft.inWorklist;
  const validStatus = Object.hasOwn(statusLabels, draft.repairStatus);
  const validMethod = Object.hasOwn(methodLabels, draft.repairMethod);
  const membershipLabel = membershipChanged
    ? draft.inWorklist
      ? "저장 시 등록"
      : "저장 시 해제"
    : draft.inWorklist
      ? "등록됨"
      : "미등록";

  return (
    <section className={styles.root} aria-labelledby={titleId}>
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>검사 대상별 보수 기록</p>
          <h3 id={titleId}>보수 검토</h3>
        </div>
        <span
          className={`${styles.badge} ${saved ? styles.green : styles.muted}`}
        >
          {saved ? "저장된 기록" : "새 기록"}
        </span>
      </header>
      <dl className={styles.context}>
        <div>
          <dt>검사 계획</dt>
          <dd>
            {planTitle === null
              ? "계획 미지정"
              : planTitle || "계획 이름 미조회"}
          </dd>
        </div>
        <div>
          <dt>검사 대상</dt>
          <dd>{pointLabel || "포인트 이름 미조회"}</dd>
        </div>
      </dl>
      <form
        className={styles.form}
        aria-describedby={error ? errorId : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          if (
            !busy &&
            validStatus &&
            validMethod &&
            draft.actor.trim() &&
            draft.reason.trim()
          )
            onSave();
        }}
      >
        <fieldset disabled={busy} className={styles.fields}>
          <legend className={styles.srOnly}>보수 기록 편집</legend>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              <span>업무 상태</span>
              <select
                value={draft.repairStatus}
                onChange={(event) =>
                  update({ repairStatus: event.target.value as RepairStatus })
                }
              >
                {!validStatus && (
                  <option value={draft.repairStatus} disabled>
                    확인되지 않은 상태
                  </option>
                )}
                {(Object.entries(statusLabels) as [RepairStatus, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label className={styles.field}>
              <span>작업 방법</span>
              <select
                value={draft.repairMethod}
                onChange={(event) =>
                  update({ repairMethod: event.target.value as RepairMethod })
                }
              >
                {!validMethod && (
                  <option value={draft.repairMethod} disabled>
                    확인되지 않은 방법
                  </option>
                )}
                {(Object.entries(methodLabels) as [RepairMethod, string][]).map(
                  ([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          <p className={styles.help}>
            상태와 방법은 별도로 기록합니다. 사진 등급만으로 보수 방법이나 완료
            여부가 결정되지 않습니다.
          </p>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={draft.ta}
              onChange={(event) => update({ ta: event.target.checked })}
            />
            <span>TA에 포함</span>
          </label>
          <div className={styles.formGrid}>
            <label className={styles.field}>
              워크리스트 반영
              <select
                value={draft.inclusionMode}
                onChange={(event) =>
                  update({
                    inclusionMode: event.target
                      .value as MaintenanceDraft["inclusionMode"],
                  })
                }
              >
                <option value="auto">등급에 따라 자동 반영</option>
                <option value="include">수동으로 포함 유지</option>
                <option value="exclude">수동 제외 유지</option>
              </select>
            </label>
            <label className={styles.field}>
              항목 표시
              <select
                value={draft.visibility}
                onChange={(event) =>
                  update({
                    visibility: event.target
                      .value as MaintenanceDraft["visibility"],
                  })
                }
              >
                <option value="visible">표시·복원</option>
                <option value="hidden">삭제 (복원 가능)</option>
              </select>
            </label>
          </div>
          <p className={styles.help}>
            유효 3~5등급은 자동 반영됩니다. 수동 제외·삭제는 재판독 뒤에도
            유지되고, 상태와 이력은 보존됩니다.
          </p>
          {!!saved?.newEvidenceCount && (
            <p className={styles.warning}>
              완료 후 새로 확인할 근거 {saved.newEvidenceCount}개가 있습니다.
            </p>
          )}
          {draft.repairStatus === "done" && (
            <div className={styles.membership}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() =>
                  update({
                    acknowledgedEvidence: Object.fromEntries(
                      uniquePhotos
                        .filter((photo) => saved?.evidenceVersions?.[photo.id])
                        .map((photo) => [
                          photo.id,
                          saved!.evidenceVersions![photo.id],
                        ]),
                    ),
                  })
                }
              >
                현재 페이지의 판독 근거 확인
              </button>
              <p className={styles.help}>
                {draft.acknowledgedEvidence
                  ? `${Object.keys(draft.acknowledgedEvidence).length}개 근거 확인을 저장합니다.`
                  : "완료 상태만 저장해도 새 근거가 확인 처리되지는 않습니다."}
              </p>
            </div>
          )}
          <fieldset className={styles.evidence}>
            <legend>
              근거 사진 <span>{draft.photoIds.length}개 선택</span>
            </legend>
            {uniquePhotos.length > 0 ? (
              <ul className={styles.photoList}>
                {uniquePhotos.map((photo) => {
                  const checked = draft.photoIds.includes(photo.id);
                  return (
                    <li key={photo.id}>
                      <label
                        className={`${styles.photoChoice} ${checked ? styles.selectedPhoto : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={saved?.targetType === "photo"}
                          onChange={(event) =>
                            update({
                              photoIds: event.target.checked
                                ? [...draft.photoIds, photo.id]
                                : draft.photoIds.filter(
                                    (id) => id !== photo.id,
                                  ),
                            })
                          }
                        />
                        <span>
                          <strong>{photo.name || "사진 이름 미조회"}</strong>
                          <small>
                            {Number.isInteger(photo.grade) &&
                            photo.grade! >= 1 &&
                            photo.grade! <= 5
                              ? `표시 등급 ${photo.grade}`
                              : "등급 미확인"}
                          </small>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.emptyEvidence}>
                선택할 사진이 없습니다. 근거 사진 없이 기록할 수 있습니다.
              </p>
            )}
            {missingSelected.length > 0 && (
              <div className={styles.warning}>
                <p>
                  선택한 사진 {missingSelected.length}개가 현재 페이지 밖에
                  있습니다. 선택은 유지됩니다. 이동한 사진 등 불필요한 선택은
                  개별 해제할 수 있습니다.
                </p>
                <ul className={styles.photoList}>
                  {missingSelected.map((id) => (
                    <li key={id}>
                      <span>
                        {selectedPhotoNames[id] ||
                          `선택 사진 ${id.slice(0, 8)}`}
                      </span>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        aria-label={`${selectedPhotoNames[id] || id} 근거 선택 해제`}
                        onClick={() =>
                          update({
                            photoIds: draft.photoIds.filter(
                              (selected) => selected !== id,
                            ),
                          })
                        }
                      >
                        이 선택 해제
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </fieldset>
          <label className={styles.field}>
            <span>
              수정자 <small>필수</small>
            </span>
            <input
              value={draft.actor}
              onChange={(event) => update({ actor: event.target.value })}
              required
              maxLength={60}
              autoComplete="off"
            />
          </label>
          <label className={styles.field}>
            <span>
              변경 사유 <small>필수</small>
            </span>
            <textarea
              value={draft.reason}
              onChange={(event) => update({ reason: event.target.value })}
              required
              maxLength={1000}
              rows={3}
              placeholder="상태·방법 변경 또는 워크리스트 등록·해제 이유"
            />
          </label>
        </fieldset>
        {error && (
          <p className={styles.error} id={errorId} role="alert">
            {error}
            <span>입력 내용은 유지됩니다.</span>
          </p>
        )}
        {(!validStatus || !validMethod) && (
          <p className={styles.error} role="alert">
            업무 상태와 작업 방법을 확인한 뒤 저장해 주세요.
          </p>
        )}
        <footer className={styles.editorFooter}>
          <p>변경 내용과 사유를 함께 저장합니다.</p>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={
              busy ||
              !validStatus ||
              !validMethod ||
              !draft.actor.trim() ||
              !draft.reason.trim()
            }
          >
            {busy ? "저장 중…" : "저장 반영"}
          </button>
        </footer>
        <span className={styles.srOnly} role="status">
          {busy ? "보수 기록을 저장하고 있습니다." : ""}
        </span>
      </form>
    </section>
  );
}

export type MaintenanceWorklistRow = MaintenanceItem & {
  recordPurpose?: "inspection" | "presentation" | "verification";
  planTitle: string | null;
  pointLabel: string;
  photoName?: string;
  photoGrade?: number | null;
  teamId?: string | null;
  rackId?: string | null;
  photoVisibility?: "visible" | "hidden";
  missing?: boolean;
  /** Pass the server's evidence count; null means unavailable. */
  photoCount: number | null;
};
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
export type MaintenanceWorklistProps = {
  /** Parent supplies already-filtered worklist rows. No client-side re-filtering. */
  items: readonly MaintenanceWorklistRow[];
  /** Server total under the current filters; never derived from this page's rows. */
  total: number | null;
  page?: number;
  pages?: number;
  pageSize?: number;
  onPageSizeChange?: (pageSize: number) => void;
  title?: string;
  selectionActionLabel?: string;
  selectionActionExpanded?: boolean;
  onSelectionAction?: () => void;
  emptyDescription?: string;
  onPageChange?: (page: number) => void;
  busy?: boolean;
  error?: string | null;
  onOpen: (item: MaintenanceWorklistRow) => void;
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (item: MaintenanceWorklistRow, selected: boolean) => void;
};

export function MaintenanceWorklist({
  items,
  total,
  page,
  pages,
  pageSize = 10,
  onPageSizeChange,
  title = "대상 목록",
  selectionActionLabel,
  selectionActionExpanded = false,
  onSelectionAction,
  emptyDescription = "보수 필요 사진이 자동으로 모입니다. 목록에서 사진을 선택해 작업 방법과 TA 포함 여부를 관리하세요.",
  onPageChange,
  busy = false,
  error,
  onOpen,
  selectedIds,
  onSelectionChange,
}: MaintenanceWorklistProps) {
  const titleId = useId();
  const validTotal =
    total !== null && Number.isSafeInteger(total) && total >= 0;
  const pagination =
    Number.isSafeInteger(page) &&
    page! >= 1 &&
    Number.isSafeInteger(pages) &&
    pages! >= 1;
  return (
    <section className={styles.root} aria-labelledby={titleId} aria-busy={busy}>
      <header className={`${styles.heading} ${styles.worklistHeading}`}>
        <h3 id={titleId}>{title}</h3>
        {onSelectionChange && onSelectionAction && (
          <button
            type="button"
            className={styles.secondaryButton}
            aria-expanded={selectionActionExpanded}
            onClick={onSelectionAction}
          >
            {selectionActionLabel || "작업 묶음 만들기"}
          </button>
        )}
      </header>
      {error && (
        <p className={styles.error} role="alert">
          {error}
          {items.length > 0 && <span>마지막으로 조회한 목록입니다.</span>}
        </p>
      )}
      {items.length > 0 ? (
        <div className={styles.workTableWrap}>
          <table className={styles.workTable}>
            <thead>
              <tr>
                {onSelectionChange && (
                  <th scope="col">
                    <span className={styles.srOnly}>묶음 선택</span>
                  </th>
                )}
                <th scope="col">검사 사진</th>
                <th scope="col">검사계획 · 위치</th>
                <th scope="col">등급</th>
                <th scope="col">진행 상태</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  {onSelectionChange && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${item.photoName || "검사 사진"} 작업 묶음에 선택`}
                        checked={selectedIds?.has(item.id) ?? false}
                        disabled={busy || !item.persisted || item.missing}
                        onChange={(event) =>
                          onSelectionChange(item, event.currentTarget.checked)
                        }
                      />
                    </td>
                  )}
                  <td>
                    <button
                      type="button"
                      className={styles.workPhotoButton}
                      aria-label={`보수 기록 열기: ${item.photoName || "검사 사진"}`}
                      disabled={busy}
                      onClick={() => onOpen(item)}
                    >
                      <span className={styles.workThumb} aria-hidden="true">
                        {item.targetId && (
                          <img
                            src={`${apiBase}/api/inspections/${item.targetId}/thumbnail`}
                            alt=""
                            loading="lazy"
                          />
                        )}
                      </span>
                      <span>
                        <strong>{item.photoName || "사진 이름 미조회"}</strong>
                        {!!item.newEvidenceCount && (
                          <small>새 근거 {item.newEvidenceCount}</small>
                        )}
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className={styles.workContext}>
                      <strong>{item.planTitle || "계획 미지정"}</strong>
                      <small>{item.pointLabel || "위치 미확인"}</small>
                    </span>
                  </td>
                  <td>
                    {Number.isInteger(item.photoGrade) &&
                    item.photoGrade! >= 1 &&
                    item.photoGrade! <= 5
                      ? `${item.photoGrade}등급`
                      : "등급 미확인"}
                  </td>
                  <td>
                    <span
                      className={`${styles.badge} ${statusClass[item.repairStatus] || styles.muted}`}
                    >
                      {statusLabels[item.repairStatus] || "상태 미확인"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.empty} role="status">
          <strong>
            {busy
              ? "워크리스트를 불러오는 중입니다."
              : error
                ? "워크리스트를 조회하지 못했습니다."
                : validTotal && total > 0
                  ? "이 페이지에 표시할 항목이 없습니다."
                  : "표시할 워크리스트 항목이 없습니다."}
          </strong>
          {!busy && !error && <p>{emptyDescription}</p>}
        </div>
      )}
      {pagination && (
        <nav className={styles.pagination} aria-label="워크리스트 페이지">
          <span className={styles.paginationSummary}>
            {validTotal ? `전체 ${total}건 · ` : ""}
            {page} / {pages}페이지
          </span>
          <div className={styles.paginationControls}>
            <label className={styles.pageSizeControl}>
              한 화면에 보기
              <select
                aria-label="한 화면에 보기"
                value={pageSize}
                disabled={busy || !onPageSizeChange}
                onChange={(event) =>
                  onPageSizeChange?.(Number(event.target.value))
                }
              >
                <option value={10}>10장</option>
                <option value={25}>25장</option>
                <option value={50}>50장</option>
              </select>
            </label>
            {onPageChange && (
              <div className={styles.paginationButtons}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || page! <= 1}
                  onClick={() => {
                    if (!busy && page! > 1) onPageChange(1);
                  }}
                >
                  처음
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || page! <= 1}
                  onClick={() => {
                    if (!busy && page! > 1) onPageChange(page! - 1);
                  }}
                >
                  이전
                </button>
                {page! > 3 && pages! > 5 && (
                  <span className={styles.pageEllipsis} aria-hidden="true">
                    …
                  </span>
                )}
                {pageNumberWindow(page!, pages!).map((pageNumber) => (
                  <button
                    key={pageNumber}
                    type="button"
                    className={`${styles.secondaryButton} ${styles.pageNumber}${pageNumber === page ? ` ${styles.pageNumberSelected}` : ""}`}
                    aria-current={pageNumber === page ? "page" : undefined}
                    disabled={busy || pageNumber === page}
                    onClick={() => onPageChange(pageNumber)}
                  >
                    {pageNumber}
                  </button>
                ))}
                {page! < pages! - 2 && pages! > 5 && (
                  <span className={styles.pageEllipsis} aria-hidden="true">
                    …
                  </span>
                )}
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || page! >= pages!}
                  onClick={() => {
                    if (!busy && page! < pages!) onPageChange(page! + 1);
                  }}
                >
                  다음
                </button>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={busy || page! >= pages!}
                  onClick={() => {
                    if (!busy && page! < pages!) onPageChange(pages!);
                  }}
                >
                  마지막
                </button>
              </div>
            )}
          </div>
        </nav>
      )}
    </section>
  );
}
