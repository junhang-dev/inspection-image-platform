"use client";
import { useCallback, useEffect, useState } from "react";
import { requestJson } from "./api";
import type {
  MaintenanceItem,
  MaintenanceWorklistRow,
} from "@/components/MaintenancePanel";
export type Purpose = "inspection" | "presentation" | "verification";
export type SavedMaintenance = MaintenanceItem & { recordPurpose: Purpose };
export type MaintenanceQuery = {
  planId?: string;
  pointId?: string;
  recordPurpose?: Purpose | "all";
  inWorklist?: "true" | "all";
  ta?: string;
  repairStatus?: string;
  repairMethod?: string;
  teamId?: string;
  rackId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};
export type MaintenancePage = {
  items: (MaintenanceWorklistRow & { recordPurpose: Purpose })[];
  total: number;
  page: number;
  pages: number;
  pointSummaries: Record<
    string,
    {
      total: number;
      registered: number;
      none: number;
      review: number;
      planned: number;
      progress: number;
      done: number;
    }
  >;
};
export const maintenanceApi = <T>(path: string, options: RequestInit = {}) =>
  requestJson<T>(
    `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/maintenance${path}`,
    options,
  );
export function useMaintenanceQuery(query: MaintenanceQuery, enabled = true) {
  const key = new URLSearchParams(
    Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const [state, setState] = useState<{
    key: string;
    data: MaintenancePage | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  useEffect(() => {
    if (!enabled) return;
    let active = true,
      pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await maintenanceApi<MaintenancePage>("/query?" + key, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (active) setState({ key, data, error: "" });
      } catch (error) {
        if (active)
          setState((old) => ({
            key,
            data: old.key === key ? old.data : null,
            error: (error as Error).message,
          }));
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [key, revision, enabled]);
  return {
    ...(state.key === key ? state : { data: null, error: "" }),
    refresh,
  };
}
