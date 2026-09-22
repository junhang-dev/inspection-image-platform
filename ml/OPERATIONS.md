# 동결 모델 실행·운영 인계

이 절차는 **학습·최종 평가 없이 이미 동결한 모델을 실행**한다. 현재 모델 성능은 train99.57% PASS / test60%(기준70%) FAIL이다. 재시작 성공을 성능 합격으로 바꾸지 않는다.

## 필요한 파일

- 추론 코드와 `ml/model-contract.json`: Git에 포함한다. 계약에는 모델 버전·전처리 버전·가중치 SHA-256만 있다.
- 동결 가중치 `model.pt`: Mac 로컬에만 보관한다. 현재 로컬 기본 위치는 `ml/artifacts/finetune.local/model.pt`다.
- Python3.11과 프로젝트 가상환경. 기존 개발 환경은 `ml/requirements.txt`로 설치한다. 추론 전용 새 환경에서는 torch2.14.0/torchvision0.29.0과 `ml/requirements-runtime.txt`를 설치한다.

서버를 실행하는 데 사진 원본, split manifest, train/validation/test, 학습 스크립트가 필요하지 않다. 평가 기록과 test 재실행 방지 registry는 별도 로컬 감사 자료로 계속 보존한다.

## Mac에서 확인·시작·종료·재시작

저장소 루트에서 실행한다. 기본 loopback은 다른 컴퓨터에 모델 API를 직접 공개하지 않는다.

```sh
# 가중치·버전만 확인: 이미지를 추론하거나 포트를 열지 않는다.
ml/.venv/bin/python -m ml.serve --check

# 시작: 이 터미널에서 전경으로 실행한다.
ml/.venv/bin/python -m ml.serve --port 8001
```

다른 경로의 동결 가중치는 `--checkpoint /absolute/path/model.pt`로 지정한다. 운영 계약은 `--contract /absolute/path/model-contract.json`으로 지정할 수 있다. 가중치 해시나 모델·전처리 버전이 계약과 다르면 준비 상태가 되지 않고 시작에 실패한다.

별도 터미널의 상태 확인:

```sh
ml/.venv/bin/python -m ml.healthcheck --port 8001
```

ready=true와 세 가지 모델 식별자가 계약과 같으면 종료코드0, 미기동·불일치·로딩 실패는 종료코드1이다.

**종료:** 시작한 터미널에서 Ctrl-C를 한 번 누르고 `Application shutdown complete`를 확인한다. **재시작:** 종료 후 같은 시작 명령을 실행하고 healthcheck를 확인한다. PID를 추측해 종료하거나 모든 Python 프로세스를 종료하지 않는다. 이 실행기는 기존 프로세스를 찾아 종료하거나 포트를 강제로 확보하지 않는다.

이미 사용 중인 포트가 있으면 별도 포트로 점검한다.

```sh
ml/.venv/bin/python -m ml.serve --port 8002
ml/.venv/bin/python -m ml.healthcheck --port 8002
```

현재8001은 이전 `uvicorn ml.service:app` 명령으로 기동된 서비스다. 이번 작업에서는 중지·교체하지 않았다. 기존 `/health`는 ready/model_version만 제공하므로 새 엄격한 healthcheck의 추가 필드를 충족하지 않는다. 운영 인계 시 제품 담당이 정한 중단 시점에 새 `ml.serve`로 전환한다. 기존 서비스가 불량이라는 뜻은 아니다.

## 제품 Compose와 연결

Mac 별도 모델을 유지하면 제품 API가 `http://host.docker.internal:8001`을 사용한다. 현재 제품 Compose의 `MODEL_DOCKER_API_URL` 계약과 맞춘다. 호스트 loopback 접근은 Docker 환경에 따라 달라질 수 있으므로 API 컨테이너 안에서 `/health` 및 승인 demo 추론을 확인한다. 연결이 안 된다고 모델을 자동으로0.0.0.0에 공개하거나 방화벽을 변경하지 않는다.

Mac 전경 모델 프로세스는 `docker compose up/down`에 포함되지 않는다. 터미널 종료·Mac 재부팅 후에는 별도로 시작해야 한다. 따라서 지금 구성을 '모델까지 Compose 한 명령으로 완전 재현'이라고 보고하지 않는다. 이번에는 새 자동 실행 서비스나 전역 시스템 설정을 만들지 않았다.

## 선택적인 Linux CPU 컨테이너 제안

현재 추론 코드는 CPU를 사용한다. 따라서 MPS 의존성 없이 Linux CPU 실행을 시도할 수 있지만 **Linux ARM64에서 실제 build/run, demo3장 수치 비교, stop/start를 검증했다**. 모델 파일은약3.8MB, 로컬이미지는1,034,742,007bytes(약0.964GiB)다. 최초패키지설치단계159초, 기동후메모리snapshot364.7MiB였다. 공식Python베이스는확인한digest로고정했다. Linux AMD64나미검증사진전체의수치동일성을주장하지않는다.

공식 Python 이미지, PyTorch CPU index, PyPI 패키지를 받는 구성만 준비했다. 원본·가중치·manifest를 이미지에 넣거나 registry로 push하지 않는다.

```sh
# 반드시 ml/를 context로 사용한다. 저장소 루트 context를 사용하지 않는다.
docker build -f ml/Dockerfile -t inspection-model:local ./ml

# 제품8001과 겹치지 않는 선택적 검증 예시. 실행할 때 절대경로를 넣는다.
docker run --name inspection-model-check --rm \
  --read-only --tmpfs /tmp:rw,nosuid,size=64m \
  -e TMPDIR=/uploads-tmp \
  --mount type=volume,src=inspection-model-upload-tmp,dst=/uploads-tmp \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src=/absolute/path/model.pt,dst=/models/model.pt,readonly \
  --mount type=bind,src=/absolute/path/final-freeze.local.json,dst=/models/final-freeze.json,readonly \
  -p 127.0.0.1:8002:8001 inspection-model:local \
  --host 0.0.0.0 --port 8001 --checkpoint /models/model.pt --contract /models/final-freeze.json
```

`ml/.dockerignore`는 기본 전부 제외 후 명시된 추론 코드·계약·의존성 파일10개만 허용한다. Dockerfile의 COPY도 같은 파일로 제한한다. 가중치는 **읽기 전용 bind mount**로만 제공한다. non-root UID10001이 읽을 수 있는 로컬 파일인지 확인한다. 파일이 없거나 해시가 다르면 시작 실패가 정상이다. Linux에서도 모델·전처리 버전뿐 아니라 승인 demo의 등급·점수를 Mac 결과와 대조한 뒤 채택한다.

최신 Dockerfile은 `/uploads-tmp`를 UID:GID10001:10001, 권한0700으로 만들고 `TMPDIR` 기본값도 지정한다. **새 전용 named volume의 기본 copy-up을 사용하면 root 초기화 helper가 필요 없다.** `volume-nocopy` 또는 Compose `volume.nocopy: true`를 지정하지 않는다. 새 볼륨 및 동일 볼륨의 컨테이너 재생성 후 쓰기·정리는 [실행 기록](../records/model-volume-copyup.md)에서 확인했다. 이미지에 `VOLUME` 선언은 없으므로 볼륨은 실행 설정에 명시해야 한다.

기존 비어 있지 않은 볼륨의 소유권은 이미지 변경으로 교정되지 않는다. 실제 권한을 확인하고, 기존 볼륨을 삭제·초기화하지 않는다. host bind 방식을 선택하면 별도 전용 디렉터리를 만들고 UID10001의 읽기·쓰기·탐색 권한을 제공해야 한다. 원본·DB·가중치 경로를 임시 저장소로 사용하지 않는다. 임시 경로는 외부에 공개하거나 Git에 넣지 않는다. 디스크 TMPDIR는64MiB `/tmp` tmpfs와 별개다. 쓰기 불가·디스크 부족은503 `upload_storage_unavailable`로 처리한다. 정상 완료·오류·연결 중단 뒤 임시 파일을 닫고, 진행 중인 디스크 I/O나 추론은 끝난 뒤 닫는다. 강제 OS종료의 파일 정리는 운영 환경에 따라 별도 확인해야 한다.

제품 담당의 Compose 선택안(직접 적용하지 않음):

```yaml
services:
  model:
    profiles: ["model"]
    build:
      context: ./ml
      dockerfile: Dockerfile
    environment:
      TMPDIR: /uploads-tmp
    volumes:
      - type: volume
        source: model-upload-tmp
        target: /uploads-tmp
      - type: bind
        source: ${MODEL_WEIGHTS_PATH:?Set absolute local frozen checkpoint path}
        target: /models/model.pt
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ${MODEL_CONTRACT_PATH:?Set absolute local frozen contract path}
        target: /models/final-freeze.json
        read_only: true
        bind:
          create_host_path: false
    command: ["--host", "0.0.0.0", "--port", "8001", "--checkpoint", "/models/model.pt", "--contract", "/models/final-freeze.json"]
    read_only: true
    tmpfs:
      - /tmp:rw,nosuid,size=64m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    restart: unless-stopped
volumes:
  model-upload-tmp:
```

같은 Compose 네트워크의 API 연결 주소는 `http://model:8001`이다. 모델 포트를 호스트에 공개할 필요는 없다. 제품 담당이 API의 환경변수·profile·`depends_on: condition: service_healthy`를 함께 조정해야 한다. 중지는 해당 Compose 서비스 대상으로 하고 DB/MinIO 볼륨을 삭제하지 않는다. 제품 compose.yaml/.env/Dockerfile은 이 모델 작업에서 편집하지 않았다.

## 이번에 실제 확인한 범위

- Mac 별도8002에서 `ml.serve` 시작, 계약 일치 health, Ctrl-C 정상종료, 종료후 health 실패, 동일 명령 재시작.
- 기존8001과8002의 승인 demo3장 응답 전체가 일치. 재시작 후에도 같은3장 응답이 보존됨.
- 기존8001은 계속 ready, 가중치 SHA-256 불변. test 접근·재학습 없음.
- 운영계약/기존API 테스트9개 통과, 독립 코드 검토에서 중요결함 없음.
- Docker allowlist 정적 검사 및 실제 Linux ARM64 build/run 통과. 실제 build context 전송12.17kB. 이미지 자체에가중치·비공개freeze·artifacts없음확인.
- 공식Python base digest `sha256:a36c24f9cbdf4fd0f52d67f0823eeac19c2028c637cecc392d97f980d4fec56b`.
- 로컬image ID `sha256:7cccccbf011893a98eff0afa5c449741e0610ad940486f62f80f66f8b66aa76f`. Python3.11.16,torch2.14.0+cpu,torchvision0.29.0+cpu,Pillow12.3.0.
- weights와비공개동결계약은실행시에만readonly bind mount. container readonly root, UID10001, CPU2/memory2GiB, 127.0.0.1:8002로검증.
- Mac vs Linux demo3장 grade/model/preprocessing완전일치,confidence최대차1.1920928955078125e-7(사전허용오차1e-5이하).
- 동일container stop→미준비확인→start후같은bytes3장응답완전보존. 검증container정리후기존8001유지,로컬이미지만보존.
- 제품Compose에model서비스를실제통합한검증은별도제품담당범위다. 이작업에서제품Compose나현재8001을교체하지않았다.

위 Linux 이미지 ID와 수치 대조는 스트리밍 변경 이전 검증이다. 최신 스트리밍 API의 Mac 검증은 [스트리밍 기록](../records/model-streaming-upload.md), 정확한 `f89d970` 소스의 새 Linux 이미지·UID10001·96MiB 실제 디스크 스풀 검증은 [Docker 후속 기록](../records/model-streaming-docker.md)을 따른다. 이후 Dockerfile의 디렉터리 사전 생성과 root helper 없는 named volume 초기화는 [copy-up 기록](../records/model-volume-copyup.md)을 따른다. host bind 권한과 제품 Compose 통합은 별도 검증 대상이다.

TMPDIR 설정만으로 저장 위치를 확정하지 않는다. Python은 잘못된 임시 경로에서 다른 경로를 선택할 수 있으므로 실제 실행UID로 `tempfile.gettempdir()`와 임시 파일 생성·쓰기·정리를 확인한다. 초기화 helper에서 소유권을 넘긴 뒤 권한을 변경하면 최소 capability 구성에서는 실패할 수 있다. 권한을 먼저 설정하고 소유권을 마지막에 넘기거나, 넘긴 뒤 해당UID로 권한을 설정한다.
