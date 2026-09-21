# 동결 모델 Linux Docker 실행 재현성 검증

2026-09-21 약17:54~18:03 KST. 허브가 기존운영보완후같은승인로컬범위의Docker실제검증을요청했다. 새모델학습·최종test평가·서비스모델교체를수행하지않았다.

## 사전 자원·데이터 경계

- Mac 데이터볼륨여유48GiB,로컬OrbStack LinuxARM64 VM약8GiB,기존컨테이너약1.7GiB사용snapshot확인.
- Unix소켓의로컬orbstack빌더사용. 원격빌더/registry push없음.
- deny-all `.dockerignore`에명시된코드·runtime의존성·공개모델계약10파일만허용. 실제build context전송12.17kB.
- 원본사진,학습manifest,고정test재실행registry,학습산출물,가중치,비공개freeze를buildcontext에포함하지않음.
- 공식Python이미지,PyTorch CPU index,PyPI패키지만수신. 실제weights와비공개freeze는실행시에만읽기전용bind mount.

## 빌드·환경

| 항목 | 실제 결과 |
|---|---|
| 플랫폼 | Linux ARM64 |
| 최초패키지설치단계 | 약159초 |
| 고정Python베이스digest | `sha256:a36c24f9cbdf4fd0f52d67f0823eeac19c2028c637cecc392d97f980d4fec56b` |
| 로컬image ID | `sha256:7cccccbf011893a98eff0afa5c449741e0610ad940486f62f80f66f8b66aa76f` |
| 이미지크기 | 1,034,742,007bytes,약0.964GiB |
| Python / torch / torchvision / Pillow | 3.11.16 / 2.14.0+cpu / 0.29.0+cpu / 12.3.0 |
| 기동후메모리snapshot | 364.7MiB |
| 검증자원제한 | CPU2,메모리2GiB |
| 권한·파일시스템 | UID10001,readonly root,weights/freeze RW=false |
| 포트 | 127.0.0.1:8002→container8001 |

처음tag로해석된공식Python베이스digest를확인후Dockerfile에고정했고,캐시재빌드도성공했다. 이미지내용검사에서 `/app/ml`에는추론모듈과공개계약만존재하며,가중치·비공개freeze·artifacts는이미지에없음을확인했다.

## 수치·재시작 검증

실행전에등급·모델·전처리버전완전일치,confidence절대차이1e-5이하로비교기준을기록했다. 입력은승인된train demo3장뿐이며파일명은다르게보내동일bytes를사용했다.

- 등급·모델버전·전처리버전: Mac현재8001과Linux8002의3/3완전일치.
- confidence절대차: 0, 1.1920928955078125e-7, 1.1920928955078125e-7. 사전허용오차통과.
- Linux3회HTTP추론시간: 약0.286/0.036/0.041초. 소량연결검사이며대규모성능평가가아님.
- 컨테이너health=healthy,가중치SHA와동결계약일치.
- 같은컨테이너 stop→8002연결거절확인→start→같은3장응답전체보존 PASS.
- 원래8001은계속ready,가중치SHA불변. 현재서비스재시작·교체없음.
- 검증용컨테이너만중지·삭제후8002닫힘확인,검증된로컬이미지는보존.

## 인계와 한계

LinuxARM64컨테이너는선택가능한운영방식으로검증됐다. 제품담당이원하면Compose네트워크의`http://model:8001`,readonlyweights/freeze mount,health조건과profile을통합할수있다. 실제제품Compose통합·운영전환은아직별도확인대상이다. 제품compose.yaml/.env/rootDockerfile은수정하지않았다.

모델가중치와전처리계산은변경하지않았고Linux의작은부동소수점차를숨기거나점수를보정하지않았다. LinuxAMD64·전체사진·장시간부하·OS재부팅복구까지검증했다고주장하지않는다. 모델정확도는기존train99.57% PASS/test60%(기준70%) FAIL을유지한다.

상세build로그·mount검사·사전허용오차·demo응답·재시작·정리증거는Git제외 `ml/artifacts/operations.local/`에보존한다. 테스트10장·train/validation원본·manifest는이번검증에접근하지않았다.
