# 배포 v3: 고정 HTTPS 주소

제출 주소는 **[Drone Inspection Platform](https://drone-inspection-g10.dlwnsgod2761.workers.dev)** 이다. 이 문서는 고정 주소의 연결, 실제 공유 제품 버전, 데이터 보존과 운영 조건을 기록한다.

## 현재 연결

```text
고정 workers.dev
  → Worker (SHARED_WEB binding 1개)
  → HTTP VPC Service (127.0.0.1:3000 한 곳)
  → named Cloudflare Tunnel
  → 공유 Next 웹 3000 → /api rewrite → 공유 API 4000
```

Worker·VPC Service·named Tunnel을 각각 하나 생성했다. 기존 Workers Free($0) 계정에서 진행했고, 추가 유료 지출·결제 등록·새 OAuth 또는 관리 API token 발급은 없었다. 기존 quick tunnel은 복구용으로 유지한다. DB·사진 저장소·모델 포트를 외부에 직접 연결하지 않는다.

| 항목 | 최종 확인 |
| --- | --- |
| 공유 제품 소스 | 제품 커밋 `efe33b5b9212b44c5a61c1459c2ec9a29ffb4a3c` ([PR #25](https://github.com/junhang-dev/inspection-image-platform/pull/25)), 동결 소스 SHA `4d68a1a0e5e69154334622d4ad1ac13891b7dbbbafe8ae2a8ff60af39e534e21` |
| 웹 BUILD_ID | `U-DPKmO8rkYmeZnypdD5G` |
| 웹/API 실행 경계 | loopback 3000/4000, dataScope=shared |
| 사진·업무 데이터 | 전체 사진 380장 = 기존 공유 80장 + 승인 원본 300장, 업무 기본 조회 357장 |
| 최종 고정 URL 검증 | 2026-09-22 09:31 KST 최신 화면·공유 API·기존 사진/판독/이력 PASS |

최신 사용자 승인에 따라 원본 300장의 사진·실제 판독·업무 기록을 최종 사이트에 포함한다. 명시적 공유 프로필과 승인 해시 목록을 사용하는 별도 저장소로 준비하며, 전용 로컬 프로필의 웹/API를 공개 origin에 직접 연결하지 않는다. 원본·DB·가중치·분리 목록·인증 파일은 GitHub에 넣지 않는다. 공유 JSON 응답에서는 내부 원본 경로·학습 출처 필드를 제거하고 내부 저장 근거는 보존한다.

## 실제 고정 주소 검증

2026-09-22 실제 Cloudflare 경로에서 다음을 확인했다.

- 루트·health·사진 기본/전체·계획·포인트·보수 GET 7개가 200을 반환했다.
- 공개 origin을 CORS에 추가했다. localhost·기존 quick·고정 URL은 GET 200/OPTIONS 204, 미허용 Origin은 403이었다. 기존 `.env`는 수정하지 않았다.
- 승인 demo-01.jpg 1장(2,965,056바이트)을 검증 목적으로 업로드했다. 실제 청크는 1개였으며, 완료 요청을 다시 보내도 같은 사진 ID를 반환했다.
- 실제 전체 사진 AI가 4등급으로 판독했다. 사람 등급·재촬영 표시를 저장하고 되돌려도 원래 AI 결과는 같았고, 이력 5건과 원본 SHA-256 일치를 확인했다.
- 검증용 사진·포인트만 별도로 추가했다. 그 두 항목과 해당 전송을 제외한 기존 엔티티 93건·이력 291건·완료 전송 15건·청크 17개·객체 79개의 비교 해시는 모두 같았다.
- named connector만 같은 Tunnel ID/token으로 재시작했다. 약 1.19초 후 ready 상태가 됐고, 같은 고정 URL과 기존 quick URL에서 루트·health를 재조회했다. DB·객체·업로드 상태의 비교 해시는 같았다.

위 업로드·connector 검사는 이전 공유 제품에서 먼저 수행했다. 최신 제품으로의 전환과 최종 회귀 결과는 다음과 같다.

- 최신 공유 웹/API로 교체 후 고정 URL의 `Drone Inspection Platform` 제목과 실제 브라우저의 새 화면을 확인했다. 공개 루트 HTML 36,082바이트의 SHA-256과 확인한 CSS/JS는 같은 최신 로컬 배포본과 일치했다.
- health는 `dataScope=shared`, ready/model.ready true였다. 전체 사진 380장·업무 기본 357장·전체 계획 9건·포인트 18개·랙 120개·전체 보수 조회 43건을 확인했다. 목적·표시 필터에 따라 화면의 개수는 다를 수 있다.
- 허브가 외부 URL의 사진 4페이지를 독립 조회하여 380개 ID가 기존 80개와 승인 원본 300개의 정확한 합집합인지 확인했다. SHA·크기·상태·AI·사람 등급·수정 버전·계획/포인트 불일치와 공개 JSON의 금지 내부 필드·로컬 경로는 0건이었다.
- 이전 고정 URL 검증 사진의 원본 2,965,056바이트/SHA·AI·사람 판단·포인트·이력 5건을 그대로 재조회했다. 최신 전환 후 중복 업로드나 새 모델 판독은 만들지 않았다. 제품 후보의 실제 업로드·ROI·재시작 회귀는 [제품 실행 검증](product-v3-runtime.md)에 기록했다.
- 전환 전후 이전 공유 저장소의 엔티티 95건·이력 297건·완료 전송 16건·청크 18개·객체 80개 및 기존 환경 파일의 비교 해시는 같았다. 새 공유 저장소에는 승인 자료를 합친 411개 엔티티·671개 이력·379개 사진 객체를 보존했다. 객체 379개의 원본/복제본 바이트와 SHA 전수 비교는 제품 담당이 통과했다.
- 최신 운영 소스 50개를 제품 커밋과 비교했다. 49개는 바이트 단위로 같고 `RoiPanel.tsx` 한 곳의 줄 끝 공백만 달랐다. 이 차이를 제거하려고 검증된 아티팩트를 다시 빌드하지 않았다. 모델·ROI·quick/named tunnel과 이전 공유 저장소는 전환 과정에서 재시작하지 않았다.

검증 목적 자료는 실제 검사 업무와 구분한다. 로컬 테스트의 4MiB 합성 청크 검사와 실제 2.965MB 단일 청크 업로드를 같은 증거로 표시하지 않는다. 실제 사용자 다중 접속 부하와 WebSocket 연결은 검증하지 않았다.

## 배포한 Worker와 구성

최초 Worker는 공식 Playground에서 검토한 프록시 소스를 넣은 뒤 배포했다. `PUBLIC_HOSTNAME`을 위 고정 hostname으로 지정하고 VPC Service `SHARED_WEB` 하나만 연결했다. 요청 host가 다르거나 binding이 없으면 실패 응답을 반환한다. path/query/method/body는 정해진 Service로만 전달하며 요청 본문 전체를 메모리에 모으거나 로그에 남기지 않는다. API 응답은 no-store이고 redirect는 수동 전달한다.

배포 모듈 `index.js`는 저장소의 `worker.mjs`와 들여쓰기 차이가 있다. 로컬 검토 소스 SHA-256은 `dacbde9a7876529b0fd76a3829dabcccf0de17d6899413eeeb780df39a6cf8f5`, 실제 배포 소스는 `b30aad794da4b7b71daf6341c655c79d0345d3350d07423db8a55388f2ea8948`이며 줄의 앞뒤 공백을 제외한 내용은 같다. 허브가 저장된 실제 editor 소스와 검토 소스를 같은 Babel parser로 parse/print한 결과도 일치했다. 이는 provider에서 소스를 다시 내려받은 검사와는 구분한다. Playground의 사용하지 않는 기본 `data.js`·`welcome.html` 모듈이 남아 있다. 계정·원본·인증 자료는 포함하지 않았다.

실제 `compatibility_date`는 `2026-09-21`, flag는 없으며 Worker logs/traces와 preview URL은 비활성화했다. 예제 설정의 날짜 `2026-09-22`와 실제 적용값을 구분한다. 검토 소스의 Node 계약 검사 15개와 Wrangler 4.136.1 합성 ID dry-run이 통과했다. dry-run은 실제 배포·요금·성능 검사를 대신하지 않는다.

[공식 Playground 배포](https://developers.cloudflare.com/workers/playground/#deploy) · [VPC Service 설정](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/) · [Binding API](https://developers.cloudflare.com/workers-vpc/api/)

## 운영과 복구

Mac 전원·네트워크·웹/API·사진 저장소·모델·named connector가 실행 중이어야 접속할 수 있다. 고정 주소는 Mac이 꺼진 동안 서비스가 계속된다는 뜻이 아니다. 전역 launchd나 부팅 후 자동 시작은 설정하지 않았다.

실제 credential·ID·실행 명령·PID·로그·BUILD·검증 결과와 이전 버전은 Git에서 제외한 로컬 운영 manifest에 보관한다. credential 디렉터리는 0700, 파일은 0600이다. 제한된 Tunnel token을 `--token-file`로 읽으며 token 값을 명령 인수에 직접 넣지 않는다. [cloudflared 실행 옵션](https://developers.cloudflare.com/tunnel/reference/run-parameters/)

재시작할 때 같은 Tunnel ID/token·Worker명·account subdomain·Service target을 유지한다. 웹은 **빌드 시** API 4000 rewrite를 고정한 standalone/static/public 묶음을 사용한다. 같은 DB의 API 작성 프로세스를 중복 실행하지 않는다. 실제 전환 전 업로드 수신과 판독 중 작업을 확인하고, 이전 공유 저장소·아티팩트·실행 설정을 복구용으로 보존한다.

문제가 생기면 보존한 이전 웹/API와 저장소 실행 설정으로 돌아간다. DB·볼륨 삭제나 credential 폐기를 원복 수단으로 사용하지 않는다. Worker rollback만으로 VPC 설정이나 Mac 서비스가 되돌아가지는 않는다. 기존 quick URL은 전송 경로의 복구용이며 같은 웹 origin이므로 제품 자체 오류의 독립 복제본은 아니다.

## 무료 범위와 남은 한계

2026-09-22 공식 안내상 VPC는 공개 beta 동안 무료다. Workers Free는 일 100,000요청·요청당 CPU 10ms·메모리 128MB이며 네트워크 대기는 CPU 시간에 포함되지 않는다. 요청당 subrequest 50개·동시 외부 연결 6개는 전체 사용자 6명 제한을 뜻하지 않는다. 프록시는 요청당 VPC fetch 1개를 사용한다. 무료 계정의 요청 본문 한도는 100MB이며 제품은 4MiB 단위 청크를 사용한다. 부하·긴 요청·네트워크 중단에서는 실제 한도와 timeout의 영향을 받을 수 있다. [Workers 제한](https://developers.cloudflare.com/workers/platform/limits/) · [VPC 가격](https://developers.cloudflare.com/workers-vpc/platform/pricing/)

Cloudflare Pages의 고정 `pages.dev`는 정적 사이트를 올리는 별도 방법이다. 현재 제품은 동적 API·DB·사진 저장소·로컬 AI가 필요하므로 Pages 파일 업로드만으로 전체 기능이 배포되지는 않는다. 제출 직전 최신 사용자 합의에 따라 이번에는 기존 Worker 연결을 완성했고 Pages 프로젝트는 만들지 않았다. [Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/) · [Next.js 안내](https://developers.cloudflare.com/pages/framework-guides/nextjs/)

전체 사진 모델은 `mobilenetv3small-ft-20260921T074822Z`, 전처리는 `rgb-first-frame-exif-full-resize224-imagenet-v1`, checkpoint SHA-256은 `21245b2f2d8b478b7b2762c51e7882692babd062eb1de8ec305cb090a7906753`으로 동결했다. 기존 최종 test 정확도 60%는 합격선 70% 미달이며, 배포 성공이나 UI 기능 검증을 모델 성능 합격으로 표시하지 않는다. 실제 동료 사용자 검수·현장 효과 측정 여부는 최종 QA 기록을 따른다.
