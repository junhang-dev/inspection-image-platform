"use client";

import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { MaintenanceBundle } from "@/lib/maintenance";
import type { MaintenanceWorklistRow } from "./MaintenancePanel";
import styles from "./MaintenanceBundleWorkspace.module.css";
import { useAuth } from "./AuthProvider";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const statusLabels: Record<string, string> = {
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
  none: "등록 전",
};
const statusStyles: Record<string, string> = {
  review: styles.review,
  planned: styles.planned,
  progress: styles.progress,
  done: styles.done,
  none: styles.none,
};
const uniqueValues = (values: (string | null | undefined)[]) => [
  ...new Set(values.filter((value): value is string => Boolean(value))),
];

export function MaintenanceBundleWorkspace({
  bundles,
  loading,
  error,
  hasCachedData,
  onRetry,
  retryScopeKey,
  onOpen,
}: {
  bundles: readonly {
    bundle: MaintenanceBundle;
    matchingMemberIds: ReadonlySet<string>;
  }[];
  loading: boolean;
  error?: string | null;
  hasCachedData: boolean;
  onRetry?: () => void;
  retryScopeKey?: string;
  onOpen: (item: MaintenanceWorklistRow) => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryFocus = useRef<{ scopeKey: string | undefined } | null>(null);
  useLayoutEffect(() => {
    if (!retryFocus.current) return;
    if (retryFocus.current.scopeKey !== retryScopeKey) {
      retryFocus.current = null;
      return;
    }
    if (error) return;
    retryFocus.current = null;
    if (document.activeElement === document.body)
      headingRef.current?.focus({ preventScroll: true });
  }, [error, retryScopeKey]);
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <header className={styles.heading}>
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          작업 묶음
        </h2>
        <strong className={styles.total}>
          {loading ? "조회 중" : error ? "미조회" : `${bundles.length}개`}
        </strong>
      </header>
      {error && (
        <>
          <p className={styles.error} role="alert">
            작업 묶음을 불러오지 못했습니다.{" "}
            {hasCachedData && "마지막 정상 조회 결과를 표시 중입니다. "}
            {error}
          </p>
          {onRetry && (
            <button
              type="button"
              className="text-button"
              aria-label="작업 묶음 다시 조회"
              onFocus={() => {
                retryFocus.current = { scopeKey: retryScopeKey };
              }}
              onBlur={() => {
                retryFocus.current = null;
              }}
              onClick={onRetry}
            >
              다시 조회
            </button>
          )}
        </>
      )}
      {bundles.length ? (
        <div className={styles.bundleList}>
          {bundles.map(({ bundle, matchingMemberIds }) => {
            const plans = uniqueValues(
              bundle.members.map((member) => member.planTitle),
            );
            const matchingMemberCount = matchingMemberIds.size;
            return (
              <details className={styles.bundle} key={bundle.id}>
                <summary className={styles.summary}>
                  <span className={styles.bundleTitle}>
                    <strong>{bundle.name}</strong>
                    <small>
                      {bundle.members.length}장 ·{" "}
                      {plans.length === 1
                        ? plans[0]
                        : plans.length
                          ? `여러 검사계획 ${plans.length}개`
                          : "계획 미확인"}
                    </small>
                    {matchingMemberCount < bundle.members.length && (
                      <small>
                        조건 일치 {matchingMemberCount}/{bundle.members.length}
                        장{" · 전체 구성 표시"}
                      </small>
                    )}
                  </span>
                  <span
                    className={styles.stateCounts}
                    aria-label="사진별 진행 상태"
                  >
                    {(["review", "planned", "progress", "done"] as const).map(
                      (status) =>
                        bundle.statusCounts[status] > 0 && (
                          <span
                            key={status}
                            className={`${styles.status} ${statusStyles[status]}`}
                          >
                            {statusLabels[status]} {bundle.statusCounts[status]}
                          </span>
                        ),
                    )}
                    {bundle.statusCounts.none > 0 && (
                      <span className={`${styles.status} ${statusStyles.none}`}>
                        등록 전 {bundle.statusCounts.none}
                      </span>
                    )}
                    {bundle.inactiveCount > 0 && (
                      <span className={`${styles.status} ${statusStyles.none}`}>
                        TA 제외 {bundle.inactiveCount}
                      </span>
                    )}
                  </span>
                  <ChevronDown
                    className={styles.chevron}
                    size={18}
                    aria-hidden="true"
                  />
                </summary>
                <div className={styles.memberContent}>
                  <div className={styles.tableWrap}>
                    <table className={styles.memberTable}>
                      <thead>
                        <tr>
                          <th scope="col">사진</th>
                          <th scope="col">검사계획 · 위치</th>
                          <th scope="col">등급</th>
                          <th scope="col">진행 상태</th>
                          <th scope="col">
                            <span className={styles.srOnly}>상세</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {bundle.members.map((member) => {
                          const matchesCurrentScope = matchingMemberIds.has(
                            member.id,
                          );
                          return (
                            <tr
                              key={member.id}
                              className={
                                member.missing ? undefined : styles.memberRow
                              }
                              onClick={(event) => {
                                const target = event.target;
                                if (
                                  target instanceof Element &&
                                  target.closest(
                                    "button, a, input, select, label",
                                  )
                                ) {
                                  return;
                                }
                                if (!member.missing) onOpen(member);
                              }}
                            >
                              <td>
                                <span className={styles.photoCell}>
                                  <span
                                    className={styles.thumb}
                                    aria-hidden="true"
                                  >
                                    {member.photoVisibility === "hidden" ? (
                                      <small>숨김 사진</small>
                                    ) : member.targetId ? (
                                      <img
                                        src={`${apiBase}/api/inspections/${member.targetId}/thumbnail`}
                                        alt=""
                                        loading="lazy"
                                      />
                                    ) : null}
                                  </span>
                                  <span>
                                    <strong>
                                      {member.photoName || "사진 이름 미조회"}
                                    </strong>
                                    {matchingMemberCount <
                                      bundle.members.length &&
                                      matchesCurrentScope && (
                                        <small className={styles.scopeMatch}>
                                          조건 일치
                                        </small>
                                      )}
                                    {!!member.newEvidenceCount && (
                                      <small className={styles.attention}>
                                        새 근거 {member.newEvidenceCount}
                                      </small>
                                    )}
                                    {member.missing && (
                                      <small>
                                        연결된 사진을 조회할 수 없음
                                      </small>
                                    )}
                                    {!member.missing &&
                                      (!member.inWorklist ||
                                        !member.ta ||
                                        member.visibility !== "visible" ||
                                        member.photoVisibility ===
                                          "hidden") && (
                                        <small>
                                          현재 TA 보수 대상에서 제외됨
                                        </small>
                                      )}
                                  </span>
                                </span>
                              </td>
                              <td>
                                <span className={styles.memberContext}>
                                  <strong>
                                    {member.planTitle || "계획 미확인"}
                                  </strong>
                                  <small>
                                    {member.pointLabel || "위치 미확인"}
                                  </small>
                                </span>
                              </td>
                              <td>
                                {Number.isInteger(member.photoGrade)
                                  ? `${member.photoGrade}등급`
                                  : "미확인"}
                              </td>
                              <td>
                                <span
                                  className={`${styles.status} ${statusStyles[member.repairStatus] || statusStyles.none}`}
                                >
                                  {statusLabels[member.repairStatus] ||
                                    "상태 미확인"}
                                </span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className={styles.openButton}
                                  disabled={member.missing}
                                  onClick={() => onOpen(member)}
                                >
                                  기록 열기
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      ) : loading ? (
        <div className={styles.empty} role="status">
          작업 묶음을 불러오는 중입니다.
        </div>
      ) : error ? null : (
        <div className={styles.empty} role="status">
          현재 조건에 맞는 작업 묶음이 없습니다.
        </div>
      )}
    </section>
  );
}

export function MaintenanceBundleComposer({
  selectedMembers,
  selectedCount,
  selectionStartRef,
  name,
  busy,
  error,
  onNameChange,
  onClear,
  onRemove,
  onCloseActionVisibilityChange,
  onClose,
  onCreate,
}: {
  selectedMembers: readonly {
    id: string;
    photoName: string;
    planTitle: string | null;
    pointLabel: string;
  }[];
  selectedCount: number;
  selectionStartRef?: RefObject<HTMLInputElement | null>;
  name: string;
  busy: boolean;
  error?: string;
  onNameChange: (name: string) => void;
  onClear: () => void;
  onRemove: (id: string) => void;
  onCloseActionVisibilityChange: (visible: boolean) => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const { can } = useAuth();
  const canWrite = can("work.write");
  const inputId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const nextFocusId = useRef<string | null>(null);
  const focusNameInput = useRef(false);
  const initialFocusHandled = useRef(false);
  const previousSelectedCount = useRef(selectedCount);
  useEffect(() => {
    if (!canWrite) return;
    if (initialFocusHandled.current) return;
    initialFocusHandled.current = true;

    if (selectedCount > 0) {
      nameInputRef.current?.focus();
      return;
    }

    const selectionStart = selectionStartRef?.current;
    if (selectionStart && !selectionStart.disabled) {
      selectionStart.focus();
    } else {
      nameInputRef.current?.focus();
    }
  }, [canWrite, selectedCount, selectionStartRef]);
  useEffect(() => {
    const previousCount = previousSelectedCount.current;
    previousSelectedCount.current = selectedCount;
    const activeElement = document.activeElement;
    const hasKeyboardFocus =
      activeElement instanceof HTMLElement &&
      activeElement.matches(":focus-visible");
    if (canWrite && previousCount < 2 && selectedCount >= 2 && hasKeyboardFocus) {
      nameInputRef.current?.focus();
    }
  }, [canWrite, selectedCount]);
  useEffect(() => {
    if (nextFocusId.current) {
      removeButtons.current.get(nextFocusId.current)?.focus();
      nextFocusId.current = null;
    } else if (focusNameInput.current) {
      nameInputRef.current?.focus();
      focusNameInput.current = false;
    }
  }, [selectedMembers]);
  useEffect(() => {
    const closeButton = closeButtonRef.current;
    if (!closeButton || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        onCloseActionVisibilityChange(
          entry.isIntersecting && entry.intersectionRatio >= 0.75,
        );
      },
      { threshold: [0, 0.75] },
    );
    observer.observe(closeButton);

    return () => {
      observer.disconnect();
      onCloseActionVisibilityChange(false);
    };
  }, [onCloseActionVisibilityChange]);
  return (
    <section className={styles.composer} aria-labelledby={`${inputId}-heading`}>
      <div className={styles.composerHeading}>
        <h3 id={`${inputId}-heading`}>새 작업 묶음</h3>
        {selectedCount > 0 && (
          <span className={styles.selectedCount}>{selectedCount}장 선택</span>
        )}
        <button
          type="button"
          className={styles.closeButton}
          ref={closeButtonRef}
          aria-expanded={true}
          onClick={onClose}
          disabled={busy}
        >
          작성 접기
        </button>
      </div>
      {selectedMembers.length > 0 && (
        <ul className={styles.selectedList} aria-label="선택한 사진 목록">
          {selectedMembers.map((member) => (
            <li className={styles.selectedItem} key={member.id}>
              <span className={styles.selectedDetails}>
                <strong>{member.photoName}</strong>
                <small>
                  {member.planTitle || "계획 미지정"} · {member.pointLabel}
                </small>
              </span>
              <button
                type="button"
                className={styles.selectedRemoveButton}
                aria-label={`선택 해제: ${member.photoName}`}
                ref={(button) => {
                  if (button) removeButtons.current.set(member.id, button);
                  else removeButtons.current.delete(member.id);
                }}
                disabled={busy || !canWrite}
                onClick={() => {
                  if (!canWrite || busy) return;
                  const index = selectedMembers.findIndex(
                    (selectedMember) => selectedMember.id === member.id,
                  );
                  const nextMember =
                    selectedMembers[index + 1] ?? selectedMembers[index - 1];
                  nextFocusId.current = nextMember?.id ?? null;
                  focusNameInput.current = !nextMember;
                  onRemove(member.id);
                }}
              >
                해제
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.composerFields}>
        <label htmlFor={inputId}>작업 묶음 이름</label>
        <input
          ref={nameInputRef}
          id={inputId}
          value={name}
          maxLength={100}
          onChange={(event) => {
            if (canWrite && !busy) onNameChange(event.currentTarget.value);
          }}
          placeholder="예: 정유2팀 파이프랙 3 보수"
          disabled={busy || !canWrite}
        />
        <button
          type="button"
          className={styles.createButton}
          disabled={busy || !canWrite || selectedCount < 2 || !name.trim()}
          onClick={() => {
            if (canWrite && !busy && selectedCount >= 2 && name.trim()) onCreate();
          }}
        >
          {busy ? "묶음 저장 중…" : "작업 묶음 만들기"}
        </button>
        {selectedCount > 0 && (
          <button
            type="button"
            className={styles.clearButton}
            disabled={busy || !canWrite}
            onClick={() => {
              if (!canWrite || busy) return;
              focusNameInput.current = true;
              onClear();
            }}
          >
            전체 해제
          </button>
        )}
      </div>
      {!canWrite ? (
        <p className={styles.help} role="status">
          조회 권한에서는 작업 묶음을 만들 수 없습니다.
        </p>
      ) : selectedCount < 2 && (
        <p className={styles.help} role="status">
          {selectedCount === 1
            ? "사진을 한 장 더 선택하세요."
            : "목록에서 사진을 2장 이상 선택하세요."}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
