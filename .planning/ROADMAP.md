# Roadmap: WHENNOTE

## Overview

WHENNOTE(구 WHENWORK)는 1인 개발자 전용으로 돌아가던 트레이 할 일 앱을, 다른 준비 없이 설치 파일 하나로 쓰는 공개 앱으로 다시 세우는 브라운필드 대체(subtract-and-replatform) 작업이다. 저장소를 PostgreSQL·Docker에서 내장 파일 저장소로 바꿔 "캡처는 절대 잃지 않는다"는 원래 보장을 지키는 데서 시작해(Phase 1), 그 위에서 AI·git 수집·캘린더·Obsidian처럼 "누구나"라는 기준에 맞지 않는 기능을 화면부터 저장소까지 전 계층에서 걷어내고(Phase 2), 사용자에게 데이터 소유권을 돌려주는 내보내기·가져오기와 작성자 자신의 기존 데이터 이전을 만든다(Phase 3). 그다음 지금까지 Windows에 치우쳐 있던 첫 실행·단축키·자동 실행·알림 처리를 macOS까지 실기기에서 검증하고(Phase 4), 마지막으로 이름과 아이콘을 WHENNOTE로 바꿔 두 OS 설치 파일을 새 공개 리포에서 배포하고 작성자 본인이 일주일 실사용으로 완료를 확인한다(Phase 5).

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: 내장 저장소 전환** - PostgreSQL·Docker 없이 내장 저장소(node:sqlite)로 교체, 캡처 유실 제로 보장 유지
- [ ] **Phase 2: 레거시 기능 제거** - AI·git 수집·캘린더·Obsidian·창 컨텍스트를 UI부터 저장소까지 전 계층에서 삭제
- [ ] **Phase 3: 내보내기·가져오기·이전** - JSON 왕복 내보내기/가져오기, 기존 PostgreSQL 데이터 1회 이전
- [ ] **Phase 4: 첫 실행·플랫폼 대응** - 무설정 첫 실행, 단축키 재바인딩, macOS 실기기 동작 검증
- [ ] **Phase 5: 이름·아이콘·릴리스** - WHENNOTE 개명·아이콘 적용, 듀얼 OS 배포, 일주일 도그푸딩 완료 판정

## Phase Details

### Phase 1: 내장 저장소 전환
**Goal**: main/index.mjs 구조 정리(동작 변경 없는 순수 리팩터)를 먼저 마치고, 그 위에 PostgreSQL·Docker 없는 내장 저장소(node:sqlite)로 교체해 "캡처는 절대 유실되지 않는다"는 원래 보장을 유지한다.
**Depends on**: Nothing (첫 단계)
**Requirements**: STOR-01, STOR-02, STOR-03, STOR-04, STOR-05
**Success Criteria** (what must be TRUE):
  1. 앱은 PostgreSQL·Docker 등 외부 프로세스 없이 실행되고, 프로젝트·항목·이벤트가 앱 데이터 폴더 안의 단일 파일 저장소에 저장된다
  2. 저장소 쓰기가 실패해도 캡처는 로컬 큐 폴백에 남고, 다음 실행 시 자동으로 반영된다
  3. 캡처 직후 강제 종료해도 그 캡처가 유실되지 않음을 자동 테스트가 재현해서 증명한다
  4. 앱을 업데이트해도 사용자 개입 없이 저장소 스키마가 최신 버전으로 자동 이행된다
  5. 새 저장소 스키마에는 제거 대상 테이블(activity, issue, resume_card, repo_state, cal_event, review)이 처음부터 만들어지지 않는다
**Plans**: 7 plans (6 waves)

Plans:
- [ ] 01-01-PLAN.md — main/index.mjs를 lifecycle/ipc/jobs로 3분할 (동작 변경 없는 순수 리팩터, D-08)
- [ ] 01-02-PLAN.md — [tracer] main/store.mjs 개설 + 캡처→오늘 뷰 한 줄기 배선, 손상·상위버전·이행 전 백업
- [ ] 01-03-PLAN.md — 큐 재설계(시작 시 1회 반영)와 동기 즉시 반영·재시도·대기 건수 표시
- [ ] 01-04-PLAN.md — 살아남는 CRUD 전부와 축소된 아침 브리핑 이식
- [ ] 01-05-PLAN.md — IPC 위임을 store로 교체, 레거시 채널 스텁화·백그라운드 타이머 정리
- [ ] 01-06-PLAN.md — main/db.mjs·main/backup.mjs 삭제, pg를 devDependencies로 격하
- [ ] 01-07-PLAN.md — 캡처 직후 강제종료 스모크(두 프로세스 SIGKILL 하네스)

**Research flag**: yes — node:sqlite API(프라그마, 트랜잭션, 동시 접근)가 기존 쿼리 패턴을 충분히 커버하는지 스파이크로 먼저 확인한 뒤 저장소 재작성 전체를 맡길지 결정한다. 부족하면 같은 store.mjs 경계 뒤에서 better-sqlite3로 대체한다

### Phase 2: 레거시 기능 제거
**Goal**: `claude -p` 기반 AI 기능, git/GitHub/GitLab 수집, 캘린더 연동, Obsidian 볼트 출력, 포그라운드 창 추적을 화면·preload·IPC·모듈·설정·저장소·테스트 모든 계층에서 남김없이 제거한다.
**Depends on**: Phase 1
**Requirements**: RMV-01, RMV-02, RMV-03, RMV-04, RMV-05, RMV-06, RMV-07
**Success Criteria** (what must be TRUE):
  1. 재개 카드·인박스 AI 분류·완료 제안·주간 리뷰 화면과 그 뒤의 설정·IPC가 어디에도 남아 있지 않다
  2. 이슈 탭과 리포 상태 표시가 화면에서 사라지고, git/gh/glab를 호출하는 코드가 없다
  3. 오늘 뷰에서 일정 타임라인이 사라지고 캘린더 설정 항목이 없다
  4. 설정에 Obsidian 볼트 경로나 SQL 덤프 백업 옵션이 없다 (백업은 Phase 3의 JSON 내보내기가 대신한다)
  5. 캡처한 항목에 포그라운드 창 제목(context.fg)이 더 이상 기록되지 않고, 관련 PowerShell 워커도 없다
  6. 제거된 모듈명·IPC 채널명·설정 키를 코드베이스 전체에서 검색하면 0건이고, 남은 단위 테스트와 스모크가 통과한다
  7. 화면 문구·기본값·테스트 픽스처·README에 특정 프로젝트 약어·볼트 경로·DB 계정·캘린더 URL 같은 개인 흔적이 없다
**Plans**: TBD
**UI hint**: yes

### Phase 3: 내보내기·가져오기·이전
**Goal**: 사용자가 데이터를 스스로 소유해 내보내고 복원할 수 있게 하고, 작성자 본인의 기존 PostgreSQL 데이터를 새 저장소로 한 번에 옮긴다.
**Depends on**: Phase 1, Phase 2
**Requirements**: DATA-01, DATA-02, DATA-03, DATA-04
**Success Criteria** (what must be TRUE):
  1. 설정에서 전체 데이터(프로젝트·항목·대기·완료 이력)를 사람이 읽을 수 있는 JSON 파일 하나로 내보낼 수 있다
  2. 다른 PC의 앱에서 그 JSON을 가져오면 같은 상태로 복원되고, 내보내기→가져오기 왕복 자동 테스트가 통과한다
  3. 가져오기 직전 현재 데이터가 자동으로 백업되어, 잘못 가져와도 이전 상태로 되돌릴 수 있다
  4. 기존 PostgreSQL의 project·item·event 데이터를 새 저장소로 옮기는 스크립트가 행 수 일치·UTC 보존·context JSON 왕복·soft-delete 판정을 모두 통과하고, 공개 앱 UI에는 노출되지 않는다
**Plans**: TBD
**UI hint**: yes

### Phase 4: 첫 실행·플랫폼 대응
**Goal**: 설치 후 아무 설정 없이 캡처가 바로 되고, 단축키 재바인딩·로그인 시 자동 실행·알림 폴백·트레이 안내가 Windows와 macOS 실기기 양쪽에서 실제로 동작한다.
**Depends on**: Phase 1, Phase 2
**Requirements**: PLAT-01, PLAT-02, PLAT-03, PLAT-04, PLAT-05, PLAT-06
**Success Criteria** (what must be TRUE):
  1. 설치 후 첫 실행에 설정 화면 없이 단축키 캡처가 바로 동작한다
  2. 단축키 등록이 실패하면 사용자에게 알리고, 설정에서 다른 조합으로 바꾸면 그 조합의 등록 성공 여부까지 다시 확인한다
  3. 로그인 시 자동 실행 토글이 Windows와 미서명 macOS 실기기 양쪽에서 실제로 동작한다
  4. 아침 브리핑 알림이 권한 거부나 실패로 조용히 사라지지 않고 앱 안 표시로 대체된다
  5. 첫 실행에 트레이/메뉴바 아이콘 위치와 인박스 숫자키 분류를 OS별 문구로 한 번 안내한다
  6. macOS에서 메뉴바 상주(독 아이콘 없음)·글로벌 단축키·창 위치 기억·알림이 동작하고, OS 분기는 플랫폼 모듈(main/platform/*) 안에만 있다
**Plans**: TBD
**UI hint**: yes
**Research flag**: yes — macOS 실기기에서 Accessibility 권한과 무관하게 globalShortcut 등록이 조용히 실패하는지(`isRegistered()`가 true를 반환해도 실제로는 눌리지 않는 경우), 미서명 앱의 로그인 항목(`setLoginItemSettings`)이 실제로 켜지는지 실기기로 검증이 필요하다

### Phase 5: 이름·아이콘·릴리스
**Goal**: 앱이 WHENNOTE라는 이름과 아이콘으로 Windows·macOS 설치 파일을 새 공개 리포에서 배포하고, 작성자 본인이 새 버전으로 완전히 갈아타 일주일 실사용으로 완료를 확인한다.
**Depends on**: Phase 3, Phase 4
**Requirements**: NAME-01, NAME-02, NAME-03, REL-01, REL-02, REL-03, REL-04, REL-05, DONE-01
**Success Criteria** (what must be TRUE):
  1. 패키지명·productName·appId·설치 파일명·트레이 툴팁·창 제목·README가 모두 WHENNOTE를 쓴다
  2. 앱 데이터 폴더도 새 이름을 쓰고, 기존 whenwork 설정(단축키·창 위치·브리핑 시각)이 있으면 첫 실행에 한 번 가져온다
  3. 제공된 WHENNOTE 아이콘이 설치 파일·실행 파일·창·macOS Dock/dmg에 적용되고, 트레이/메뉴바에는 그로부터 파생한 단순 글리프가 작게 봐도 알아보이도록 표시된다
  4. 같은 electron-builder 설정에서 Windows NSIS와 macOS(arm64·x64) dmg·zip이 만들어지고, GitHub Actions가 두 OS를 빌드해 GitHub Releases에 자동으로 올린다
  5. README에 스크린샷과 함께 미서명 우회 절차(Windows SmartScreen, macOS Gatekeeper)가 있고, 실제 브라우저로 내려받은 파일로 검증되어 있다
  6. 공개 리포는 새 저장소·새 히스토리에서 시작해 비밀(토큰·계정) 스캔을 통과하고, 패키징된 설치본 스모크 테스트가 Windows·macOS 모두 통과한다
  7. 작성자가 새 버전으로 완전히 갈아타 개인용 설치본과 docker DB를 끈 채 일주일 사용해도 불편이 없다
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. 내장 저장소 전환 | 0/7 | Planned | - |
| 2. 레거시 기능 제거 | 0/TBD | Not started | - |
| 3. 내보내기·가져오기·이전 | 0/TBD | Not started | - |
| 4. 첫 실행·플랫폼 대응 | 0/TBD | Not started | - |
| 5. 이름·아이콘·릴리스 | 0/TBD | Not started | - |
