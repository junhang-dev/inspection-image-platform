# 로컬 원본 연결과 실행

기존 원본 300개를 같은 Mac의 전용 제품에서 조회한다. 파일은 300개를 그대로 보존하고, 같은 내용의 중복 1개는 객체 299개와 사진 기록 300개로 표현한다. 공개가 허용된 시연 복제본 5개는 원본의 alias이며 사진 5개를 추가하지 않는다. 기존 학습 231 / 검증 58 / 고정 평가 10 분리는 바꾸지 않는다.

가상 정유팀 4개에 75개씩, 팀의 가상 랙 3개에 25개씩 배치한다. 사진의 안정 식별자만으로 배치하며 사진 내용·파일명 정답·예측 등급을 사용하지 않는다. 4개 계획과 랙별 12개 가상 사진 묶음을 연결한다. 실제 설비 위치와 검사일은 미확인이다.

## 별도 저장소 준비

로컬 인계 자료의 배치 plan과 학습 판독 report 경로·SHA를 확인한 뒤 다음 명령의 변수를 지정한다. 이 자료와 실제 원본, 자격 파일은 Git 또는 Docker build context에 넣지 않는다. `setup-private`는 기존 설정을 덮어쓰지 않는다.

```sh
node scripts/setup-private.mjs \
  --root "$PWD/local/private-runtime" \
  --plan "$PRIVATE_PLAN_PATH" --plan-sha256 "$PRIVATE_PLAN_SHA256" \
  --train-report "$PRIVATE_TRAIN_REPORT_PATH" \
  --train-report-sha256 "$PRIVATE_TRAIN_REPORT_SHA256"

docker compose -p inspection-private \
  --env-file local/private-runtime/infra.env -f compose.private.yaml \
  up -d --wait
node scripts/bootstrap-private-bucket.mjs "$PWD/local/private-runtime"
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" \
  node scripts/mark-storage-profile.mjs --apply
```

전용 DB는 13307, MinIO는 19000, API는 4100, 웹은 3100을 사용하며 모두 127.0.0.1에만 연결한다. MinIO 콘솔은 외부 포트를 열지 않는다. 전용 MySQL 사용자는 해당 schema, MinIO 사용자는 해당 bucket 읽기·쓰기와 multipart 처리에만 권한을 갖는다. API에는 관리자 자격을 전달하지 않는다. bootstrap은 실제 설치된 IAM 정책과 사용자 연결을 확인해 로컬 감사 파일을 남긴다.

`api.env`와 `infra.env`는 서로 다른 역할의 자격이며 공유 서비스의 `.env`를 복사해 만들지 않는다. API 시작 전에 실행 범위, 전용 포트·자격, DB/bucket의 `storage_profile`, 보존 메타데이터 SHA를 검증한다. 외부 Host, 외부 프록시 주소, Cloudflare 전달 헤더는 전용 API에서 거절한다. 전용 웹/API를 공개 터널에 연결하지 않는다.

## 등록·재개·판독

```sh
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" node scripts/import-private.mjs
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" node scripts/import-private.mjs --apply
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" node scripts/infer-private.mjs
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" node scripts/infer-private.mjs --apply
```

`--apply` 없는 import는 메타데이터만 확인하며 원본을 읽지 않는다. 적용 시 보존된 크기/SHA와 원본이 일치해야 하고 JPG/PNG 서명만 확인해 바이트 그대로 복사한다. 등록 중 이미지 디코더나 모델은 호출하지 않는다. registry는 manifest SHA+sourceId로 UUID와 배치를 먼저 예약한다. 객체는 같은 키의 실제 크기/SHA를 확인해 재사용하고, 사진·이력·등록 완료를 한 DB transaction으로 확정한다. 완료된 기록을 다시 가져와도 AI·사람 판단·현재 관계·이력을 초기화하지 않는다. `--stop-after 6`은 6개 신규 등록 뒤 종료 코드 75로 중단해 같은 명령으로 재개하는 검증용 옵션이다.

전체 작업은 동일 DB 연결의 advisory lock을 사용한다. 연결을 잃으면 복사·모델 요청을 취소하고 후속 저장을 차단한다. 실행별 임시 폴더를 분리하며 24시간이 지난 임시 폴더만 정리한다. 이미 모델 서버가 시작한 내부 계산까지 취소된다고 보장하지는 않는다. 확정 여부가 불명확한 객체를 자동 삭제하지 않는다.

캐시는 보고서 SHA → manifest → 원본 ID/SHA → 모델·전처리·checkpoint를 대조한다. 캐시가 없거나 일치하지 않으면 미판독으로 남긴다. 캐시에 원래 판독 시각이 없으면 미확인으로 표시하며 파일 수정 시각이나 가져오기 시각으로 대신하지 않는다. MySQL JSON의 숫자 표현으로 confidence의 마지막 소수점이 IEEE-754 한 단위 달라질 수 있다. 원보고서 SHA를 유지하며 검증은 등급·모델·출처를 정확히 비교하고 confidence에만 machine epsilon을 허용한다.

등록한 모든 원본은 자동 큐·재시도에서 제외한다. `infer-private --apply`만 기존 결과가 없는 비평가 사진을 동결 모델로 판독한다. 실제 객체 전체를 로컬 파일에 받아 SHA/크기를 확인한 뒤 동일 파일 디스크립터를 전송한다. 모델의 세 식별자와 결과의 모델·전처리 식별자가 일치해야 저장한다. sourceId 또는 실제 SHA가 고정 평가 사진이면 이름·alias·클라이언트 split과 무관하게 판독을 거절한다. multipart, 청크 완료, 재시도, worker, 재시작 복구도 같은 정책을 사용한다.

## 실행·검증

```sh
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" npm run start:api
# 다른 터미널: 이 빌드는 API4100에만 연결한다.
API_INTERNAL_BASE_URL=http://127.0.0.1:4100 npm run build
PORT=3100 npm start
# 저장된 모든 객체의 바이트를 검사하고 raw DB/이력을 로컬에 기록한다.
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" \
  node scripts/verify-private.mjs before-restart.local.json --complete
```

웹은 `http://127.0.0.1:3100`이다. 운영 중인 공유 웹의 빌드 폴더를 덮어쓰지 않도록 별도 실행 디렉터리에서 빌드한다. 의존성을 복사할 때 상대 symlink를 보존한다. API/web을 종료하고 전용 Compose 서비스를 재시작한 뒤 같은 설정으로 API/web을 다시 시작한다. 아래 비교는 객체 299개의 원본 바이트와 DB 모든 행·전체 이력·registry·alias가 그대로인지를 검사한다. 운영 중 `down -v`는 사용하지 않는다.

```sh
DOTENV_CONFIG_PATH="$PWD/local/private-runtime/api.env" \
  node scripts/verify-private.mjs after-restart.local.json --complete \
  --compare before-restart.local.json
```

단위 검사는 `npm test`, 타입 검사는 `npm run typecheck`다. `tests/helpers/private-fixture.mjs`는 합성 픽셀 300개만 생성한다. 실제 SQL/HTTP 통합 검사는 포트 13308/19002/4300과 `local/private-verification/fixture`의 독립 환경을 요구한다. `PRIVATE_IMPORT_INTEGRATION=1`, 해당 환경의 `DOTENV_CONFIG_PATH`, `node --import=dotenv/config --test tests/private-import.integration.test.mjs`를 실행한 뒤 같은 방식으로 `tests/private-runtime.integration.test.mjs`를 실행한다. 일반 `npm test`는 이 두 실제 인프라 검사를 건너뛴다.

## 기존 공유 서비스 전환 조건

이 버전은 공유 API에도 `DATA_SCOPE=shared`, 절대 `DATASET_PLAN_PATH`, 정확한 `DATASET_PLAN_SHA256`을 요구한다. 정책용 메타데이터와 그 참조 파일만 같은 Mac에서 읽을 수 있어야 한다. API 컨테이너에서는 해당 메타데이터 경로를 읽기 전용으로 연결해야 한다. 원본 이미지나 전용 자격을 공유 컨테이너에 연결하지 않는다.

공유 DB·버킷은 기존 사진·이력을 보존한 채 해당 공유 설정으로 `mark-storage-profile.mjs --apply`를 실행해 범위를 표시한다. 비공개 기록이나 다른 범위 표식이 있으면 전환을 거절한다. 설정 누락 시 기본 저장소로 대신 시작하지 않는다. 실제 공유 운영은 별도 검증한 보수 버전을 유지하며, 이번 로컬 원본 등록은 공유 API 업그레이드 또는 원본 300장의 공개 배포를 의미하지 않는다.
