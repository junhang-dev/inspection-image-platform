# 플랜트파일럿 · PlantPilot

검사계획 → 생산팀·파이프랙·포인트 → 사진 업로드·AI 판독 → 보수 워크리스트 → 결과·이력을 연결하는 **검사·보수 통합 관제** 프로젝트입니다. AI 결과를 바로 사용할 수 있으며 사람 검수는 필수 관문이 아닙니다.

2026-09-21 추가된 최종 제품 요구는 [제품 확장 설계·검증 기준](docs/product-v2.md)에 모았습니다. 계획에서 사진을 올리는 흐름, 가상 팀 구역 지도, 사진 삭제·복원, 보수 방법별 워크리스트, 업로드 제한 개선과 화면 정리를 단계적으로 구현합니다. 아래 기존 수행 결과와 새 요구의 구현 상태는 구분하며, 문서 반영만으로 새 기능을 완료 처리하지 않습니다.

**현재 공유 사이트의 코드 기준(2026-09-21 22:10 KST):** [계획 중심 첫 구현 PR #14](https://github.com/junhang-dev/inspection-image-platform/pull/14)의 `0159062`입니다. PlantPilot 이름, 팀·랙 연결, 계획 상세에서 포인트·사진 추가, 같은 포인트의 계획별 사진 분리를 반영했습니다. 실제 파일·화면·충돌 복구 결과는 [QA 기록 PR #4](https://github.com/junhang-dev/inspection-image-platform/pull/4), 추가 설계와 보강 지도 자산은 [PR #5](https://github.com/junhang-dev/inspection-image-platform/pull/5)에 있습니다. 초안 PR 게시와 `main` 병합은 다르며, 업로드 제한 개선·삭제·워크리스트·새 지도 화면까지 완료됐다는 뜻은 아닙니다.

**2026-09-21 구현을 시작했습니다. 실제 제품 기동·모델 성능·외부 접속의 완료 여부는 수행 기록으로 확인합니다.** 먼저 최신 [목표·범위·완료 기준](docs/goal.md)을 읽고, AI와 작업할 때는 [AGENTS.md](AGENTS.md)를 따릅니다.

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

제품·모델·목표 문서는 PR #1·#2·#3으로 `main`에 병합되었습니다(2026-09-21 확인 커밋 `64221ad`). [제품 실행 안내](https://github.com/junhang-dev/inspection-image-platform/blob/main/records/platform-runbook.md), [모델 실행 안내](https://github.com/junhang-dev/inspection-image-platform/blob/main/ml/README.md), [모델 최종 평가](https://github.com/junhang-dev/inspection-image-platform/blob/main/records/model-final-evaluation.md)를 확인하세요. 일반 사진 업로드·시연 중복 방지·오류 안내·설비/랙 개념 맵의 후속 변경은 [PR #7](https://github.com/junhang-dev/inspection-image-platform/pull/7)에 있습니다.

웹·API·MySQL·MinIO·동결 모델의 5서비스 Compose 기동과 전체 중단/재시작 후 데이터 보존도 별도 환경에서 확인했습니다. [PR #8](https://github.com/junhang-dev/inspection-image-platform/pull/8)은 PR #7 위의 추가 구성이고 [PR #6](https://github.com/junhang-dev/inspection-image-platform/pull/6)의 모델 소스가 필요합니다. 이후 정확한 후보 소스를 별도 폴더에 결합해 웹·API·모델 전체 빌드와 실제 업로드·저장·추론도 확인했습니다. 첫 패키지 다운로드 실패는 연결 회복 후 같은 소스로 재시도해 통과했습니다. 이는 병합 전 검증이며 `main` 병합이나 공유 서비스 전환을 의미하지 않습니다. 현재 공유 사이트는 기존 Mac 실행을 유지합니다.

실제 파일·화면·오류 복구·시간·동시 업무의 검증 결과는 [QA 기록 PR #4](https://github.com/junhang-dev/inspection-image-platform/pull/4)에 있습니다. 외부 업로드 10장 저장 목록까지 13.01초, 접수 후 AI 등급 10개 표시까지 17.45초를 1회 관찰했습니다. 실제 AI 처리 중 계획 작성·저장·캘린더 표시도 자동 조작으로 확인했으며, 사람이 전체 업무를 1분에 수행했다는 뜻은 아닙니다. 사용자 후속 합의로 **전체 업무 조작 약 1분에서 AI 판독 대기는 제외**합니다. [동료 검수표](docs/team-review.md)는 선택 피드백이며, 사람 검수 결과가 없어도 에이전트가 실제 화면·저장 파일을 검증하고 개선을 계속합니다. [자율 개선 기준 변경 기록](records/2026-09-21-autonomous-improvement.md)을 함께 확인하세요.

현재 모델은 **train 99.57%로 90% 기준 PASS, 고정 test 60%로 70% 기준 FAIL**입니다. 파일 업로드·저장·실제 추론 연결 성공과 모델 성능 합격을 구분합니다. 공개 저장소에 원본 데이터와 학습 가중치는 없으므로 코드 복제만으로 Jun의 실행 환경과 동일한 모델이 준비되는 것은 아닙니다. 각각의 브랜치에 있는 실행 안내와 `records/`의 한계를 함께 확인하세요.

로컬 Label Studio와 재학습 관리의 구현·검증은 [PR #9](https://github.com/junhang-dev/inspection-image-platform/pull/9)에 있습니다. 실제 시연 후보 표시·라벨 제출·내보내기와 제한된 후보 학습을 확인했으며, 검증용 라벨을 학습에 넣거나 서비스 모델을 교체하지 않았습니다. 19:00 KST 네트워크 복구 점검에서 기존 공유 주소·모델·DB가 정상임을 확인했고, Label Studio의 일부 접속 오류도 프록시 수정 후 정상화했습니다.

## 팀원이 시작하는 방법

현재 공유 버전의 코드를 자료 작성·검증에 쓰려면 **새 폴더에** 해당 브랜치를 복제합니다. 출력된 커밋이 위 기준과 같은지 확인하고, 실행 절차는 해당 브랜치의 `records/platform-runbook.md`와 `records/platform-plan-workflow-v2.md`를 함께 읽으세요. 로컬 원본·DB·학습 가중치는 Git에 없으므로 이 명령만으로 운영 데이터와 모델이 준비되지는 않습니다.

```sh
git clone --branch codex/jun/platform-plan-workflow-v2 https://github.com/junhang-dev/inspection-image-platform.git inspection-image-platform-review
cd inspection-image-platform-review
git rev-parse HEAD
```

새 폴더에서 시작하려면 다음과 같이 복제합니다.

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
