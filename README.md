# Drone Inspection Platform

생산팀별 검사계획 → 파이프랙 → 사진·ROI·AI 판독 근거 → 보수 워크리스트 → 결과·이력을 연결하는 **검사·보수 통합 관제** 프로젝트입니다. AI 결과를 바로 사용할 수 있으며 사람 검수는 필수 관문이 아닙니다.

**2026-09-22 확대 수정 진행 중:** [v3 계획](docs/product-v3.md)에 따라 포인트 없이 만드는 생산팀별 계획, 팀별 30랙, 추가 업로드, 보수 필요 자동 워크리스트, 수정·삭제, ROI·SHAP, 단계별 모델 개선과 고정 제출 주소를 구현합니다. [새 요구의 진행 현황](records/2026-09-22-product-v3-status.md)을 확인하세요. 아래 v2 인수 결과는 이전 버전의 증거이며 새 요구 완료를 뜻하지 않습니다.

2026-09-21 추가된 최종 제품 요구는 [제품 확장 설계·검증 기준](docs/product-v2.md)에 모았습니다. 계획에서 사진을 올리는 흐름, 가상 팀 구역 지도, 사진 삭제·복원, 보수 방법별 워크리스트, 업로드 제한 개선과 화면 정리를 구현했습니다. 실제 화면·백엔드 파일·변경 이력을 대조한 실행 결과는 [완료 인수 기록](records/2026-09-22-completion-handoff.md)에 정리했습니다. 합의한 제품 구현·필수 실행 검증을 마쳤으며, 모델 성능 미달과 운영 관제는 별도로 유지합니다.

**현재 공유 사이트:** [플랜트파일럿 열기](https://yellow-asp-says-needle.trycloudflare.com). 06:13 KST 운영 중단 뒤 같은 코드·모델로 복구했으며, 이전 임시 주소는 종료됐습니다. 06:26 KST 새 주소의 외부·로컬 응답, 같은 웹 빌드·모델 식별자와 업로드 Origin 허용을 확인했습니다. 원본 전용 로컬 환경의 기록도 보존됐습니다. 종료 계기는 아직 확인되지 않았으며 30분 관제를 계속합니다.

**공유 사이트의 코드 기준(2026-09-22 03:05 KST 반영, 06:26 KST 복구 확인):** 웹은 [지도 클릭 개선 PR #19](https://github.com/junhang-dev/inspection-image-platform/pull/19)의 `776bcf9`, API는 [보수·워크리스트 PR #18](https://github.com/junhang-dev/inspection-image-platform/pull/18)의 `6fbae15`, 모델 입력 코드는 [PR #13](https://github.com/junhang-dev/inspection-image-platform/pull/13)의 `90dc402`입니다. 계획 우선 등록·대용량 이어올리기·KPI 목록 이동·사진 삭제/복원·가상 지도에 이어 **계획·포인트별 보수 상태와 방법, 명시적으로 저장하는 별도 워크리스트**를 반영했습니다. 지도 수정은 운영 소스에서 화면 파일 두 개만 교체했고, 기존 공유 주소에서 외부·로컬 HTML·CSS·API 준비 상태와 사진·보수 조회를 확인했습니다. 모델의 가중치·전처리·평가 결과는 유지합니다.

표시 목적에 따른 업무·검증 자료 분리 기능도 검증했습니다. 생성 근거가 확인된 사진 21개와 검증용 계획 1개만 분류해 **기본 업무 목록은 사진 44개·계획 3개**로 정리했습니다. 이번 보수 버전 전환에서도 전체 사진 65개·포인트 4개·계획 4개와 기존 이력 236개를 보존하고, 기존 관리 상태를 보수 기록 4개로 이관하며 이력 8개를 추가했습니다. 별도 격리 환경에서는 실제 새 사진 두 장으로 계획 생성부터 판독·재촬영 사유·보수/워크리스트 저장·이력 재조회와 서비스 재시작 후 파일·기록 보존을 확인했습니다. 후속 단일 연속 자동 실행은 **총 3.970초, AI만 기다린 1.298초를 제외한 업무 조작 2.672초**로 관찰됐습니다. 승인 사진 한 장을 사용한 에이전트 실행이며 사람의 판단·OS 파일 찾기 시간은 포함하지 않습니다.

새 업로드 경로의 승인 사진 복제 10장은 **저장 확인까지 8.815초, 이후 전체 AI 결과 표시까지 6.237초**였습니다. 배치 판독이 미완료인 동안 계획·캘린더·대기 목록을 사용할 수 있었고, 처리 중 숨긴 사진은 AI 완료 후에도 목록·KPI·지도에서 제외됐습니다. 재촬영·라벨 후보의 개별 해제와 원래 AI·보수·이력 보존도 확인했습니다. **원본 300장도 공유 서비스와 분리한 로컬 환경에 실제 등록**했습니다. 팀별 75장·랙별 25장으로 가상 배치하고 299개 고유 파일의 저장·API 재조회와 재시작 후 보존, 전체 사진의 마지막 페이지 접근을 확인했습니다. 지도에서 발견한 랙 표시 겹침은 수정 후 PC·모바일 36개 클릭으로 확인했습니다. 이 원본은 공유 사이트나 Git에 공개하지 않았습니다. 별도 환경에서는 실패 사진의 화면 버튼을 한 번 눌러 같은 사진에 실제 판독 결과가 반영되는 것도 확인했습니다. 07시 후속 QA에서 실제 macOS 파일 선택창과 취소 뒤 선택 파일 없음·전송 비활성을 직접 확인했습니다. 취소 전후 DB 네 테이블의 개수·해시 요약과 사진·계획·포인트·보수 API 응답도 같았습니다. OS 창에서의 다중 선택 조작과 네트워크 쓰기 요청 개수는 이 취소 검사의 범위에 포함하지 않습니다. [추가 요구별 현재 상태](records/2026-09-22-product-v2-status.md), [독립 QA PR #4](https://github.com/junhang-dev/inspection-image-platform/pull/4), [설계·지도 자산 PR #5](https://github.com/junhang-dev/inspection-image-platform/pull/5)를 함께 확인하세요. 초안 PR 게시와 `main` 병합은 구분합니다.

독립 업로드 검증에서는 12개 선택과 추가 긴 이름 파일 1개, 총 13개의 입력·DB·API 다운로드·MinIO 원본 크기와 SHA-256이 일치했고 실제 AI 판독을 확인했습니다. 28,323,297바이트의 유효 합성 PNG도 포함하며 그 등급은 성능 평가에 쓰지 않았습니다. 부분 실패·응답 손실·새로고침 후 같은 ID로 복구했고, 중복 완료 요청이 사진이나 이력을 늘리지 않았습니다. 업로드 버전 전환 당시 사진 64개·포인트 4개·계획 4개를 보존했으며, 이번 조회·지도 전환 시점에는 새 사진 한 개가 추가된 65개·4개·4개입니다. 이 운영 수량과 격리 검증 환경의 1,001개 페이지 검사 자료는 구분합니다.

로컬 원본 등록 코드는 [PR #20](https://github.com/junhang-dev/inspection-image-platform/pull/20)의 `e263593`이며, 지도 수정 [PR #19](https://github.com/junhang-dev/inspection-image-platform/pull/19)의 `776bcf9`를 기반으로 합니다. 원본 300장 자체는 포함하지 않습니다. 새 API는 명시적인 실행 범위·신뢰 자료 계약·전용 DB/버킷 표식을 요구하므로 기존 공유 API에 그대로 교체하지 않습니다. 해당 브랜치의 실행 안내에 따라 분리한 로컬 환경에서 사용합니다.

**2026-09-21 착수 기록 — 당시 main 기준:** **2026-09-21 구현을 시작했습니다. 실제 제품 기동·모델 성능·외부 접속의 완료 여부는 수행 기록으로 확인합니다.** 먼저 최신 [목표·범위·완료 기준](docs/goal.md)을 읽고, AI와 작업할 때는 [AGENTS.md](AGENTS.md)를 따릅니다.

**제품 v2 인수 기록 — e263593 기준:** 업로드·실제 모델 판독·계획별 조회·지도·보수 기록을 구현했고 로컬 서비스와 임시 외부 접속을 검증했습니다. 원본 300장은 별도 로컬 저장소에서 관리합니다. 모델의 고정 평가 정확도는 60%로 합격선 70%에 미달하며, 실제 동료의 사용 시간과 현장 효과는 측정하지 않았습니다. 먼저 [목표·범위·완료 기준](docs/goal.md)을 읽고, AI와 작업할 때는 [AGENTS.md](AGENTS.md)를 따릅니다.

## 들어 있는 것

| 위치 | 용도 |
|---|---|
| `README.md` | 팀원 시작 안내 |
| `AGENTS.md` | AI 작업·협업 기준 |
| `docs/goal.md` | 합의한 목표, 이번 범위와 완료 기준 |
| `docs/product-v2.md` | 최종 제품 추가 요구, 관계 데이터·화면 설계, 단계별 검증 |
| [ref/](ref/) | 업무 흐름·아키텍처·등급 기준·향후 구상 그림 6개 |
| [image/demo/](image/demo/) | 기존 train에서 등급별 한 장씩 복제한 시연 사진 5개 |
| [records/](records/) | 실제 행사 시작 이후의 첫 프롬프트·세션 로그·검사 결과 |

샘플은 사용자가 공개 활용을 허용한 과제 사진입니다. 중립적인 이름으로 복제했으며 정답·성능 평가용 테스트 세트가 아닙니다. 원본 300장과 부가 자료·기존 분리 목록은 Jun이 로컬에서 보존합니다. 고정 test 10장은 샘플 선정이나 튜닝에 사용하지 않습니다.

구현과 실행 검증은 [운영 기록](records/platform-runbook.md), [업로드](docs/uploads.md), [사진 조회](docs/photo-query.md), [보수 기록](docs/maintenance.md)에 정리했습니다. 원본 300장 등록과 전용 실행은 [로컬 원본 연결](docs/private-import.md)을 따릅니다. **이 API 버전은 명시적인 실행 범위·메타데이터 계약·DB/버킷 표식 없이 시작하지 않습니다.** 기존 공유 서비스를 업그레이드하기 전에 해당 문서의 전환 조건을 확인하세요.

제품·모델·목표 문서는 PR #1·#2·#3으로 `main`에 병합되었습니다(2026-09-21 확인 커밋 `64221ad`). [제품 실행 안내](https://github.com/junhang-dev/inspection-image-platform/blob/main/records/platform-runbook.md), [모델 실행 안내](https://github.com/junhang-dev/inspection-image-platform/blob/main/ml/README.md), [모델 최종 평가](https://github.com/junhang-dev/inspection-image-platform/blob/main/records/model-final-evaluation.md)를 확인하세요. 일반 사진 업로드·시연 중복 방지·오류 안내·설비/랙 개념 맵의 후속 변경은 [PR #7](https://github.com/junhang-dev/inspection-image-platform/pull/7)에 있습니다.

웹·API·MySQL·MinIO·동결 모델의 5서비스 Compose 기동과 전체 중단/재시작 후 데이터 보존도 별도 환경에서 확인했습니다. [PR #8](https://github.com/junhang-dev/inspection-image-platform/pull/8)은 PR #7 위의 추가 구성이고 [PR #6](https://github.com/junhang-dev/inspection-image-platform/pull/6)의 모델 소스가 필요합니다. 이후 정확한 후보 소스를 별도 폴더에 결합해 웹·API·모델 전체 빌드와 실제 업로드·저장·추론도 확인했습니다. 첫 패키지 다운로드 실패는 연결 회복 후 같은 소스로 재시도해 통과했습니다. 이는 병합 전 검증이며 `main` 병합이나 공유 서비스 전환을 의미하지 않습니다. 현재 공유 사이트는 기존 Mac 실행을 유지합니다.

실제 파일·화면·오류 복구·시간·동시 업무의 검증 결과는 [QA 기록 PR #4](https://github.com/junhang-dev/inspection-image-platform/pull/4)에 있습니다. 외부 업로드 10장 저장 목록까지 13.01초, 접수 후 AI 등급 10개 표시까지 17.45초를 1회 관찰했습니다. 실제 AI 처리 중 계획 작성·저장·캘린더 표시도 자동 조작으로 확인했으며, 사람이 전체 업무를 1분에 수행했다는 뜻은 아닙니다. 사용자 후속 합의로 **전체 업무 조작 약 1분에서 AI 판독 대기는 제외**합니다. [동료 검수표](docs/team-review.md)는 선택 피드백이며, 사람 검수 결과가 없어도 에이전트가 실제 화면·저장 파일을 검증하고 개선을 계속합니다. [자율 개선 기준 변경 기록](records/2026-09-21-autonomous-improvement.md)을 함께 확인하세요.

현재 모델은 **train 99.57%로 90% 기준 PASS, 고정 test 60%로 70% 기준 FAIL**입니다. 파일 업로드·저장·실제 추론 연결 성공과 모델 성능 합격을 구분합니다. 공개 저장소에 원본 데이터와 학습 가중치는 없으므로 코드 복제만으로 Jun의 실행 환경과 동일한 모델이 준비되는 것은 아닙니다. 각각의 브랜치에 있는 실행 안내와 `records/`의 한계를 함께 확인하세요.

로컬 Label Studio와 재학습 관리의 구현·검증은 [PR #9](https://github.com/junhang-dev/inspection-image-platform/pull/9)에 있습니다. 실제 시연 후보 표시·라벨 제출·내보내기와 제한된 후보 학습을 확인했으며, 검증용 라벨을 학습에 넣거나 서비스 모델을 교체하지 않았습니다. 19:00 KST 네트워크 복구 점검에서 기존 공유 주소·모델·DB가 정상임을 확인했고, Label Studio의 일부 접속 오류도 프록시 수정 후 정상화했습니다.

## 팀원이 시작하는 방법

현재 공유 버전의 코드를 자료 작성·검증에 쓰려면 **새 폴더에** 제품 브랜치를 복제합니다. 출력된 커밋이 위 제품 기준과 같은지 확인하세요. 제품 브랜치에는 `ml/` 자체가 없으므로 모델 소스는 PR #13의 고정 커밋에서 검토용 폴더에 함께 가져옵니다. 아래 모델 파일 복원은 작업 폴더에 소스를 추가하며 Git 커밋이나 브랜치 병합을 수행하지 않습니다.

```sh
git clone --branch codex/jun/platform-map-marker-fix https://github.com/junhang-dev/inspection-image-platform.git inspection-image-platform-review
cd inspection-image-platform-review
git rev-parse HEAD
git fetch origin codex/jun/model-streaming-upload
git restore --source=90dc40209ded6b330552e20079780aa7ac90f635 --worktree -- ml/
```

실행 절차는 제품 브랜치의 `records/platform-runbook.md`, `docs/uploads.md`, `docs/photo-query.md`, `docs/maintenance.md`, `records/platform-maintenance-v2.md`와 가져온 `ml/OPERATIONS.md`를 함께 읽으세요. 라벨링 후보의 새 페이지 조회 호환은 [PR #16](https://github.com/junhang-dev/inspection-image-platform/pull/16)에 별도로 있으며 현재 모델 서버의 교체를 뜻하지 않습니다. 로컬 원본·DB·가중치·비밀 설정은 Git에 없으므로 코드 복제만으로 운영 데이터와 모델이 준비되지는 않습니다. 실제 공유 서비스는 Mac에서 실행 중이며, 위 안내는 동료의 별도 검토 환경을 위한 것입니다.

`main`에 병합된 기준부터 새 폴더에서 시작하려면 다음과 같이 복제합니다. 위 최신 초안 PR의 기능이 모두 포함된 상태는 아닙니다.

```sh
git clone https://github.com/junhang-dev/inspection-image-platform.git
cd inspection-image-platform
```

기존 복제본에 로컬 변경이 있으면 먼저 보존하세요. **현재 브랜치가 `main`이고 작업 트리가 깨끗한 경우에만** `git pull --ff-only`로 갱신합니다. 자기 작업은 별도 브랜치에서 진행하고, 제품 코드 통합은 Jun에게 모읍니다. 같은 파일의 편집 담당과 Git 작성 담당은 한 번에 한 명입니다.

실제 행사를 시작할 때 `records/`에 **시작 시각·시작 커밋·사용한 목표·첫 프롬프트**를 기록하고, 이후 실제 세션과 실행한 검사 결과를 남깁니다. 공개 전 비밀·개인 대화를 확인하며, 지금의 사전 준비를 행사 실행 증거로 기록하지 않습니다.

## 참고 그림

- [기존 업무 흐름](ref/before.png) · [개선 흐름 구상](ref/after.png) · [아키텍처 초안](ref/inspection-image-platform-architecture.png) · [등급 판정 기준](ref/%EB%93%B1%EA%B8%89%ED%8C%90%EC%A0%95%EA%B8%B0%EC%A4%80.png)
- 지도 참고: [3D map](ref/3d%20map.png) · [지도·드론 연동 계획](ref/map%20%EA%B8%B0%EB%B0%98%20%EB%93%9C%EB%A1%A0%20%EC%9E%90%EB%8F%99%20%EC%A0%90%EA%B2%80%20%EC%97%B0%EB%8F%99%20%ED%96%A5%ED%9B%84%20%EA%B3%84%ED%9A%8D.png). 사용자 제공 항공 캡처와 기존 3D 참고 그림을 보강해 가상 정유 1~4팀 → 파이프랙 → 포인트로 연결합니다. **AI 보강 이미지는 시각 참고이며 가상 구역·좌표는 실제 측량 자료가 아닙니다. 실제 설비 3D 디지털 트윈·드론 dock 연동은 제외합니다.**

그림에는 후순위 기능도 포함돼 있습니다. 이번 구현 범위는 `docs/goal.md`가 기준입니다.
