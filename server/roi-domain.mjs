import { z } from "zod";
export const ROI_POLICY = "exif-oriented-first-frame-normalized-v1";
export const roiCoordinates = z.object({
  x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1),
  w: z.number().finite().positive().max(1), h: z.number().finite().positive().max(1),
}).strict().refine((roi) => roi.x + roi.w <= 1 && roi.y + roi.h <= 1, "선택 영역이 원본 사진의 범위를 벗어났습니다.");
export const currentAnalysis = (job, photo, roi) => Boolean(photo && photo.id === job.photoId && photo.visibility !== "hidden" &&
  photo.sha256 === job.originalSha256 && (!job.roiId || (roi?.id === job.roiId && roi.visibility !== "hidden" && roi.editVersion === job.roiVersion && roi.photoId === photo.id && roi.originalSha256 === photo.sha256)));
export function verifyAnalysisResult(result, job) {
  const identity = ["model_version", "preprocessing_version", "checkpoint_sha256"];
  if (result.schemaVersion !== "roi-shap-v1" || result.sourceId !== job.sourceId || result.originalSha256 !== job.originalSha256 ||
      (result.roiId ?? null) !== job.roiId || result.roiPolicyVersion !== ROI_POLICY ||
      identity.some((key) => result[key] !== job.expectedModel[key]) ||
      !Number.isInteger(result.grade) || result.grade < 1 || result.grade > 5 ||
      !Number.isSafeInteger(result.orientedWidth) || result.orientedWidth <= 0 ||
      !Number.isSafeInteger(result.orientedHeight) || result.orientedHeight <= 0)
    throw new Error("분석 응답의 원본·영역·모델 식별자가 일치하지 않습니다.");
  const { orientedWidth: W, orientedHeight: H } = result;
  const roi = job.roi ?? { x: 0, y: 0, w: 1, h: 1 };
  const expected = [Math.floor(roi.x * W), Math.floor(roi.y * H), Math.ceil((roi.x + roi.w) * W), Math.ceil((roi.y + roi.h) * H)];
  if (JSON.stringify(result.bbox) !== JSON.stringify(expected)) throw new Error("분석 응답의 실제 픽셀 범위가 다릅니다.");
  if (job.kind === "explain") {
    const e = result.explanation;
    if (!e || e.method !== "shap.GradientExplainer" || e.approximation !== "expected_gradients" || e.outputSpace !== "logit" ||
        e.targetGrade !== (job.targetGrade ?? result.grade) || e.mapAggregation !== "signed-channel-sum" ||
        !Array.isArray(e.map) || e.map.length !== 224 || e.map.some((row) => !Array.isArray(row) || row.length !== 224 || row.some((value) => !Number.isFinite(value))) ||
        ![e.mapScale, e.baseValue, e.outputValue, e.attributionSum, e.additivityResidual, e.residualTolerance].every(Number.isFinite) ||
        typeof result.cacheable !== "boolean" || e.mapScale < 0 || e.residualTolerance < 0 ||
        !e.backgroundId || !e.shapVersion || !Number.isInteger(e.nsamples) || e.nsamples < 1 || !Number.isInteger(e.seed) || !result.cacheKey)
      throw new Error("SHAP 계산 응답이 계약과 다릅니다.");
    const near = (a, b) => Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));
    const values = e.map.flat();
    const mapSum = values.reduce((sum, value) => sum + value, 0);
    const mapScale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    if (!near(e.outputValue - e.baseValue - e.attributionSum, e.additivityResidual) || !near(mapSum, e.attributionSum) || !near(mapScale, e.mapScale))
      throw new Error("SHAP 기여도와 설명 오차가 일치하지 않습니다.");
    const passed = Math.abs(e.additivityResidual) <= e.residualTolerance;
    if (result.cacheable !== passed || e.qualityStatus !== (passed ? "passed" : "residual_high")) throw new Error("정밀도가 부족한 설명을 완료 결과로 사용할 수 없습니다.");
  }
  return result;
}
