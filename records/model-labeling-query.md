# Label Studio 후보의 페이지 조회 호환성 수정

2026-09-21, 기반 commit90dc402. 허브가 제품 query-map의 페이지 조회 계약에 맞춰 bridge의 전체 후보 수집을 수정하도록 요청했다. 기존 코드는 구 배열 API를 한 번 읽고 길이1000 이상만 잘림으로 판단해, 제한된 목록과 목적 기본필터를 전체 후보로 오인할 수 있었다. 제품은 호환 배열의 기본1000과 X-Total-Count를 유지하도록 조정했지만 bridge는 명시 total이 있는 새 페이지 계약으로 전환한다.

## 최종 동작

- `/api/inspections/query`에 명시 page/pageSize100을 보내 전페이지를 수집한다. total/pages/page/pageSize 및 scope가 요청과 일치해야 하고, 마지막까지 모인 고유UUID수가 total과 같아야 성공한다.
- 중간 total/pages 변경, 마지막 페이지로 clamp된 응답, 중복UUID·반복 페이지, 잘못된UUID, 빈/짧은 중간 페이지, 과다 항목, 잘못된 숫자 타입을 거절한다. 부분 snapshot 성공으로 처리하지 않고 전체 prepare를 재시도할 수 있는 오류를 낸다.
- 일반 engineer_review_pending은 inspection/visible/labeling=true다. 허브가 확정한 workflow_test는 inspection/presentation/verification 세 목적을 허용하므로 recordPurpose=all을 명시하고 각 행도 허용된 목적/visible/labeling을 충족하는지 검사한다. 아직 inspection인 검증 후보를 이름으로 추정하거나 누락시키지 않는다.
- 승인 demo5개 SHA와 동결 manifest train 대응을 추가로 제한하며 새 사진을 LS에 보내거나 학습에 자동 편입하지 않는다. snapshot의 training_eligible=false와 workflow 승격 금지는 유지한다.
- 페이지 전체 검사 후 승인된 후보 이미지만 기존 bytes/SHA 검사를 수행한다. snapshot에는 명시 조회범위·총수·고유UUID수·페이지 수 및 각 원래 recordPurpose/visibility도 보존한다. 기존 snapshot/export/registry는 수정하지 않는다.

## 검사 범위

`python3 -m unittest labeling.test_candidate_pages -v`: **7개 PASS**. 가짜 HTTP 페이지와 합성 manifest/payload만 사용했다. 실제 서버 포트를 열거나 제품·Label Studio에 요청하지 않았다. 정상101건/100경계,0건과정확페이지경계,총수증감·메타데이터불일치·clamp·조기빈/짧음·중복·정체·잘못된UUID·scope위반을 검사했다.

prepare 통합 검사에서 두 번째 페이지가 실패하면 이미지 요청과 snapshot 생성이0임을 확인한다. 정상일 때 승인 밖 후보100개는 내려받지 않고 합성 승인후보1개만 처리하며, 전체조회수101·train연결·원래목적·학습부적격을 보존한다. 합성 validation/test SHA를 allowlist에 넣어도 이미지 요청 전에 train 경계에서 거절한다.

실제 API/Label Studio 연결이나 실제 후보 선정·import/export는 이번 수정에서 재실행하지 않았다. 원본300·고정test·가중치 접근, 추론·학습·운영 서비스 변경도 없다. 기존 모델 성능 test60% FAIL은 그대로다.

## 한계와 통합

제품 query는 각 응답의 DB snapshot을 보장하지만 여러 페이지를 하나의 snapshot으로 고정하지 않는다. 같은 total을 유지한 동시 삭제·추가 등 모든 변경을 이 클라이언트가 탐지한다고 주장하지 않는다. 감지할 수 있는 수량·중복·scope 불일치는 실패시키고, 실제 import 이후 검토/학습 승인 계약은 기존대로 별도 유지한다.

제품 query-map API가 배포되기 전에는 준비 명령의 새 endpoint가 없을 수 있으며 구 배열로 조용히 대체하지 않는다. 실제 페이지 API 연결 검증은 제품 담당이 준비 상태를 알린 뒤 별도 범위에서 진행한다. 독립 검토자가 코드와 가짜 응답 검사를 확인하고7개를 별도 실행해 모두 통과했으며 중요 결함을 발견하지 못했다. 이후 목적 필드가 잘못된 배열 타입인 경우도 같은 조회 오류로 거절하도록 보완하고 해당 실패 사례를 포함해7개를 다시 통과했다.
