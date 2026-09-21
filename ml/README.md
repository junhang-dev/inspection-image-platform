# 로컬 부식 등급 모델

사진 픽셀을 MobileNetV3 Small 특징으로 바꾸고 train에서 학습한 선형 분류기로 1~5등급을 추론한다. confidence는 보정하지 않은 softmax 점수이며 실제 정답 확률로 보장하지 않는다. 파일명·설비번호·포인트는 추론에 전달하지 않는다.

## 동결 모델 실행

운영 시작에는 **학습을 다시 하지 않는다**. [운영 인계](OPERATIONS.md)에 가중치 확인·시작·종료·health·재시작과 선택적 Docker 계약을 정리했다.

```sh
python3 -m venv ml/.venv
ml/.venv/bin/python -m pip install -r ml/requirements.txt
ml/.venv/bin/python -m ml.serve --check
ml/.venv/bin/python -m ml.serve --port 8001
# 별도 터미널
ml/.venv/bin/python -m ml.healthcheck --port 8001
```

현재 로컬에 이미 있는 동결 가중치가 필요하다. 새 Git 복제본에는 가중치가 없으므로 로컬 인계 경로를 `--checkpoint`로 지정한다. 개발 실험은 `ml.train`/`ml.finetune`의 별도 승인 범위이며 운영 시작 절차에 포함하지 않는다.

새 `ml.serve`의 기본은 동결된 `ml/artifacts/finetune.local/model.pt`와 `ml/model-contract.json`이다. 기존 직접 `uvicorn ml.service:app` 실행은 `MODEL_PATH`가 없으면 초기 `ml/artifacts/model.pt`를 읽으므로 운영 인계에서는 새 진입점을 사용한다. 학습 시 공개 ImageNet 가중치를 내려받아 프로젝트 안에 캐시한다. 추론 서비스는 가중치를 자동 다운로드하지 않는다. 원본 사진은 외부로 전송하지 않는다.

- 공개 가중치 출처: https://download.pytorch.org/models/mobilenet_v3_small-047dcff4.pth
- 공식 모델 설명: https://docs.pytorch.org/vision/stable/models/generated/torchvision.models.mobilenet_v3_small.html
- 전처리: 첫 프레임 → EXIF 방향 적용 → RGB → 전체 사진 224×224 resize → ImageNet 정규화. 중심 crop을 하지 않아 사진 가장자리를 버리지 않는다. 가로세로 비율 왜곡은 초기 모델의 한계다.
- 학습은 고정 train 231장, validation 58장만 읽는다. 매 사진 SHA-256을 기존 manifest와 비교한다. test 실행 옵션은 없다.
- 사전학습 특징 추출기는 고정하고 C 5개 × class weight 2개를 검증한다. validation macro F1 우선, 동률이면 정확도로 선택한다. 10가지 조합 탐색을 '10회 연속 성능 정체'로 해석하지 않는다.
- 가중치·원본 리포트·로그는 Git 제외 대상이다. `*.local.*`, `*.pt`, `*.pth`, `.venv/`를 그대로 유지한다. 사진별 리포트와 manifest는 공개하지 않는다.

## 제품 연결 계약

`GET /health` → `{"ready": true, "model_version": "..."}`. 모델이 없거나 로딩에 실패하면 ready=false이다.

`POST /predict`의 multipart 필드는 **image**이며 JPEG/PNG/MPO bytes를 받는다. 응답 예시는 형태만 나타낸다.

```json
{"grade": 3, "confidence": 0.62, "model_version": "mobilenetv3small-linear-...", "preprocessing_version": "rgb-first-frame-exif-full-resize224-imagenet-v1"}
```

| HTTP | 의미 | 다음 행동 |
|---|---|---|
| 400 | multipart 손상·미완성·계약 외 필드 | image 파일 하나로 전송 형식 확인 |
| 422 | 사진 없음·손상·지원하지 않는 형식 | JPEG/PNG 사진으로 다시 요청 |
| 503 | 모델 미준비 또는 임시 저장소 장애 | detail을 보고 모델 설정 또는 임시 디스크 공간·권한 확인 후 재시도 |
| 500 | 실제 추론 실패 | 원래 결과는 미생성으로 남기고 재시도 |

백엔드가 비동기 작업으로 호출하고 180초 timeout/실패 상태를 관리한다. 서비스는 브라우저에 직접 공개하지 않는다. Docker에서 Mac 서비스에 접근하려면 host.docker.internal:8001과 호스트 바인딩/보안 정책을 실제로 검증해야 한다. 기본 실행은 loopback에만 바인딩한다.

모델 API의 고정20MiB 제한은 제거했다. 한 요청에는 `image` 파일 하나를 보내고, 제품의 업로드 묶음 개수와는 별개다. 파일은1MiB 이후 임시 디스크로 수신하며 원본 bytes를 재인코딩하지 않는다. 전처리와 동결 모델은 그대로다. multipart 헤더는16KiB로 제한하고 일반 폼 필드는 받지 않는다. 임시 디스크 용량·동시 요청 수·전송 시간·디코딩 메모리에는 실제 자원 한계가 있다. 기존40Mpixel 디코딩 보호는 유지하므로 모든 해상도나 무한 용량을 보장하지 않는다. Docker의 임시 저장소는 [운영 안내](OPERATIONS.md)의 디스크 볼륨 설정을 따른다.

## 검증

```sh
ml/.venv/bin/python -m unittest ml.test_service ml.test_streaming_upload ml.test_serving_contract -v
```

실제 가중치가 먼저 필요하다. 공개 승인된 train demo로 파일명과 bytes/file 입력에 따른 결과 보존,20MiB 초과 전송·잘못된 파일·미준비·취소·임시 저장소 오류를 검증한다. demo 성공은 모델 성능 평가가 아니다. 이미 사용한 최종 test10장은 다시 평가하지 않는다. 새 최종 성능 주장은 별도 독립 평가 계획에 대한 사람 합의가 필요하다.

## 작은 미세조정 실험

```sh
ml/.venv/bin/python -m ml.finetune --manifest /absolute/path/to/split.local.json
ml/.venv/bin/python -m unittest ml.test_finetune -v
```

기존 특징 추출기의 마지막 3개 block과 선형 분류기만 최대 12epoch 조정한다. BatchNorm 통계는 고정하고 train에만 좌우 반전을 적용한다. 초기 모델(epoch 0)도 후보로 두며 validation macro F1, 동률 정확도로 선택한다. 10epoch 연속 개선이 없으면 중단한다.

결과는 별도 `ml/artifacts/finetune.local/model.pt`에 저장하고 서비스는 자동 교체하지 않는다. `--initial`, `--output`, `--epochs`를 지정할 수 있다. 초기/서비스 체크포인트와 같은 출력 경로 또는 이미 존재하는 실험 출력은 거부하므로 다음 실험에는 새 출력 폴더를 사용한다. 후보가 전체 정확도를 높여도 검토 대상 재현율을 낮출 수 있으므로 각 지표를 함께 확인한다.

## 동결 모델 최종 평가와 현재 서비스

이번 실행에서 최종 선택한 모델은 `mobilenetv3small-ft-20260921T074822Z`다. 승인 합격선은 train90% / test70%이며 실제 train230/231(99.57%) PASS, 최종 test6/10(60%) FAIL이다. 모델 성능 합격으로 표시하지 않는다. 이 결과 이후 튜닝하거나 합격선을 바꾸지 않는다. 참고 재현율은 추가 합격 gate가 아니다.

현재 평가된 동일 모델로 기동하는 명령은 다음과 같다. 가중치는 로컬 산출물이며 Git에 포함되지 않으므로 해당 파일이 있어야 한다.

```sh
MODEL_PATH=ml/artifacts/finetune.local/model.pt ml/.venv/bin/python -m uvicorn ml.service:app --host 127.0.0.1 --port 8001
```

`ml.evaluate`는 train/validation 평가를 지원하며 final test에는 승인 기준, 모델/전처리 버전, checkpoint/manifest 해시가 담긴 `--freeze` 계약이 필요하다. 이미 한 번 실행된 고정 test는 같은 항목 ID·SHA-256으로 식별하여 `ml/artifacts/final-test-access.local/`의 기록으로 재실행을 거부한다. freeze 파일을 복사하거나 다른 모델을 지정해도 같은 test 세트는 재실행하지 않는다. 실패한 평가도 자동으로 잠금을 삭제하지 않는다. 최종 test는 이미 수행됐으므로 반복 실행하지 않는다.

```sh
ml/.venv/bin/python -m unittest ml.test_finetune ml.test_evaluate -v
```

위 평가 보호 테스트는 가짜 입력 bytes와 fake predictor만 사용하므로 실제 test 사진에 접근하지 않는다. 실제 API 테스트는 train demo만 사용한다.

다른 worktree나 실행 디렉터리로 통합할 때는 최종 가중치와 동결 계약, 평가 리포트뿐 아니라 `ml/artifacts/final-test-access.local/`도 **로컬로 함께 보존**한다. 이 registry를 새로 만들거나 지우면 이미 실시한 test의 재실행 이력이 사라진다. 이 파일들을 Git 또는 외부 배포물에 포함하지 않는다.
