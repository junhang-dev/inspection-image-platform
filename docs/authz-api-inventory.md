# 로그인·역할 권한 설계를 위한 API 경로 목록

**후속 구현:** 2026-10-11 사용자가 개발 자체 계정과 관리자·업무담당·조회자 역할을 승인해 구현했다. 현재 결과는 [로그인 구현과 확인 범위](auth-implementation.md)를 따른다. 아래 익명 조회 가능·로그인 미구현 기록은 구현 전 관찰이며 실제 과거 증거로 보존한다.

**코드 경로 기준일:** 2026-10-08 · **최근 읽기 확인:** 2026-10-11

**상태:** 서버 코드와 `local-private` 개발 런타임의 읽기 전용 조사. 권한 정책이나 로그인 방식의 승인 문서가 아니다.

## 조사 범위와 결론

현재 `server/`의 API 경로와 서버 시작 구성을 확인했다. API는 계획·사진·판독·보수·TA 묶음·ROI·분석 작업을 제공한다. 제품 코드에서 사용자 로그인, 세션 확인, 역할 또는 팀별 사용자 권한을 확인하는 미들웨어는 찾지 못했다.

현재 경로는 **총 49개 method/path**로 분류했다. 이 중 `DELETE` 경로는 없다. 사진·계획·보수·ROI의 숨김/복원은 `PATCH`로 처리한다. TA 묶음 API는 현재 `GET`과 `POST`만 제공한다.

`server/index.mjs`의 공통 미들웨어는 로컬 전용 프로파일에서 Host, forwarded host/IP를 검사하고, 허용된 브라우저 출처만 CORS에 허용한다. 이것은 실행 위치와 출처를 제한하는 검사다. 사용자 이름이나 역할을 확인하지 않는다. 공유 프로파일에서는 응답 데이터를 공개 계약에 맞게 거르는 미들웨어가 있지만 사용자 신원을 확인하지 않는다. 공개 서비스 앞단의 별도 프록시 인증은 이 조사에서 확인하지 않았다.

일부 변경 API는 요청 본문에서 `actor`, `reason`, `expectedVersion`을 받는다. `actor`와 `reason`은 변경 이력에 저장되고, `expectedVersion`은 동시 수정 충돌을 확인하는 데 쓰인다. `actor`는 요청자가 보낸 문자열이라 로그인 계정 증명이 아니다. 코드가 기록하는 처리자 표기도 동작별로 다르다. 재판독 요청과 ROI 분석 요청 생성 기록은 코드의 기본 이름 `현업 엔지니어`, 사진 판독 백그라운드 작업 기록은 `AI 서비스`, ROI 분석 실행·결과 저장·복구 기록은 `영역 분석 서비스`를 사용한다. 일부 API의 처리자 이름은 사용자가 보낸 값이고, 일부는 서버가 고정해 넣는 값이다. 어느 쪽도 현재 실제 로그인 신원을 증명하지 않는다. 기존 이력을 로그인 계정에 소급 귀속하면 안 된다.

## 개발 런타임 읽기 전용 재검증 — 2026-10-08 14:24 KST

개발 웹 `127.0.0.1:3100/`에 HEAD 요청, 개발 API `127.0.0.1:4100`에 GET 요청을 보냈다. `HEAD /`, `GET /api/health`, `GET /api/locations`는 `200`이었다. Health 응답은 `ready: true`, `dataScope: local-private`였다.

`Authorization`과 `Cookie` 없이 다음 API를 조회했고, 모두 `200`이었다. 세 업무 조회 요청에는 `Origin: http://127.0.0.1:3100`을 지정했다.

| 익명 읽기 요청 | 결과 |
| --- | --- |
| `GET /api/plans` | `200` |
| `GET /api/maintenance/query?page=1&pageSize=1` | `200` |
| `GET /api/maintenance/bundles` | `200` |

따라서 확인한 개발 환경의 조회 경로는 사용자 로그인이나 역할을 확인하지 않는다. 이 결과는 로컬 `local-private` 런타임에만 해당한다. 공유 운영 `3000/4000`, 외부 프록시 인증, API 변경 요청 권한은 시험하지 않았다. 기본 셸 요청은 loopback 접근을 허용받지 못했지만, 사용자 요청 범위의 권한 확장 읽기 전용 요청에서 응답을 확인했다.

## 사용자 요청에 따른 익명 읽기 재시험 — 2026-10-08 15:15 KST

개발 API에 `Authorization`과 `Cookie`를 보내지 않고 `GET /api/health`, `/api/locations`, `/api/plans`, `/api/maintenance/query?page=1&pageSize=1`, `/api/maintenance/bundles`를 다시 조회했다. 모두 `200`이었고 health의 `dataScope`는 `local-private`였다. 따라서 개발 API 조회는 현재 로그인·역할 제한 없이 접근 가능하다. 변경 API, 운영 API, 외부 프록시 인증은 시험하지 않았다.

## 개발 접속 복구 뒤 익명 읽기 확인 — 2026-10-11 09:57 KST

사용자가 OrbStack을 켠 뒤 개발 웹 `3100`과 API `4100`을 실행했다. `Authorization`과 `Cookie`를 보내지 않은 다음 GET 요청은 모두 `200`이었다.

| 읽기 요청 | 확인한 범위 |
| --- | --- |
| `/api/health` | `ready: true`, `dataScope: local-private`, `model.ready: false` |
| `/api/plans?visibility=all` | 숨김 포함 15건. 기본 검사계획 화면의 전체 13건과 조회 범위가 다르다. |
| `/api/maintenance/query` | 사진별·보수 대상 포함·현재 항목·업무 자료·1페이지/10장 조건에서 총 108건 |
| `/api/maintenance/query`에 `ta=true&unbundledOnly=true` 추가 | 같은 조건의 미배정 TA 사진 총 2건 |
| `/api/maintenance/bundles` | 저장 묶음 0개 |

이 결과는 확인한 `local-private` 개발 조회 경로가 사용자 로그인·역할 확인 없이 응답한다는 근거다. 역할별 변경 권한, 다른 팀 자료에 대한 거부, 세션 만료, 운영 서비스 앞단 인증은 시험하지 않았다. 목록 필터나 Host/CORS 검사를 사용자 권한으로 계산하지 않는다. 업무 API 변경 요청과 계정·권한 설정은 하지 않았다.

## 경로 목록

현재 서버 소스에 선언된 API 경로를 권한 설계 단위로 묶었다. `조회`, `변경`은 HTTP 동작의 성격만 뜻한다. 현재 역할별 허용 여부가 구현되어 있다는 뜻은 아니다.

| 업무 | HTTP 경로 | 동작 | 권한 설계 시 볼 점 |
| --- | --- | --- | --- |
| 서비스·위치 | `GET /api/health` | 상태 조회 | 서비스 범위와 모델·저장소 상태가 노출된다. |
| 서비스·위치 | `GET /api/locations` | 팀·랙 목록 조회 | 위치 목록 열람 범위가 필요한지 정한다. |
| 데모 | `GET /api/demo/:name` | 허용 목록의 데모 이미지 제공 | 이미지 열람 권한과 업무 원본 권한을 구분한다. |
| 포인트 | `GET /api/points` | 포인트 조회 | `recordPurpose`는 조회 조건이지 사용자 권한이 아니다. |
| 포인트 | `POST /api/points` | 포인트 등록 | 생성 권한·팀/랙 범위가 미정이다. |
| 포인트 | `PATCH /api/points/:id` | 포인트 정보 수정 | `actor`·`reason`·버전을 받지만 신원 검증은 없다. |
| 포인트 | `GET /api/points/:id/history` | 변경 이력 조회 | 이력 열람 권한을 따로 정한다. |
| 포인트 | `PATCH /api/points/:id/purpose` | 기록 목적 변경 | 공개·업무 범위 변경 권한과 감사 책임이 필요하다. |
| 검사계획 | `GET /api/plans` | 계획 목록 조회 | 팀·랙·기록 목적·숨김 상태 필터는 사용자 접근 차단과 다르다. |
| 검사계획 | `GET /api/plans/:id` | 계획 상세 조회 | 팀/계획 범위 열람 권한이 미정이다. |
| 검사계획 | `GET /api/plans/:id/history` | 계획 이력 조회 | 이력 열람 권한을 따로 정한다. |
| 검사계획 | `POST /api/plans` | 계획 생성 | 생성 담당자와 범위가 미정이다. |
| 검사계획 | `PATCH /api/plans/:id` | 계획 수정·상태·숨김/복원 | 수정·재개·숨김/복원 권한을 분리할지 정한다. |
| 검사계획 | `PATCH /api/plans/:id/purpose` | 기록 목적 변경 | 공개·업무 범위 변경 권한과 감사 책임이 필요하다. |
| 검사 사진 | `GET /api/inspections/query` | 필터·페이지 조회 | 팀·랙·계획 필터는 서버의 사용자별 데이터 범위 권한이 아니다. `labeling=true`는 라벨 후보 조회 필터다. |
| 검사 사진 | `GET /api/inspections` | 사진 목록 호환 조회 | 기존 호환 경로다. 새 권한 적용 때 함께 보호해야 한다. |
| 검사 사진 | `GET /api/inspections/:id` | 사진 메타데이터 조회 | 숨김 상태·다른 팀 자료에 대한 접근 규칙이 미정이다. |
| 검사 사진 | `GET /api/inspections/:id/thumbnail` | 썸네일 제공 | 원본 보기와 별개로 열람 권한 대상이다. |
| 검사 사진 | `GET /api/inspections/:id/image` | 원본 이미지 제공 | 민감 원본 열람·다운로드 권한을 명시한다. |
| 검사 사진 | `GET /api/inspections/:id/history` | 사진 이력 조회 | 이력 열람 권한을 따로 정한다. |
| 검사 사진 | `PATCH /api/inspections/:id` | 위치·사람 등급·재촬영·라벨 후보 변경 | 수정 항목별 역할을 정한다. `labeling`은 후보 지정이지 외부 라벨 작성이 아니다. |
| 검사 사진 | `PATCH /api/inspections/:id/visibility` | 숨김·복원 | 삭제처럼 보이는 숨김과 복원 권한·사유·책임자를 정한다. |
| 검사 사진 | `PATCH /api/inspections/:id/purpose` | 기록 목적 변경 | 데이터 공개·분류 범위 변경 권한이 미정이다. |
| AI 판독 | `POST /api/inspections/:id/retry` | 재판독 요청 | 재판독을 누가 요청할지, 자동 처리 actor를 어떻게 기록할지 정한다. |
| 사진 업로드 | `POST /api/demo-inspections` | 고정 데모 사진 등록 | 업무 원본 업로드와 다른 기능이다. 공개 실행에서의 허용 조건도 별도 확인한다. |
| 사진 업로드 | `POST /api/inspections` | 다중 파일 업로드 | 업로드 권한·팀/계획 범위·공개 정책을 정한다. |
| 청크 업로드 | `POST /api/upload-sessions` | 전송 세션 생성 | 사용자가 세션을 소유하는 연결이 현재 없다. |
| 청크 업로드 | `GET /api/upload-sessions/:id` | 세션 상태 조회 | 세션 소유자·관리자만 상태를 볼지 정한다. |
| 청크 업로드 | `PUT /api/upload-sessions/:id/chunks` | 파일 조각 전송 | 세션 소유자와 상태별 청크 전송 권한을 정한다. 별도 취소 API는 없다. |
| 청크 업로드 | `POST /api/upload-sessions/:id/complete` | 업로드 완료·사진 저장 | 완료 권한과 중복/재시도 책임을 정한다. |
| 청크 업로드 | `POST /api/upload-sessions/:id/restart` | 업로드 재시작 | 세션 소유자 검증이 필요하다. |
| 보수 기록 | `GET /api/maintenance/query` | 보수 목록·건수 조회 | 필터·팀/랙 범위가 역할별 데이터 제한인지 별도로 정한다. |
| 보수 기록 | `GET /api/maintenance/pair` | 계획·포인트 보수 조회 | 해당 계획과 포인트 범위를 확인한다. |
| 보수 기록 | `GET /api/maintenance/target` | 사진별 보수 조회 | 사진 접근 권한과 함께 제한한다. |
| 보수 기록 | `GET /api/maintenance/:id` | 보수 상세 조회 | 열람 권한이 미정이다. |
| 보수 기록 | `GET /api/maintenance/:id/history` | 보수 이력 조회 | 이력 열람 권한을 따로 정한다. |
| 보수 기록 | `POST /api/maintenance` | 보수 항목 생성 | 상태·방법·TA 설정 변경 권한은 현업 역할 합의가 필요하다. |
| 보수 기록 | `PATCH /api/maintenance/:id` | 보수 항목 수정·상태·숨김/복원 | 완료·제외·숨김/복원 의미와 담당 역할을 정한다. |
| TA 작업 묶음 | `GET /api/maintenance/bundles` | 묶음 목록 조회 | 묶음과 각 사진의 접근 범위를 맞춘다. |
| TA 작업 묶음 | `POST /api/maintenance/bundles` | 사진을 묶어 새 묶음 생성 | 현재 API에 수정·삭제 경로는 없다. 편집 책임과 이력 규칙이 미정이다. |
| ROI | `GET /api/inspections/:id/rois` | 사진 영역 조회 | 원본 사진 접근 권한과 같은 경계를 적용할지 정한다. |
| ROI | `POST /api/inspections/:id/rois` | 영역 생성 | 분석 대상 편집·요청 권한을 정한다. |
| ROI | `PATCH /api/rois/:id` | 영역 수정·숨김/복원 | 수정·숨김 권한과 이력 책임을 정한다. |
| ROI | `GET /api/rois/:id/history` | 영역 이력 조회 | 이력 열람 권한을 따로 정한다. |
| ROI 분석 | `POST /api/analysis-jobs` | 사진 분석·설명 작업 생성 (ROI 선택 가능) | 모델 실행 권한과 대상 범위를 정한다. |
| ROI 분석 | `GET /api/inspections/:id/analysis-jobs` | 사진별 분석 내역 조회 | 사진 조회 권한을 따른다. |
| ROI 분석 | `GET /api/analysis-jobs/:id` | 분석 결과 조회 | 사진·영역 권한을 확인한다. |
| ROI 분석 | `POST /api/analysis-jobs/:id/cancel` | 진행 작업 취소 | 요청자·관리자 취소 권한을 정한다. |
| ROI 분석 | `GET /api/analysis-jobs/:id/history` | 분석 이력 조회 | 이력 열람 권한을 따로 정한다. |

별도 계정·역할 관리 API, 외부 Label Studio 전송·실제 라벨 작성·내보내기 API는 현재 제품 경로에서 확인하지 못했다. `labeling` 값은 사진의 후보 표시와 목록 필터다. 판독 결과 반영은 별도 사용자용 결과 등록 API가 아니라 서버 내부의 비동기 처리 경로다.

업로드 세션에는 취소·삭제 API가 없다. 필요한 경우 세션 만료·정리의 자동 동작과 사용자 취소 기능을 별도 설계 항목으로 다룬다.

## 권한 설계에 넘길 기준

- 목록 필터, `recordPurpose`, 숨김 상태, 데이터셋 허용 정책, CORS, Host/IP 검사는 사용자 역할 검증으로 계산하지 않는다.
- 사진 목록뿐 아니라 원본·썸네일·이력·다운로드 경로까지 직접 호출 권한을 설계한다. UI 버튼 숨김만으로 접근을 제한할 수 없다.
- 조회, 업로드/생성, 판독 재요청, 사람 판정 수정, 보수/TA 변경, 숨김/복원, ROI/분석, 이력 열람을 각각 권한표에 올린다.
- 전역 권한과 팀·랙·계획 범위 권한을 구분한다. 실제 범위와 역할 이름은 현업·IT가 정하기 전까지 제안 상태다.
- 로그인 구현 시 `actor`는 인증된 사용자 식별자에서 생성한다. 기존 문자열 이력은 보존하고, 과거 기록을 새 계정에 소급 연결하지 않는다.
- 보호를 시작할 때 브라우저만 막지 말고 각 API에서 비로그인·허용/거부 역할·다른 범위·만료 세션을 검증한다. 배포 프록시 보호는 별도 인프라 조사로 확인한다.

## 근거 파일

- 공통 미들웨어·기본 경로: [`server/index.mjs`](../server/index.mjs#L44-L78)
- 계획: [`server/plan-routes.mjs`](../server/plan-routes.mjs#L13-L21)
- 보수와 묶음: [`server/maintenance-routes.mjs`](../server/maintenance-routes.mjs#L52-L100), [`server/maintenance-bundle-routes.mjs`](../server/maintenance-bundle-routes.mjs#L28-L40)
- ROI·분석: [`server/roi-routes.mjs`](../server/roi-routes.mjs#L47-L127)
- 개인 개발 요청 제한: [`server/runtime-profile.mjs`](../server/runtime-profile.mjs#L100-L119)
- 사진·라벨 후보 필터: [`server/photo-query.mjs`](../server/photo-query.mjs#L17-L65)
- 이력 저장과 버전 충돌 검사: [`server/store.mjs`](../server/store.mjs#L146-L168), [`server/store.mjs`](../server/store.mjs#L212-L239), [`server/store.mjs`](../server/store.mjs#L257-L299)

이번 조사는 서버 코드 정적 확인과 위에 적은 개발 런타임 HTTP HEAD/GET만 수행했다. DB 직접 연결, API 변경 요청, 로그인·권한 코드 변경, 자동 테스트, 운영·배포 인프라 점검은 하지 않았다.
