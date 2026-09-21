# 로컬 Label Studio와 재학습 관리

현재 연결 범위는 **고정 승인 demo 5개 중 제품에서 labeling 후보로 지정된 사진**이다. 새 일반 업로드와 test는 받지 않는다. demo는 기존 train 원본 SHA에 연결하며 표본 수를 늘리지 않는다. 모든 명령은 저장소 루트에서 실행한다.

## 기동과 유지

Label Studio 1.23.0 공식 이미지 digest는 `sha256:aa461572e8f9d86a1bf9520c1db620204e86160fd2f80dd7e9d40ac84a8828ea`다. 태그의 digest가 바뀌면 기동 스크립트가 거부한다.

```sh
docker --context orbstack pull heartexlabs/label-studio:1.23.0
python3 -m labeling.local_runtime
python3 -m labeling.loopback_proxy
```

첫 번째 Python 명령은 컨테이너를 만들고, 두 번째는 전경에서 `http://127.0.0.1:8085`를 제공한다. 이 터미널을 유지한다. 기존 컨테이너를 암묵적으로 삭제하거나 교체하지 않는다. 이미 만들어진 컨테이너는 아래처럼 다시 시작한 뒤 프록시를 실행한다.

```sh
docker --context orbstack start inspection-label-studio-local
python3 -m labeling.loopback_proxy
```

프록시는 Ctrl+C로 종료하고, 컨테이너는 `docker --context orbstack stop inspection-label-studio-local`로 종료한다. 재생성으로 내부 IP가 바뀌면 프록시도 다시 시작한다. 자동 부팅 복구는 제공하지 않는다. 제품 Compose와 별도이며 제품 담당만 Compose를 수정한다.

OrbStack internal network의 published port가 활성화되지 않는 것을 실제 확인했다. 그래서 컨테이너의 외부 송신 차단을 유지하고, 정확히 그 컨테이너 내부 주소만 전달하는 로컬 프록시를 둔다. 프록시는 127.0.0.1에만 바인딩하며 HTTP 요청에서 목적지를 받지 않는다. 버전 확인을 위한 PyPI 연결도 내부망에서 실패하지만 서비스는 정상 시작한다.

`state.local/images`만 `/label-studio/candidates/approved`에 readonly mount한다. local-files 문서 루트는 `/label-studio/candidates`다. DB는 별도 `state.local/db`, 토큰·비밀번호는 권한600의 `state.local/secrets.local.env`에 있다. 로그인 계정은 `operator@localhost`; 비밀번호는 해당 로컬 파일에서 확인한다. 이 파일을 명령 출력·Git·URL·제품 프런트엔드에 넣지 않는다. 공개 터널에 LS/프록시/학습 API를 연결하지 않는다.

## 후보 연결과 실제 라벨 내보내기

```sh
python3 -m labeling.bridge prepare --manifest /absolute/path/split.local.json
python3 -m labeling.bridge import --snapshot SNAPSHOT_SHA256
```

prepare는 localhost4000의 `/api/inspections/query`를 pageSize100으로 끝까지 읽는다. 매 요청에 `labeling=true`, `visibility=visible`, 모든 팀·랙·계획·포인트 및 분류 범위를 명시한다. `engineer_review_pending`은 `recordPurpose=inspection`만 허용한다. `workflow_test`는 `recordPurpose=all`로 조회하되 각 행의 목적을 inspection/presentation/verification 세 값으로 검사한다. 이는 아직 inspection으로 남은 기존 검증 후보를 포함하기 위한 허브 합의이며, 승인 demo5개의 SHA/train 제한은 그대로다. 별도 수동 목적·ID 옵션은 추가하지 않는다.

페이지별 total/pages/page/pageSize/scope와 항목 수를 검사하고 고유UUID수=total이어야 진행한다. 중복·범위 밖 목적/hidden·페이지 보정/정체·조기 빈 페이지·총수 변동은 재시도 가능한 오류로 중단한다. 전체 페이지를 검증하기 전 이미지를 다운로드하거나 snapshot을 쓰지 않으며, 구 배열 API로 fallback하지 않는다. 실패하면 원인을 확인한 뒤 prepare 전체를 새로 실행한다. 서버는 응답 하나의 snapshot만 보장하므로 같은 total을 유지한 동시 교체까지 한 시점의 전체 후보라고 증명하지는 않는다.

승인 demo 이름·고정 SHA·symlink 여부와 기존 동결 manifest SHA·분리 구조도 먼저 검사한다. 후보 bytes를 다시 해시하고 같은 SHA는 하나의 원본으로 묶는다. snapshot은 명시 조회범위·전체수/고유UUID수·페이지 수, 각 후보의 backend ID/수정 시각/목적/visibility/원래 AI/사람 수정값을 보존한다. training_eligible=false이며 원본 사진·test pixels는 열지 않는다. 기존 snapshot/export/검토 registry는 다시 쓰거나 승격하지 않는다.

import는 실제 프로젝트와 후보 전용 Local Files storage를 등록한다. 이미지 URL만 넣으면 LS1.23의 프로젝트 파일 권한 검사에서404가 나므로 storage가 필수다. 실패한 import receipt는 보존되며 같은 snapshot의 무조건 재import를 막는다. 현재 초기404 진단용 프로젝트1은 기록으로 남겼고, 수정된 프로젝트2에서2개 제출/내보내기를 확인했다.

웹 UI에서 사진을 보고 등급을 선택하고 Submit한다. 기본 프로젝트의 라벨은 `workflow_test`이며 학습에 사용할 수 없다.

```sh
python3 -m labeling.bridge export --snapshot SNAPSHOT_SHA256
```

출력된 export SHA의 JSON은 `labeling/state.local/exports/`에 저장된다. source ID·SHA·task ID·annotation ID/작성자/시각과 원래 AI·사람 수정·학습 annotation이 분리된다. 미완료 라벨은 빈 annotation으로 남으며 검토 승인이 불가능하다. 충돌·다른 task·변경된 이미지 연결은 거부한다. 라벨 export가 제품의 AI나 humanGrade를 덮어쓰지 않는다.

## 실제 엔지니어 검토 라벨을 사용하는 후속 절차

이번 기능 검증 라벨을 승격하지 않는다. 실제 엔지니어가 작업할 새 프로젝트를 처음부터 별도로 만든다.

```sh
python3 -m labeling.bridge prepare --manifest /absolute/path/split.local.json --purpose engineer_review_pending
python3 -m labeling.bridge import --snapshot NEW_SNAPSHOT_SHA256
# 실제 엔지니어가 UI에서 라벨 작성 후:
python3 -m labeling.bridge export --snapshot NEW_SNAPSHOT_SHA256
```

엔지니어는 export를 검토하고 각 항목에 대해 다음 형식의 로컬 decisions JSON을 작성한다. 값은 실제 export의 source_id/sha256/완료된 grade여야 하며 임의 예시를 정답으로 쓰지 않는다.

```json
[{"source_id":"ID_FROM_EXPORT","sha256":"SHA256_FROM_EXPORT","grade":3}]
```

```sh
python3 -m labeling.bridge review --export-sha256 EXACT_EXPORT_SHA256 --decisions /absolute/path/decisions.local.json --reviewer '실제 검토자' --reason '검토 근거'
```

정확한 export 해시·항목별 결정·검토자·사유·시각을 묶은 새 reviewed JSON을 만든다. `workflow_test`는 이 명령으로도 승격할 수 없다. CLI의 검토자 문자열은 인증된 신원 증명이 아니며, 신뢰된 Mac 운영자가 실제 사람 검토를 확인해 실행하는 로컬 절차다. 실제 엔지니어 라벨 품질과 현장 적합성은 이번 자동 검증에서 확인하지 않았다.

## 재학습 미리보기와 명시적 단회 승인

```sh
ml/.venv/bin/python -m ml.retraining preview --manifest /absolute/path/split.local.json --initial /absolute/path/frozen-model.pt
# 실제 검토 라벨을 적용할 때만 --labels /absolute/path/reviewed-export.json 추가
ml/.venv/bin/python -m ml.retraining approve --snapshot EXACT_SNAPSHOT_SHA256 --config-sha256 EXACT_CONFIG_SHA256 --actor '승인 주체' --reason '승인 근거'
ml/.venv/bin/python -m ml.retraining run --snapshot EXACT_SNAPSHOT_SHA256
ml/.venv/bin/python -m ml.retraining history
```

미리보기는 고정 train231/validation58만 복사한 immutable snapshot을 만든다. test 항목은 학습 snapshot에 넣지 않는다. SHA 중복과 새 표본·validation 라벨 변경을 거부하고, reviewed 라벨은 기존 train 항목의 라벨 보완에만 사용한다. 원본 분리 파일과 원본 bytes는 변경하지 않는다.

승인은 snapshot/config SHA와 정확히 연결된다. 승인·실행 입구에서 원래 동결manifest의 ID/SHA/path/split/source_root와 검토라벨·초기가중치 계약을 다시 대조한다. 내용을 바꾸고 새 해시를 붙인 snapshot도 거부한다. 단회 consumed marker를 배타적으로 만들고, 실행 시작/실패/완료/후보 등록을 로컬에 남긴다. 후보 등록까지 성공해야 완료로 기록하며 실패 이력이 우선한다. 같은 승인을 재사용할 수 없다. 실패나 중단 후에는 원인을 검토하고 새 snapshot/승인을 만들어야 한다. 임의 학습 명령·외부 URL·HTTP 실행 API는 제공하지 않는다.

작은 검증 설정은 동결된 MobileNetV3 backbone의 특징 + 로지스틱 head1개(C0.1,balanced,CPU2threads)다. 결과는 candidate_only로 등록하며 최종 test는 미평가다. 현재8001 모델 교체 명령은 없다.

2026-09-21 허브의 기존 사용자 승인 근거로 정확한 snapshot/config의1회 실행을 실제 확인했다. actor는 `hub agent`로 기록했으며 새로운 사람 승인이나 라벨 품질 승인을 가장하지 않았다. 후보 train100% / validation56.90%, macroF1 .547647로 기존 validation63.79%보다 낮다. 관리 기능 검증 성공이며 성능 개선은 아니다. 기존 동결 모델의 test60% FAIL을 대체하지 않는다. 추가 반복 실험은 수행하지 않았다.

## 검사

```sh
ml/.venv/bin/python -m unittest labeling.test_bridge ml.test_retraining -v
```

실패 이력·승인 재사용·snapshot 변조·test 포함 거절은 격리 단위 검사로 확인했다. 실제 현장 라벨로 재학습하는 실험은 아직 수행하지 않았다. 비공개 상태/토큰/DB/라벨/가중치/상세증거/스크린샷은 `*.local` 아래에 보존하고 공개하지 않는다.
