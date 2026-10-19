import type { RepairMethod, RepairStatus } from "@/components/MaintenancePanel";

export function statusAfterMethod(status: RepairStatus, method: RepairMethod): RepairStatus {
  if (status === "progress" || status === "done") return status;
  if (method === "none") return "none";
  if (method === "undecided") return "review";
  return "planned";
}

/** A confirmed write stays saved even when its following reads fail. */
export async function finishMaintenanceSave<
  T extends { id: string; editVersion: number },
>(
  saved: T,
  {
    onConfirmed,
    readLatest,
    refreshLists,
  }: {
    onConfirmed: (item: T & { persisted: true }) => void;
    readLatest: (id: string) => Promise<T>;
    refreshLists: (readFailed: boolean) => Promise<void>;
  },
): Promise<unknown[]> {
  // POST/PATCH returns the persisted entity without the derived view flag.
  onConfirmed({ ...saved, persisted: true });
  const refreshErrors: unknown[] = [];
  try {
    onConfirmed({ ...(await readLatest(saved.id)), persisted: true });
  } catch (error) {
    refreshErrors.push(error);
  }
  try {
    await refreshLists(refreshErrors.length > 0);
  } catch (error) {
    refreshErrors.push(error);
  }
  return refreshErrors;
}
