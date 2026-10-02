# Drone Inspection Platform

검사 사진을 계획·생산팀·파이프랙에 연결하고, AI 판독과 보수 후속 업무를 한곳에서 관리하는 웹 서비스입니다.

- 서비스: [Drone Inspection Platform](https://drone-inspection-g10.dlwnsgod2761.workers.dev)
- 소스 코드: [GitHub 저장소](https://github.com/junhang-dev/inspection-image-platform)

## 업무 흐름

1. 생산팀과 검사할 랙을 지정해 검사계획을 만듭니다.
2. 계획과 랙에 사진을 추가합니다. 개별 포인트 연결은 필요할 때 할 수 있습니다.
3. 사진의 AI 부식 등급을 확인하고 필요하면 사람 판정이나 재촬영 여부를 기록합니다.
4. 보수 대상 사진을 보수 관리에서 검토하고 작업 방법·진행 상태·TA 포함 여부를 관리합니다.
5. 라벨링 후보와 판독·업무 변경 이력을 확인합니다.

AI 등급은 사진에서 보이는 부식 분류입니다. 설비 안전성이나 실제 보수 지시를 확정하지 않습니다. 원래 AI 결과와 사람의 수정값은 별도로 보존됩니다. 현재 고정 test 정확도는 60%로 프로젝트 목표 70%에 미달합니다. 기능 동작과 모델 성능은 별도로 평가합니다.

## 구성

- `src/`: Next.js 웹 화면
- `server/`: Express API와 업무 규칙
- `ml/`: 이미지 판독 모델과 ROI·SHAP 설명 서비스
- `docs/`: 제품 요구사항, 실행·데이터 정책, 배포 안내
- `records/`: 시점별 검증 결과와 인수 기록

웹은 API와 연결하고, API는 MySQL 업무 기록·MinIO 원본 사진·별도 Python 모델 서비스와 통신합니다. 서비스 주소는 Cloudflare Worker에서 전용 Tunnel을 거쳐 운영 웹으로 연결됩니다.

## 로컬 개발

필요한 Node.js·npm 버전과 개인 전용 데이터 설정은 [개발·데이터 안내](docs/private-import.md)를 따릅니다. 아래 명령은 전용 설정·DB·MinIO가 준비된 개발 환경에서 사용합니다. 원본 사진, 모델 가중치, DB, 로컬 환경 파일은 Git에 포함하지 않습니다.

```sh
npm ci
npm run dev:private
```

개발 웹은 `http://127.0.0.1:3100`, 전용 API는 `http://127.0.0.1:4100`에서 실행합니다. 운영 웹/API는 `3000/4000`이며 개발 데이터와 분리되어 있습니다. 전용 저장소 준비와 데이터 계약 설정 없이 운영 설정으로 개발 서버를 실행하지 마세요.

주요 확인 명령은 다음과 같습니다.

```sh
npm run typecheck
npm test
npm run build
```

## 운영 안내

운영 주소, 데이터 경계, 모델 연결, 안전한 배포·복구 절차는 [배포 안내](docs/deployment-v3.md)에 있습니다. 최신 제품 동작은 [제품 요구사항](docs/product-v3.md)과 [실행 계약](docs/product-v3-runtime.md)을 확인하세요. 자세한 검증 근거는 [records](records/)에 보존합니다.
