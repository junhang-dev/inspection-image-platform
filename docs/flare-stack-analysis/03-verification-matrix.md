# 화면 조작·소스 검증 기록

기호: **UI** 운영 페이지에서 직접 확인, **코드** 로컬 Flare 또는 드론 저장소에서만 확인, **제한** 계정/쓰기 권한/배포 차이 등으로 미검증. 시점은 2026-09-29 KST이며 화면 데이터 수치는 그 시점의 스냅샷이다.

## Flare Stack: 순서대로 눌러 본 경로

| 동작 | 확인한 결과 | 범위 |
|---|---|
| 홈의 전체 해제 → No.4 CDU 선택 → 전체 선택 | 빈 상태 → 카드 한 장 → 모든 카드 12개. | UI. 표시 선택은 최종 전체 선택으로 복원. |
| 좌측 No.4 CDU 열기, 대시보드 홈 누르기 | `/cctv/no4-cdu` 상세 → `/` 복귀. | UI. |
| PV 개요 | 계산 설명과 예시가 담긴 모달. | UI+코드. |
| 실시간/과거/알람 탭 | 같은 CCTV에서 작업 모드가 교체됨. | UI. |
| 과거 장기 그래프 한 점 선택 | 선택선과 해당 시각 중심 세부 그래프. | UI. 기간 집계 규칙은 코드. |
| 세부 그래프 한 점 선택 | 원본 프레임·시각·PV·Flame/Steam/Smoke 수치 카드. | UI. |
| 객체 표시 토글 → 확대 → 다음 화살표 | 원본과 감지 오버레이 전환. 확대에서도 토글이 유지되고 다음 프레임에서 시각과 수치가 함께 바뀜. | UI. 키보드 이동은 미확인. |
| 학습용 저장 | 로그인 전 비활성 상태. | UI. 실제 복사/중복 응답은 코드만 확인. |
| 알람 규칙·조회·행 상세 | 규칙 #2와 비활성 새 규칙 버튼, 알람 표/카운트, 행의 상세 설명·그래프·프레임. | UI. 생성·편집·확인 처리는 미실행. |
| 설정 → PV 파라미터 → ROI | `cctv:manage` 권한 없음, 읽기 전용 값, 8꼭짓점 다각형 영상. | UI. ROI 편집/저장은 코드만 확인. |
| 다크 모드 전환·복귀 | 밝은 화면→어두운 화면→밝은 화면. | UI. 최종 밝은 상태로 복원. |
| 로그인 모달 | ID/비밀번호 입력 UI. | UI. 실제 로그인/관리자 화면은 제한. |

사용자 첨부 캡처 1–10은 각각 상세 상단, 출처 문구, 로고, 장기/세부 그래프, 프레임 토글/확대, 알람, 설정·ROI의 시각 근거로 함께 사용했다. 알람 표의 상태 메뉴는 열림을 봤으나 특정 옵션 적용을 확정하지 못해 필터 실동작 확인으로 기록하지 않았다. 장기 차트 드래그/더블클릭·범례 전환은 소스에 있으나 이번 클릭 경로에서는 검증하지 않았다. 관리자 권한의 변경 실행도 검증하지 않았다.

## 드론 사이트: 눌러 본 경로

| 동작 | 확인한 결과 | 범위 |
|---|---|---|
| 홈·지도 팀 선택 | KPI, 계획 시작 안내, 지도/팀→Rack 목록. 지도 선택으로 연결 범위 축소. | UI. 지도 점은 코드상 개념 배치. |
| 사진 목록 → 사진 #158 상세 | 원본, AI 등급 4, 사람 수정 등급 4, 판독 정보 펼침의 실제 MobileNet 버전·전처리 문자열. | UI. ID/모델은 상세 헤더에서 잘 보이지 않음. |
| ROI 펼침, ROI v1/v2 선택 | 기존 ROI 버전·사각형 값·ROI 등급 5·분석 작업/이력. 원본 전체 등급 4와 다른 의미. | UI+코드. 신규 재판독은 실행하지 않음. |
| SHAP 설명/강도 영역 | 기여도 열지도와 강도 조절, 빨강/파랑 의미. | UI+코드. 신규 SHAP 작업은 실행하지 않음. |
| 보수 기록 열기 | 상태/방법/TA, 증빙 사진, 자동/수동 포함, 가시성 복원. 위치는 일부 화면에서 ‘위치 미확인’으로 보임. | UI. 저장/수정은 미실행. |
| 점검 계획 → 상세 → 이 계획에 사진 추가 | 계획 범위(5/30)·이력·완료/취소/삭제 등, 업로드 화면에서 계획·Rack 사전 선택. | UI. 파일 전송은 미실행. |
| 작업 목록 상세 필터·라벨 후보 | 보수 상태/방법/TA/가시성 필터, 제외·등급 하향 구분. 라벨 후보 빈 상태. | UI. |
| 사진 목록의 페이지/검색 범위 | 50개 단위 목록과 필터된 서버 결과를 확인. | UI+코드. 전체 조건 조합을 전수 테스트하지 않음. |

## 드론 저장소에서 확인한 사실

드론 GitHub 리비전은 [`a2c407c`](https://github.com/junhang-dev/inspection-image-platform/tree/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2)이다. 아래 링크는 변경되지 않는 커밋을 가리킨다.

| 소스 | 도출한 사실 |
|---|---|
| [src/app/page.tsx](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/app/page.tsx) | 탭/필터/사진 모달이 단일 홈 상태에 결합. PhotoDialog에서 결과·ROI·보수·편집을 한꺼번에 배치. 화면 actor 초기값은 인증 세션이 아님. |
| [src/app/globals.css](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/app/globals.css) | 녹색·회색 중심의 기존 토큰/큰 양의 페이지 스타일. |
| [src/lib/api.ts](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/lib/api.ts), [src/lib/photo-query.ts](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/lib/photo-query.ts), [server/photo-query.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/photo-query.mjs) | 서버 필터·페이지·집계, 요청 취소/주기 갱신, 일부 오류 처리. 차트나 목록을 만들 때 전체 362개 중 첫 50개만 클라이언트 집계하면 안 됨. |
| [src/components/RoiPanel.tsx](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/components/RoiPanel.tsx), [server/roi-domain.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/roi-domain.mjs), [server/roi-routes.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/roi-routes.mjs) | 사진별 정규화 사각형 ROI, 원본 SHA·버전 검증, 비동기 판독/설명과 오래된 결과 거부. SHAP는 `GradientExplainer` 출력 품질 계약을 검증. |
| [server/maintenance-domain.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/maintenance-domain.mjs), [server/maintenance-view.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/maintenance-view.mjs), [src/components/MaintenancePanel.tsx](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/components/MaintenancePanel.tsx) | 사람 판단 우선의 실효 등급, 보수 상태/방법/TA, 증빙/가시성/제외 규칙. 디자인 변경 때 의미를 보존. |
| [server/plan-domain.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/plan-domain.mjs), [server/uploads.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/uploads.mjs), [src/lib/upload.ts](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/lib/upload.ts) | 계획 범위와 파일별 청크 업로드·재개/해시 계약. |
| [src/lib/concept-map.ts](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/src/lib/concept-map.ts) | 지도 점은 장비/Rack/ID의 안정적 해시 위치로, 실제 현장 좌표가 아님. |
| [deployment/cloudflare-fixed-url/worker.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/deployment/cloudflare-fixed-url/worker.mjs), [server/index.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/index.mjs) | Worker는 고정 호스트/HTTPS와 상류 연결을 다루고 실제 API는 Express 서버. `workers.dev` URL만으로 모든 기능이 Worker에서 실행되는 것은 아님. |
| [server/inference-policy.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/inference-policy.mjs), [server/publication-contract.mjs](https://github.com/junhang-dev/inspection-image-platform/blob/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2/server/publication-contract.mjs) | 보존 평가 사진의 재판독 제한, 원본 해시/공개 범위에 관한 정책. UI 재구성으로 우회하지 않도록 유지. |

저장소의 `tests/`, `ml/`, `labeling/`, `scripts/`도 전체 트리에서 기능 위치를 파악했다. 모든 테스트와 학습 스크립트를 실행하거나 운영 모델 결과를 독립 검증하지 않았다. 저장소 README의 과거 수치와 운영 화면의 현재 수치가 다를 수 있으며 이것만으로 배포 오류라고 판단하지 않는다. 실제 계정 권한·상류 서버 구성·사진별 데이터 보존 정책은 화면/공개 소스만으로 확정할 수 없다.

## 검증해야 할 구현 위험

1. 현행 공개 API와 새 세션 권한의 호환성. 서버의 모든 변경 라우트에서 범위·행위자를 강제해야 한다.
2. 사진의 원본 AI·사람 수정·ROI 별도 등급과 버전의 연결. 서로 다른 값을 하나의 ‘AI 등급’으로 합치면 잘못된 판단을 유도한다.
3. 원본 촬영 시간/점검 회차의 존재 여부. 데이터가 없을 때 추세 그래프를 만들면 사실처럼 보이는 허구가 된다.
4. SHAP 결과의 잔차/품질 상태와 stale job. 열지도는 검출 마스크가 아니므로 표시 토글 명칭이 중요하다.
5. 지도 개념 배치와 실제 설비 좌표의 구별.
6. 화면 리팩터링 뒤 업로드 재개·soft delete 복원·보수 포함/제외·버전 충돌 등 이미 구현된 데이터 계약의 회귀.
