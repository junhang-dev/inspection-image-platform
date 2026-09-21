# 고정 주소 프록시

현재 공유 웹 한 곳(127.0.0.1:3000)을 Workers VPC Service로 연결하는 준비 소스다. 운영 절차·비용·자료 범위·원복은 [배포 문서](../../docs/deployment-v3.md)를 따른다. 외부 리소스를 자동 생성하거나 기존 서비스를 시작/종료하는 스크립트는 포함하지 않는다.

## 로컬 계약 검사

Node.js 22 이상에서 실행한다. 네트워크·실제 사진·운영 DB 없이 합성 청크와 fetch fixture를 사용한다.

~~~sh
node --test deployment/cloudflare-fixed-url/worker.test.mjs deployment/cloudflare-fixed-url/config.test.mjs
~~~

15개 검사가 통과했다. 이 결과는 Cloudflare runtime/권한/성능/배포 및 실제 업로드 회귀와 별개다.

## 적용 파일 준비

1. *.example.json을 Git 밖의 전용 운영 폴더로 복사한다.
2. 실제 계정·Service·Tunnel ID와 배정된 workers.dev hostname만 채운다. 고정 대상 IP/port, binding 개수, 허용 hostname 구조는 바꾸지 않는다.
3. worker.mjs도 그 운영 폴더에 복사하고 SHA-256을 기록한다. CLI는 그 폴더와 명시적 config를 사용하여 관련 없는 저장소 파일을 보내지 않는다.
4. 실제 파일을 검사한다.

~~~sh
node deployment/cloudflare-fixed-url/validate-config.mjs "<local-wrangler.json>" "<local-vpc-service.json>"
~~~

이 검사는 현재 계정의 Free plan이나 권한·동의·리소스 존재를 확인하지 않는다. 설정 범위만 확인한다. placeholder가 남거나 private 포트/추가 binding이 있으면 실패한다. identifier 값을 로그에 출력하지 않는다.

Wrangler 후보는 공식 npm의 4.136.1이며 Node >=22가 필요하다. 기존 root package.json·전역 설치를 바꾸지 않고 명시 버전을 사용한다.

~~~sh
WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false npx --yes wrangler@4.136.1 deploy \
  --dry-run --config "<local-wrangler.json>" --outdir "<local-output-dir>"
~~~

실제 deploy는 계정·무료 플랜·전용 3리소스 범위 검토 후에만 실행한다. deploy 전에 dry-run 산출물이 Worker 소스만 포함하는지 확인한다. 검증 전 placeholder 파일을 deploy하지 않는다.

## 터널 수명과 운영

새 remotely-managed Tunnel은 별도 제한 token 파일로 실행한다. 이미 실행 중인 quick tunnel은 유지한다. 로그·PID·metrics 주소를 로컬 manifest에 기록하고 stdin과 터미널 세션을 분리해 실행한다. Token을 명령 인수에 직접 넣거나 debug 로그에 노출하지 않는다.

~~~sh
cloudflared tunnel --config /dev/null --no-autoupdate \
  --metrics "127.0.0.1:<approved-free-metrics-port>" \
  --loglevel info --log-directory "<local-log-dir>" \
  --pidfile "<local-pid-file>" run --token-file "<local-token-file>"
~~~

같은 Tunnel ID/token·Worker명/account subdomain·Service target을 유지해 재시작한다. ID/credential 수명과 로컬 PID 수명을 구분한다. 새 로그인·OAuth 권한·장기 token 생성·public binding이 필요한 시점의 구체적 범위를 검토하며, 유료 업그레이드나 전체 네트워크 binding은 허용하지 않는다.

Worker 버전, VPC JSON, Tunnel ID/설정, Mac의 빌드·실행 설정은 각각 manifest에 저장한다. Worker rollback은 나머지 설정을 자동 복원하지 않는다. 최소 검증은 실제 청크 업로드·원본 응답·비동기 판독/poll·결과/이력과 같은 주소 재시작이다.

[Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/) · [Binding fetch](https://developers.cloudflare.com/workers-vpc/api/) · [cloudflared token-file](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file)
