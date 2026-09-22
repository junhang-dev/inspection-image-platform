# 스트리밍 모델의 Linux Docker 실행 검증

2026-09-21. 허브가 제품 업로드 개선과 독립적으로 Docker 검증을 요청했다. 후보는22:27 KST에 기동했고 검증 후 정상 종료했다. 운영8001, 제품·QA 서비스, Compose와 제품 코드는 변경하지 않았다.

## 소스와 이미지

- 검증 소스 commit: `f89d970b0eca939b5fd8620c7ccab0b43ce01bc1`.
- 로컬 tag: `inspection-model:streaming-f89d970`.
- image ID: `sha256:b4d46599f83518ab18a4b25cbab5831688133c6c28852cc4fc54bc063a5cf94e`.
- 플랫폼: Linux ARM64 / OrbStack. Python3.11.16, torch2.14.0+cpu, torchvision0.29.0+cpu, Pillow12.3.0, FastAPI0.141.1, Starlette1.6.0, python-multipart0.0.32.
- `ml/`만 build context로 사용했다. 기존 allowlist10개 파일을 해당 commit과 bytes 대조했고, 컨테이너 안의 추론 코드·계약 파일도 SHA가 일치했다. 모델 가중치·원본·평가 기록은 build context에 포함하지 않았다.
- 기존 dependency layer를 재사용하고 변경된 추론 소스로 새 이미지를 빌드했다. 이미지는 로컬에 보존하며 registry에 push하지 않았다.

## 실행·임시 저장소

별도 후보의 호스트 연결은 `127.0.0.1:18002`만 사용했다. UID:GID10001:10001, readonly root, 동결 가중치·계약의 readonly bind mount는 실제 조회로 확인했다. 실행 명령에는 모든 capability 제거, no-new-privileges, CPU2개/메모리2GiB도 지정했다. 이 네 옵션의 HostConfig 조회값은 증거 JSON에 보존하지 않아 독립 검토에서는 명령 설정 사실까지만 대조했다.

이번 후보만을 위한 새 Docker named volume을 `/uploads-tmp`에 연결하고 `TMPDIR=/uploads-tmp`로 지정했다. 해당 mount는 btrfs 디스크이며 `/tmp`의64MiB tmpfs와 별개였다. 소유자10001/그룹10001/권한0700을 확인했다. 같은 UID에서 기본 `tempfile.gettempdir()`가 정확히 `/uploads-tmp`를 반환했고 실제 파일 생성→쓰기→fsync→읽기→close/unlink가 통과했다.

준비 중 최소 capability의 root helper에서 chown 이후 chmod를 실행해 EPERM이 발생했다. 이미 소유권이 이전된 같은 새 볼륨을 UID10001로 열어 chmod를 완료했다. 추가 capability나 기존 볼륨 권한 변경은 없었다. 초기화 시 chmod를 먼저 하고 chown을 마지막에 수행하거나, 소유권 이전 후 해당 소유자로 권한을 설정해야 한다.

PyTorch가 시작 시 임시 경로에 캐시 디렉터리를 만든다. 첫 검사에서 전체 디렉터리가 비었다는 가정이 실패해, 시작 캐시를 기준 상태로 분리하고 업로드 스풀의 열린 FD와 전후 디렉터리 차이를 검사했다. 런타임 소스 수정은 없었다.

## 실제 추론·스풀 검증

- 엄격한 health 계약의 ready/model/preprocessing/checkpoint SHA 일치와 Docker healthcheck `healthy`를 확인했다.
- 승인 demo JPEG1개와 기존96MiB 후행 패딩 fixture1개에 `POST /predict`를 실제 실행했고 모두 HTTP200이었다. 두 응답의 grade/confidence/model/preprocessing은 완전히 같았다.
- 이미 보존된 동일 demo의 Mac 응답과도 전체 응답이 일치했다. 사전 confidence 허용차는1e-5, 실제 차이는0이었다.
- 96MiB body를 전송하고 마지막 multipart boundary 전송을 잠시 멈췄다. 후보 Python의 `/proc/1/fd`에서 `/uploads-tmp`에 열린 스풀1개, 크기100,663,296bytes, UID/GID10001을 확인했다. 해당 스풀을 읽어 계산한 SHA는 전송 fixture SHA와 일치했다.
- 마지막 boundary 전송 후 판독이 완료되면 열린 스풀은0개였고 디렉터리는 시작 캐시만 있던 기준 상태로 돌아왔다. 단순히 응답 성공만으로 정리를 추정하지 않았다.
- 승인 demo·fixture·동결 가중치의 SHA는 검증 전후 불변이었다. 원본300개와 test 이미지에는 접근하지 않았다.

단위검사19개는 다시 실행하지 않았다. 이번에는 기존에 미검증이던 Linux Docker·권한·실제 디스크 수신·정리를 확인했다.

## 정리·인계·한계

이번 후보의 정확한 컨테이너 ID와 소유 label을 확인한 후 정상 stop(exit0, OOM 없음)→컨테이너 제거→이번 전용 임시 볼륨 제거를 수행했다. 검사 시작 전에 실행 중이던 기존 컨테이너7개는 계속 실행 중이었고, 운영8001 health는 전후 같은 ready 상태였다. 기존 원본·DB·MinIO 볼륨을 정리하지 않았다. 새 모델 이미지만 통합용으로 로컬 보존했다.

제품 담당은 새 이미지를 사용할 때 전용 디스크 TMPDIR와 실행UID의 실제 접근을 확인해야 한다. Python 임시 경로 선택은 잘못된 TMPDIR에서 다른 경로로 fallback할 수 있으므로 환경변수 설정만 확인하지 말고 `tempfile.gettempdir()`와 파일 생성·쓰기를 함께 검사한다. 이번 검증은 named volume 방식이다. `ml/OPERATIONS.md`의 host bind 예제와 제품 Compose 통합은 별도 실행 검증 대상이며 완료로 표시하지 않는다.

96MiB는 같은 승인 demo에 후행 bytes를 붙인 전송 fixture다. 대형 해상도·다중 동시 요청·장시간 부하·Linux AMD64·재부팅 후 복구는 검증하지 않았다. 원래40Mpixel 디코딩 보호와 자원 한계는 유지한다. 관측 시간에는 스풀 확인을 위한 의도적 중지가 포함되므로 성능 수치로 사용하지 않는다.

현재 서비스 모델 교체, 학습·최종 test 재실행·기준 변경은 수행하지 않았다. 기존 train99.57% PASS / test60%(기준70%) FAIL은 그대로다. 개별 응답·fixture SHA·mount 상세·로그는 Git 제외 `ml/artifacts/docker-streaming.local/`에 보존한다.

독립 검토자는 문서와 보존 메타데이터를 대조해 소스10개·내부파일7개, 실제UID/디스크/readonly/loopback, 두 추론 응답, 스풀0→1→0, SHA·정리 근거가 일치함을 확인했다. HostConfig 일부의 증거 미보존은 위와 같이 명령 설정과 조회 검증으로 구분했다. 검토자는 원본·fixture·가중치 접근이나 Docker 재실행을 하지 않았다.
