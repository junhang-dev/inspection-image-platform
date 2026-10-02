export type RackActionKind =
  | "create-plan"
  | "add-photo"
  | "choose-photo-plan"
  | "review-maintenance"
  | "inspect-photos"
  | "retry-data"
  | "retry-photos"
  | "retry-maintenance"
  | "retry-plan-photos";

export type RackGuidance = {
  tone: "loading" | "attention" | "calm";
  message: string;
  actions: { kind: RackActionKind; label: string }[];
};

type RackPlan = { id: string; status: "planned" | "done" | "cancelled" };
type PhotoState = {
  pending: number;
  unread: number;
  error: number;
  retake: number;
};

export function getRackGuidance({
  plansLoaded,
  dataError,
  plans,
  planPhotoCounts,
  planPhotosError,
  photoTotal,
  photoSummary,
  photosError,
  maintenanceTotal,
  maintenanceReviewTotal,
  maintenanceError,
  hasPointHistory,
}: {
  plansLoaded: boolean;
  dataError: boolean;
  plans: readonly RackPlan[];
  planPhotoCounts: Record<string, { total: number }> | null;
  planPhotosError: boolean;
  photoTotal: number | null;
  photoSummary: PhotoState | null;
  photosError: boolean;
  maintenanceTotal: number | null;
  maintenanceReviewTotal: number | null;
  maintenanceError: boolean;
  hasPointHistory: boolean;
}): RackGuidance {
  const waiting = (
    message = "계획·사진·보수 현황을 확인하는 중입니다.",
  ): RackGuidance => ({
    tone: "loading",
    message,
    actions: [],
  });
  const attention = (
    message: string,
    kind: RackActionKind,
    label: string,
  ): RackGuidance => ({
    tone: "attention",
    message,
    actions: [{ kind, label }],
  });
  if (dataError)
    return attention(
      "공장 업무 정보를 조회하지 못했습니다.",
      "retry-data",
      "기본 정보 다시 조회",
    );
  if (!plansLoaded) return waiting();
  if (photosError)
    return attention(
      "사진 현황을 조회하지 못했습니다.",
      "retry-photos",
      "사진 다시 조회",
    );
  if (maintenanceError)
    return attention(
      "보수 현황을 조회하지 못했습니다.",
      "retry-maintenance",
      "보수 다시 조회",
    );
  if (
    photoTotal === null ||
    photoSummary === null ||
    maintenanceTotal === null ||
    maintenanceReviewTotal === null
  )
    return waiting();

  const active = plans.filter((plan) => plan.status === "planned");
  if (active.length && planPhotosError)
    return attention(
      "계획별 사진 현황을 조회하지 못했습니다.",
      "retry-plan-photos",
      "계획별 사진 다시 조회",
    );
  if (active.length && !planPhotoCounts)
    return waiting("계획별 사진 현황을 확인하는 중입니다.");
  if (
    active.some((plan) => !Number.isInteger(planPhotoCounts?.[plan.id]?.total))
  ) {
    return attention(
      "계획별 사진 수를 확인할 수 없습니다.",
      "retry-plan-photos",
      "계획별 사진 다시 조회",
    );
  }

  const emptyActive = active.filter(
    (plan) => planPhotoCounts?.[plan.id]?.total === 0,
  );
  const actions: RackGuidance["actions"] = [];
  let message = "";
  if (emptyActive.length) {
    message = `진행 중인 계획 ${emptyActive.length}개에 이 랙의 검사 사진이 없습니다.`;
    actions.push({
      kind: active.length === 1 ? "add-photo" : "choose-photo-plan",
      label:
        active.length === 1 ? "이 계획에 사진 추가" : "사진 추가할 계획 선택",
    });
  }
  if (maintenanceReviewTotal > 0) {
    message ||= `이 랙에 검토할 보수 항목 ${maintenanceReviewTotal}건이 있습니다.`;
    actions.push({
      kind: "review-maintenance",
      label: `검토 필요 항목 확인 (${maintenanceReviewTotal})`,
    });
  }
  if (photoSummary.error > 0 || photoSummary.retake > 0) {
    const issues = [
      photoSummary.error > 0 ? `판독 실패 ${photoSummary.error}장` : "",
      photoSummary.retake > 0 ? `재촬영 표시 ${photoSummary.retake}장` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    message ||= `${issues}이 있습니다.`;
    actions.push({ kind: "inspect-photos", label: "사진 상태 확인" });
  }
  if (actions.length) return { tone: "attention", message, actions };

  if (
    active.length === 0 &&
    plans.length === 0 &&
    photoTotal === 0 &&
    maintenanceTotal === 0 &&
    !hasPointHistory
  ) {
    return attention(
      "아직 이 랙의 검사계획과 사진 기록이 없습니다.",
      "create-plan",
      "이 랙으로 검사계획 만들기",
    );
  }
  if (photoSummary.pending > 0) {
    message = `AI 판독 대기·진행 중인 사진 ${photoSummary.pending}장이 있습니다.`;
  } else if (photoSummary.unread > 0) {
    message = `미판독 사진 ${photoSummary.unread}장이 있습니다. 필요하면 사진에서 판독 상태를 확인하세요.`;
  } else if (active.length > 0) {
    message =
      "현재 검토가 필요한 항목은 없습니다. 검사계획은 계속 진행 중입니다.";
  } else if (plans.length > 0 && photoTotal === 0) {
    const done = plans.filter((plan) => plan.status === "done").length;
    const cancelled = plans.filter(
      (plan) => plan.status === "cancelled",
    ).length;
    const prior =
      done && cancelled
        ? `이 랙을 포함한 이전 검사계획 ${done + cancelled}개가 있습니다(완료 ${done}개·취소 ${cancelled}개).`
        : done
          ? `이 랙을 포함한 완료된 검사계획 ${done}개가 있습니다.`
          : `이 랙을 포함한 취소된 검사계획 ${cancelled}개가 있습니다.`;
    message = `${prior} 이 랙에 등록된 사진은 없습니다.`;
  } else if (plans.length > 0) {
    message =
      "진행 중인 계획은 없습니다. 이전 검사계획과 사진은 아래에서 확인할 수 있습니다.";
  } else {
    message =
      photoTotal > 0
        ? "진행 중인 계획은 없습니다. 기존 사진은 아래에서 확인할 수 있습니다."
        : maintenanceTotal > 0
          ? "진행 중인 계획은 없습니다. 기존 보수 기록은 아래에서 확인할 수 있습니다."
          : "진행 중인 계획은 없습니다. 기존 포인트 기록은 아래에서 확인할 수 있습니다.";
  }
  return {
    tone: "calm",
    message,
    actions: [
      {
        kind: active.length
          ? active.length === 1
            ? "add-photo"
            : "choose-photo-plan"
          : "create-plan",
        label: active.length ? "사진 추가" : "새 검사계획 만들기",
      },
    ],
  };
}
