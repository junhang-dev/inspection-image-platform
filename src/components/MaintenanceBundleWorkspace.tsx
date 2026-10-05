"use client";

import { useId } from "react";
import { ChevronDown } from "lucide-react";
import type { MaintenanceBundle } from "@/lib/maintenance";
import type { MaintenanceWorklistRow } from "./MaintenancePanel";
import styles from "./MaintenanceBundleWorkspace.module.css";

const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const statusLabels: Record<string, string> = {
  review: "검토 필요",
  planned: "작업 예정",
  progress: "작업 중",
  done: "완료",
  none: "상태 미지정",
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
  onOpen,
}: {
  bundles: readonly MaintenanceBundle[];
  loading: boolean;
  error?: string | null;
  onOpen: (item: MaintenanceWorklistRow) => void;
}) {
  const headingId = useId();
  return (
    <section className={styles.root} aria-labelledby={headingId}>
      <header className={styles.heading}>
        <h2 id={headingId}>만든 작업 묶음</h2>
        <strong className={styles.total}>{bundles.length}개</strong>
      </header>
      {error && (
        <p className={styles.error} role="alert">
          작업 묶음을 불러오지 못했습니다. {error}
        </p>
      )}
      {bundles.length ? (
        <div className={styles.bundleList}>
          {bundles.map((bundle) => {
            const plans = uniqueValues(
              bundle.members.map((member) => member.planTitle),
            );
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
                        상태 미지정 {bundle.statusCounts.none}
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
                        {bundle.members.map((member) => (
                          <tr key={member.id}>
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
                                  {!!member.newEvidenceCount && (
                                    <small className={styles.attention}>
                                      새 근거 {member.newEvidenceCount}
                                    </small>
                                  )}
                                  {member.missing && (
                                    <small>연결된 사진을 조회할 수 없음</small>
                                  )}
                                  {!member.missing &&
                                    (!member.inWorklist ||
                                      !member.ta ||
                                      member.visibility !== "visible" ||
                                      member.photoVisibility === "hidden") && (
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
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty} role="status">
          {loading
            ? "작업 묶음을 불러오는 중입니다."
            : "저장된 작업 묶음이 없습니다."}
        </div>
      )}
    </section>
  );
}

export function MaintenanceBundleComposer({
  selectedCount,
  name,
  busy,
  error,
  onNameChange,
  onClear,
  onClose,
  onCreate,
}: {
  selectedCount: number;
  name: string;
  busy: boolean;
  error?: string;
  onNameChange: (name: string) => void;
  onClear: () => void;
  onClose: () => void;
  onCreate: () => void;
}) {
  const inputId = useId();
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
          onClick={onClose}
          disabled={busy}
        >
          닫기
        </button>
      </div>
      <div className={styles.composerFields}>
        <label htmlFor={inputId}>작업 묶음 이름</label>
        <input
          id={inputId}
          value={name}
          maxLength={100}
          onChange={(event) => onNameChange(event.currentTarget.value)}
          placeholder="예: 정유2팀 파이프랙 3 보수"
          disabled={busy}
        />
        <button
          type="button"
          className={styles.createButton}
          disabled={busy || selectedCount < 2 || !name.trim()}
          onClick={onCreate}
        >
          {busy ? "묶음 저장 중…" : "작업 묶음 만들기"}
        </button>
        {selectedCount > 0 && (
          <button
            type="button"
            className={styles.clearButton}
            disabled={busy}
            onClick={onClear}
          >
            선택 해제
          </button>
        )}
      </div>
      {selectedCount < 2 && (
        <p className={styles.help}>
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
