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

위 합성 검사 단계에서는 실제 API/Label Studio 연결이나 실제 후보 선정·import/export를 재실행하지 않았다. 이후 별도로 수행한 실제 API 메타데이터 조회는 아래 후속 기록과 구분한다. 원본300·고정test·가중치 접근, 추론·학습·운영 서비스 변경도 없다. 기존 모델 성능 test60% FAIL은 그대로다.

## 한계와 통합

제품 query는 각 응답의 DB snapshot을 보장하지만 여러 페이지를 하나의 snapshot으로 고정하지 않는다. 같은 total을 유지한 동시 삭제·추가 등 모든 변경을 이 클라이언트가 탐지한다고 주장하지 않는다. 감지할 수 있는 수량·중복·scope 불일치는 실패시키고, 실제 import 이후 검토/학습 승인 계약은 기존대로 별도 유지한다.

제품 query-map API가 배포되기 전에는 준비 명령의 새 endpoint가 없을 수 있으며 구 배열로 조용히 대체하지 않는다. 제품 담당의 준비 통지 뒤 격리 API의 단일 페이지 메타데이터 조회를 아래 범위에서 확인했다. 운영 연결·실제 다중 페이지·전체 prepare와 Label Studio 연결은 이 결과에 포함하지 않는다. 독립 검토자가 코드와 가짜 응답 검사를 확인하고7개를 별도 실행해 모두 통과했으며 중요 결함을 발견하지 못했다. 이후 목적 필드가 잘못된 배열 타입인 경우도 같은 조회 오류로 거절하도록 보완하고 해당 실패 사례를 포함해7개를 다시 통과했다.


## 후속 실제 API 조회 — 2026-09-21 23:58 KST

제품 담당이 격리 API3400의 query endpoint 준비를 통지하고 읽기 전용 후보 수집 검증을 요청했다. 로컬 실행 기록의 시작 시각은 `2026-09-21T14:58:36.710144Z`, 클라이언트 bridge 소스는 `fdbb3d5f9187fea1119dce701ac6cfae134aae05`다. 대상은 `http://127.0.0.1:3400/api/inspections/query`였다. 해당 기록의 source_commit은 **클라이언트 커밋**이며 서버 커밋을 뜻하지 않는다. 서버의 정확한 실행 커밋·이미지 전체 digest·파일 해시는 이 검증에 저장하지 않았으므로 특정 서버 커밋과의 동일성을 주장하지 않는다.

`python3 -B -`의 인라인 읽기 전용 래퍼에서 실제 `Client`/`candidate_pages`를 다음 두 설정으로 호출했다. 래퍼는 `/api/inspections/query?` 경로의 GET만 허용하고 응답 필드·페이지 메타데이터·검증 결과를 로컬 JSON에 기록했다. 아래는 실행한 핵심 호출이며 새로운 prepare 명령이 아니다.

```python
candidate_pages(client, "workflow_test", page_size=1)
candidate_pages(client, "engineer_review_pending", page_size=100)
```

- 실제 GET은 모드별1회, 총2회였다. 두 응답 모두 total1/고유UUID1/pages1이며 명시 scope와 `items,total,page,pages,pageSize,summary,pointCounts,scope` 필드가 일치해 PASS였다.
- 두 모드에서 반환된 후보는 inspection/visible/labeling=true의 승인 demo SHA 일치1건, 승인 밖 후보0건이었다. 승인 여부는 기존 allowlist 메타데이터로 대조했으며 사진 bytes는 내려받지 않았다.
- workflow_test의 요청 목적은 all, engineer_review_pending은 inspection이었다. 실제 후보가1건뿐이어서 다중 페이지 전환·다른 목적의 실제 후보·동시 변경 오류는 이번 실제 연결에서 검증하지 않았다. 해당 오류 처리의 근거는 앞의 합성7검사다.
- 사진 요청0, Label Studio 요청0, 상태 변경0, 추론0을 기록했다. 실제 prepare/snapshot 생성·import/export·운영4000 연결·원본 bytes 일치 검증은 수행하지 않았다. 이 결과를 전체 라벨링 흐름 완료로 확대하지 않는다.
- 최초 시도는 sandbox 네트워크 제한으로 API 응답을 받지 못했다. 허용된 재실행의 성공 기록과 최초 실패 기록을 각각 로컬에 보존했다. 이번 문서 보강에서는 재조회하지 않았다.

성공 근거는 Git 제외 `ml/artifacts/labeling-query.local/`의 읽기 전용 JSON에 보존했다. 개별 후보ID·SHA·로컬 상세 report는 공개하지 않는다. Git 담당이 이 증거를 대조해 PR16 설명에 단일 페이지 실제 조회 결과와 남은 한계를 먼저 반영했으며, 이 문서 보강은 그 후속 기록 정합성을 맞춘다.
