# 모델 API의 고정 업로드 용량 제한 제거

2026-09-21 21시 KST 작업, 최종 HTTP 확인21:23 KST. 시작 기준은 `aa44a44`, 작업 브랜치는 `codex/jun/model-streaming-upload`다. 허브는 최신 사용자 요청인 일반 업로드 개수·고정 용량 제한 제거에 맞춰 모델 API의20MiB 제한 제거를 담당 작업에 전달했다. 원본을 축소·재인코딩하지 않고 같은 로컬 API·동결 모델·전처리를 유지하는 범위다. 제품의 계획 중심 업로드 UI와 backend/Compose 변경은 제품 담당 소유다.

## 구현

- 요청 전체를 모으는 ASGI middleware와20MiB bytes 검사를 제거했다. `POST /predict`는 기존 multipart `image` 파일 하나와 기존 응답 형식을 유지한다. 제품에서 선택하는 업로드 묶음의 개수 제한은 이 단일 추론 API 계약과 별개다.
- Starlette의1MiB spool 이후 디스크 임시 파일로 수신하고 Pillow에 파일 핸들을 넘긴다. 수신 원본을 축소하거나 다시 인코딩하지 않는다. 첫 프레임→EXIF 방향→RGB→전체224 resize→ImageNet 정규화 및 모델 가중치는 그대로다.
- 일반 폼 필드와 추가 파일,16KiB 초과 multipart 헤더를 거절한다. `python-multipart.finalize()`의 잘린 body 검증 부재를 보완해 종료 boundary가 없는 요청은 추론하지 않는다.
- 정상 완료·실패·연결 중단·취소의 임시 파일 정리를 보장한다. 디스크 I/O나 추론 중 취소는 worker 완료 뒤 파일을 닫는다. 손상 이미지422, multipart 오류400, 임시 저장소 장애503, 추론 내부 실패500을 구분한다.
- Docker 운영 예제에 디스크 기반 임시 디렉터리와 `TMPDIR` 연결을 추가했다. 기존64MiB tmpfs만 업로드 저장소로 사용하는 구성은 피해야 한다. 제품 Compose 자체는 수정하지 않았다.

## 실제 검증

`ml/.venv/bin/python -m unittest ml.test_streaming_upload ml.test_service ml.test_serving_contract -q`: **19개 PASS**. 정상/손상 파일, 파일명 독립성, 동결 식별자,20MiB 초과 spool 및 SHA 보존, 잘린 multipart, 수신/쓰기/추론 중 취소, 반복 취소, 디스크 부족/읽기 장애, 추가 파일/과대 헤더 거절을 검사했다. 승인 demo5개 모두 bytes 입력과 파일 입력의 전처리 tensor가 완전히 같았다.

독립 기술 검토에서 추론 중 취소의 조기 파일 닫힘과 디스크 읽기 오류의422 오분류를 발견했다. 수정 후 검토자가 스트리밍 회귀10개를 별도 실행해 모두 통과했고 추가 중요 결함은 발견하지 못했다.

최종 코드를 엄격한 동결 계약으로 Mac의 별도8002에 기동했다. 기존8001을 중지·교체하지 않았다. 승인 JPEG demo 복제본에 후행0 bytes를 붙인 전송 fixture를 사용했다. 픽셀은 같고 원본 파일은 수정하지 않았다.

| 검사 | 결과 |
|---|---|
| 기존8001 / 후보8002의 동일 demo 응답 | grade/confidence/model/preprocessing 전체 동일 |
| 24MiB chunked multipart | HTTP200, 기존 demo와 응답 전체 동일, 약0.218초 |
| 96MiB Content-Length multipart | HTTP200, 기존 demo와 응답 전체 동일, 약0.350초 |
| 24MiB 요청 RSS 표본 | 시작519,984KiB / 관측최대534,880KiB,9표본 |
| 96MiB 요청 RSS 표본 | 시작513,088KiB / 관측최대523,168KiB,14표본 |
| 잘못된 파일 | HTTP422 `invalid_image` |
| demo5개 및 동결 가중치 SHA | 전후 불변 |
| 기존8001 health | 전후 동일, ready=true |

RSS는 `ps`를 약20ms 간격으로 호출한 관측값이며 짧은 피크를 놓칠 수 있다. 파일 용량 증가만큼 전체 body를 메모리에 복제하는 경로는 제거됐지만, 이 표본을 최대 메모리 보장이나 동시 부하 시험으로 해석하지 않는다. fixture와 상세 SHA/응답/로그는 Git 제외 `ml/artifacts/streaming-upload.local/`에 보존한다.

## 적용 상태와 한계

검증 완료 후 임시 후보8002는 정상 종료했다. 현재8001 운영 전환은 허브·제품 담당 조율 후 별도 진행한다. 새 코드의 Docker 이미지 실행 및 제품 Compose 임시 디스크 볼륨 연결은 이번 Mac 검증에 포함되지 않았다. 해당 설정과400/422/503 오류 계약을 제품 담당에게 전달했다. 제품 담당은 계획 관계 구현 이후 별도 업로드 제한 제거 단위에서 통합하기로 회신했다. UI를 변경하지 않았으므로 기존 화면 검사를 반복하지 않았다.

24/96MiB 검사는 동일 demo의 전송 용량 확인이다. 실제 대형 해상도·대규모 동시 요청·무한 저장 용량을 검증한 것이 아니다. 기존40Mpixel 디코딩 보호와 실제 디스크/메모리/전송 시간 한계는 유지한다. 서비스는 공개 터널에 직접 노출하지 않는다.

모델은 `mobilenetv3small-ft-20260921T074822Z`, 전처리는 `rgb-first-frame-exif-full-resize224-imagenet-v1`을 유지한다. 기존 train99.57% PASS / 최종test60%(기준70%) FAIL도 그대로다. 고정 test10장 접근·추론·오류분석, 추가 학습, 모델 자동 교체, 원본300장 공개는 수행하지 않았다.
