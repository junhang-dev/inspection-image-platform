"use client";
import { useCallback, useEffect, useState } from "react";
import { requestJson } from "./api";

export type Photo = {
  id: string;
  editVersion: number;
  name: string;
  sha256?: string;
  pointId: string | null;
  planId: string | null;
  teamId?: string | null;
  rackId?: string | null;
  evidenceFingerprint?: string;
  status: "pending" | "processing" | "done" | "error" | "unread";
  aiProvenance?: {
    kind:
      | "cached_frozen_training"
      | "cached_frozen_evaluation"
      | "live_frozen_inference";
    predictedAt: string | null;
    importedAt?: string;
  };
  ai: {
    grade: number;
    confidence: number;
    model_version: string;
    preprocessing_version: string;
  } | null;
  humanGrade: number | null;
  retake: boolean;
  retakeReason: string;
  labeling: boolean;
  error: string | null;
  createdAt: string;
  recordPurpose: "inspection" | "presentation" | "verification";
  visibility: "visible" | "hidden";
};

export type PhotoScope = {
  planId: string;
  recordPurpose: "inspection" | "presentation" | "verification" | "all";
  visibility: "visible" | "hidden" | "all";
  teamId: string;
  rackId: string;
  search: string;
};
export const defaultPhotoScope: PhotoScope = {
  planId: "all",
  recordPurpose: "inspection",
  visibility: "visible",
  teamId: "all",
  rackId: "all",
  search: "",
};
export type PhotoQuery = Partial<PhotoScope> & {
  pointId?: string;
  photoId?: string;
  classification?: string;
  labeling?: "all" | "true";
  page?: number;
  pageSize?: number;
};
export type PhotoPage = {
  items: Photo[];
  total: number;
  page: number;
  pages: number;
  pageSize: number;
  summary: {
    total: number;
    repair: number;
    pending: number;
    retake: number;
    labeling: number;
  };
  pointCounts: Record<string, number>;
  rackCounts: Record<string, number>;
};
export function usePhotoQuery(query: PhotoQuery) {
  const key = new URLSearchParams(
    Object.entries(query)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [name, String(value)]),
  ).toString();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const [state, setState] = useState<{
    key: string;
    data: PhotoPage | null;
    error: string;
  }>({ key: "", data: null, error: "" });
  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await requestJson<PhotoPage>(
          `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/inspections/query?${key}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        if (active) setState({ key, data, error: "" });
      } catch (error) {
        if (active)
          setState((previous) => ({
            key,
            data: previous.key === key ? previous.data : null,
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
  }, [key, revision]);
  const current = state.key === key ? state : { data: null, error: "" };
  return { ...current, refresh, loaded: current.data !== null };
}

export function usePhotoRecord(seed: Photo) {
  const [photo, setPhoto] = useState(seed);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const latest = await requestJson<Photo>(
          `${process.env.NEXT_PUBLIC_API_BASE_URL || ""}/api/inspections/${seed.id}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(10000),
            ]),
          },
        );
        if (active) {
          setPhoto(latest);
          setError("");
        }
      } catch (cause) {
        if (active) setError((cause as Error).message);
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
  }, [seed.id]);
  return { photo, error };
}
