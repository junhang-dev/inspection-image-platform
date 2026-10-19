# 2026-10-19 UI 기본 조작 기준 마이너 패치

## 목표와 범위

- 사용자 요청: "이 정도 원칙만 적용해서 마이너 패치 진행하자"와 "서버반영도해줘".
- 11px 미만 텍스트 금지, 본문·입력 14px 이상, 주요 버튼 40px 이상, `focus-visible`, 같은 목적 버튼 이름·스타일 유지, 회전 문자 화살표 금지를 적용했다.
- UI CSS 5개 파일만 변경했다. API, 인증, 데이터, 모델, 사진 원본, Worker·Tunnel 설정은 변경하지 않았다.
- 요청 수신 시각은 실행 기록에서 분 단위로 확인할 수 없어 생략했다. 운영 웹 전환·검증은 2026-10-19 12시대 KST에 완료했다.

## 검증

- `git diff --check` 통과.
- `npm run typecheck` 통과.
- `npm test`: 206개 중 195개 통과, 0개 실패, 선택 인프라 검사 11개 건너뜀.
- `npm run build` 통과. API rewrite가 `http://127.0.0.1:4000/api/:path*`를 가리키는 것을 확인했다.
- `src/`의 CSS·TSX·TS에서 11px 미만 `font-size` 선언이 없는 것을 확인했다.
- 별도 후보 포트 3101에서 루트·공유 API health HTTP 200, `ready=true`, `dataScope=shared`, 모델 `ready=true`를 확인했다. 후보 프로세스는 종료했고 3101 listener가 남지 않았다.

## 운영 반영과 데이터 보존

- 소스 커밋 `3025f15`의 웹을 `local/shared-v3-final/releases/ui-ux-rules-20261019/web-final`로 전환했다. BUILD_ID는 `QQ_5koVvclb-lXeiF0bXq`다.
- 운영 웹 PID는 `41616`, API PID는 전후 모두 `39227`이었다. API는 `grade-method-20261019` 릴리스를 유지한다.
- 고정 주소에서 루트와 API health가 HTTP 200이었다. API `ready=true`, `dataScope=shared`, 모델 `ready=true`다.
- 공개 웹에서 참조한 CSS 2개가 새 후보 빌드의 CSS와 바이트 단위로 일치했다.
- 기존 브라우저 탭을 재사용해 홈(접수 사진 300장, 보수 대상 111건), 보수 관리(111건), 검사계획(진행 중 1, 전체 5, 완료 4, 취소 0)을 확인했다. 계획 목록에서 등록일시와 사진 추가·계획 관리 버튼도 표시됐다.
- 전환 전후 DB 테이블 전체 행 해시와 사진 객체 300개의 키·크기·ETag 해시가 일치했다. 두 시점 모두 진행 중 업로드 0, 사진 판독 0, 분석 작업 0이었다.
- 새 사진 업로드, AI 추론, 보수 기록 저장은 하지 않았다. 사용자 탭 외에 브라우저를 열지 않았고, 별도 후보 웹 프로세스 종료를 확인했다.

## 전환 복구 기록

- 첫 LaunchAgent 재등록은 `Bootstrap failed: 5`로 실패했다. 즉시 기존 plist를 복원했고 기존 웹 HTTP 200, API PID 유지, 후보 포트 종료를 확인했다.
- 기존 기록과 같은 방식으로 프로세스 중지 후 1.5초 대기 뒤 재등록했다. 새 작업 경로와 웹 200을 확인한 뒤 운영 반영을 완료했다.
- 복구용 plist·서비스 manifest와 전후 데이터 요약은 `local/shared-v3-final/runtime/backups/ui-ux-rules-20261019/`에 보존했다.

## 한계

- 키보드 전용 탐색에서 `focus-visible` 효과를 브라우저로 별도 측정하지 않았다. 선언과 전체 UI 로드만 확인했다.
- 새 업로드·추론·업무 저장 end-to-end는 실행하지 않았다.
