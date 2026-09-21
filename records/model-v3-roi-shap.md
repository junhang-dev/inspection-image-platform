# v3 ROI·실제 SHAP 및 제한 후보 실험

2026-09-22, 시작 기준 acaca0d, 작업 브랜치 codex/jun/model-roi-shap.
사용자는 이 작업에서 직접 `v3 구현·제한 실험·예약 갱신 승인`을 응답했다. 기존 30-2 예약은 공식 도구로 갱신했으며 prompt/updated_at 외 필드 불변, 30분/ACTIVE/같은 대상이다. 초기 갱신 거절 뒤 직접 승인으로 재검토가 통과했다.

## 구현과 실제 검증

- EXIF 전치 후 첫 RGB 프레임의 normalized ROI를 정수 bbox로 변환하고 같은 224 전처리를 적용한다. 원본 bytes와 전체사진 결과는 변경하지 않는다.
- 별도 loopback 후보 API만 추가했다. 기존 운영 8001과 동결 모델/전처리/가중치는 보존했다. 모델 wrapper의 5개 logit이 기존 경로와 정확히 일치하고 입력 gradient가 유한·비영임을 승인 demo로 확인했다.
- 실제 SHAP 0.51.0 GradientExplainer(expected gradients)를 별도 환경에서 실행한다. 기본 타깃은 실제 예측등급의 logit 하나이며 특정 1등급에 고정하지 않는다. train에서 복제된 승인 demo 5개를 원래 train ID/SHA에 연결해 배경으로 사용했다. 신규 표본으로 집계하지 않는다.
- 고정 test ID 또는 실제 수신 SHA 중 하나라도 보호 항목이면 decode/worker 전에 거부한다. known source ID/SHA도 대조한다. 신규 업로드의 DB 연결은 제품 소유이며 unknown ID가 train으로 승격되지는 않는다. 배경은 고정 manifest의 포함된 train만 허용한다.
- 업로드 idle 30초, 계산 child 시작부터 60초 한도다. child의 모델/배경 로드도 60초에 포함하며 업로드 총 시간은 포함하지 않는다. ASGI disconnect/취소/timeout은 해당 child kill→reap 후 임시파일·실행 슬롯을 반환한다.
- 합성 검사: EXIF 8방향/full ROI tensor parity, 잘못된 좌표, ID/SHA 보호, 실제 선형 SHAP 기여합·seed, HTTP 보호의 worker 호출 전 거부, timeout/task cancel/ASGI disconnect의 실제 child PID 소멸. Python unittest 6개 PASS.
- 실제 HTTP: 승인 demo ROI 200, SHAP 200, 잘못된 ROI 422, SHA 불일치 422. HTTP 설명은 약13.67초. 합성 안전검증과 실제 모델 계산 검증을 구분한다.

## SHAP 수렴 관측

같은 승인 demo·ROI·타깃·배경을 유지했다. 최초64 표본에서 잔차가 사전에 정한 기준을 초과해 `residual_high`, `cacheable=false`로 반환했다. 측정 비용을 근거로 허브와256표본 단회 수렴 검증을 조율했으며 기준은 완화하지 않았다.

| 설정 | SHAP 계산 시간 | 기여합 잔차 | 허용 잔차 | 품질 |
|---|---:|---:|---:|---|
| 64표본 | 2.833초 | 2.061379 | 2.052500 | residual_high |
| 256표본 | 9.095초 | 0.277857 | 2.052500 | passed |

잔차는 `output logit − background mean logit − signed attribution sum`이다. 허용값 `max(0.1, 0.25 × abs(output − base))`는 프로젝트 초기 정합성 검사이며 보편적인 SHAP 품질 표준이나 설명 정확도의 증명이 아니다. 동일256설정의 후속 실제 HTTP 결과에서도 같은 잔차를 확인했다. 최초 smoke의 peak RSS는 약977MB였다. seed 고정은 다른 기기/라이브러리까지 bitwise 반복성을 보장하지 않는다.

signed 채널 합 기여맵과 실제 모델·타깃·배경 해시·ROI·원본 SHA를 반환한다. 양/음 기여는 비교 배경에 대한 모델 출력 변화이며 물리적 부식 원인, 실제 부식 영역 정답, 설비 안전성을 뜻하지 않는다. 높은 잔차의 결과는 검증된 설명 캐시로 승격하지 않는다. 제품 UI 연결·사용자 검수·현장 설명 타당성은 이 API 검사로 완료 처리하지 않는다.

## 제한 후보 실험 결과

기존 validation 집계에서 3→2 오류8/15, 4등급 정답0/2와 적은 train 4등급10개를 확인했다. 이 결과와 train/validation 격차를 근거로 낮은 학습률·label smoothing 및 클래스 가중을 비교했다. 전체사진 라벨을 ROI 정답으로 재사용하지 않았다.

공통: 초기 동결 모델, seed42, CPU2 threads, 동시1, batch16, backbone lr0.00002/head0.00005, label smoothing0.05, weight decay0.01, 후보별4epoch. 각 epoch의 validation 결과를 append-only 기록하고 ledger는 원자 교체한다. 독립 검토에서 지적한 초기모델 identity 고정·실패 시 관측횟수 보존을 보완 후 실행했다.

| 모델 | validation accuracy | macro F1 | 심한 과소판독 수 | 결과 |
|---|---:|---:|---:|---|
| 기존 동결 baseline | 63.79% | 0.556080 | 0 | 운영 유지 |
| 마지막 블록1개+sqrt 클래스 가중 | 56.90% | 0.542308 | 0 | candidate_only |
| 마지막 블록3개+역빈도 클래스 가중 | 51.72% | 0.506568 | 0 | candidate_only |

후보별 학습 소요23.56초/36.42초(데이터 사전 로드 제외), 각각 epoch1이 후보 내 최선이었다. 총 후보2개/실행8epoch/validation 관측8회를 모두 기록했고 누적 승인 한도를 소진했다. 기존 초기 checkpoint SHA 불변 확인. 최종 test 재접근/평가0, 서비스 교체0. 기존 train99.57% PASS/test60% FAIL은 그대로다. 두 후보 모두 baseline보다 낮아 선택하지 않았다. 추가 후보를 자동 반복하지 않는다.

## 독립 검토와 증거

독립 검토는 초기 설계와 구현을 정적으로 확인했다. test 보호·train 배경·gradient parity·hard timeout·캐시 연결을 검토했고, actual disconnect 감시, sourceId/roiId 캐시 결합, 초기모델 identity 고정, epoch별 append-only 관측을 보완했다. 실험 결과와 원본/개별 결과/SHAP 맵/배경 설정/가중치는 로컬 Git 제외 위치에 보존한다.

공개 코드는 ml/roi.py, ml/explain.py, ml/explain_worker.py, ml/roi_service.py, ml/v3_candidates.py, ml/test_roi_explain.py, ml/requirements-explain.txt 및 API 문서다. 제품 server/src/compose와 운영 소스는 수정하지 않았다. 설명 환경의 pip check PASS. 제품 UI/DB job·cache·overlay·취소상태의 실제 통합은 제품 담당의 후속 검증 범위다.

다음 성능 개선은 표본이 적은 등급의 라벨/데이터 품질과 독립 평가 계획을 먼저 정리한다. 이번 두 후보 실패를 근거로 원본 라벨을 임의 수정하거나 고정 test를 분석하지 않는다.
