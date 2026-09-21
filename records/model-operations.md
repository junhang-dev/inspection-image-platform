# 동결 모델 운영 재현성 보완

2026-09-21 약17:40~17:52 KST. 시작 커밋 `49537c8`. 허브의 핵심 운영 재현성 점검 요청에 따라 모델 소유 경로만 변경했다. 제품 compose.yaml/.env/Dockerfile은 편집하지 않았다.

## 변경

- `ml.serve`: 학습·평가 없이 동결 가중치를 기동하는 전경 실행기. 기본 loopback, 별도 포트 지원, Ctrl-C로 해당 프로세스만 종료.
- `ml/model-contract.json`, `ml.contract`: 모델/전처리 버전과 SHA-256 일치를 확인. 불일치 시 엄격한 운영 시작에 실패.
- `/health`에 전처리 버전과 실제 검증한 가중치 해시를 추가. `ml.healthcheck`는 세 식별자와ready를확인하고실패시종료코드1.
- 시작 시 학습 스크립트를 먼저 실행하게 읽힐 수 있던 README를 동결 모델 운영 절차로 정리.
- `ml/OPERATIONS.md`: Mac 시작·종료·상태·재시작, 기존 수동8001에서 새 진입점으로 전환할 때의 차이, 제품 Compose 연결 경계 설명.
- 선택적인 `ml/Dockerfile`: Linux CPU 추론 전용. 공식 Python/PyTorch/PyPI 수신만 구성. 기본전부제외 `.dockerignore`와명시적COPY로 추론코드·계약·의존성10파일만context허용. 가중치는이미지에넣지않고readonlybind mount로제공하는계약.

## 실제 검증

| 항목 | 결과 |
|---|---|
| `ml.serve --check` | 동결 SHA/model/preprocess 일치 PASS, 이미지추론없음 |
| 운영계약5 + 기존API4 테스트 | 9개 PASS |
| 별도127.0.0.1:8002 시작 | ready 및 세식별자 계약일치 PASS |
| 기존8001 vs 신규8002 demo3장 | grade/confidence/model/preprocess 응답전체일치 |
| 8002 Ctrl-C 종료 | 정상종료 exit0; 이후health 연결거절/exit1 확인 |
| 8002 동일명령 재시작 | 같은3장 응답보존,계약일치 PASS |
| 검증 프로세스 정리 | 재시작검증후8002 정상종료 |
| 현재8001 | 중지·재시작·교체하지않음,검증중ready유지 |
| 동결 가중치 | SHA-256 불변 |
| 추론전용패키지 pins | 설치된Mac환경과전부일치 |
| Docker context | deny-all/명시allowlist/COPY 정적검사PASS |
| Docker build/run | 미실행. Linuxwheel·컨테이너응답동일성 미검증 |

독립 기술검토에서 중요결함이 발견되지 않았다. 실제운영검사는별도loopback포트와승인demo3장만사용했다. 원본학습사진·manifest·고정test사진에접근하거나재학습·재평가하지않았다. 상세실행증거는Git제외 `ml/artifacts/operations.local/`에보존했다.

## 인계 판단과 남은 한계

현재CPU모델은Mac에서이미빠르게실행된다. 모델파일은약3.8MB지만LinuxPyTorch이미지는더큰패키지다운로드·디스크·수치검증이필요하므로이번핵심인계는**Mac기동계약검증완료,컨테이너는선택안준비**로구분한다. MPS를쓰는추론코드가아니므로현재방식에MPS이점은없다.

Mac모델프로세스는Compose라이프사이클밖이다. 터미널종료·Mac재부팅후별도기동이필요하며'모델까지Compose한번으로기동검증완료'라고표시하지않는다. 현재8001은이전수동uvicorn의health필드형식이므로새엄격healthcheck는제품담당이계획한전환후사용한다. 이번에는기존서비스를전환하지않았다.

선택컨테이너는ml/만buildcontext로사용하고가중치를readonly mount해야한다. rootcontext/registry push/원본전송은수행하지않았다. basePython tag는digest고정상태가아니므로실제채택시이미지digest·플랫폼·패키지·demo응답동일성을기록해야한다.

모델성능은기존train99.57% PASS / test60%(기준70%) FAIL 그대로다. 운영재현성PASS를성능합격으로해석하지않는다. Git전담과슬롯조율후공개코드·요약기록만커밋한다.

## 후속 승인에 따른 실제 Linux 검증

위 최초 인계 이후 허브가 같은 로컬 범위의 Docker build/run까지 명시 승인했다. 실제 Linux ARM64 검증이 완료되어 앞의 Docker 미검증 항목은 후속 검증 범위에 한해 해소됐다. 상세는 `records/model-docker-verification.md`와 최신 `ml/OPERATIONS.md`를 참조한다. 제품 Compose에 모델 서비스를 통합하거나 현재8001을 교체한 것은 아니다.
