# 로컬 부식 등급 모델

사진 픽셀을 MobileNetV3 Small 특징으로 바꾸고 train에서 학습한 선형 분류기로 1~5등급을 추론한다. confidence는 보정하지 않은 softmax 점수이며 실제 정답 확률로 보장하지 않는다. 파일명·설비번호·포인트는 추론에 전달하지 않는다.

## 설치와 실행

```sh
python3 -m venv ml/.venv
ml/.venv/bin/python -m pip install -r ml/requirements.txt
ml/.venv/bin/python -m ml.train --manifest /absolute/path/to/split.local.json
ml/.venv/bin/python -m uvicorn ml.service:app --host 127.0.0.1 --port 8001
```

서비스는 기본 `ml/artifacts/model.pt`를 읽는다. 다른 위치는 `MODEL_PATH` 환경변수로 지정한다. 학습 시 공개 ImageNet 가중치를 내려받아 프로젝트 안에 캐시한다. 추론 서비스는 가중치를 자동 다운로드하지 않는다. 원본 사진은 외부로 전송하지 않는다.

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
| 413 | 20 MiB 초과 | 용량을 줄인 뒤 다시 요청 |
| 422 | 사진 없음·손상·지원하지 않는 형식 | JPEG/PNG 사진으로 다시 요청 |
| 503 | 모델 미준비 | MODEL_PATH와 서비스 로그 확인 후 재시작 |
| 500 | 실제 추론 실패 | 원래 결과는 미생성으로 남기고 재시도 |

백엔드가 비동기 작업으로 호출하고 180초 timeout/실패 상태를 관리한다. 서비스는 브라우저에 직접 공개하지 않는다. Docker에서 Mac 서비스에 접근하려면 host.docker.internal:8001과 호스트 바인딩/보안 정책을 실제로 검증해야 한다. 기본 실행은 loopback에만 바인딩한다.

## 검증

```sh
ml/.venv/bin/python -m unittest ml.test_service -v
```

실제 가중치가 먼저 필요하다. 공개 승인된 train demo로 파일명을 바꿔도 결과가 동일한지, 정상/잘못된 파일/미준비/용량초과 응답을 검증한다. demo 성공은 모델 성능 평가가 아니다. 최종 test는 팀의 합격선 확정과 최종 모델 동결 후 별도 승인된 평가로 진행한다.
