# 로컬 Label Studio·재학습 관리 후속 검증

2026-09-21, 기반 commit1127303. 핵심 제품 검증 후 허브가 사용자 후속 구현 승인에 따라 로컬 Label Studio 연동·재학습 관리를 착수하도록 통보했다. 초기 연결과 UI 제출은18:18~18:26 KST에 수행했다. 공개 제품·Cloudflare·현재 모델8001은 변경하지 않았다.

## 실제 연결과 화면

- 공식 Label Studio1.23.0, image digest `sha256:aa461572e8f9d86a1bf9520c1db620204e86160fd2f80dd7e9d40ac84a8828ea`를 설치했다.
- Docker internal 전용 네트워크로 외부 송신을 차단하고 통계 수집도 비활성화했다. 이미지 루트는 후보 전용 readonly mount, DB/토큰/export/승인 상태는 별도 로컬 저장소다.
- OrbStack internal network에서 published port가 활성화되지 않아, 컨테이너 내부 주소만 전달하는127.0.0.1:8085 전용 프록시를 추가했다. 임의 요청 URL로 upstream을 바꾸지 못한다.
- 제품 backend labeling 후보와 승인 demo 고정SHA의 교집합2개를 실제 가져왔다. 기존train 원본ID에 대응시키고 새 표본은 추가하지 않았다.
- 첫 프로젝트에서 이미지404를 발견했다. LS1.23의 프로젝트 Local Files storage 권한을 연결하고 후보 전용 하위 디렉터리로 수정한 프로젝트2에서 실제 이미지와 정상표시를 확인했다. 실패 프로젝트는 진단 기록으로 이름을 바꿔 보존했다.
- UI에서2개 라벨을 선택·Submit했다. 제출 완료 목록의2개 annotation과 실제 사진 화면을 캡처했다. local-files 응답2개의 bytes SHA는 snapshot/demo SHA와 일치했다.
- 실제 JSON export에서 원래AI/사람수정/작성라벨이 각각 분리됨을 확인했다. 해당2개 결과는 workflow_test이며 학습 불가다. screenshot/export/개별ID/토큰은Git에포함하지않는다.

## 실제 재학습 관리 1회

미리보기의 기존train231/validation58·신규0·test제외·workflow라벨0과 정확한 snapshot/config SHA를 허브에 제시했다. 허브는 기존 사용자 소규모 실험/후속구현 승인을 근거로 단회 실행을 승인했다. actor는 `hub agent`로 기록했으며 새로운 사람 승인이나 라벨 품질 승인으로 표현하지 않는다.

- 동결backbone + 로지스틱head1개, C0.1, balanced, CPU2threads. 목적은 관리 실행·이력·후보등록 확인이다.
- 단회 실행 완료 및 candidate_only 등록. 상세 run ID는 로컬 증거에 보존한다.
- train231/231=100%, validation33/58=56.90%, validation macroF1=.547647.
- 기존 validation63.79%/.5561보다 낮으므로 성능 개선으로 판단하지 않는다. 추가 반복 실험은 수행하지 않았다.
- 새후보의 final test는 미평가다. 기존모델의train99.57% PASS/test60%(기준70%) FAIL을승계하거나대체하지않는다.
- 기존8001 health ready 및 동결가중치SHA불변을실행후확인했다. test사진을읽거나서비스모델을교체하지않았다.

## 검토와 검사

독립기술검토에서 demo 디렉터리 전체를 허용하는 결함, bridge의 고정manifest 미대조, 학습소비자의 reviewed provenance 문자열만 신뢰하는 결함을 발견해수정했다. 고정demo5 이름/SHA·변조/symlink 거절, 동결manifest SHA·구조검사, 원본snapshot→export→검토결정→reviewed registry 해시연결검증을추가했다. 추가검토에서새해시로다시만든snapshot의원본대조누락과후보등록실패시완료오표시가능성을확인했다. 승인/실행입구에서도원래manifest·각entry전체·source_root·검토라벨·초기가중치동결계약을다시검사하고,후보등록성공뒤완료를기록하며실패상태를우선표시하도록수정했다.

`ml/.venv/bin/python -m unittest labeling.test_bridge ml.test_retraining -v`:16개PASS. 추가사진/변조/symlink/외부origin/알수없는task/라벨충돌/잘못된manifest/workflow승격/가짜reviewed플래그/승인누락/승인후변조/승인재사용/test포함/실행실패기록을격리단위검사했다. 정상reviewed연결과새해시의test재표기/임의라벨/source_root/초기가중치변조거절,후보registry쓰기실패의완료오표시방지는합성fixture로확인했다. 실제workflow export도학습소비자에서거절됨을확인했다.

실패 run 이력은 주입된 실패의 단위 검사로 확인했으며, 실제관리run은1회성공했다. 실제엔지니어검토라벨의품질·그라벨로학습한성능·대규모부하·OS재부팅후자동복구는검증하지않았다.

## 후속 사용과 한계

`labeling/README.md`에실제기동/정지/후보import/UI제출/export/엔지니어검토/미리보기/승인/실행명령을기록했다. 실제엔지니어작업은새engineer_review_pending snapshot으로시작하고정확exportSHA와항목별ID/SHA/grade검토결정을보존한다. workflow_test는승격하지못한다. 학습승인은라벨검토와별도로snapshot/config에바인딩한다.

현재승인demo범위만지원하며일반신규업로드자동학습·전체원본라벨링을구현했다고표현하지않는다. backend 최신1000개한계에닿으면실패하므로미래에는제품담당의후보전용페이징API가필요하다. Mac신뢰운영자의CLI승인기록은계정인증/현장정답인증을대체하지않는다. proxy는전경프로세스이며터미널종료후재실행해야한다. 컨테이너재생성시내부IP가바뀌면proxy도재시작한다. 제품Compose편집은제품담당소유다.

비공개증거는 `labeling/state.local/` 및 `ml/artifacts/retraining.local/`에보존한다. 공식설치/보안기준은 [시작설정](https://labelstud.io/guide/start), [로컬저장소](https://labelstud.io/guide/storage_local), [공식릴리스](https://github.com/HumanSignal/label-studio/releases/tag/1.23.0)를확인했다.

## 와이파이 중단 후 로컬 연결 점검과 프록시 수정

후속 연결 확인에서 기존 모델8001과 Label Studio 컨테이너가 계속 실행 중임을 확인했다. 모델 health200/ready, LS health200/UP, 로그인 화면200이었다. 컨테이너 재시작 횟수는0이었다.

제품 담당의8085 HTTP400은 와이파이 종료와 별개의 프록시 헤더 처리 오류로 재현됐다. 소문자 `host`를 받은 뒤 고정 `Host`를 추가해 중복 전달한 것이 원인이었다. 대소문자를 구분하지 않고 기존 Host를 제외한 후 고정 Host 하나만 전달하도록 수정했다.

이 작업 소유의 로컬 프록시만 같은 설정으로 재기동했다. `localhost`/`127.0.0.1` 각각에서 `Host`/`host` 요청4개 모두 정상 로그인 redirect302를 확인했다. 인증된 프로젝트의 기존 annotation2개와 이미지2개 SHA 일치, 모델8001 ready도 보존됐다. 헤더 대소문자·중복 방지 회귀검사1개PASS 및 diff-checkPASS. 학습·추론 재실행, 컨테이너 재생성, 원본·라벨·DB 변경은 하지 않았다.
