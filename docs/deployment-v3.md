# 배포 v3: 고정 HTTPS 주소

목표는 **Drone Inspection Platform**의 제출 주소가 재시작 후에도 유지되고, 그 주소에서 업로드·실제 AI 판독·결과·이력 조회가 이어지는 것이다. 제품 제목과 v3 통합은 제품 담당이 수행한다. 이 문서는 배포 연결과 검증을 다룬다.

현재 상태: **로컬 구성 준비, 외부 리소스 미생성, 고정 주소 미배포**. 사용자는 Cloudflare 로그인을 완료했고 도메인은 없다고 알렸다. IAB에서 실제 로그인과 Workers Free($0) Current plan을 확인했다. VPC 화면에서 기존 Worker/Service/Tunnel이 없음을 확인했다. 실제 Create Tunnel은 자동 승인 검토가 지속 리소스·실행 credential의 action-time 사용자 확인을 요구해 차단했고, 생성된 리소스는 없다. 허브에서 정확 범위 확인을 요청했으며 우회하지 않는다.

## 선택한 구성과 범위

`고정 workers.dev → Worker → VPC Service → named Tunnel → 공유 web 127.0.0.1:3000 → 기존 /api rewrite`

Worker·HTTP VPC Service·named Tunnel을 각각 하나 사용한다. VPC Service의 실제 목적지를 공유 웹의 `127.0.0.1:3000`으로 제한한다. 사용자 URL의 host/port/query를 목적지 선택에 사용하지 않는다. 전체 네트워크 VPC binding, DB·MinIO·모델 직접 공개는 포함하지 않는다. 원본 300장의 전용 웹/API에도 연결하지 않는다.

Mac의 전원·네트워크와 웹/API/모델은 계속 필요하다. 고정 주소는 origin 중단 중의 접속 성공이나 Mac 부팅 후 자동 실행을 보장하지 않는다. 지속 Tunnel ID와 credential로 재실행해 동일 주소를 회복하는 것이 이번 범위다. 전역 launchd·전원·보안 설정 변경은 포함하지 않는다.

기존 Cloudflare 도메인이 있었다면 subdomain 하나와 named Tunnel만 쓰는 경로가 더 단순하다. 현재 사용자는 도메인이 없다고 답했으므로 도메인 구매 없이 위 구성부터 검증한다. Vercel은 프런트만 배포해도 로컬 API의 고정 연결을 별도로 해결해야 한다. 고정 별칭 뒤에 변동 quick tunnel을 두는 구성은 완료 조건을 충족하지 않는다. [Tunnel 시작 안내](https://developers.cloudflare.com/tunnel/get-started/), [VPC 시작 안내](https://developers.cloudflare.com/workers-vpc/get-started/)

## 실제 사전 확인

2026-09-22 07:56 KST의 운영 기준이다. 이후 추가 업로드나 전환 시 새 기준을 확보한다.

| 항목 | 확인 결과 |
| --- | --- |
| 기존 임시 주소 | https://yellow-asp-says-needle.trycloudflare.com |
| 웹 / API 커밋 | `776bcf95a4f1126163b7b3036ef2eaf0e3438f1b` / `6fbae158e657572ec952924b3c68722fad08bb9e` |
| 웹 BUILD | `75fGThFZJQ79HSeKlOfLB` |
| 읽기 검사 | 루트·health·사진 기본/전체·계획·포인트·보수의 GET 7개 모두 200 |
| health | ready/model.ready true, 동결 모델 3식별자 일치 |
| 업로드 정책 | demoMode false, publicUploadsAllowed true |
| 집계 | 사진 기본 57/전체 79, 계획 5, 포인트 5, 보수 전체 4 |
| Vercel | 브라우저 로그인 전, CLI 기존 token invalid. g10 프로젝트·GitHub 연결 미확인 |
| 이번 사전 검사 | 원본 바이트 조회·업로드·판독·데이터 변경·서비스 변경 0 |

전체 보수는 `recordPurpose=all&inWorklist=all`, 사진 전체는 `recordPurpose=all&visibility=all`이다. 복구 당시 숫자를 현재 자료의 고정 개수로 사용하지 않는다.

사전 기록 `preflight.local.json`의 SHA-256은 `cc92be3ec59cade127bfa6f2493a1283ea9bec4c62e0749d18f71b310db3fd18`이다. 로컬 증거·계정 식별자·운영 경로는 공개 문서에 넣지 않는다.

준비 소스 기준은 `e263593f0aae59a8b19f0d8527b6e9b1b0edf351`이며 현재 운영 API와 다르다. 운영 health에는 새 dataScope 필드가 없다. 이 체크아웃을 현재 운영에 그대로 복사하지 않고, 새 API 전환은 [공유 실행 계약](private-import.md#기존-공유-서비스-전환-조건)을 먼저 충족한다.

## 리소스와 전달 자료

| 대상 | 후보 설정 | 외부에 전달되는 자료 |
| --- | --- | --- |
| named Tunnel | 이름 `drone-inspection-g10`, 기존 quick tunnel과 별도 ID | 터널 연결에 필요한 식별자·네트워크 메타데이터 |
| VPC Service | HTTP, IPv4 `127.0.0.1`, port `3000`, 해당 Tunnel ID | 서비스 설정과 공유 웹의 HTTP 요청/응답 |
| Worker | 이름 `drone-inspection-g10`, VPC binding `SHARED_WEB` 하나 | 비밀 없는 프록시 코드와 공유 웹의 요청/응답 |
| 공개 URL | `https://drone-inspection-g10.<account-subdomain>.workers.dev` | 공유 서비스에서 허용한 페이지·사진·API 응답 |

이름·주소는 아직 배정되지 않은 후보다. 같은 이름의 기존 리소스가 있으면 자동 덮어쓰지 않는다. 사용자별 코드/사진을 저장하는 새 cloud DB·bucket은 만들지 않는다. 기존 Cloudflare 중계 범위의 공유 서비스만 연결하며, 학습 원본·가중치·DB dump·전용 자격은 전송하지 않는다.

VPC Service는 설정한 host/port로만 연결하고 fetch URL의 host/port로 목적지를 바꾸지 않는다. Worker도 고정 PUBLIC_HOSTNAME만 받고, 원 요청의 path/query/method/body를 수동 redirect 모드로 전달한다. 전체 body 버퍼링이나 요청 body 로그를 사용하지 않는다. API 응답은 no-store로 전달하며 Cloudflare Cache API를 사용하지 않는다. [VPC Service 설정](https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/), [Binding API](https://developers.cloudflare.com/workers-vpc/api/)

## 무료 한도와 timeout

비용 상한은 **새 유료 지출 0원**이다. 무료 Workers 사용 가능 여부를 계정에서 확인하고, 결제 등록·유료 플랜·한도 초과 자동 업그레이드는 수행하지 않는다.

2026-09-22 확인한 공식 안내 기준:

- VPC는 공개 beta 동안 무료이고 Workers 요청·CPU 한도는 별도다. beta 기능·API 변경 가능성이 있다.
- Workers Free는 일 100,000 요청, 요청당 CPU 10ms, 메모리 128MB다. 네트워크 응답 대기는 CPU 시간에 포함되지 않는다.
- 요청 하나당 subrequest 50개, 동시 외부 연결 6개 제한이 있다. 이를 계정 전체 동시 사용자 6명이라는 뜻으로 해석하지 않는다. 이 프록시는 요청당 VPC fetch 하나를 사용한다.
- 무료 Cloudflare 계정의 요청 본문 한도는 100MB다. 제품은 4MiB 청크를 사용하므로 파일 전체 크기와 단일 요청 크기를 구분한다. 기존 완료 요청·원본 응답도 실제 검증한다.
- HTTP Worker 실행 자체는 클라이언트 연결이 유지되는 동안 고정 wall-time 한도가 없지만, 중간 Cloudflare/origin의 연결·읽기 제한까지 없다는 뜻은 아니다. 로컬 Next rewrite의 180초와 edge timeout이 긴 요청을 자동 보장하지 않는다. 완료/조회 지연과 연결 끊김 재시도를 실측한다.
- 일반 Tunnel origin 연결 기본 timeout은 30초다. 응답 전체 제한과 다른 값이다. named Tunnel에 quick tunnel의 200 동시 요청 제한을 그대로 적용하지 않는다.

[Workers 제한](https://developers.cloudflare.com/workers/platform/limits/), [VPC 가격](https://developers.cloudflare.com/workers-vpc/platform/pricing/), [VPC 제한](https://developers.cloudflare.com/workers-vpc/platform/limits/), [Tunnel origin 설정](https://developers.cloudflare.com/tunnel/reference/origin-parameters/), [업로드 계약](uploads.md)

Vercel을 이후 선택할 때 Functions 본문 4.5MB와 외부 rewrite timeout 120초를 구분해 실제 청크·완료·원본 경로를 검증한다. 행사 계정의 요금제·종료일·g10 권한은 미확인이다. [Functions 제한](https://vercel.com/docs/functions/limitations), [Vercel 제한](https://vercel.com/docs/limits)

## 파일과 인증 경계

재현용 소스는 [deployment/cloudflare-fixed-url](../deployment/cloudflare-fixed-url/)에 둔다.

- `worker.mjs`: 스트리밍 프록시 초안.
- `worker.test.mjs`, `config.test.mjs`: 네트워크 없는 프록시 계약 및 private 포트·추가 binding·미완성 설정 거절 검사.
- `wrangler.example.json`: 실제 ID가 없는 Worker 설정.
- `vpc-service.example.json`: 단일 loopback 대상만 있는 Service 요청 템플릿.
- `named-tunnel.example.json`: 도메인이 있을 때의 원격 ingress 대안.
- `validate-config.mjs`: 실제 적용 파일의 hostname·단일 target·binding 범위를 로컬에서 검증. 계정 요금제나 권한을 확인하는 도구는 아니다.

실제 계정 ID/Service ID/Tunnel ID, token 파일, 완성된 배포 설정, 로그·PID·검증 기록은 이 디렉터리 밖의 전용 로컬 운영 폴더에 보관한다. credential 디렉터리는 0700, 파일은 0600으로 제한한다. 공개 폴더 전체를 CLI에 업로드하지 않고, 승인된 Worker 소스와 설정의 배포 산출물만 사용한다.

실행 credential은 해당 named Tunnel의 제한된 token 파일을 사용한다. 계정 전체 인증서·Global API Key를 Worker나 cloudflared에 넣지 않는다. 터널 실행은 `cloudflared tunnel ... run --token-file <local-token-file>` 방식으로 하여 명령 인수·로그에 token 자체를 남기지 않는다. cloudflared 2026.9.1 도움말에서 지원을 확인했다. debug 로그는 사용하지 않는다. [실행 옵션](https://developers.cloudflare.com/tunnel/reference/run-parameters/)

VPC 생성에는 Connectivity Directory Admin 역할, 기존 서비스 binding에는 Connectivity Directory Bind 역할이 필요하다. Worker 배포·Tunnel 연결 권한도 실제 계정에서 확인한다. 기존 역할로 가능한지 먼저 확인하며 새 OAuth/API token 권한·리소스 공개 설정은 구체적 대상과 범위를 검토하고 실행한다.

## 전환과 검증 순서

1. 로그인된 IAB에서 무료 계정·기존 Worker/Tunnel/VPC·권한·workers.dev subdomain을 확인한다. 새 결제나 광범위 권한 확대가 필요하면 그 단계에서 사람 판단을 받는다.
2. 운영 web/API/model의 커밋·BUILD·실행 명령·포트·CORS와 공유 데이터/이력 기준을 로컬에 확보한다. 기존 quick tunnel은 계속 유지한다.
3. 제품 v3 후보는 별도 디렉터리·합의된 포트에서 준비한다. 현재 운영 .next나 .env를 덮어쓰지 않는다. 공유 업로드 임시 폴더에 API 작성 프로세스 둘을 동시에 두지 않는다.
4. 검토한 단일 Worker/Service/Tunnel만 만든다. named Tunnel은 별도 프로세스로 실행하고, stdin 분리·로그/PID 파일·같은 ID 재시작 명령을 기록한다. 로그/metrics도 loopback으로 제한하고 현재 metrics 포트와 충돌시키지 않는다.
5. 고정 URL에서 루트·정적 자산·health·목록 조회를 확인한다. 상대 /api 경로를 유지하고 필요한 CORS에는 새 origin만 추가한다. OPTIONS와 실제 PUT/POST를 따로 확인한다. 브라우저에 원래 quick tunnel 주소로 redirect되는 요청이 없어야 한다.
6. QA와 합의한 공개 demo 사본으로 verification 기록을 만든다. 4MiB 청크, 동일 청크 재시도·완료 중복 방지, 새로고침 후 재개, 실제 모델 판독, 원 AI/사람 판단 분리, 결과·이력 재조회까지 실행한다. 검증 개수와 예상 증가분을 기록하고 기존 사용자 기록을 수정하지 않는다.
7. named Tunnel만 같은 ID/token으로 재시작해 동일 hostname이 복구되는지 확인한다. 이어 제품 담당과 합의한 서비스의 재시작·저장 보존 회귀를 수행한다. 현재 quick tunnel을 끊어 시험하지 않는다.
8. 합격 뒤 최종 주소·리소스·origin·커밋/BUILD·재시작/원복 방법·실제 검증을 허브에 인계한다. 허브의 감시 주소와 팀 제출 안내 갱신을 조율한다. 기존 quick tunnel 종료는 별도 조율한다.

## 원복과 판정

연결·청크·판독·이력·재시작 중 하나라도 실패하면 새 주소를 완료로 보고하지 않고 기존 quick tunnel을 유지한다. 새 경로의 origin을 바꿨다면 기록한 이전 공유 origin으로 되돌린다. 제품까지 전환했다면 제품 담당이 보존한 이전 web/API 빌드와 실행 경계로 복귀한다. DB/볼륨 삭제, 비밀 폐기, 새 리소스 삭제를 자동 원복 수단으로 사용하지 않는다.

로컬 Node 계약 검사 15개가 통과했다. Wrangler 4.136.1의 합성 ID 설정 dry-run도 통과했고, Worker 산출물은 1.99KiB(gzip 0.85KiB), VPC Service binding 하나로 확인했다. 실제 배포는 수행하지 않았다. 4MiB 청크의 바이트/SHA·header, 수동 redirect, 응답 스트리밍, 409/503/OPTIONS 전달, private 포트·추가 binding 거절을 확인했다. 현재 기준 소스의 src/server 검색에서는 WebSocket/EventSource 사용을 찾지 못했다. 101 응답 객체 보존 검사는 실제 WebSocket 연결 검증을 뜻하지 않는다.

Worker 버전, VPC Service JSON, Tunnel ID/설정, Mac web/API 아티팩트·실행 설정을 각각 로컬 manifest로 보존한다. Worker rollback만으로 VPC 설정이나 Mac 파일이 복구되지는 않는다. ROI/SHAP는 제품의 비동기 job/poll 계약을 그대로 전달하며 Worker에서 계산하지 않는다.

로컬 계약 검사는 실제 Cloudflare 배포·업로드·성능 검증이 아니다. 계정 리소스 생성, 새 origin CORS, 실제 고정 주소와 재시작 회귀는 실행 결과를 따로 기록한다. 현재 health 성공과 모델 성능 합격도 구분한다.
