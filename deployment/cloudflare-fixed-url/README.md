# 고정 주소 프록시

**[Drone Inspection Platform 제출 주소](https://drone-inspection-g10.dlwnsgod2761.workers.dev)** 를 공유 웹 `127.0.0.1:3000`으로 연결한다. Worker·HTTP VPC Service·named Tunnel 각 1개를 기존 무료 계정에 생성했고 실제 업로드·AI 판독·이력·동일 주소 재시작을 확인했다. 최신 제품 버전과 데이터·검증 범위는 [배포 문서](../../docs/deployment-v3.md)를 따른다.

## 계약 검사

Node.js 22 이상에서 네트워크·실제 사진·운영 DB 없이 실행한다.

```sh
node --test deployment/cloudflare-fixed-url/worker.test.mjs deployment/cloudflare-fixed-url/config.test.mjs
```

15개 검사가 통과했다. 실제 Cloudflare runtime·부하·제품 회귀 검증은 별도로 기록한다.

## 설정과 재현

`*.example.json`은 실제 ID가 없는 템플릿이다. 실제 계정·Service·Tunnel ID, hostname, token, 로그와 PID는 Git 밖의 전용 운영 폴더에만 보관한다. 소스·설정을 검토한 뒤 해당 폴더와 명시적 config만 사용한다. VPC target은 HTTP `127.0.0.1:3000`, binding은 `SHARED_WEB` 하나다.

```sh
node deployment/cloudflare-fixed-url/validate-config.mjs "<local-wrangler.json>" "<local-vpc-service.json>"
```

이 검사는 placeholder·private 포트·추가 binding을 거절한다. 계정 권한·요금·승인 여부는 판정하지 않는다. Wrangler 4.136.1 합성 설정 dry-run도 통과했다.

```sh
WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false npx --yes wrangler@4.136.1 deploy \
  --dry-run --config "<local-wrangler.json>" --outdir "<local-output-dir>"
```

실제 최초 배포는 로그인된 공식 Playground의 사용자 코드 배포로 수행했다. `index.js`와 검토한 `worker.mjs`는 들여쓰기 차이를 제외한 내용이 같다. 실제 compatibility date는 `2026-09-21`, 예제는 `2026-09-22`다. 공개 문서의 검증된 차이를 배포 누락으로 오인해 기존 Worker를 임의로 덮어쓰지 않는다. [공식 Playground](https://developers.cloudflare.com/workers/playground/#deploy)

## 터널 운영

Mac 서비스와 전용 named connector를 유지한다. 기존 quick tunnel은 복구용으로 남겼다. 로그·PID·loopback metrics와 실행 설정을 로컬 manifest에 기록했고 stdin·터미널 세션을 분리했다. 부팅 후 자동 시작은 설정하지 않았다.

```sh
cloudflared tunnel --config /dev/null --no-autoupdate \
  --metrics "127.0.0.1:<approved-free-metrics-port>" \
  --loglevel info --log-directory "<local-log-dir>" \
  --pidfile "<local-pid-file>" run --token-file "<local-token-file>"
```

같은 ID/token·Worker명·hostname·Service target으로 재시작한다. token 자체를 명령 인수·공개 파일에 넣지 않는다. 계정 전체 인증서나 Global API Key는 사용하지 않았다. Worker rollback은 Mac의 제품·저장소나 Service 설정을 자동 복구하지 않으므로 각각 이전 실행 설정을 보존한다.

[Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/) · [Binding fetch](https://developers.cloudflare.com/workers-vpc/api/) · [token-file](https://developers.cloudflare.com/tunnel/reference/run-parameters/#token-file)
