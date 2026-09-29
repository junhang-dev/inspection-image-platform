# 개발용 소스 지도

이 문서는 화면 설계에 바로 영향을 주는 실행 경로를 정리한다. 전체 코드 파일 이름과 크기, 깊게 읽은 드론 파일 여부는 [source-inventory.json](source-inventory.json)에 있다. `readDeeply: false`는 파일 존재/역할 분류만 했다는 뜻이다. 원본 저장소의 전체 110개 코드 파일과 Flare 로컬 두 소스 묶음(현행 구조 후보 53개, 별도 프런트 33개)을 인벤토리했다. 설정·정적 자산·잠금 파일은 이 코드 파일 수에 포함하지 않는다.

## Flare Stack 서비스 경계

| 위치 | 입력·출력과 UI 관계 | 확인할 점 |
|---|---|---|
| `frontend/src/app/page.tsx` + `useCctvStore.ts` | CCTV 조회/선택 → 홈 카드 → 상세 링크. | 선택된 카드 수와 ON 상태는 서로 다른 값. |
| `frontend/src/app/cctv/[id]/page.tsx` | 한 CCTV의 실시간/과거/알람 탭, 선택 프레임, 확대·학습용 저장을 조합. | 탭 변경·장기 점 선택 시 하위 선택을 초기화해 다른 시각 사진을 섞지 않음. |
| `HistoryChart.tsx` + `DetailedHistoryChart.tsx` | 서버 집계 버킷 → 장기 축 → 국소 측정점 → 프레임. | PV(0–100)와 감지 비율(%)의 축을 분리하고 결측을 0으로 그리지 않음. |
| `query-service/app/main.py` | Elasticsearch 집계, 세부 프레임/서명 URL, Redis 실시간 중계. | 조회 기간에 따른 간격/표본 수, S3 키가 있는 프레임만 제공. |
| `model-backend/app/main.py` | RTSP 원본에 YOLO 감지·ROI 중심점 필터, PV 계산, Redis/원본 저장 및 주석 영상. | 객체 비율 분모는 전체 프레임. ROI 클리핑 면적 아님. |
| `ingest-worker/app/main.py` | 비동기 원본 이미지·감지 메타데이터 S3/Elasticsearch 저장. | 원본과 계산 당시 파라미터를 연결. |
| `alarm-service/app/main.py` + `AlarmHistoryPanel.tsx` | 규칙 조회/편집, 이력, 확인 처리, SSE 발생 통지. | 규칙 편집과 알람 확인은 서로 다른 행위/권한. |
| `auth-service/app/main.py`, `useAuthStore.ts` | 세션 쿠키/JWT/역할·권한·CCTV 범위. | UI 버튼과 서버 변경 API가 모두 범위를 검사. |
| `orchestrator/app/main.py`, `CctvSettingsModal.tsx` | CCTV 메타데이터·계산 파라미터·ROI·학습용 프레임 등록. | 쓰기와 원본 조회를 구별. |

별도 `flare-stack-ai-cctv-frontend-main`은 UI 기초 구조와 일부 컴포넌트가 겹치지만 로그인/권한, 설정 모달, HLS 등 운영 화면에 필요한 일부가 없다. 운영 배포의 정확한 빌드 ID는 확인할 수 없으므로 이 문서의 소스 설명은 백엔드 저장소 안의 프런트엔드를 기준으로 한다.

## 드론 실행 경로와 개선 접점

| 작업 | 현재 UI → API → 데이터/모델 | 설계 변경 위치 |
|---|---|---|
| 목록/범위 | `Home`의 tab/scope/filter/page → `usePhotoQuery` → `GET /api/inspections/query` → 서버 필터/건수/페이지. | URL 쿼리로 범위/필터 저장. 기존 응답 건수와 페이지를 그대로 사용. |
| 사진 상세 | `PhotoDialog` → `usePhotoRecord` 주기 갱신 → `GET /api/inspections/:id`, 이미지/이력 전용 경로. | 독립 상세 경로와 읽기 요약/편집 모드. 폴링 중 작성중 폼 값과 서버 새 데이터를 섞지 않음. |
| 사람 수정 | `PATCH /api/inspections/:id`의 `expectedVersion`, `humanGrade`, `retake`, `actor`, `reason` → 감사 기록. | 세션 actor로 교체, 버전 충돌 시 폼 보존/새 값 비교. |
| 삭제/복원 | `PATCH /api/inspections/:id/visibility`, `purpose` 등 → 가시성/목적/이력. | 더보기 메뉴의 명시적 상태/복원. 사진과 보수 기록 연결 유지. |
| 계획 | `GET/POST/PATCH /api/plans`, `/api/plans/:id/history`, 계획별 Rack 범위. | 계획 상세에서 해당 사진·보수 작업으로 직접 연결. |
| 업로드 | `POST /api/upload-sessions` → `PUT .../chunks` → `POST .../complete` → MinIO/원본 SHA → 모델 작업. | 계획·Rack 문맥을 유지하며 실패/재개 상태를 새 레이아웃에 연결. |
| ROI | `/api/inspections/:id/rois`와 `/api/rois/:id` → `POST /api/analysis-jobs` → 상태/결과 조회/취소. | ROI 버전과 전체 등급 분리, 원본 변경 때 오래된 결과 경고. |
| 보수 | `GET /api/maintenance/query`, `/pair`, `/target`, `POST/PATCH /api/maintenance`, 이력. | 카드/목록에 상태·방법·TA·포함/제외·증빙의 원래 의미 유지. |
| 지도 | `InspectionMap` → `conceptPosition` 해시 위치. | 개념도 레이블. 실제 위경도나 정밀 설비 좌표로 표현하지 않음. |
| 배포 | Cloudflare 고정 URL Worker → VPC binding 상류 웹 → Next/Express → MySQL·MinIO, Python 분류/ROI 서비스. | 인증 쿠키/호스트/HTTPS/CORS/업로드 응답을 이 전체 경로에서 시험. |

드론의 전체 사진 분류 결과 `photo.ai.grade`와 사람 수정 `photo.humanGrade`가 함께 있고, 최종 판단은 사람 값이 있을 때 이를 우선한다. ROI 작업은 별도 식별자·원본 SHA·정규화 사각형·버전·모델/전처리/체크포인트를 가진다. `server/roi-domain.mjs`는 ROI 범위(0–1), EXIF 방향을 적용한 이미지 좌표, 결과의 실제 픽셀 bbox 및 SHAP 품질을 검사한다. 이는 UI에서 ‘선택 영역’이라는 말만 동일해도 CCTV의 다각 ROI와 서로 다른 계산이다.

`server/inference-policy.mjs`는 고정 평가 데이터의 재판독이나 허용되지 않은 원본의 공개 업로드를 제한한다. `server/publication-contract.mjs`는 공개 데이터의 범위를 다룬다. 인증을 나중에 더하더라도 이 데이터 출처·공개·평가 분리 정책을 약하게 만들지 않아야 한다. UI의 라벨 후보 버튼을 학습 데이터 저장으로 바꿀 때에도 실제 등록/검수/학습은 서로 다른 단계로 표시한다.

## 개발 중 확인할 최소 검사

| 변경 묶음 | 저장소의 기존 검사와 새 사용자 경로 |
|---|---|
| 공통 UI/상세 | `npm run typecheck`, `npm run build`; 목록→상세→뒤로/새로고침, 모바일 폭에서 사진/도구 정렬. |
| 서버 쿼리 | `npm test` 중 photo-query/relations/maintenance/ROI 테스트; 동일 범위에서 전체 건수와 50개 페이지가 맞는지. |
| 업로드/ROI | uploads·ROI·model contract 테스트; 청크 재개, 중복 원본, ROI 변경 뒤 이전 job 무효화, SHAP 품질 실패 표시. |
| 권한 | 조회/수정/업로드/확인 API를 비로그인·담당자·다른 팀·관리자 각각 직접 호출해 401/403/성공을 검증. UI만 비활성으로 둔 상태를 통과로 보지 않음. |
| 데이터 의미 | AI 전체 등급 4, ROI 등급 5, 사람 수정 3인 사진과 날짜 미상 사진을 fixture로 두고 표시·집계·비교를 검증. |

이 문서는 소스 분석과 계획이다. 실행 중인 운영 서버의 비공개 설정, 인증된 관리자 행동, 실제 모델 정확도를 검증한 보고서는 아니다.
