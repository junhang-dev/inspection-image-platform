# 최종 모델 동결 및 평가

## test 실행 전 동결

- 동결 시각: 2026-09-21T07:53:34.906892+00:00
- 모델: `mobilenetv3small-ft-20260921T074822Z`.
- 전처리: `rgb-first-frame-exif-full-resize224-imagenet-v1`.
- 모델 SHA-256: `21245b2f2d8b478b7b2762c51e7882692babd062eb1de8ec305cb090a7906753`.
- 승인된 합격선: train exact accuracy ≥90%, test exact accuracy ≥70%. recall/심각저평가는 참고 지표이며 gate가 아니다.
- 선택 이유: 미세조정 epoch11이 validation macro F1 0.5561, exact37/58로 초기 모델보다 높음. train만 보고 선택하지 않음.
- train 결과: 230/231=99.57%, 승인 기준 PASS.
- 기준확정/모델동결 전에 고정 test 사진은 읽지 않음.
- test는 동결 계약/가중치/manifest 해시를 확인한 뒤 단1회 평가. 평가 결과 이후 모델·전처리·합격선을 변경하지 않음.

## 실제 최종 평가 결과

| 구분 | 기준 | 실제 | 판정 |
|---|---:|---:|---|
| train 정확 일치 | ≥90% | 230/231, 99.57% | PASS |
| test 정확 일치 | ≥70% (7/10) | 6/10, 60% | FAIL |
| 모델 종합 성능 | 두 기준 충족 | test 미달 | FAIL |

참고 지표: test macro F1 0.5810, 1·2/3~5 구분 8/10, 실제 3~5 재현율 4/6, 실제 4·5를 1·2로 크게 낮춘 경우 0/4. 이 값들은 승인된 추가 gate가 아니다. test 사진별 ID·실제등급·예측등급·confidence·버전은 Git 제외 상세 JSON에 보존했다. 최종 test 후 재학습·튜닝·기준변경은 수행하지 않았다.

## 평가 버전의 실제 서비스 연결

- 제품 담당에게 교체를 사전 통보하고 기존8001 프로세스를 정상 종료한 뒤 `MODEL_PATH=ml/artifacts/finetune.local/model.pt`로 재기동했다. 기존 초기모델 가중치는 보존했다.
- 기존 프로세스 종료는 sandbox에서 거부되어 명시된 범위의 escalation 승인으로 종료했다. 종료 실패 직후 한 번 기동한 프로세스는 포트 점유로 종료되었고, 정상 종료 후 재기동 성공했다.
- `/health` ready=true, model_version=`mobilenetv3small-ft-20260921T074822Z`.
- `/predict`의 실제 승인 demo 응답도 동일 model_version/동일 preprocessing_version. 가중치 SHA-256도 동결·평가 해시와 일치.
- 해당 demo 1회 응답 0.235초. 이 입력은 train demo 복제본이며 최종 test를 다시 실행한 것이 아니다.
- 최종 모델 환경으로 API4+체크포인트보호2+최종평가보호1 = 7개 테스트 통과. 최종평가보호는 합성 bytes/fake predictor를 사용해 실제 test 사진 재접근 없이 검사했다.

## 데이터 구조 검증

- 원본300장 SHA-256을 기존 manifest와 재대조하여300/300 일치.
- 원본 manifest 자체 SHA-256 불변 확인.
- 포함된 train231/validation58/test10, 제외된 동일내용 중복1 보존.
- 기존 그룹/해시의 split 간 겹침 없음, 포함ID중복없음, 라벨1~5 범위 확인.
- 이 PASS는 구조·무결성 범위다. 실제 현장등급의 정답성·물리적 포인트 식별·미확인 유사사진 독립성을 보증하지 않는다.
- 파일→모델API 연결은 승인 demo로 확인했다. 실제 파일→제품 백엔드→UI 및 스크린샷 기반 검증은 제품/검증 담당에서 확인한다.
- 최종 모델 HTTP 추론10회(승인 demo5장×2회): 총0.995초, 최대0.230초. 서로 다른10장 평가나 최종test 반복이 아니다. 제품 전체 업로드/큐/네트워크 시간을 포함하지 않는다.
- 최종평가 재실행보호 독립검토 수정완료: freeze파일명 대신 test ID·SHA-256 기반 marker를 고정 local registry에 저장. 복사된 freeze로 재시도하는 합성검사도통과. 다른worktree로통합할때registry보존이필요하다.
