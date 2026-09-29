# Flare Stack AI CCTV → 드론 점검 플랫폼: 조사와 이식 계획

조사일: 2026-09-29 (KST). 이 폴더는 **구현 요청서**다. 운영 사이트를 직접 클릭해 본 결과, 로컬 Flare Stack 소스, 드론 사이트 화면, 드론 저장소의 `a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2` 커밋을 함께 대조했다. 운영 배포가 각 소스의 동일 커밋이라는 증거는 없으므로 화면 관찰과 코드 추론을 구별했다. 로그인하지 않은 상태에서 생성·수정·삭제·업로드·알람 확인은 실행하지 않았다.

- [01. Flare Stack 화면·소스 분석](01-flarestack-audit.md): 실제로 눌러 확인한 작동, 정보 구조, 색과 상태 표현, 백엔드 데이터 흐름, 코드만 확인한 관리자 기능.
- [02. 드론 페이지 이식 설계](02-drone-migration-plan.md): 현행 기능과의 대응, 화면 설계, 데이터·권한 계약, 우선순위와 완료 기준.
- [03. 검증 기록과 근거](03-verification-matrix.md): 항목별 관찰·소스·미검증 범위와 주요 파일 경로.
- [04. 개발용 소스 지도](04-source-map.md): 서비스·API·데이터 계약과 구현 검증 경로.
- [전체 코드 파일 인벤토리](source-inventory.json): 두 Flare 묶음과 드론 저장소의 코드 파일 목록 및 깊이 읽은 범위.

## 가장 큰 판단

Flare Stack의 완성도는 청록색 자체보다 **대상 → 상태 → 판독 근거 → 조치**의 순서가 분명한 데서 나온다. 드론 페이지는 원본 AI 판독, 사람 수정, ROI 판독, 보수 판단, 이력을 이미 갖추고 있다. 첫 작업은 이 데이터를 다시 만드는 것이 아니라, 사진 상세의 주 경로를 단순화하고 해당 결과가 어디서 왔는지 한눈에 보이게 하는 것이다.

Flare Stack은 고정 CCTV 프레임의 탐지 객체와 PV 시계열을 다룬다. 드론 앱은 각 사진의 **부식 형상 등급 1–5**를 분류하며 ROI를 다시 잘라 별도 판독하고 SHAP 설명을 제공한다. 따라서 Flare Stack의 객체 박스, Flame/Steam/Smoke 비율, PV 그래프를 드론 화면에 그대로 옮길 수 없다. 공통으로 옮길 것은 탐색·비교·확대·설명·권한·색 사용의 설계다.

## 소스 범위

Flare Stack 로컬 소스는 `flare-stack-ai-cctv-backend-main/flare-stack-ai-cctv-backend-main`의 서비스·프런트엔드와 별도 `flare-stack-ai-cctv-frontend-main/flare-stack-ai-cctv-frontend-main`을 비교했다. 실제 화면의 로그인·설정·HLS 등은 전자의 `frontend`와 더 잘 맞는다. 별도 프런트엔드는 이전 또는 분리된 변형으로 보고 분석의 기준에서 제외했다. 드론 소스는 [공개 저장소의 고정 커밋](https://github.com/junhang-dev/inspection-image-platform/tree/a2c407cc9cd3ccb50fe66e35b0adcdeaeda344a2)을 기준으로 읽었다. 전체 트리의 역할을 훑고 화면·API·저장·ROI·권한과 직결된 파일을 깊게 추적했다. 사용자 권한 기능은 실제 관리자 계정으로 검증하지 못했다.
