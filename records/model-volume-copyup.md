# 모델 임시 볼륨의 root helper 없는 초기화

2026-09-21. 제품 담당이 업로드 통합을 위해 새 named volume의 기본 copy-up으로 임시 저장소 소유권을 준비할 수 있는지 요청했다. 기반 commit은 `3e5b084`이며 기존 Dockerfile에는 해당 디렉터리가 없었다.

## 변경

`ml/Dockerfile`의 root build 단계에서 `/uploads-tmp`를 소유UID/GID10001:10001·권한0700으로 만들고, `TMPDIR=/uploads-tmp`를 기본값으로 지정했다. 실행 `USER 10001:10001`은 유지한다. 이미지에 `VOLUME` 선언을 추가하지 않았으며 실행 시 명시적으로 named volume을 연결한다. 추론 코드·모델·전처리·가중치 계약은 바꾸지 않았다.

Docker는 새/빈 볼륨에 이미지 경로의 내용을 기본적으로 복사하며 `volume-nocopy`로 이를 비활성화할 수 있다. 이 문서의 소유권 보존 결론은 아래 실제 Linux ARM64 실행에 근거한다. [Docker 공식 볼륨 문서](https://docs.docker.com/engine/storage/volumes/#mounting-a-volume-over-existing-data)

## 실제 실행

- 로컬 이미지: `inspection-model:volume-copyup`.
- image ID: `sha256:f6d6a540208fa36de1a88c77bcfa5b1861633624fec8d422b3e59fb71d91fc7e`.
- 검증 Dockerfile SHA-256: `d7bcd42c7324f4439af145414af7c9ed360675533e9e2816ab62ed5fe464cb27`.
- ARM64 OrbStack에서 새 전용 named volume2개만 만들고 검증했다. 모든 실행은 기본USER10001:10001, readonly root, network none, cap-drop ALL, no-new-privileges 설정이며 포트를 열지 않았다. 가중치·사진을 연결하거나 추론하지 않았다.
- 기본 copy-up의 새 볼륨은 root helper 없이 owner/group10001·mode0700을 유지했다. 기본 `tempfile.gettempdir()`가 `/uploads-tmp`였고, 파일 생성→쓰기→fsync→읽기→정리가 통과했다.
- 같은 볼륨을 새 컨테이너에 재연결해도 권한과 쓰기·정리가 유지됐다. 첫 컨테이너에서 작성한 합성 확인값이 보존됐으며 두 번째 컨테이너에서 해당 확인 파일까지 정리했다.
- 별도의 새 볼륨에 `volume-nocopy`를 지정한 대조에서는 owner/group0·mode0755였고 UID10001 쓰기가 PermissionError로 거절됐다. 따라서 제품 설정에서는 `volume.nocopy: true`를 사용하지 않는다.
- 후보 컨테이너는 각각 실행 후 제거됐고 이번에 만든 볼륨2개도 제거했다. 새 이미지만 로컬에 보존하며 push하지 않았다. 운영8001·기존서비스·기존볼륨·Compose는 변경하지 않았다.

## 범위와 인계

`ml/OPERATIONS.md`의 실행·Compose 예제는 named volume을 기본으로 바꿨다. 기존 비어 있지 않은 볼륨과 host bind의 소유권을 자동 교정한다고 주장하지 않는다. 기존 데이터가 있으면 삭제·초기화하지 말고 별도 권한 확인이 필요하다. 제품 실제 Compose 통합은 제품 담당 범위다.

독립 코드 검토는 디렉터리 준비 순서·최소 권한·일치하는 TMPDIR·익명볼륨 미생성·모델 계약 불변을 확인했고 중요 결함을 발견하지 못했다. 검토자는 Docker 실행을 재수행하지 않았다. 실제 실행 근거는 Git 제외 `ml/artifacts/volume-copyup.local/`에 보존했다. 기존 대용량 추론·모델 성능 검사는 변경 범위가 아니므로 반복하지 않았다.
