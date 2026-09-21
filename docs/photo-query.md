# 사진 조회·표시 계약

`GET /api/inspections/query`는 목록·KPI·최근 사진·지도 사진 수에 쓰는 공통 조회다. 필터를 SQL `WHERE`에서 먼저 적용하고 전체 집계와 페이지를 구분한다. 완료하지 못한 업로드 세션은 사진에 포함하지 않는다.

## 요청과 응답

- `planId`, `pointId`: `all`(기본), UUID, `unassigned`. 사진에 직접 저장된 관계만 사용하며 이름·날짜로 계획을 추측하지 않는다.
- `recordPurpose`: `inspection`(기본), `presentation`, `verification`, `all`. 기존 누락 값은 업무 검사로 읽는다. 이름에 demo/validation이 들어 있어도 자동 분류하지 않는다.
- `visibility`: `visible`(기본), `hidden`, `all`. 누락 값은 표시 중으로 읽는다.
- `teamId`, `rackId`: `all` 또는 가상 위치 카탈로그 ID. 같은 팀의 랙이어야 한다.
- `search`: 사진명·설비·랙·포인트 이름의 부분 문자열. `%`, `_`, `=`를 와일드카드로 해석하지 않는다.
- `classification`: `all`(기본), `repair`, `pending`, `retake`, `done`, `error`.
- `labeling`: `all`(기본), `true`.
- `page`: 1부터. `pageSize`: 1~100, 기본 50. 반환 상한은 페이지 크기이며 전체 저장 수량 제한이 아니다.

응답은 `items`, `total`, `page`, `pages`, `pageSize`, `summary`, `pointCounts`, `scope`다. `total`은 해당 분류를 포함한 전체 건수, `items`는 현재 페이지다. 빈 결과도 `page=1`, `pages=1`이다. 요청 페이지가 마지막 페이지를 넘으면 실제 마지막 페이지로 맞춘다. `scope`는 검증·기본값 적용 후 요청이며 실제 페이지는 루트 `page`를 사용한다.

`summary`는 공통 조건에서 `classification`만 제외한 네 카드와 완료·실패·라벨링 후보 수다. 따라서 카드 집합은 겹칠 수 있다.

| 카드 | 조건 |
|---|---|
| 전체 검사 사진 | 저장된 사진의 모든 판독 상태 |
| 보수 필요 분류 | `humanGrade ?? ai.grade`가 3 이상 |
| AI 판독 대기·진행 | `pending` 또는 `processing` |
| 재촬영 필요 | `retake === true` |

`pointCounts`는 현재 분류까지 포함한 같은 조건의 포인트별 전체 사진 수다. 한 응답의 집계·목록·포인트 수는 같은 MySQL 반복 읽기 트랜잭션에서 조회한다. `created_at DESC, id DESC`로 정렬한다. 서로 다른 페이지 요청은 하나의 고정 스냅샷이 아니므로, 검증·외부 연결은 페이지 중복/누락·총수 변동을 감지하고 다시 조회해야 한다. `scripts/photo-records.mjs`가 이 검사를 제공한다.

포인트와 계획도 `recordPurpose`의 누락을 업무 검사로 읽으며 `GET /api/points`, `GET /api/plans`는 기본 업무 검사만 반환한다. `?recordPurpose=all`은 관계·이력·검증을 위한 명시적 전체 조회다. 각각의 `/:id/purpose` PATCH는 같은 CAS 계약을 사용한다. 부모의 목적을 바꿔도 기존 자식 사진의 목적은 바꾸지 않는다. 신규 계획·포인트·사진 생성에는 목적을 명시할 수 있고, 파일별 전송 세션의 목적은 재시도 중 바꿀 수 없다. 목적 없는 기존 전송 큐·세션은 업무 검사로 이어진다.

기존 배열 `GET /api/inspections`의 기본 1,000개 상한은 호환을 위해 유지하며 `X-Total-Count`를 제공한다. 새 화면·전체 자료 검증에는 페이지 API를 쓴다. 선택 사진은 `GET /api/inspections/:id`로 독립 조회하므로 AI 상태 변화로 목록 필터를 벗어나도 상세 상태를 갱신한다.

## 숨김·복원과 목적

- `PATCH /api/inspections/:id/visibility`: `visibility`, `expectedVersion`, `actor`, `reason`만 받는다. 서버에서 숨김 시각·작업자·사유를 기록한다. 복원은 현재 숨김 표시를 해제하며 과거 숨김 이력은 유지한다.
- `PATCH /api/inspections/:id/purpose`: `recordPurpose`, `expectedVersion`, `actor`, `reason`만 받는다. 원래 AI·사람 판단·관계·원본은 바꾸지 않는다.
- 두 작업 모두 잠근 최신 행에서 수정 버전을 비교한다. 오래된 값은 409로 거절한다. AI 작업은 별도 큐에서 처리하며 숨김·목적·사람 판단을 덮어쓰지 않는다.
- 숨긴 사진의 원본·썸네일은 객체·썸네일 캐시에 접근하기 전에 404로 처리한다. 새 응답은 `no-store`다. 이미 내려받았거나 이전 버전에서 캐시한 바이트를 회수하는 기능은 아니다.
- 숨김은 원본 삭제나 접근 권한 관리가 아니다. 공개 미승인 원본을 공유 DB·버킷에 넣지 않는 기존 경계를 유지한다. `presentation`도 공개 승인을 뜻하지 않는다.

화면은 계획·목적·표시 상태·팀·랙·검색 조건을 카드 이동 중 유지한다. 조회 실패를 0으로 표시하지 않으며, 유지한 자료에는 마지막 조회임을 안내한다. 계획·포인트 상세도 같은 범위의 전체 건수와 페이지를 쓴다. 지도 배경·좌표는 가상 참고이며 실제 측량·설비 확인 결과가 아니다.

## 검증 도구

`scripts/verify-photo-query.mjs`는 **별도 smoke API 컨테이너**에서 합성 메타데이터를 추가한다. 명시적 격리 환경 식별값과 모델 연결 차단 상태가 필요하며 운영 환경에서 실행하지 않는다. 기존 승인 demo 객체를 참조하고 합성 AI 값은 실제 추론으로 취급하지 않는다. 6개 KPI 계약, 1,001개 페이지, 계획 분리, 숨김·복원 원본, CAS, 조회 중 경합과 기존 자료 보존을 확인한다.

`verify-persistence.mjs`는 모든 사진 목적·숨김을 포함한 전 페이지를 조회한다. 기본 모드는 원본 SHA도 확인한다. 숨긴 원본은 해당 환경의 `PERSISTENCE_MINIO_ENDPOINT/PORT`를 명시해 MinIO에서 확인한다. `--metadata-only`는 메타데이터·이력만 확인하며 원본 검증으로 보고하지 않는다. 포인트·계획이 기존 배열 상한에 도달하면 전체 보존으로 통과시키지 않는다.
