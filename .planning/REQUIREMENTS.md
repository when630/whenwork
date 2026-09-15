# Requirements: WHENWORK

**Defined:** 2026-09-14
**Core Value:** 설치 파일 하나를 받아 실행한 사람이, 다른 것을 아무것도 깔지 않고, 단축키로 던진 할 일을 절대 잃지 않는다.

## v1 Requirements

이번 마일스톤에서 만들 것. 각 항목은 로드맵 단계에 매핑된다.

### 저장소 (STOR)

- [x] **STOR-01**: 앱은 외부 DB·컨테이너 없이 앱 데이터 폴더 안의 내장 저장소(단일 파일)에 프로젝트·항목·이벤트를 저장한다
- [x] **STOR-02**: 캡처는 저장소 상태와 무관하게 절대 실패하지 않는다. 저장소 쓰기가 실패하면 로컬 큐 폴백에 남고 다음 실행 시 자동 반영된다
- [x] **STOR-03**: 캡처 직후 앱을 강제 종료해도 그 캡처는 유실되지 않는다. 이를 재현하는 자동 테스트가 있다
- [x] **STOR-04**: 저장소 스키마에 버전이 있고, 앱 업데이트 시 사용자 개입 없이 자동 마이그레이션된다
- [x] **STOR-05**: 저장소는 제거되는 기능의 테이블(activity, issue, resume_card, repo_state, cal_event, review)을 만들지 않는다

### 내보내기·가져오기·이전 (DATA)

- [ ] **DATA-01**: 사용자는 설정에서 전체 데이터(프로젝트·항목·대기·완료 이력)를 사람이 읽을 수 있는 JSON 파일 하나로 내보낼 수 있다
- [ ] **DATA-02**: 사용자는 내보낸 JSON을 다른 PC의 앱에서 가져와 같은 상태를 복원할 수 있다. 내보내기→가져오기 왕복 테스트가 있다
- [ ] **DATA-03**: 가져오기 직전 현재 데이터가 자동으로 백업되어 잘못 가져와도 되돌릴 수 있다
- [ ] **DATA-04**: 기존 PostgreSQL 데이터(project·item·event)를 새 저장소로 한 번 옮기는 스크립트가 있다. 행 수 비교, 타임존(UTC) 보존, context JSON 왕복, soft-delete 필터 판정을 통과한다. 공개 앱 UI에는 노출되지 않는다(작성자 전용)

### 제거 (RMV)

- [ ] **RMV-01**: `claude -p` 의존과 재개 카드·인박스 AI 분류·완료 제안·주간 리뷰가 UI·preload·IPC·모듈·설정·저장소·테스트 모든 계층에서 제거된다
- [ ] **RMV-02**: git·gh·glab 수집기, 이슈 탭, 리포 상태 추적이 제거된다
- [ ] **RMV-03**: Apps Script 캘린더 연동과 오늘 뷰의 일정 타임라인이 제거된다
- [ ] **RMV-04**: Obsidian 볼트 출력과 SQL 덤프 백업이 제거된다(백업은 JSON 내보내기가 대신한다)
- [ ] **RMV-05**: 캡처 시점 포그라운드 창 제목 추적(context.fg, PowerShell 워커)이 완전히 삭제된다
- [ ] **RMV-06**: 제거된 모듈명·IPC 채널명·설정 키가 코드베이스 전체에서 grep 0건이고, 남은 단위 테스트와 스모크가 통과한다
- [ ] **RMV-07**: 화면 문구·기본값·테스트 픽스처·문서에서 개인 흔적(특정 프로젝트 약어, 볼트 경로, DB 계정, 캘린더 URL)이 제거된다

### 첫 실행·플랫폼 (PLAT)

- [ ] **PLAT-01**: 설치 후 첫 실행에 아무 설정 화면 없이 단축키 캡처가 바로 동작한다
- [ ] **PLAT-02**: 단축키 등록이 실패하면 사용자에게 알리고, 설정에서 다른 조합으로 바꿀 수 있다(재바인딩). 바꾼 조합도 등록 성공 여부를 확인한다
- [ ] **PLAT-03**: 설정에 로그인 시 자동 실행 토글이 있고, Windows와 미서명 macOS 빌드 실기기에서 실제로 동작함을 확인한다
- [ ] **PLAT-04**: 아침 브리핑 알림이 권한 거부나 실패로 표시되지 않으면 앱 안 표시로 대체되어 조용히 사라지지 않는다
- [ ] **PLAT-05**: 첫 실행에 트레이 아이콘 위치(OS별 문구)와 인박스 숫자키 분류를 한 번 안내한다
- [ ] **PLAT-06**: macOS에서 메뉴바 상주(독 아이콘 없음), 글로벌 단축키, 창 위치 기억, 알림이 동작한다. OS 분기는 플랫폼 모듈 안에 있고 호출부에 흩어지지 않는다

### 이름 (NAME)

- [ ] **NAME-01**: 앱 이름은 WHENWORK를 유지한다(2026-09-15 개명 철회). 패키지명, productName, appId, 설치 파일명, 트레이 툴팁, 창 제목, README와 문서가 일관되게 WHENWORK를 쓰고 다른 이름 언급이 남지 않는다
- [ ] **NAME-02**: 앱 데이터 폴더는 기존 `whenwork` 그대로 쓰고, 기존 설정 파일(단축키·창 위치·브리핑 시각)은 새 버전 첫 실행에서 그대로 이어진다
- [ ] **NAME-03**: 앱 아이콘이 제공된 WHENWORK 아이콘(`assets/icon/whenwork.png`, 1254×1254 RGBA — 파란 그라데이션 원형 시계에 체크 마크, 투명 배경)으로 바뀐다. 설치 파일·실행 파일·창·macOS Dock/dmg에 적용되고, `tools/make-icon.mjs`의 픽셀아트 생성이 이를 덮어쓰지 않는다. 트레이 아이콘은 같은 아이콘에서 파생한 단순 글리프(16·32px, macOS는 템플릿 이미지)로 작게 봐도 알아볼 수 있다

### 릴리스 (REL)

- [ ] **REL-01**: Windows 설치 파일(NSIS)과 macOS 설치 파일(dmg·zip, arm64와 x64 개별)이 같은 electron-builder 설정에서 빌드된다
- [ ] **REL-02**: GitHub Actions가 두 OS에서 빌드해 GitHub Releases에 자동으로 올린다
- [ ] **REL-03**: README에 미서명 첫 실행 우회(Windows SmartScreen "추가 정보 → 실행", macOS Gatekeeper "손상됨" 해제)가 스크린샷과 함께 있고, 실제 브라우저로 내려받은 파일로 절차를 검증했다
- [ ] **REL-04**: 공개 리포는 새 저장소·새 히스토리에서 시작하고, 공개 전 비밀(토큰·계정) 스캔을 통과한다
- [ ] **REL-05**: 패키징된 설치본에서 스모크 테스트가 Windows·macOS 모두 통과한다

### 완료 판정 (DONE)

- [ ] **DONE-01**: 작성자가 새 버전으로 갈아타고 개인용 설치본과 docker DB를 끈 채 일주일 사용해도 불편이 없다

## v2 Requirements

다음 릴리스로 미룬다. 추적하되 이번 로드맵에는 없다.

### 신뢰·배포

- **TRUST-01**: 코드 서명·공증(Apple Developer, Windows 인증서)
- **TRUST-02**: 자동 업데이트(서명이 먼저다)

### 편의

- **CONV-01**: CSV 읽기 전용 내보내기(엑셀용)
- **CONV-02**: 영어 UI(i18n)
- **CONV-03**: Linux 빌드

## Out of Scope

명시적으로 제외. 범위 확장을 막기 위해 기록한다.

| Feature | Reason |
|---------|--------|
| AI 기능(재개 카드·AI 분류·완료 제안·주간 리뷰), API 키 방식 포함 | Claude 구독·CLI 전제가 "누구나"에 어긋난다. 수동 분류가 신뢰 면에서 오히려 장점. 개인용은 태그 `v-personal`로 보존 |
| git·GitHub·GitLab 수집 | 비개발자에게 쓸모 없고 CLI 설치·인증을 요구한다 |
| 캘린더 연동(Apps Script·OAuth) | 개인 Workspace 제약에 맞춘 해법. 표준 OAuth는 검증·서명 비용이 크다 |
| Obsidian 볼트 출력, 주간 리뷰(목록형 포함) | 주간 리뷰가 빠지면 쓸 자리가 없다. 사용자가 남길 기능에서 고르지 않았다 |
| 멀티 디바이스 동기화·계정 | 1인 1PC 유지. 내보내기·가져오기가 수동 이동을 대신한다 |
| 사람이 직접 편집하는 파일 저장(JSON/Markdown) | 동시 수정·손상을 앱이 감당해야 한다. 내장 저장소 + 내보내기로 대신 |
| 다른 GTD 앱 형식 가져오기(Todoist CSV 등) | 상용 앱 사이에도 드문 기능. 유지 부담이 크다 |
| 하위 작업·중첩 프로젝트 | 평면 모델(항목·프로젝트·대기·인박스) 유지. 렌더러 비대화를 키운다 |
| 팀·공유·권한 | 원 설계의 전면 배제 유지 |
| 포그라운드 창 컨텍스트의 크로스플랫폼 포팅 | macOS 화면 녹화 권한이 필요해 미서명 앱과 충돌. 삭제로 결정 |

## Traceability

어느 단계가 어느 요구사항을 다루는지. 로드맵 작성 시 채운다.

| Requirement | Phase | Status |
|-------------|-------|--------|
| STOR-01 | Phase 1 | Complete |
| STOR-02 | Phase 1 | Complete |
| STOR-03 | Phase 1 | Complete |
| STOR-04 | Phase 1 | Complete |
| STOR-05 | Phase 1 | Complete |
| DATA-01 | Phase 3 | Pending |
| DATA-02 | Phase 3 | Pending |
| DATA-03 | Phase 3 | Pending |
| DATA-04 | Phase 3 | Pending |
| RMV-01 | Phase 2 | Pending |
| RMV-02 | Phase 2 | Pending |
| RMV-03 | Phase 2 | Pending |
| RMV-04 | Phase 2 | Pending |
| RMV-05 | Phase 2 | Pending |
| RMV-06 | Phase 2 | Pending |
| RMV-07 | Phase 2 | Pending |
| PLAT-01 | Phase 4 | Pending |
| PLAT-02 | Phase 4 | Pending |
| PLAT-03 | Phase 4 | Pending |
| PLAT-04 | Phase 4 | Pending |
| PLAT-05 | Phase 4 | Pending |
| PLAT-06 | Phase 4 | Pending |
| NAME-01 | Phase 5 | Pending |
| NAME-02 | Phase 5 | Pending |
| NAME-03 | Phase 5 | Pending |
| REL-01 | Phase 5 | Pending |
| REL-02 | Phase 5 | Pending |
| REL-03 | Phase 5 | Pending |
| REL-04 | Phase 5 | Pending |
| REL-05 | Phase 5 | Pending |
| DONE-01 | Phase 5 | Pending |

**Coverage:**

- v1 requirements: 31 total
- Mapped to phases: 31
- Unmapped: 0 ✓

---
*Requirements defined: 2026-09-14*
*Last updated: 2026-09-14 after roadmap creation (traceability filled)*
