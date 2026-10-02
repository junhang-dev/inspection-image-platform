"use client";

import { useCallback, useEffect, useState } from "react";
import { requestJson } from "./api";
import type { PhotoPage } from "./photo-query";

export type RackPlanPhotoCount = Pick<
  PhotoPage["summary"],
  "total" | "pending" | "error" | "unread" | "done"
>;

export function useRackPlanPhotos({
  rackId,
  planIds,
  enabled,
  changeKey,
}: {
  rackId: string | null;
  planIds: string[];
  enabled: boolean;
  changeKey: string;
}) {
  const ids = [...planIds].sort().join(",");
  const key = `${rackId ?? ""}|${ids}|${changeKey}`;
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const [state, setState] = useState<{
    key: string;
    counts: Record<string, RackPlanPhotoCount> | null;
    error: string;
  }>({ key: "", counts: null, error: "" });

  useEffect(() => {
    if (!enabled || !rackId || !ids) return;
    let active = true;
    let loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const counts = await Promise.all(ids.split(",").map(async (planId) => {
          const query = new URLSearchParams({
            planId,
            rackId,
            recordPurpose: "inspection",
            visibility: "visible",
            pageSize: "1",
          });
          const page = await requestJson<PhotoPage>(
            `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/inspections/query?${query}`,
            { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) },
          );
          return [planId, {
            total: page.total,
            pending: page.summary.pending,
            error: page.summary.error,
            unread: page.summary.unread,
            done: page.summary.done,
          }] as const;
        }));
        if (active) setState({ key, counts: Object.fromEntries(counts), error: "" });
      } catch (cause) {
        if (active) setState({ key, counts: null, error: (cause as Error).message });
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = window.setInterval(load, 15000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [key, rackId, ids, enabled, revision]);

  if (!rackId || !ids) return { counts: {}, error: "", retry };
  return state.key === key
    ? { counts: state.counts, error: state.error, retry }
    : { counts: null, error: "", retry };
}
