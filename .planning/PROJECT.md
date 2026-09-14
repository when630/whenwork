# WHENWORK — 누구나 쓰는 퀵캡처 트레이 앱

## What This Is

WHENWORK는 생각난 할 일을 글로벌 단축키 한 번으로 던져 두고, 오늘 볼 것만 한 화면에서 보는 트레이 상주 앱이다. 지금까지는 1인 개발자인 나의 환경(PostgreSQL·Docker, Claude CLI, git·gh·glab, Apps Script 캘린더, Obsidian 볼트)에 맞춘 개인용이었다. 이번 작업은 그 의존성과 과한 기능을 걷어내고, 비개발자를 포함한 한국어 사용자 누구나 설치 파일 하나로 쓰는 공개 앱으로 다시 세우는 일이다.

## Core Value

**설치 파일 하나를 받아 실행한 사람이, 다른 것을 아무것도 깔지 않고, 단축키로 던진 할 일을 절대 잃지 않는다.**

캡처 손실 제로가 원래의 제1목적이었고(설계 v2.16 §1), 이번에는 그 앞에 "아무 준비 없이"가 붙는다. 다른 모든 것이 실패해도 이것은 지켜야 한다.

## Requirements

### Validated

기존 코드가 이미 하고 있고 실사용으로 확인된 것. 이번 작업에서도 그대로 남는다.

- ✓ 트레이 상주 + 글로벌 단축키(기본 Ctrl+Alt+Space)로 원라인 퀵캡처 창을 띄운다 — M1, 설치본 실사용
- ✓ 캡처는 로컬 append-only 큐에 먼저 쓰고 저장소가 죽어 있어도 잃지 않는다 — M1 (`main/queue.mjs`)
- ✓ `#약어`로 캡처 시점에 프로젝트를 지정할 수 있고, 없으면 인박스로 간다 — M1, `98b3cc5`에서 복구
- ✓ 오늘 뷰: 지연·오늘 마감·예정·인박스를 프로젝트 횡단으로 한 화면에, 키보드 중심 조작 — M1, 12.4절
- ✓ 프로젝트 CRUD와 순서 변경(Shift+↑↓) — `11f2a51`, `ef3fff1`
- ✓ 인박스 항목을 숫자 키로 프로젝트에 배정(다이렉트 분류) — `218ce2e`
- ✓ 대기(waiting-for) 추적: 요청해 두고 회신을 기다리는 항목을 따로 본다 — M3
- ✓ 마감 자연어 파싱("내일", "금요일") — `main/parse.mjs`
- ✓ 아침 브리핑: 설정 시각 이후 하루 한 번, 지연·오늘 마감·오래된 대기·인박스 건수를 한 줄 알림으로. 급한 것이 없으면 열린 할 일 수를 대신 말한다 — 오픈이슈 #3, 12.8절
- ✓ 창 위치 기억, 드래그 이동, 투명 라운드 창 — `701ab00`, `6c0b4ab`
- ✓ 사용자 행동을 이벤트로 남겨 KPI를 셀 수 있다 — `db.logEvent`
- ✓ Windows NSIS 설치본으로 빌드·설치·상주 — `113872f`

### Active

이번 마일스톤에서 만들 것. 검증 전까지는 가설이다.

- [ ] 외부 서비스·CLI·컨테이너 없이 설치 파일 하나로 실행된다 (PostgreSQL·Docker 의존 제거, 앱이 관리하는 내장 저장소로 교체)
- [ ] 저장소가 바뀌어도 로컬 큐 → 저장소 흐름과 "캡처는 절대 실패하지 않는다" 보장은 유지된다
- [ ] 사용자는 설정에서 데이터 전체를 사람이 읽을 수 있는 형식으로 내보내고, 다시 가져올 수 있다 (데이터 소유는 내보내기로)
- [ ] 기존 PostgreSQL의 프로젝트·항목·대기 데이터를 새 저장소로 한 번 옮기는 이전 경로가 있다 (나 자신의 이전용. 공개판 사용자에게는 보이지 않아도 된다)
- [ ] `claude -p` 의존과 그에 얹힌 기능(재개 카드, 인박스 AI 분류, 완료 제안, 주간 리뷰 초안)이 코드에서 제거된다
- [ ] git·gh·glab 수집기와 이슈 탭, 리포 상태 추적이 제거된다
- [ ] Apps Script 캘린더 연동과 오늘 뷰의 일정 타임라인이 제거된다
- [ ] Obsidian 볼트 출력이 제거된다
- [ ] Windows 전용 코드(PowerShell 포그라운드 창 제목 추적 등)가 제거되거나 OS별로 갈라져, macOS에서도 트레이·단축키·창 위치가 동작한다
- [ ] Windows와 macOS 설치 파일이 GitHub Releases에 함께 올라간다 (미서명. README에 SmartScreen·Gatekeeper 우회 방법 안내)
- [ ] 첫 실행에 아무 설정 없이 캡처가 되고, 단축키 충돌 시 사용자가 바꿀 수 있다
- [ ] 화면 문구·설정·README가 "내 환경"을 전제하지 않는다 (특정 프로젝트 약어, 볼트 경로, DB 계정 같은 개인 흔적 제거)
- [ ] 남은 기능의 단위 테스트가 통과하고 스모크(`npm run smoke`)가 두 OS 빌드에서 돈다
- [ ] 내가 새 버전으로 완전히 갈아타고 개인용 설치본을 꺼도 불편이 없다 (완료 판정)

### Out of Scope

- **AI 기능 전반(재개 카드·AI 분류·완료 제안·주간 리뷰)** — Claude 구독과 CLI 로그인을 전제로 해 "누구나"에 어긋난다. API 키 방식으로 되살리는 것도 이번에는 하지 않는다. 필요하면 태그 `v-personal`에서 되살린다
- **git·GitHub·GitLab 수집** — 비개발자에게 쓸모가 없고 CLI 설치·인증을 요구한다. 개발자용 확장은 다음 마일스톤 후보
- **캘린더 연동** — 내 Workspace 제약에 맞춘 Apps Script 해법이라 일반화되지 않는다. 표준 OAuth 연동은 서명·검증 비용이 커 범위 밖
- **Obsidian 볼트 출력** — 주간 리뷰가 빠지면 쓸 자리가 없다
- **주간 리뷰(AI 없는 목록형 포함)** — 사용자가 남길 기능에서 고르지 않았다
- **영어 UI / i18n** — 한국어 사용자만 대상으로 한다. 문자열 리소스 분리도 하지 않는다
- **코드 서명·공증** — 비용(Apple $99/년)과 CI 파이프라인이 범위를 넘는다. 미서명 배포 + README 안내로 대신한다
- **Linux 빌드** — 트레이·글로벌 단축키가 데스크톱 환경별로 갈려 검증 비용이 크다
- **자동 업데이트** — 미서명 상태에서는 반쪽이라 다음에 검토한다
- **멀티 디바이스 동기화·충돌 해결** — 1인 1PC 전제는 유지한다. 내보내기·가져오기가 수동 이동을 대신한다
- **팀·공유·권한** — 원래 설계의 전면 배제 유지
- **사람이 직접 편집하는 파일 저장(JSON/Markdown)** — 동시 수정·손상을 앱이 감당해야 해서 내장 저장소 + 내보내기로 대신한다

## Context

- **현 상태**: 설계 v2.16(`docs/01_설계.md`) 기준 M1·M2·M3 구현 완료, 오픈이슈 #1~#6 전부 닫힘. 단위 테스트 187건·스모크 통과. `%LOCALAPPDATA%\Programs\WHENWORK\WHENWORK.exe` 설치본으로 실사용 중. DB는 docker `whenwork-db`(5433).
- **코드베이스 맵**: `.planning/codebase/` 7개 문서(2026-09-14). 주요 우려: `main/index.mjs` 1479줄·`renderer/today.js` 1854줄 비대화, 큐 drain의 읽기-쓰기 사이 경합, `main/db.mjs`·`main/issues.mjs` 테스트 부재, 설정 파일 평문 토큰. 이번 작업에서 issues·calendar·ai·vault·collect·repo 모듈이 통째로 빠지므로 비대화는 상당 부분 자연 해소된다. 큐 원자성은 저장소 교체 때 함께 본다.
- **도그푸딩에서 배운 것**: 자동으로 도는 것은 "실패했을 때 드러나는가, 입력이 비었을 때도 할 말이 있는가"로 본다(12.8절). 자동으로 채워지는 필드는 한 건이 아니라 분포로 검증한다(12.9절). 캡처가 안 쓰이는 원인은 기능 바깥(아침에 앱을 열 이유)에 있었다. 브리핑 폴백은 남는 기능이라 이 교훈이 그대로 적용된다.
- **설정 파일 함정**: `settings.json`을 PowerShell로 쓰면 BOM이 붙어 앱이 빈 설정으로 출발한다. 이전 스크립트는 Node로 쓴다.
- **기존 저장 스키마**: item·project·event 테이블이 남을 핵심. activity·issue·resume_card·repo_state·cal_event·review는 제거 대상. 이전 시 item.context(포그라운드 창 제목)는 옮기되 새 캡처에서는 OS별로 갈린다.
- **렌더러는 프레임워크 없는 vanilla JS + `renderer/tokens.css`**. Pretendard 번들. 그대로 유지.

## Constraints

- **Tech stack**: Electron + vanilla JS 유지 — 이미 돌아가는 UI를 다시 쓰지 않는다. 저장소만 교체한다
- **저장소**: 네이티브 모듈이 필요하면 Windows·macOS 두 빌드에서 electron-builder 리빌드가 깨지지 않아야 한다. 형태 선택은 리서치에서 결정
- **배포**: GitHub Releases, 미서명. 설치 파일 외에 사용자가 받아야 할 것이 없어야 한다
- **플랫폼**: Windows 11 + macOS. 두 OS에서 트레이·글로벌 단축키·알림·창 위치 기억이 검증되어야 한다. macOS 검증 장비 확보가 전제
- **언어**: 한국어 UI 하나
- **데이터 이전**: 나의 기존 PostgreSQL 데이터를 잃지 않는다. 이전 후 개인용 코드는 태그로 보존한다
- **테스트**: 남는 기능의 기존 테스트는 계속 통과해야 하고, 새로 넣는 스모크·테스트는 고친 코드를 되돌려 실패를 확인한다

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 네 의존성(PostgreSQL·Docker, `claude -p`, 개인 연동, git·gh·glab)을 전부 제거 | "누구나"의 기준을 비개발자로 두면 어느 하나도 남길 수 없다 | — Pending |
| 핵심은 단축키 캡처 + 오늘 뷰. 대기·인박스 손 분류·아침 브리핑은 남기고 주간 리뷰는 버림 | 의존성 없이 성립하고 실사용에서 쓰인 것만 남긴다 | — Pending |
| 저장은 앱이 관리하는 내장 저장소 + 내보내기·가져오기 | 사람이 편집하는 파일은 손상·충돌을 앱이 감당해야 한다. 소유는 내보내기로 충분 | — Pending |
| Windows + macOS 동시 릴리스, Linux 제외 | 비개발자 대상이면 macOS를 뺄 수 없다. Linux는 트레이 환경 편차가 크다 | — Pending |
| 미서명 배포 + README 우회 안내 | 초기 공개에서 비용 0. 서명은 다음 마일스톤 검토 | — Pending |
| 한국어 UI 하나 | i18n은 날짜 파싱까지 번지는 큰 작업. 대상 사용자를 좁혀 시작한다 | — Pending |
| 나도 새 버전으로 옮기고 기존 데이터를 이전 | 두 버전 공존은 수정을 양쪽에 해야 한다. 완료 판정도 "내가 갈아타도 불편이 없다" | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-14 after initialization*
