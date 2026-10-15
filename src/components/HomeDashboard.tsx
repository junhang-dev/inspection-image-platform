"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Compass,
  FolderKanban,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { requestJson } from "@/lib/api";
import locations from "@/lib/virtual-locations.json";
import type { PhotoPage } from "@/lib/photo-query";
import type { MaintenancePage } from "@/lib/maintenance";
import styles from "./HomeDashboard.module.css";

type Destination = "dashboard" | "plans" | "photos" | "worklist" | "taWorklist";
const query = "recordPurpose=inspection&visibility=visible&pageSize=1";
const base = process.env.NEXT_PUBLIC_API_BASE_URL || "";

// Home summaries have their own scope, independent of filters in work screens.
function useSummary<T>(path: string, revision: number) {
  const [state, setState] = useState<{ data: T | null; error: boolean }>({
    data: null,
    error: false,
  });
  useEffect(() => {
    let active = true;
    let pending = false;
    const controller = new AbortController();
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const data = await requestJson<T>(`${base}/api/${path}`, {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (active) setState({ data, error: false });
      } catch {
        if (active) setState({ data: null, error: true });
      } finally {
        pending = false;
      }
    };
    void load();
    const timer = setInterval(load, 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [path, revision]);
  return state;
}
const count = (value: number | undefined) =>
  value === undefined ? "—" : value.toLocaleString("ko-KR");

function TeamRow({
  team,
  total,
  revision,
  onOpen,
}: {
  team: (typeof locations.teams)[number];
  total?: number;
  revision: number;
  onOpen: () => void;
}) {
  const { data, error } = useSummary<PhotoPage>(
    `inspections/query?${query}&teamId=${encodeURIComponent(team.id)}`,
    revision,
  );
  const percent = data && total ? Math.min(100, (data.total / total) * 100) : 0;
  return (
    <button className={styles.team} onClick={onOpen}>
      <span className={styles.teamName}>
        {team.name}
        <ArrowRight size={15} />
      </span>
      <span className={styles.teamTrack}>
        <span style={{ width: `${percent}%` }} />
      </span>
      <strong>
        {error ? "조회 실패" : count(data?.total)}
        <small>{!error && " 장"}</small>
      </strong>
    </button>
  );
}

export default function HomeDashboard({
  onNavigate,
  onTeamPhotos,
}: {
  onNavigate: (tab: Destination, status?: "done") => void;
  onTeamPhotos: (teamId: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const photos = useSummary<PhotoPage>(`inspections/query?${query}`, revision);
  const maintenance = useSummary<MaintenancePage>(
    `maintenance/query?${query}&targetType=photo&inWorklist=true`,
    revision,
  );
  const p = photos.data;
  const m = maintenance.data;
  const statuses = [
    { key: "review", label: "검토 필요", color: "#dbad62" },
    { key: "planned", label: "작업 예정", color: "#7aacc8" },
    { key: "progress", label: "작업 중", color: "#39b5a2" },
    { key: "done", label: "완료", color: "#829c8f" },
  ] as const;
  const metrics = [
    {
      label: "접수 사진",
      value: p?.total,
      unit: "장",
      icon: Camera,
      target: "photos",
    },
    {
      label: "AI 판독 완료",
      value: p?.summary.done,
      unit: "장",
      icon: CheckCircle2,
      target: "photos",
    },
    {
      label: "보수 관리 대상",
      value: m?.total,
      unit: "건",
      icon: Wrench,
      target: "worklist",
    },
    {
      label: "보수 완료",
      value: m?.statusCounts.done,
      unit: "건",
      icon: FolderKanban,
      target: "worklist",
    },
  ] as const;
  return (
    <div className={styles.home}>
      <section className={styles.intro} aria-labelledby="home-title">
        <h1 id="home-title">홈</h1>
        <button
          className={styles.refresh}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} />
          현황 새로고침
        </button>
      </section>
      {(photos.error || maintenance.error) && (
        <div className={styles.error} role="alert">
          {photos.error && "사진 현황 "}
          {maintenance.error && "보수 현황 "}조회에 실패했습니다. 현황
          새로고침으로 다시 조회하세요.
        </div>
      )}
      <section className={styles.metrics} aria-label="전체 업무 현황">
        {metrics.map(({ label, value, unit, icon: Icon, target }) => (
          <button
            key={label}
            className={styles.metric}
            onClick={() =>
              onNavigate(
                target,
                label === "AI 판독 완료" || label === "보수 완료"
                  ? "done"
                  : undefined,
              )
            }
          >
            <span className={styles.metricLabel}>
              <Icon size={18} />
              {label}
              <ArrowRight size={16} />
            </span>
            <strong>
              {count(value)}
              <small>{unit}</small>
            </strong>
          </button>
        ))}
      </section>
      <div className={styles.overview}>
        <section className={styles.map} aria-labelledby="home-map-title">
          <img
            src="/maps/refinery-overview-v1.png"
            alt="공장 배치를 보여주는 AI 보강 항공 참고 이미지"
          />
          <div className={styles.mapShade} />
          <div className={styles.mapTop}>
            <span>
              <Compass size={15} />
              공장 현황
            </span>
            <span>{locations.teams.length}개 생산팀 · 가상 구역</span>
          </div>
          <div className={styles.mapBottom}>
            <h2 id="home-map-title">공장 3D 탐색</h2>
            <span>
              {locations.teams.length}개 생산팀 · {locations.racks.length}개 랙
            </span>
            <button onClick={() => onNavigate("dashboard")}>
              3D 지도로 이동
              <ArrowRight size={18} />
            </button>
          </div>
        </section>
        <section className={styles.panel} aria-labelledby="home-team-title">
          <div className={styles.panelHeading}>
            <div>
              <h2 id="home-team-title">생산팀별 접수 현황</h2>
            </div>
            <Camera size={22} />
          </div>
          <div className={styles.teams}>
            {locations.teams.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                total={p?.total}
                revision={revision}
                onOpen={() => onTeamPhotos(team.id)}
              />
            ))}
          </div>
          <div className={styles.teamFooter}>
            <span>전체 접수 사진</span>
            <strong>
              {count(p?.total)}
              <small> 장</small>
            </strong>
          </div>
        </section>
      </div>
      <div className={styles.bottom}>
        <section
          className={styles.panel}
          aria-labelledby="home-maintenance-title"
        >
          <div className={styles.panelHeading}>
            <div>
              <h2 id="home-maintenance-title">보수 진행 현황</h2>
            </div>
            <button
              className={styles.textLink}
              onClick={() => onNavigate("worklist")}
            >
              보수 관리
              <ArrowRight size={15} />
            </button>
          </div>
          <div className={styles.statusBar} aria-hidden="true">
            {statuses.map((status) => (
              <span
                key={status.key}
                style={{
                  background: status.color,
                  flex: m?.statusCounts[status.key] ?? 0,
                }}
              />
            ))}
          </div>
          <div className={styles.statuses}>
            {statuses.map((status) => (
              <div key={status.key}>
                <span>
                  <i style={{ background: status.color }} />
                  {status.label}
                </span>
                <strong>
                  {count(m?.statusCounts[status.key])}
                  <small> 건</small>
                </strong>
              </div>
            ))}
          </div>
        </section>
        <section
          className={styles.workflow}
          aria-labelledby="home-workflow-title"
        >
          <h2 id="home-workflow-title">바로가기</h2>
          <div>
            {[
              ["01", "검사 계획", "plans"],
              ["02", "사진 · 판독", "photos"],
              ["03", "워크리스트 관리", "taWorklist"],
            ].map(([step, title, target]) => (
              <button
                key={step}
                onClick={() => onNavigate(target as Destination)}
              >
                <span>{step}</span>
                <div>
                  <strong>{title}</strong>
                </div>
                <ArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
