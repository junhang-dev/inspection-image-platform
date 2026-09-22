"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { requestJson } from "@/lib/api";
import type { Photo } from "@/lib/photo-query";
type Rect = { x: number; y: number; w: number; h: number };
type Roi = { id: string; photoId: string; name: string; coordinates: Rect; editVersion: number; visibility: "visible" | "hidden" };
type Result = {
  grade: number; originalSha256: string; roiId: string | null;
  model_version: string; preprocessing_version: string; checkpoint_sha256: string;
  orientedWidth: number; orientedHeight: number; bbox: [number, number, number, number];
  cacheable?: boolean; cacheKey?: string; elapsedMs: number;
  explanation?: { map: number[][]; mapScale: number; targetGrade: number; outputSpace: string; method: string; shapVersion: string; backgroundId: string; nsamples: number; seed: number; baseValue: number; outputValue: number; additivityResidual: number; residualTolerance: number; qualityStatus: string };
};
type Job = { id: string; photoId: string; originalSha256: string; kind: "predict" | "explain"; roiId: string | null; roiVersion: number | null; status: string; isCurrent: boolean; error: string | null; editVersion: number; createdAt: string; result?: Result };
type Audit = { id: string; actor: string; reason: string; at: string; before: Roi | null; after: Roi };
const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL || "";
const api = <T,>(path: string, options?: RequestInit) => requestJson<T>(`${apiBase}/api${path}`, options);
const labels: Record<string, string> = { queued: "계산 대기", running: "계산 중", completed: "계산 완료", failed: "계산 실패", imprecise: "설명 정밀도 부족", cancelled: "취소됨", stale: "영역 변경됨" };
const equalRect = (a: Rect | null, b: Rect | null) => JSON.stringify(a) === JSON.stringify(b);

function ContributionOverlay({ result, strength }: { result: Result; strength: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = ref.current?.getContext("2d"), explanation = result.explanation;
    if (!context || !explanation) return;
    const pixels = context.createImageData(224, 224);
    for (let y = 0; y < 224; y++) for (let x = 0; x < 224; x++) {
      const value = explanation.map[y][x], offset = (y * 224 + x) * 4;
      pixels.data[offset] = value >= 0 ? 230 : 28;
      pixels.data[offset + 1] = value >= 0 ? 64 : 107;
      pixels.data[offset + 2] = value >= 0 ? 36 : 232;
      pixels.data[offset + 3] = explanation.mapScale > 0 ? Math.round(Math.min(1, strength * Math.abs(value) / explanation.mapScale) * 230) : 0;
    }
    context.putImageData(pixels, 0, 0);
  }, [result, strength]);
  const [x0, y0, x1, y1] = result.bbox;
  return <canvas ref={ref} width={224} height={224} className="contribution-overlay" aria-label="실제 SHAP 양·음 기여도" style={{ left: `${100 * x0 / result.orientedWidth}%`, top: `${100 * y0 / result.orientedHeight}%`, width: `${100 * (x1 - x0) / result.orientedWidth}%`, height: `${100 * (y1 - y0) / result.orientedHeight}%` }}/>;
}

export default function RoiPanel({ photo }: { photo: Photo }) {
  const [open, setOpen] = useState(false), [rois, setRois] = useState<Roi[]>([]), [jobs, setJobs] = useState<Job[]>([]);
  const [allowed, setAllowed] = useState(false), [enabled, setEnabled] = useState(false);
  const [basis, setBasis] = useState<Roi | null>(null), [draft, setDraft] = useState<Rect | null>(null);
  const [name, setName] = useState("관심 영역"), [reason, setReason] = useState(""), [actor, setActor] = useState("현업 엔지니어");
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null), [resultState, setResultState] = useState<{ scope: string; value: Result } | null>(null);
  const [history, setHistory] = useState<Audit[]>([]), [overlay, setOverlay] = useState(true);
  const [strength, setStrength] = useState(5);
  const [targetGrade, setTargetGrade] = useState("");
  const box = useRef<HTMLDivElement>(null), start = useRef<{ x: number; y: number } | null>(null), lock = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const mounted = useRef(true), refreshVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; refreshVersion.current++; };
  }, []);
  const hidden = photo.visibility === "hidden";
  const refresh = useCallback(async () => {
    if (hidden) return;
    const version = ++refreshVersion.current;
    const [a, b] = await Promise.all([api<{ enabled: boolean; allowed: boolean; items: Roi[] }>(`/inspections/${photo.id}/rois`), api<Job[]>(`/inspections/${photo.id}/analysis-jobs`)]);
    if (!mounted.current || version !== refreshVersion.current) return;
    setRois(a.items); setAllowed(a.allowed); setEnabled(a.enabled); setJobs(b);
  }, [photo.id, hidden]);
  useEffect(() => {
    if (!open || hidden) return;
    let active = true, pending = false;
    const load = async () => { if (pending) return; pending = true; try { await refresh(); } catch (error) { if (active) setError((error as Error).message); } finally { pending = false; } };
    void load(); const timer = setInterval(load, 2500);
    return () => { active = false; refreshVersion.current++; clearInterval(timer); };
  }, [open, hidden, refresh]);
  const selectedJob = jobs.find((job) => job.id === jobId);
  const matchesScope = (job: Job) => job.photoId === photo.id && job.originalSha256 === photo.sha256 && job.roiId === (basis?.id ?? null) && job.roiVersion === (basis?.editVersion ?? null);
  const currentJob = Boolean(selectedJob?.isCurrent && matchesScope(selectedJob) && basis?.visibility !== "hidden" && equalRect(draft, basis?.coordinates ?? null));
  const resultScope = JSON.stringify([photo.id, photo.sha256, basis?.id ?? null, basis?.editVersion ?? null, jobId]);
  const result = currentJob && resultState?.scope === resultScope ? resultState.value : null;
  const status = selectedJob?.status;
  useEffect(() => {
    setResultState(null);
    if (hidden || !currentJob || !["completed", "imprecise"].includes(status ?? "") || !jobId) return;
    let active = true;
    void api<Job>(`/analysis-jobs/${jobId}`).then((job) => {
      if (active && job.id === jobId && job.isCurrent && matchesScope(job) && job.result && job.result.originalSha256 === photo.sha256 && job.result.roiId === (basis?.id ?? null)) setResultState({ scope: resultScope, value: job.result });
    }).catch((error) => { if (active) setError(error.message); });
    return () => { active = false; };
  }, [jobId, status, currentJob, hidden, resultScope]);
  useEffect(() => {
    setHistory([]); if (!basis) return;
    let active = true;
    void api<Audit[]>(`/rois/${basis.id}/history`).then((value) => { if (active) setHistory(value); }).catch((cause) => { if (active) setError(cause.message); });
    return () => { active = false; };
  }, [basis]);
  const dirty = !equalRect(draft, basis?.coordinates ?? null) || (basis ? name !== basis.name : draft !== null);
  const stale = basis && rois.some((roi) => roi.id === basis.id && roi.editVersion !== basis.editVersion);
  const choose = (roi: Roi | null) => {
    setBasis(roi); setDraft(roi?.coordinates ?? null); setName(roi?.name ?? "관심 영역"); setReason(""); setResultState(null); setError(""); setMessage("");
    setJobId(jobs.find((job) => job.roiId === (roi?.id ?? null) && job.roiVersion === (roi?.editVersion ?? null) && job.isCurrent)?.id ?? null);
  };
  const cursor = (event: PointerEvent) => {
    const bounds = box.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  const move = (event: PointerEvent) => {
    if (!start.current || busy) return;
    const end = cursor(event), x = Math.min(start.current.x, end.x), y = Math.min(start.current.y, end.y);
    const rect = { x, y, w: Math.abs(end.x - start.current.x), h: Math.abs(end.y - start.current.y) };
    setDraft(rect); setResultState(null);
  };
  const save = async (visibility?: "visible" | "hidden") => {
    if (lock.current) return;
    if (!actor.trim() || !reason.trim()) return setError("수정자와 영역 변경 사유를 입력하세요.");
    if (!visibility && (!draft || draft.w <= 0 || draft.h <= 0 || draft.x + draft.w > 1 || draft.y + draft.h > 1)) return setError("사진 안에 크기가 있는 영역을 선택하세요.");
    lock.current = true; setBusy(true); setError("");
    try {
      const payload = { actor, reason, ...(visibility ? { visibility } : { coordinates: draft, name }), ...(basis ? { expectedVersion: basis.editVersion } : {}) };
      const saved = await api<Roi>(basis ? `/rois/${basis.id}` : `/inspections/${photo.id}/rois`, { method: basis ? "PATCH" : "POST", body: JSON.stringify(payload) });
      if (!mounted.current) return;
      choose(saved); await refresh(); setMessage(visibility === "hidden" ? "영역을 삭제했습니다. 같은 영역을 복원할 수 있습니다." : "영역을 저장했습니다. 전체 사진의 AI 결과는 유지됩니다.");
    } catch (cause) { setError((cause as Error).message); } finally { lock.current = false; setBusy(false); }
  };
  const analyze = async (kind: "predict" | "explain") => {
    if (lock.current || dirty || stale) return;
    lock.current = true; setBusy(true); setError(""); setResultState(null);
    const key = JSON.stringify([kind, basis?.id, basis?.editVersion, targetGrade]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    try {
      const job = await api<Job>("/analysis-jobs", { method: "POST", body: JSON.stringify({ id: attempt.current.id, photoId: photo.id, roiId: basis?.id ?? null, roiVersion: basis?.editVersion ?? null, kind, targetGrade: targetGrade ? Number(targetGrade) : null }) });
      if (!mounted.current) return;
      setJobId(job.id); attempt.current = null; await refresh(); setMessage("분석을 요청했습니다. 계산 중에도 다른 사진과 업무를 확인할 수 있습니다.");
    } catch (cause) { setError((cause as Error).message); } finally { lock.current = false; setBusy(false); }
  };
  if (hidden) return null;
  return <details className="roi-panel" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>관심 영역(ROI)·판독 근거</summary>
    {open && <>
      <p>사진에서 확인할 부분을 드래그해 영역을 지정하세요. 영역 판독과 전체 사진 판독은 별도로 보존됩니다.</p>
      {!allowed ? <p className="form-intro">이 보존 자료는 새 영역 판독·설명의 대상이 아닙니다.</p> : <>
      <fieldset className="roi-controls" disabled={busy}>
      <label className="field">선택 영역<select value={basis?.id ?? ""} onChange={(event) => choose(rois.find((roi) => roi.id === event.target.value) ?? null)}><option value="">전체 사진 / 새 영역</option>{rois.map((roi) => <option key={roi.id} value={roi.id}>{roi.name}{roi.visibility === "hidden" ? " (삭제됨)" : ""} · v{roi.editVersion + 1}</option>)}</select></label>
      <div ref={box} className="roi-image" onPointerDown={(event) => { if (busy || basis?.visibility === "hidden") return; event.preventDefault(); start.current = cursor(event); event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={move} onPointerUp={(event) => { move(event); start.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { start.current = null; }}>
        <img src={`${apiBase}/api/inspections/${photo.id}/image`} alt="관심 영역을 지정할 원본" draggable={false}/>
        {result?.explanation && result.cacheable && status === "completed" && overlay && currentJob && <ContributionOverlay result={result} strength={strength}/>}
        {draft && basis?.visibility !== "hidden" && <div className="roi-selection" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.w * 100}%`, height: `${draft.h * 100}%` }}/>}
      </div>
      {result?.explanation && result.cacheable && <><label className="checkbox"><input type="checkbox" checked={overlay} onChange={(event) => setOverlay(event.target.checked)}/>SHAP 기여 영역 표시</label><label className="field">표시 강도 {strength}배<input type="range" min={1} max={20} step={1} value={strength} onChange={(event) => setStrength(Number(event.target.value))}/></label><small>색의 진하기만 조절합니다. 판독과 기여도 수치는 그대로입니다.</small><p className="shap-legend"><span>붉은색: {result.explanation.targetGrade}등급 출력을 높임</span><span>푸른색: 해당 출력을 낮춤</span></p>{result.explanation.mapScale === 0 && <p>표시할 기여가 없습니다.</p>}</>}
      {draft && <div className="roi-coordinates">{(["x", "y", "w", "h"] as const).map((key) => <label className="field" key={key}>{({ x: "왼쪽", y: "위쪽", w: "너비", h: "높이" })[key]} (%)<input type="number" min={key === "w" || key === "h" ? 0.01 : 0} max={100} step="0.01" value={Math.round(draft[key] * 10000) / 100} onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) / 100 })}/></label>)}</div>}
      {(draft || basis) && <div className="roi-edit"><label className="field">영역 이름<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)}/></label><label className="field">수정자<input value={actor} maxLength={60} onChange={(event) => setActor(event.target.value)}/></label><label className="field">변경 사유<input value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} placeholder="관심 영역을 지정·변경한 이유"/></label><div className="heading-actions"><button className="button secondary" disabled={busy || !draft || basis?.visibility === "hidden"} onClick={() => void save()}>영역 저장</button>{basis && <button className="button secondary" disabled={busy} onClick={() => void save(basis.visibility === "hidden" ? "visible" : "hidden")}>{basis.visibility === "hidden" ? "영역 복원" : "영역 삭제"}</button>}<button className="text-button" onClick={() => choose(null)}>새 영역 / 전체 사진</button></div></div>}
      {stale && <p className="form-error">다른 화면에서 영역을 수정했습니다. 영역 목록에서 다시 선택해 최신 값을 확인하세요.</p>}
      {dirty && <p className="form-intro">영역 변경을 먼저 저장한 뒤 판독·설명을 요청하세요.</p>}
      <label className="field">SHAP 설명 대상<select value={targetGrade} onChange={(event) => setTargetGrade(event.target.value)}><option value="">이번 실제 예측 등급</option>{[1, 2, 3, 4, 5].map((grade) => <option key={grade} value={grade}>{grade}등급</option>)}</select></label>
      <div className="heading-actions">{basis && <button className="button secondary" disabled={!enabled || busy || dirty || !!stale || basis.visibility === "hidden"} onClick={() => void analyze("predict")}>영역 판독</button>}<button className="button primary" disabled={!enabled || busy || dirty || !!stale || basis?.visibility === "hidden"} onClick={() => void analyze("explain")}>SHAP 설명 요청</button></div>
      {!enabled && <p>영역 분석 서비스를 준비 중입니다.</p>}
      {selectedJob && <div className="analysis-status" role="status"><strong>{labels[selectedJob.status] ?? selectedJob.status}</strong>{!selectedJob.isCurrent && <p>이전 영역 버전의 결과입니다. 현재 영역으로 다시 요청하세요.</p>}{selectedJob.error && <p>{selectedJob.error}</p>}{["queued", "running"].includes(selectedJob.status) && <button className="text-button" disabled={busy} onClick={async () => { try { await api(`/analysis-jobs/${selectedJob.id}/cancel`, { method: "POST", body: JSON.stringify({ expectedVersion: selectedJob.editVersion, actor, reason: "사용자 분석 취소" }) }); await refresh(); } catch (error) { setError((error as Error).message); } }}>계산 취소</button>}</div>}
      {result && currentJob && <div className="roi-result"><strong>{basis ? "영역" : "전체 사진 별도 분석"} AI: {result.grade}등급</strong>{result.explanation && <p>{result.explanation.targetGrade}등급의 모델 출력에 기여한 영역입니다. 실제 부식 원인·설비 안전성을 증명하지 않습니다.</p>}<details><summary>분석 정보</summary><p>모델 {result.model_version}<br/>전처리 {result.preprocessing_version}<br/>원본 방향 적용 크기 {result.orientedWidth} × {result.orientedHeight}<br/>실제 영역 {result.bbox.join(", ")}</p>{result.explanation && <p>{result.explanation.method} · {result.explanation.nsamples}개 표본 · 대상 {result.explanation.targetGrade}등급<br/>설명 오차 {result.explanation.additivityResidual.toFixed(4)} / 허용 {result.explanation.residualTolerance.toFixed(4)}<br/>배경 {result.explanation.backgroundId}</p>}</details></div>}
      {basis && <details className="audit"><summary>영역 변경 이력 {history.length}건</summary>{history.map((event) => <div className="audit-item" key={event.id}><div><b>{event.actor}</b><p>{event.reason}</p><small>{JSON.stringify(event.before?.coordinates ?? null)} → {JSON.stringify(event.after.coordinates)}</small><time>{new Date(event.at).toLocaleString("ko-KR")}</time></div></div>)}</details>}
      <details className="audit"><summary>분석 요청 이력 {jobs.filter((job) => job.roiId === (basis?.id ?? null)).length}건</summary>{jobs.filter((job) => job.roiId === (basis?.id ?? null)).map((job) => <button className="analysis-history-item" key={job.id} onClick={() => setJobId(job.id)}>{job.kind === "explain" ? "SHAP" : "영역 판독"} · {labels[job.status]} · {new Date(job.createdAt).toLocaleString("ko-KR")}{!job.isCurrent && " · 이전 영역"}</button>)}</details>
      </fieldset>
      </>}
      {message && <p role="status" className="form-intro">{message}</p>}{error && <p className="form-error" role="alert">{error}</p>}
    </>}
  </details>;
}
