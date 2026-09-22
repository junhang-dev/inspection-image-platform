# 로컬 ROI / SHAP 후보 API v1

실행 예: 별도 설명 환경에서 `python -m ml.roi_service --config /private/config.local.json --port 8103`.
loopback127.0.0.1 전용. 운영8001은 이 CLI에서 금지한다. 제품 backend를 통해서만 연결하고 학습/manifest/파일경로는 요청에 받지 않는다.

설명 환경은 requirements.txt + requirements-explain.txt를 독립 venv에 설치한다. 실제 로컬 검증은 별도 explain-env.local에 SHAP 의존성을 설치하고 기존 운영 패키지를 읽기 전용 .pth로 참조했다. 운영 venv는 업그레이드하지 않았다. 설치 재현 시 동일 lock 버전과 pip check를 확인한다.

config: `manifest`, `manifestSha256`, `checkpoint`, `contract`는 운영자가 지정한 로컬 경로/해시, `backgroundSourceIds`는 포함된train ID1~16개, `explanationNsamples`는1~256(현재검증256)이다. test ID/SHA와 manifest 해시를 확인할 수 없으면 시작을 거부한다. background는 같은 normalized ROI를 각 train 원본에 적용한다. 원본 전체 배경과 같은 분포라고 주장하지 않는다.

## 요청

`POST /v1/roi/predict` 및 `POST /v1/explanations`: multipart `image` 파일1개와 `metadata` JSON 텍스트1개(최대16KiB).

```json
{
  "sourceId": "product-source-id",
  "originalSha256": "64자리 원본 bytes SHA256",
  "expectedModel": {
    "model_version": "모델 버전",
    "preprocessing_version": "전처리 버전",
    "checkpoint_sha256": "64자리 checkpoint SHA256"
  },
  "roiPolicyVersion": "exif-oriented-first-frame-normalized-v1",
  "roiId": "roi-id-or-null",
  "roi": {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8},
  "targetGrade": 4
}
```

roi/roiId/targetGrade는 생략 또는 null 가능. roi 없으면전체, targetGrade 없으면 실제 해당전체/ROI 예측등급이다. targetGrade는설명대상이며예측등급을강제하지않는다. 추가필드/URL/파일경로 불허. metadata에 filename/학습정답을 넣지 않는다.

좌표는 **EXIF 적용 첫프레임 RGB의 실제 이미지 영역** 기준이다. CSS letterbox여백/cover잘림/화면 회전 좌표를 그대로 전달하지 않는다. x0=floor(xW),y0=floor(yH),x1=ceil((x+w)W),y1=ceil((y+h)H); bool/NaN/Inf/음수/범위초과/빈영역을거절한다. clamp로사용자의영역을조용히바꾸지않는다.

모델은 실제원본 SHA와 선언SHA를비교한다. 고정testID 또는실제SHA가일치하면 새ID/ROI/파일명에도차단한다. known manifest sourceId는SHA도일치해야한다. 신규업로드ID와bytes의DB연결은제품책임이며train으로자동편입되지않는다.

## 응답

공통: `schemaVersion=roi-shap-v1`, sourceId/originalSha256, roiId/roi/roiPolicyVersion, `bbox=[x0,y0,x1,y1]`, orientedWidth/orientedHeight, cropTensorSha256, model_version/preprocessing_version/checkpoint_sha256, grade/confidence, createdAt/elapsedMs/peakRssBytes.

설명: `explanation`에 method=shap.GradientExplainer, approximation=expected_gradients, shapVersion, targetGrade, outputSpace=logit, baseValue/outputValue/attributionSum/additivityResidual/residualTolerance/qualityStatus, map[224][224], mapScale, mapAggregation=signed-channel-sum, backgroundId/backgroundPolicy/backgroundCount, nsamples/seed/batchSize/elapsedMs/inputTensorSha256.

`map`은정규화하지않은signed logit기여이고mapScale은절댓값최댓값이다. UI는양/음색상범례를명시하고bbox안에투영한다. mapScale0이면기여없음을표시한다. 색은물리부식정답/안전판정이아니다. 배경개별ID/원본은public응답으로내보내지않고로컬설정에서감사한다.

최상위 `cacheable`은qualityStatus=passed일때만true. residual_high이면 결과수치를보존하되제품은정상설명완료캐시로승격하지않고정밀도부족상태를표시한다. 실패해도전체/ROI판독자체를지우지않는다. `cacheKey`는sourceId/roiId/원본SHA/정수bbox/모델3식별자/ROI정책/배경hash/target/logit/SHAP버전/방법/nsamples/seed를포함한다. 같은원본의다른제품기록을응답통째로재사용하지않는다. ROI버전과job현재상태를제품에서비교하여늦은결과가새ROI를덮지않게한다.

제품은jobId/explanationId/권한/상태/저장/캐시/UI를소유한다. 이API는동시1이며busy429, 계산timeout504, protected_source403, contract_mismatch409, invalid_roi/source_hash_mismatch/metadata422, dependency_unavailable503, computation_failed500. 업로드idle30초/계산child60초이며취소·disconnect시child를회수한다. `GET /health`는동결모델3식별자와정책/computeBusy를반환한다. 정상health가개별SHAP품질을보장하지는않는다.

원래전체사진AI/사람수정값은보존하고ROI판독은별도이력이다. 보수목록effective grade에ROI결과를자동대입하지않는다. 실제제품UI통합은별도검증한다.
