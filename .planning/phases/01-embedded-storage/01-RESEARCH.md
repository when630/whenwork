# Phase 1: 내장 저장소 전환 - Research

**Researched:** 2026-09-14
**Domain:** Electron 메인 프로세스 구조 정리(순수 리팩터) + `node:sqlite` 기반 내장 단일 파일 저장소로의 교체
**Confidence:** HIGH (스파이크로 직접 실행 검증) / MEDIUM (SQLite 세부 동시성·손상 시나리오는 이 세션에서 확인한 범위 내)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**캡처 쓰기 경로와 큐의 역할**
- **D-01:** 캡처는 지금처럼 `queue.append`(동기 `appendFileSync`)로 먼저 남기고, 같은 호출 흐름에서 `store.insertCaptures`를 동기로 즉시 시도한다. 큐 append는 fs만 의존해 store가 어떤 이유로든 못 열려도 실패하지 않는다. 30초 주기 `flush` 타이머는 없앤다. — **Reversibility:** costly — 캡처 경로(`capture:save`, `capture:followUp`)와 트레이 pending 표시, 스모크 프로브가 모두 이 순서를 전제로 다시 짜인다.
- **D-02:** 큐 파일은 실행 중에는 줄을 지우지 않는다(append-only). 시작 시 `queue.jsonl`을 rename으로 옆에 치우고(새 캡처는 새 파일로), 치운 파일을 전부 store에 반영(`INSERT OR IGNORE`, item.id 멱등)한 뒤 삭제한다. 현 `drain`의 읽기-쓰기 사이 경합(CONCERNS.md)은 이 구조로 사라진다. 하루 종일 안 끈 경우 큐가 수백 줄까지 자라는 것은 허용한다.
- **D-03:** 실행 중 store 즉시 반영이 throw하면 store를 닫고 다시 열어 한 번 더 시도한다. 그래도 실패하면 캡처 창은 평소처럼 "저장됨"을 보이고, 트레이 툴팁과 오늘 뷰 상단에 "N건이 기다리고 있어요 — 다시 시작하면 반영됩니다" 류의 대기 건수 표시를 한다. 지금 'DB 대기' 툴팁 자리를 그대로 쓴다. OS 알림은 띄우지 않는다.
- **D-04:** STOR-03(캡처 직후 강제 종료 시 유실 없음)은 `electron --smoke` 안에서 검증한다: 실제 앱 프로세스로 캡처를 보내고 외부에서 kill → 재기동 → 오늘 뷰 상태에 그 캡처가 있는지 검사. 이 스모크는 두 OS 빌드에서 돌아야 한다(REL-05와 연결). 새 테스트는 프로젝트 제약대로 고친 코드를 되돌려 실패를 확인한다.

**전환 기간의 레거시 기능 처리**
- **D-05:** `main/db.mjs`와 pg 풀은 Phase 1에서 삭제한다. `store.mjs`는 살아남는 함수(insertCaptures·getViewState·getProjects·프로젝트 CRUD·완료/취소·프로젝트 배정·마감·대기 전환·재촉·메모·이름 변경·소프트 삭제/복구/purge·getInbox·getHistory·briefing·logEvent)만 구현한다. 두 저장소가 공존하는 기간은 없다. — **Reversibility:** one-way — 삭제 후에는 PG 경로로 되돌릴 수 없고, 개인용 코드는 태그(`v-personal`)로만 보존된다.
- **D-06:** 레거시 IPC 핸들러(issue:*, resume:*, review:*, calendar:*, backup:*, inbox:classify, item:doneSuggest* 등)는 삭제하지 않고 무해한 스텁으로 둔다: 빈 배열·`{ ok: false }` 같은 값을 돌려주고 아무것도 쓰지 않는다. 관련 백그라운드 타이머(수집·캘린더·백업·리뷰·카드 프리웜)는 끈다. 앱은 뜨고 캡처·오늘 뷰·프로젝트·대기·인박스·브리핑은 완전히 동작하되 이슈 탭 등은 빈 화면이다. Phase 2가 스텁과 UI를 걷어낸다.
- **D-07:** `pg`는 `dependencies`에서 `devDependencies`로 옮긴다. 앱 런타임 import는 0건이어야 하고, Phase 3의 `tools/` 이전 스크립트만 쓴다. electron-builder가 devDependencies를 패키징하지 않으므로 설치본에 실리지 않는다. Phase 3 끝에 완전 제거.
- **D-08:** `main/index.mjs`는 리서치안대로 `main/lifecycle.mjs`(앱 수명·트레이·창·단축키·위치 기억), `main/ipc.mjs`(모든 `ipcMain` 핸들러), `main/jobs.mjs`(타이머·백그라운드 작업)로 3분할한다. 순수 이동이어야 하며, 분할 커밋 전후로 `npm test`와 `npm run smoke`가 동일하게 통과해야 한다. 저장소 교체는 분할이 끝난 뒤 별도 커밋으로 한다.
- **D-09:** `main/backup.mjs`와 `test/backup.test.mjs`는 Phase 1에서 함께 삭제한다(RMV-04의 일부 선행). 설정 UI의 백업 버튼은 D-06 스텁 처리. 대신 `store.mjs`에 "스키마가 만드는 테이블은 project·item·event 세 개뿐"을 검증하는 가드 테스트를 넣어 STOR-05를 증명한다.

**새 스키마의 형태**
- **D-10:** `timestamptz` 계열(captured_at·done_at·nudged_at·deleted_at·event.at)은 ISO 8601 UTC 문자열 TEXT(`2026-09-14T03:00:00.000Z`)로, `due`는 타임존 없는 `YYYY-MM-DD` TEXT로 저장한다. 사전순 정렬이 시간순과 일치해야 하고, JSON 내보내기(Phase 3)와 PG 이전에서 변환 없이 지나간다. — **Reversibility:** one-way — 저장 형식 변경은 데이터 마이그레이션과 내보내기 포맷 변경을 동반한다.
- **D-11:** item의 AI·이슈용 칼럼(suggested_project_id, issue_url, done_suggested_at, done_suggest_why, done_suggest_muted_at)과 project.repo_paths는 새 스키마에 처음부터 만들지 않는다. `store.getViewState`가 이 필드를 돌려주지 않아도 렌더러가 undefined를 falsy로 처리해 깨지지 않는지 스모크로 확인한다. Phase 3 이전 스크립트는 이 칼럼을 읽지 않는다. `item.context`(JSON)는 과거 fg·meeting 값 이전용으로 TEXT(JSON 직렬화)로 남긴다.
- **D-12:** 스키마 버전은 `PRAGMA user_version` + 순차 마이그레이션 배열로 관리한다. 시작 시 현재 버전을 읽고 다음 버전부터 마지막까지 각각 트랜잭션으로 적용한다. 새 DB도 v1부터 차례로 올라가 경로가 하나다. 한 번 배포된 마이그레이션은 수정하지 않는다. — **Reversibility:** costly — 배포 후 마이그레이션 체계를 바꾸면 이미 설치된 사용자의 DB마다 버전 해석이 달라진다.
- **D-13:** 앱이 자신보다 높은 `user_version`의 DB를 만나면(구버전으로 되돌린 사용자) store를 열지 않고 오늘 뷰에 "새 버전으로 만든 데이터입니다. 앱을 업데이트해 주세요" 안내를 표시한다. 캡처는 큐에 남아 업데이트 후 반영된다. 모르는 스키마에 쓰지 않는다.

**저장소 파일 운영**
- **D-14:** DB 파일은 `app.getPath('userData')/store.sqlite` — settings.json·queue.jsonl 옆이다. 이름에 앱 이름을 넣지 않아 Phase 5 개명(NAME-02) 때 파일명은 건드리지 않는다.
- **D-15:** 시작 시 열기 실패나 `PRAGMA integrity_check` 실패가 SQLITE_CORRUPT·SQLITE_NOTADB 같은 진짜 손상일 때만 `store.corrupt-{ISO시각}.sqlite`로 rename하고 빈 DB로 시작한 뒤 오늘 뷰에 "이전 데이터 파일이 손상되어 보관해 두었습니다" 안내를 표시한다. 잠김·권한·디스크 오류에서는 절대 이동하지 않는다(건강한 DB를 옆으로 밀지 않기 위해). 그 경우는 D-03의 대기 표시 경로를 탄다.
- **D-16:** `user_version`이 실제로 오를 때만 마이그레이션 직전에 `userData/backups/store-v{이전버전}-{YYYYMMDD}.sqlite`로 파일을 복사하고 최근 몇 개만 남긴다(보관 개수는 Claude 재량). 백업 실패는 이행을 막지 않는다. Phase 3의 가져오기 직전 자동 백업(DATA-03)이 같은 폴더·명명 관례를 쓴다.
- **D-17:** `PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`. 앱 종료 시 `wal_checkpoint(TRUNCATE)`로 -wal을 본 파일에 합쳐 사용자가 `store.sqlite` 하나만 복사해도 온전하게 한다.

### Claude's Discretion
- node:sqlite 스파이크의 합격 기준과 better-sqlite3로 갈아탈 판정 조건(같은 `store.mjs` 경계 뒤에서 교체한다는 원칙만 고정)
- `store.mjs` 단위 테스트 범위(임시 파일 DB로 살아남는 함수 전부 + 마이그레이션 v0→vN + STOR-05 가드가 최소선). STOR-03 단위 수준 재현 테스트는 사용자가 스모크만 선택했으므로 추가는 재량
- 테이블 DDL 세부(인덱스, `PRAGMA foreign_keys`, item.project_id FK 동작, event.id 정수 autoincrement 유지 여부)
- 스텁 IPC의 정확한 반환 형태, 스모크가 검사할 오늘 뷰 상태 목록, 마이그레이션 배열의 파일 배치
- 백업 보관 개수, 큐 rename 파일의 이름 규칙, 대기 건수·손상·구버전 안내 문구의 최종 표현(의미는 D-03·D-13·D-15 고정)

### Deferred Ideas (OUT OF SCOPE)
- **매일 store 파일 복사 백업**: 백업 대체 수단으로 논의됐으나 RMV-04 결정(백업은 JSON 내보내기가 대신)과 충돌해 채택하지 않음. 필요하면 Phase 3에서 JSON 내보내기의 자동 실행으로 검토
- **STOR-03의 node --test 수준 자식 프로세스 SIGKILL 테스트**: 사용자는 스모크 방식을 택했다. 단위 수준 재현은 Claude 재량으로 남김
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| STOR-01 | 앱은 외부 DB·컨테이너 없이 앱 데이터 폴더 안의 내장 저장소(단일 파일)에 프로젝트·항목·이벤트를 저장한다 | `node:sqlite`(`DatabaseSync`)는 Electron 43.3.0이 내장한 Node 24.18.1에서 추가 설치·네이티브 빌드 없이 로드됨을 이 세션에서 직접 실행 검증(스파이크 로그 하단). `store.sqlite` 단일 파일 + WAL이 D-14/D-17을 만족 |
| STOR-02 | 캡처는 저장소 상태와 무관하게 절대 실패하지 않는다. 저장소 쓰기가 실패하면 로컬 큐 폴백에 남고 다음 실행 시 자동 반영된다 | D-01(큐 선기록 + 동기 즉시 반영) + D-03(재시도 후 실패는 대기 표시)의 조합. `main/queue.mjs`의 기존 `append()`/`readAll()`은 그대로 재사용 가능(Reusable Assets) |
| STOR-03 | 캡처 직후 앱을 강제 종료해도 그 캡처는 유실되지 않는다. 이를 재현하는 자동 테스트가 있다 | D-04의 `electron --smoke` 확장 설계 — 아래 "Architecture Patterns > Pattern: 강제종료 스모크 하네스" 참고. Node `subprocess.kill('SIGKILL')`이 Windows·POSIX 모두에서 무조건 강제 종료로 동작함을 Node 공식 문서로 확인(OS별 분기 불필요) |
| STOR-04 | 저장소 스키마에 버전이 있고, 앱 업데이트 시 사용자 개입 없이 자동 마이그레이션된다 | D-12/D-13. `PRAGMA user_version`은 이 세션에서 읽기/쓰기 모두 스파이크로 확인. SQLite에는 `ALTER TABLE ADD COLUMN IF NOT EXISTS`가 없음(공식 문서) — 순번 마이그레이션 배열이 필수 |
| STOR-05 | 저장소는 제거되는 기능의 테이블(activity, issue, resume_card, repo_state, cal_event, review)을 만들지 않는다 | D-05/D-09. 새 `SCHEMA`가 `project`/`item`/`event`만 만들도록 하고, 기존 `test/backup.test.mjs`의 "EXPORT_TABLES ↔ schemaTables 대조" 패턴을 스키마 가드 테스트로 이어받는다(아래 Code Examples) |
</phase_requirements>

## Summary

이번 페이즈의 리서치 질문은 사실상 하나로 좁혀진다: `node:sqlite`가 이 앱의 실제 쿼리 패턴(프라그마·트랜잭션·동시 접근·손상 감지)을 감당하는가. 답은 **예**다. 이 세션에서 프로젝트에 실제로 설치된 Electron(`node_modules/electron` 43.3.0, 부트되는 Node 24.18.1, SQLite 3.53.1 — 사전 리서치 문서가 적어둔 43.2.0/24.17.0보다 한 단계 최신이다)을 `ELECTRON_RUN_AS_NODE=1`로 직접 실행해 `DatabaseSync`를 열고, D-12~D-17이 요구하는 모든 프라그마·트랜잭션·동시 잠금·손상 파일 시나리오를 실제로 실행했다. 전부 예상대로 동작했고 `ExperimentalWarning`도 출력되지 않았다(스파이크 로그와 재현 방법은 "Code Examples > 스파이크 실행 로그" 참고). 이로써 이 페이즈의 Research flag가 요구한 "스파이크 선행 확인"은 **통과**로 판정하며, better-sqlite3 폴백 경로는 이번 페이즈에서 채택하지 않는다.

두 번째로 큰 발견은 `main/db.mjs`의 "살아남는 함수" 중 `briefing()`이 겉보기보다 훨씬 크게 잘려나가야 한다는 점이다. D-05는 `briefing`을 살아남는 함수 목록에 넣었지만, 현재 구현은 제거 대상 테이블(`issue`, `activity`, `repo_state`)과 제거 대상 칼럼(`done_suggested_at`)에 깊이 의존한다(`main/db.mjs:782-843`). `main/brief.mjs`의 `briefingLines()`을 직접 읽어 확인한 결과 이 함수는 `b.active_issues`/`b.stale_repos`/`b.done_suggest` 등을 모두 `if (b.xxx)` falsy 가드로 감싸고 있어(`main/brief.mjs:69-90`), store가 이 필드들을 아예 반환하지 않아도 렌더링이 깨지지 않는다 — D-11이 렌더러 쪽에 적용한 것과 같은 안전판이 브리핑 로직에도 이미 있다는 뜻이다. 따라서 새 `store.briefing()`은 overdue·due_today·inbox·open_todo·oldest_todo_days·stale_waiting만 계산하는 훨씬 얇은 SQL로 다시 쓰면 되고, `staleRepos()` 호출과 `issue`/`activity` 조인은 통째로 드롭해도 된다.

세 번째 발견은 PostgreSQL 전용 SQL 구문(`now()`, `interval`, `::interval`/`::date` 캐스트, `FILTER (WHERE ...)`, `string_agg`)이 SQLite에는 없다는 것이며, 이 페이즈가 살리기로 한 함수들의 대부분이 이 중 하나 이상을 쓴다(`nudgeItem`, `removeItem`/`restoreItem`, `purgeDeleted`, `getViewState`, `getHistory`, `briefing`). 이 변환은 "SQL 방언 번역"이 아니라 "시간 계산을 SQL에서 JS로 옮기는" 설계 변경에 가깝다 — D-10이 이미 ISO 8601 문자열의 사전식 정렬을 전제하므로, `now() - interval '5 days'` 같은 식은 호출부에서 `new Date(Date.now() - 5*86400000).toISOString()`을 계산해 바인딩 파라미터로 넘기는 패턴으로 일괄 치환하면 된다(아래 SQL 변환 표).

네 번째, `main/index.mjs` 분할(D-08)은 아키텍처 리서치(ARCHITECTURE.md)가 이미 상세히 설계해 두었고 이번 세션에서 실제 라인 번호까지 다시 확인했다 — `flush()`(423-432행), `capture:save`/`capture:followUp`(1042-1077행), `today:getState`(1079-1094행), `app.whenReady`의 타이머 등록(1396-1469행), `before-quit`/`will-quit`(1471-1477행)이 각각 `ipc.mjs`/`jobs.mjs`/`lifecycle.mjs`로 어떻게 갈라지는지가 명확하다. 모듈 경계를 넘나드는 전역 상태(`queue`, `settings`, `db`→`store`, `dbOnline`, `hotkeyOk`, `tray`, `captureWin`, `todayWin`)는 순환 참조 없이 공유 가능하도록 "컨텍스트 객체 주입" 패턴을 권한다(아래 Architecture Patterns).

**Primary recommendation:** `node:sqlite`를 그대로 채택해 `store.mjs`를 새로 쓰고, `main/index.mjs` 분할(D-08)을 저장소 교체보다 먼저 별도 커밋으로 완료한 뒤, `main/db.mjs`의 "살아남는 함수"를 함수별로 하나씩(SQL 변환 표 순서대로) 옮기며 `briefing()`은 대폭 축소된 새 SQL로 다시 쓴다. STOR-03 스모크는 기존 `--smoke` 모드에 "캡처 주입 → 대기 → 강제종료(SIGKILL)" 단계를 추가하는 외부 러너로 구현한다.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| 캡처 큐 선기록 | Browser/Client 아님 — Electron **Main 프로세스**(IPC 핸들러) | — | `queue.append()`는 fs 동기 쓰기, Electron 메인 프로세스에서만 실행됨. 렌더러는 IPC 호출만 한다 |
| 즉시 저장소 반영 | API/Backend에 대응하는 계층인 **Main 프로세스 store.mjs** | 큐(fallback) | `DatabaseSync`는 Node API이므로 메인 프로세스 전용 — 렌더러(웹 컨텍스트)에서는 접근 불가. IPC를 거쳐야 함 |
| 스키마 마이그레이션 | Main 프로세스 (`store.mjs` 시작 시 1회) | — | 앱 시작 시점, DB 파일을 여는 유일한 프로세스에서 수행 |
| 오늘 뷰 상태 조회 | Main 프로세스(store 쿼리) → IPC → Renderer 렌더링 | — | 데이터 소유는 store, 표현은 renderer. 기존 패턴과 동일하게 유지 |
| 강제종료 내구성 검증(스모크) | 프로세스 수명 관리 — OS 프로세스 경계(테스트 하네스) | Main 프로세스(WAL 체크포인트) | 크래시 내구성은 OS 커널의 강제 종료(SIGKILL)와 SQLite WAL의 재생(replay)이 만나는 지점이라 "테스트 하네스(외부 프로세스)"라는 별도 계층으로 다뤄야 한다 |
| 레거시 IPC 스텁 | Main 프로세스(ipc.mjs) | — | UI는 그대로 채널을 부르므로 응답만 무해하게 바꾼다 — Renderer 변경 없음(Phase 2가 UI를 지운다) |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:sqlite` (Node 내장 모듈, 별도 설치 불필요) | Electron 43.3.0 번들 Node **24.18.1**에 포함, SQLite 엔진 **3.53.1** — 이 세션에 `node_modules/electron/package.json`과 `ELECTRON_RUN_AS_NODE=1` 실행으로 직접 확인 `[VERIFIED: node_modules/electron/package.json:2, 스파이크 실행 로그]` | STOR-01의 내장 단일 파일 저장소 | 네이티브 모듈이 아니라 Node 내장 모듈이라 electron-builder 리빌드·`asarUnpack` 문제가 구조적으로 없다. `DatabaseSync`는 동기 API라 기존 `db.mjs`/`queue.mjs`의 동기 호출 스타일과 맞는다. Node 공식 문서 기준 Stability **1.2(Release Candidate)** — v23.4.0/v22.13.0부터 플래그 없이 사용 가능, v25.7.0부터 RC `[CITED: nodejs.org/api/sqlite.html (Context7 /websites/nodejs_latest-v24_x_api)]` |

### Supporting

이번 페이즈는 **신규 npm 패키지를 설치하지 않는다.** `node:sqlite`는 Node 내장 모듈이라 `package.json`에 추가할 항목이 없다.

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pg` (기존 8.13.0, 위치만 이동) | 8.13.0 | Phase 3 개인 PG→내장 저장소 이전 스크립트 전용 | D-07에 따라 `dependencies` → `devDependencies`로 이동만 한다. 새 버전 설치 불필요 |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `node:sqlite` | `better-sqlite3@13.x` | 이번 스파이크에서 `node:sqlite`가 D-12~D-17이 요구하는 모든 프라그마·트랜잭션·동시성·손상 감지를 통과했으므로 채택하지 않는다. 만약 실제 구현 중 `node:sqlite`가 감당 못 하는 기능(예: 커스텀 SQL 함수, 특정 확장)이 발견되면 같은 `store.mjs` 경계 뒤에서 교체 — 이 경우 네이티브 모듈이므로 `electron-builder`의 `npmRebuild: true` + `asarUnpack: ["**/node_modules/better-sqlite3/**"]` 설정이 반드시 필요해진다(Windows·macOS 각각 리빌드) |

**Installation:**
```bash
# 설치할 것 없음 — node:sqlite는 Electron이 번들한 Node에 이미 포함되어 있다.
# 확인 명령(메인 프로세스 코드 안에서):
node -e "console.log(process.versions.node)"   # 24.x 확인
```

**Version verification:** 이 페이즈는 새 패키지를 설치하지 않으므로 `npm view`/`pip`/`cargo` 확인 대상이 없다. 대신 "이 프로젝트에 실제로 설치된 Electron이 번들한 Node에서 `node:sqlite`가 동작하는가"가 유일한 검증 대상이었고, 아래 스파이크로 직접 확인했다.

## Package Legitimacy Audit

이번 페이즈는 새 외부 패키지(npm)를 설치하지 않는다 — `node:sqlite`는 Node.js 내장 모듈이라 레지스트리 조회·슬롭스쿼팅 검사 대상이 아니다. 유일한 `dependencies` 변경은 기존에 이미 설치되어 있던 `pg@8.13.0`을 `devDependencies`로 옮기는 것뿐이며, 새 버전을 설치하지 않으므로 감사 대상 신규 설치가 없다.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `pg` (기존 설치, 8.13.0) | npm | 이미 설치됨(신규 설치 아님) | — | github.com/brianc/node-postgres | 해당 없음(신규 설치 없음) | `dependencies` → `devDependencies`로 위치만 이동 |

**Packages removed due to [SLOP] verdict:** none — 신규 설치가 없어 판정 대상 자체가 없음
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
[전역 단축키 / 트레이 클릭]
        │
        ▼
┌───────────────────────────┐        ┌──────────────────────────┐
│ main/lifecycle.mjs (NEW)  │        │ main/jobs.mjs (NEW)      │
│ app.whenReady, 창 생성,    │        │ 큐 fallback 드레인(1회),  │
│ tray, hotkey 등록, quit    │        │ maybeBrief, WAL 체크포인트│
└───────────────┬───────────┘        └───────────┬──────────────┘
                │ 창 IPC 브리지                    │ 주기 호출
                ▼                                  ▼
┌──────────────────────────────────────────────────────────────┐
│ main/ipc.mjs (NEW) — capture:save/followUp, today:getState,   │
│ item:*/project:* (store 위임), settings:*, 레거시 IPC 스텁     │
└───────────┬───────────────────────────────────┬──────────────┘
            │ 동기 즉시 반영 시도 (D-01)          │ 실패 시(catch)
            ▼                                    ▼
   ┌─────────────────────┐              ┌────────────────────┐
   │ main/store.mjs (NEW) │              │ main/queue.mjs (기존)│
   │ DatabaseSync, WAL,   │◄─ 시작 시 1회 │ append-only JSONL,  │
   │ user_version 마이그  │  전체 반영    │ append()/readAll()  │
   │ 레이션, project/item/ │  (D-02)      │ 그대로 재사용        │
   │ event CRUD           │              └────────────────────┘
   └──────────┬───────────┘
              ▼
   userData/store.sqlite (+ -wal, -shm)
   userData/queue.jsonl (예외 폴백)
```

### Recommended Project Structure
```
main/
├── lifecycle.mjs   # app.whenReady, BrowserWindow 생성, tray, globalShortcut, quit
├── ipc.mjs         # 모든 ipcMain.handle/.on (capture, item, project, settings, 레거시 스텁)
├── jobs.mjs        # 큐 fallback 1회 드레인, maybeBrief 유지, WAL 체크포인트/purge 타이머
├── store.mjs       # NEW — node:sqlite 기반 저장소 (db.mjs 대체)
├── queue.mjs       # 기존 그대로 (append/readAll 재사용, drain은 store.mjs가 호출)
├── settings.mjs    # 변경 없음
├── place.mjs       # 변경 없음
├── parse.mjs       # 변경 없음
└── brief.mjs       # 변경 없음 (briefingLines의 falsy 가드 덕에 store.briefing() 축소가 안전)
```

### Pattern 1: 컨텍스트 객체를 통한 모듈 간 상태 공유 (D-08 분할의 핵심)

**What:** `index.mjs`가 지금 모듈 스코프 변수로 들고 있는 `tray`, `captureWin`, `todayWin`, `dbOnline`, `hotkeyOk`, `queue`, `settings`, `store`를 `lifecycle.mjs`가 생성한 뒤 하나의 `ctx` 객체(또는 클로저)로 묶어 `ipc.mjs`/`jobs.mjs`에 함수 인자로 넘긴다.
**When to use:** 세 파일이 서로를 `import`하지 않고(순환 참조 방지) 같은 가변 상태를 공유해야 할 때.
**Example:**
```js
// main/lifecycle.mjs
export function bootstrap() {
  const ctx = {
    tray: null, captureWin: null, todayWin: null,
    dbOnline: false, hotkeyOk: false,
    queue: createQueue(...), settings: createSettings(...), store: createStore(...),
  };
  registerIpc(ctx);   // main/ipc.mjs
  scheduleJobs(ctx);  // main/jobs.mjs
  return ctx;
}
```
`ipc.mjs`/`jobs.mjs`는 `ctx`를 인자로 받는 함수만 export한다 — 기존 코드가 전역 `let`을 직접 참조하던 것과 동작은 동일하고(D-08의 "순수 이동" 요건), import 방향은 `lifecycle → ipc/jobs`로만 흐른다.

### Pattern 2: PRAGMA `user_version` 순번 마이그레이션 (D-12/STOR-04)

**What:** SQLite는 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`를 지원하지 않는다(`db.mjs`의 기존 Postgres 스타일 멱등 블록을 그대로 옮기면 두 번째 실행에서 "duplicate column name"으로 죽는다) `[CITED: sqlite.org/lang_altertable.html]`. 대신 `PRAGMA user_version`을 스키마 버전으로 쓰고, 순서가 있는 마이그레이션 함수 배열을 처음부터 끝까지 적용한다.
**When to use:** 앱 시작 시 store를 열 때 항상.
**Example:**
```js
// main/store.mjs
const MIGRATIONS = [
  (db) => db.exec(`
    CREATE TABLE project (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      abbr TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sort INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE item (
      id TEXT PRIMARY KEY,
      project_id INTEGER REFERENCES project(id),
      kind TEXT NOT NULL DEFAULT 'inbox' CHECK (kind IN ('inbox','todo','waiting')),
      title TEXT NOT NULL,
      due TEXT,
      waiting_for TEXT,
      captured_at TEXT NOT NULL,
      done_at TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      context TEXT,
      note TEXT,
      nudged_at TEXT,
      nudge_count INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT
    );
    CREATE TABLE event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT
    );
  `),
  // 다음 버전이 필요해지면 여기에 함수를 追加한다. 이미 배포된 함수는 절대 수정하지 않는다(D-12).
];

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  if (current > MIGRATIONS.length) {
    // D-13: 미래 버전 DB — 절대 쓰지 않는다
    throw new NewerSchemaError(current, MIGRATIONS.length);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      // PRAGMA는 바인딩 파라미터(?)를 받지 않는다 — 리터럴로 문자열에 넣어야 한다(스파이크로 확인)
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
```
**주의:** `node:sqlite`의 `DatabaseSync`에는 better-sqlite3의 `db.transaction(fn)` 같은 트랜잭션 헬퍼가 없다(이 세션에 `Object.getOwnPropertyNames(Object.getPrototypeOf(db))`로 프로토타입을 직접 덤프해 확인 — `open/close/prepare/exec/function/createTagStore/location/aggregate/createSession/applyChangeset/enableLoadExtension/enableDefensive/loadExtension/serialize/deserialize/setAuthorizer/constructor`뿐이다 `[VERIFIED: 스파이크 실행 로그]`). `BEGIN`/`COMMIT`/`ROLLBACK`을 `db.exec()` 문자열로 직접 감싸는 소규모 `withTransaction(db, fn)` 헬퍼는 이 프로젝트가 직접 작성해야 하는 부분이다(하단 "Don't Hand-Roll"과 모순되지 않음 — 이건 라이브러리가 안 주는 3줄짜리 래퍼이지 재발명 대상이 아니다).

### Pattern 3: PG 시간 함수를 JS 계산 + 바인딩 파라미터로 치환

**What:** `now()`, `interval '5 days'`, `::date`, `current_date` 등 PostgreSQL 전용 시간 연산자는 SQLite에 없다. D-10이 이미 모든 시간 칼럼을 ISO 8601 UTC 문자열로 저장하기로 했으므로, "N일 전"류의 조건은 호출부에서 JS `Date`로 계산해 문자열 파라미터로 바인딩하면 사전식 비교가 시간 비교와 정확히 일치한다.
**When to use:** `nudgeItem`, `removeItem`/`restoreItem`, `purgeDeleted`, `getViewState`, `getHistory`, `briefing` 전부.
**Example:**
```js
// PostgreSQL (main/db.mjs:646-653, purgeDeleted)
// "DELETE FROM item WHERE deleted_at < now() - ($1 || ' days')::interval"

// SQLite (store.mjs) — 계산은 JS에서, 비교는 문자열 그대로
function purgeDeleted(db, days = 30) {
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  return db.prepare('DELETE FROM item WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff).changes;
}
```

### Anti-Patterns to Avoid

- **Postgres 멱등 스키마 블록을 그대로 SQLite로 복붙:** `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`를 그대로 옮기면 두 번째 실행에서 "duplicate column name"으로 크래시한다 — `PRAGMA user_version` 순번 마이그레이션(Pattern 2)으로 교체해야 한다.
- **큐를 "상시 2단계 버퍼"로 되살리기:** 30초 주기 `flush` 타이머를 되살리거나 큐→store 드레인을 상시 루프로 두면 CONCERNS.md가 지적한 경합(읽기→소비→재읽기→rename 사이의 동시 append)이 재발한다. D-02대로 "시작 시 1회"로 한정해야 그 경합 창이 사실상 사라진다.
- **PRAGMA 값을 바인딩 파라미터로 넘기려는 시도:** `db.prepare('PRAGMA user_version = ?').run(3)` 형태는 동작하지 않는다(PRAGMA는 SQL 리터럴만 받는다) — 반드시 문자열 템플릿으로 숫자를 직접 삽입해야 한다(신뢰할 수 있는 내부 값이므로 인젝션 우려 없음).
- **`briefing()`을 "SQL 방언만 바꿔서" 그대로 이식:** 제거된 테이블(issue/activity/repo_state)과 제거된 칼럼(done_suggested_at)에 기대는 서브쿼리를 그대로 SQLite 문법으로 번역하면 컴파일조차 안 된다 — Summary에서 설명한 대로 축소된 버전으로 다시 써야 한다.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| 스키마 버전 관리 | 커스텀 "이미 이 컬럼 있나 확인 후 ALTER" 로직 | `PRAGMA user_version` + 순번 마이그레이션 배열(Pattern 2) | SQLite 커뮤니티 표준 관용구. 버전 판정이 정수 비교 하나로 끝나 D-13(미래 버전 감지)도 자연스럽게 구현된다 |
| WAL 체크포인트/내구성 | 수동 fsync·파일 복제로 "안전한 쓰기" 직접 구현 | `PRAGMA journal_mode=WAL` + `PRAGMA synchronous=FULL` + 종료 시 `wal_checkpoint(TRUNCATE)` | SQLite 엔진이 이미 크래시 안전성을 제공한다 — 직접 구현하면 반드시 SQLite보다 못한 결과가 나온다 |
| 캡처 큐 재설계 자체 | append/readAll을 새로 짜기 | 기존 `main/queue.mjs`의 `append()`/`readAll()` 그대로 재사용 | 이미 dependency-free·동기·테스트된 코드다(`test/queue.test.mjs` 6건 중 대부분 그대로 유효) — `drain()`만 D-02 방식으로 교체 |
| 손상 DB 판별 | 파일 헤더 매직바이트를 직접 파싱 | `PRAGMA integrity_check` 실행 후 에러의 `errcode`(26=SQLITE_NOTADB, 11=SQLITE_CORRUPT) 확인 | SQLite 엔진 자체가 훨씬 정교한 판별을 제공 — 이 세션에 직접 실행해 정확한 에러 형태를 확인했다(Code Examples 참고) |

**Key insight:** 이 페이즈는 "새 기능"이 아니라 "이미 SQLite가 해결한 문제를 SQLite에게 맡기는" 작업이다. 커스텀 코드가 필요한 지점은 오직 (1) `node:sqlite`가 제공하지 않는 트랜잭션 헬퍼 3줄, (2) PG 시간 연산자를 JS로 옮기는 SQL 재작성뿐이다.

## Runtime State Inventory

> 이 페이즈는 저장소 엔진을 통째로 교체하는 "migration" 성격이라 이 섹션을 포함한다. NAME-02(앱 이름 변경에 따른 런타임 상태)는 Phase 5 소관이며 여기서는 다루지 않는다.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | 개인용 PostgreSQL(docker) 안의 실제 `project`/`item`/`event` 등 데이터는 이 페이즈에서 **손대지 않는다**. `docker-compose`로 띄운 로컬 PG는 그대로 살아있고, 새 `store.sqlite`는 처음엔 빈 상태로 시작한다. 실제 데이터 이전은 Phase 3(DATA-04)의 별도 스크립트 몫이다 `[VERIFIED: .planning/REQUIREMENTS.md DATA-04 항목, package.json:14 "db": "docker compose up -d"]` | PLAN의 완료 기준에 "이 페이즈 종료 시점에 작성자의 기존 캡처 이력은 여전히 PG에만 있고 새 앱은 비어 있다"를 명시해 "데이터가 사라졌다"는 오인을 막을 것 |
| Live service config | `docker-compose.yml`과 `package.json`의 `"db": "docker compose up -d"` 스크립트(`package.json:14`)는 Phase 3 이전 스크립트가 여전히 그 컨테이너를 읽어야 하므로 이 페이즈에서 지우지 않는다 | 없음(유지) — 삭제는 Phase 3 완료 후 |
| OS-registered state | 없음 — 이 페이즈는 Windows 작업 스케줄러·로그인 항목 등 OS 등록 상태를 만들거나 건드리지 않는다(로그인 자동시작은 PLAT-03, Phase 4 소관) | 해당 없음 |
| Secrets/env vars | `settings.json`의 `db` 키(host/port/user/password, `main/index.mjs:407` `dbConfig = settings.get('db')`)는 `db.mjs` 삭제 후 코드 어디에서도 읽지 않는 죽은 설정이 된다 | 코드 편집: `main/ipc.mjs`(구 index.mjs)에서 `dbConfig`/`settings:get`의 `db` 응답 필드도 함께 제거할지 PLAN이 판단 — 남겨도 무해하지만 RMV-06(grep 0건) 정신에 맞추려면 이 페이즈에서 같이 정리하는 편이 이후 페이즈의 grep 작업을 줄인다 |
| Build artifacts | 네이티브 모듈 없음(`node:sqlite`는 Node 내장) — 리빌드·`asarUnpack`·egg-info류 문제가 구조적으로 발생하지 않는다. `pg`가 `devDependencies`로 이동하면 electron-builder는 "생산 의존성(dependencies)만 `node_modules`에 복사"하므로 설치본에서 자동으로 빠진다 `[CITED: electron-builder 공식 소스 주석 — "node_modules/**/* (only production dependencies will be copied) is added ... in any case", github.com/electron-userland/electron-builder PlatformSpecificBuildOptions.ts (Context7)]` | 없음 — `package.json`에서 `pg`를 `dependencies`→`devDependencies`로 옮기는 것만으로 충분, `build.files`/`asarUnpack` 추가 설정 불필요 |

## Common Pitfalls

### Pitfall 1: `briefing()`을 "SQL 방언 번역"으로만 생각하고 이식
**What goes wrong:** 제거된 `issue`/`activity`/`repo_state` 테이블에 대한 조인과, 제거된 `item.done_suggested_at` 칼럼을 참조하는 서브쿼리(`main/db.mjs:787-843`)를 그대로 SQLite 문법으로 옮기려 하면 애초에 그런 테이블/칼럼이 없어 컴파일이 실패한다.
**Why it happens:** D-05가 `briefing`을 "살아남는 함수" 목록에 넣어서 "전체 함수를 그대로 옮기면 된다"고 오해하기 쉽다.
**How to avoid:** `main/brief.mjs`의 `briefingLines()`가 `active_issues`/`stale_repos`/`done_suggest` 필드를 모두 `if (b.xxx)` falsy 가드로 감싸고 있음을 확인했으므로(`main/brief.mjs:69-90`), 새 `store.briefing()`은 이 필드들을 아예 계산하지 않거나 `0`/`null`로 고정 반환해도 안전하다. overdue·due_today·inbox·open_todo·oldest_todo_days·stale_waiting 여섯 개만 SQLite로 다시 쓴다.
**Warning signs:** `store.mjs` 초안에 `activity`나 `issue` 테이블명이 SQL 문자열에 남아있으면 즉시 발견된다(스키마에 그 테이블이 없으므로 실행 시점 에러).

### Pitfall 2: PostgreSQL 시간 연산자를 그대로 두고 "동작하겠지" 가정
**What goes wrong:** `now()`, `interval '5 days'`, `current_date`, `::date` 캐스트는 SQLite에 존재하지 않는 구문이다. 이를 놓치면 `nudgeItem`/`purgeDeleted`/`getViewState`/`getHistory`/`briefing` 전부가 실행 시점 SQL 오류를 낸다.
**Why it happens:** D-10이 "저장 형식"만 ISO 문자열로 바꾸기로 결정했지, "시간 계산을 어디서 하는가"는 명시하지 않아 SQL 안에서 여전히 계산하려는 시도가 나올 수 있다.
**How to avoid:** Architecture Patterns의 Pattern 3처럼 모든 "N일 전/후" 계산을 JS `Date`로 옮기고 문자열 파라미터로 바인딩한다. ISO 8601 UTC 문자열은 사전식 비교가 시간 비교와 동일하므로 SQL에서는 `<`/`>`/`BETWEEN` 문자열 비교만 하면 된다.
**Warning signs:** SQL 문자열에 `interval`, `now()`, `::` 캐스트, `current_date`가 남아있으면 즉시 발견 가능 — grep으로 사전 점검 가능.

### Pitfall 3: 큐 드레인을 "상시 동작"으로 되돌리기
**What goes wrong:** 기존 `main/queue.mjs`의 `drain()`은 읽기→소비→재읽기→rename 사이에 동시 append가 끼면 데이터가 유실될 수 있는 구조다(CONCERNS.md, `main/queue.mjs:36-61`). D-01/D-02는 이 구조를 "시작 시 1회"로 한정해 경합 창을 사실상 없앴는데, 습관적으로 `setInterval(flush, FLUSH_MS)`를 되살리면 이 경합이 그대로 돌아온다.
**Why it happens:** 기존 `main/index.mjs:1408`에 `setInterval(flush, FLUSH_MS)`가 있어 "당연히 있어야 하는 코드"로 착각하기 쉽다.
**How to avoid:** D-01은 "30초 주기 flush 타이머는 없앤다"를 명시적으로 결정했다 — `jobs.mjs`에 이 타이머를 절대 다시 넣지 않는다. 큐 드레인은 `store.mjs`가 앱 시작 시 한 번만 호출한다.
**Warning signs:** `jobs.mjs`나 `lifecycle.mjs`에 `setInterval`로 큐/store 관련 함수를 등록하는 코드가 있으면 즉시 리뷰 대상.

### Pitfall 4: `PRAGMA` 값을 prepared statement 파라미터로 바인딩 시도
**What goes wrong:** `db.prepare('PRAGMA user_version = ?').run(newVersion)` 같은 코드는 SQLite가 PRAGMA 문에서 `?` 바인딩을 지원하지 않아 조용히 무시되거나 오류가 난다(이 세션에 직접 확인 — PRAGMA는 문자열 리터럴만 받는다).
**Why it happens:** 다른 모든 INSERT/UPDATE/SELECT에서 파라미터 바인딩이 표준 패턴이라 PRAGMA도 같을 거라 가정하기 쉽다.
**How to avoid:** PRAGMA 값은 반드시 템플릿 리터럴로 SQL 문자열에 직접 삽입한다(``db.exec(`PRAGMA user_version = ${v}`)``). 이 값이 항상 내부에서 계산된 정수(사용자 입력 아님)이므로 인젝션 위험은 없다.
**Warning signs:** `db.prepare('PRAGMA ...= ?')` 형태의 코드는 리뷰에서 바로 걸러야 한다.

## Code Examples

### 스파이크 실행 로그 (이 세션에 실제로 실행한 결과 — `[VERIFIED: 스파이크 실행]`)

재현 방법(스크래치패드에서, 리포지토리 파일은 건드리지 않음):
```bash
# Electron이 번들한 Node로 node:sqlite를 직접 실행 (설치 불필요)
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd <spike-script.cjs>
```

실제 출력(요약, 순서 그대로):
```
--- versions ---
{"node":"24.18.1","electron":"43.3.0"}
--- node:sqlite loaded OK ---
--- opened DatabaseSync ---
journal_mode -> {"journal_mode":"wal"}
synchronous -> {"synchronous":2}                 # FULL
foreign_keys -> {"foreign_keys":1}
user_version (after set 3) -> {"user_version":3}
integrity_check -> {"integrity_check":"ok"}
--- schema created ---
db prototype members: [ 'open','close','prepare','exec','function','createTagStore',
  'location','aggregate','createSession','applyChangeset','enableLoadExtension',
  'enableDefensive','loadExtension','serialize','deserialize','setAuthorizer','constructor' ]
BEGIN/INSERT/COMMIT via exec -> OK
after ROLLBACK, row(2) present? undefined         # 롤백 정상 동작
positional insert run() -> {"changes":1,"lastInsertRowid":1}
named insert run() -> {"changes":1,"lastInsertRowid":2}   # :name 파라미터 지원 확인
get() -> {"id":"id-1","project_id":1,"title":"hello","captured_at":"..."}
all() -> [ {...}, {...} ]
INSERT OR IGNORE on existing id -> {"changes":0,"lastInsertRowid":2}   # 멱등 확인(D-02)
RETURNING via get() -> {"id":9,"name":"p9"}       # RETURNING 절 지원 확인
wal_checkpoint(TRUNCATE) -> {"busy":0,"log":0,"checkpointed":0}
--- closed OK ---
--- concurrent access test ---
second handle insert FAILED as expected:
  {"message":"database is locked","code":"ERR_SQLITE_ERROR","errcode":5,"errstr":"database is locked"}
--- corrupt file test ---
integrity_check on garbage file THREW:
  {"message":"file is not a database","code":"ERR_SQLITE_ERROR","errcode":26,"errstr":"file is not a database","name":"Error"}
CREATE TABLE on garbage file THREW: (동일 에러)
--- DONE ---
```
추가로 별도 실행에서 확인: `sqlite_version()` → `3.53.1`; `SELECT 1 ORDER BY 1 NULLS LAST` 정상 동작; `INSERT ... ON CONFLICT(id) DO UPDATE ... RETURNING` 정상 동작(UPSERT+RETURNING 동시 지원). `node:sqlite` 로드 시 stderr에 `ExperimentalWarning` 출력 **없음**(별도로 stdout/stderr 분리 실행해 확인).

**스파이크 합격 기준(Claude's Discretion 항목에 대한 판정 — 이 세션에서 적용한 기준):** (1) 설치 없이 로드됨, (2) D-17이 요구하는 WAL/synchronous 프라그마 설정·조회 가능, (3) D-12/D-13이 요구하는 `user_version` 읽기·쓰기 가능, (4) BEGIN/COMMIT/ROLLBACK이 트랜잭션 원자성을 실제로 지킴, (5) named/positional 파라미터·`INSERT OR IGNORE`·`RETURNING` 모두 지원(D-02 멱등 반영에 필수), (6) 동시 접근 시 두 번째 핸들이 에러를 던짐(무음 데이터 손상이 아니라 감지 가능한 실패), (7) 손상/비-DB 파일에서 구분 가능한 에러 코드(`errcode`)를 던짐(D-15에 필수) — 7개 기준 전부 통과. **판정: PASS — `better-sqlite3` 폴백 불필요.**

### SQL 변환 표 (PostgreSQL → SQLite, 살아남는 함수 기준)

| PG 구문(`main/db.mjs` 위치) | SQLite 대응 | 비고 |
|---|---|---|
| `ON CONFLICT (id) DO NOTHING` (`:236`, insertCaptures) | `INSERT OR IGNORE INTO ...` | 스파이크로 `changes:0` 확인(멱등) |
| `RETURNING id` (`:263`, createProject) | `... RETURNING id` | SQLite 3.53.1이 RETURNING 지원(스파이크 확인) |
| `now()` (도처) | JS `new Date().toISOString()`를 파라미터로 바인딩 | D-10과 일치, SQL에서 시간 계산 안 함 |
| `now() - ($1 \|\| ' days')::interval` (`purgeDeleted:649`, `getDoneItems:413` 등) | JS에서 `new Date(Date.now() - days*86400000).toISOString()` 계산 후 문자열 비교 | Architecture Patterns Pattern 3 |
| `done_at > now() - interval '12 hours'` (`getViewState:486`) | 위와 동일 패턴, 상수 12*3600*1000 | |
| `due NULLS LAST` (`getViewState:487`) | `ORDER BY due IS NULL, due` 또는 SQLite 3.30+ 네이티브 `NULLS LAST` | 스파이크로 `NULLS LAST` 네이티브 지원 확인(3.53.1) — 그대로 사용 가능 |
| `count(*) FILTER (WHERE ...)` (`briefing:815-828`) | `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` | SQLite에 `FILTER` 절 없음(3.53.1 기준 미지원 — 이 세션엔 별도 확인 안 함, `[ASSUMED]` 표준 SQLite 문법 지식 기준) |
| `current_date` (`briefing:816`) | JS에서 오늘 날짜(`YYYY-MM-DD`) 계산해 바인딩 | D-10의 `due` TEXT 포맷과 동일 |
| `gen_random_uuid()` (issue 관련, 이번 페이즈 대상 아님) | 해당 없음 — `promoteIssue` 등은 살아남는 함수 목록에 없음 | item.id는 캡처 시 이미 `crypto.randomUUID()`로 큐에 실려 옴(`main/index.mjs:1049`) |
| `client.query('BEGIN')`/`COMMIT`/`ROLLBACK` (트랜잭션 필요 함수: `moveProject`) | `db.exec('BEGIN')`/`'COMMIT'`/`'ROLLBACK'` | 스파이크로 원자성 확인. 헬퍼 함수로 감싸 재사용 권장(Pattern 2) |

### 강제종료 스모크 하네스 설계 스케치 (STOR-03/D-04)

D-04는 "electron --smoke 안에서" 검증하라고 명시했지만, 기존 `SMOKE_PROBE`(`main/index.mjs:58-324`)는 **한 프로세스 수명 안에서** 렌더러를 점검하고 스스로 `app.exit()`하는 구조라 "캡처 → 강제종료 → 재기동"처럼 **두 프로세스 수명에 걸친** 시나리오를 표현할 수 없다. 이 페이즈에서 필요한 것은 `--smoke`를 부르는 **외부 러너**(`test/` 또는 `tools/`, `node --test`에서 실행 가능한 별도 스크립트)이지, `SMOKE_PROBE` 문자열 자체를 두 프로세스로 쪼개는 것이 아니다.

권장 구조(Claude's Discretion 영역이므로 스케치로 제시):
```js
// test/capture-crash-smoke.test.mjs (신규, node --test로 실행)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('캡처 직후 강제 종료해도 재기동 시 그 캡처가 살아있다', async () => {
  const marker = `crash-test-${Date.now()}`;

  // 1) 첫 프로세스: 캡처를 큐에 선기록한 직후 stdout에 신호를 남기고 "스스로 종료하지 않는다"
  //    (예: 새 CLI 플래그 --smoke-inject-capture=<title> 을 SMOKE 모드에 추가해
  //    queue.append() 직후 console.log('CAPTURED') 하고 종료하지 않도록 대기)
  const p1 = spawn('npx', ['electron', '.', '--smoke', `--inject-capture=${marker}`], { cwd: repoRoot });
  await waitForStdout(p1, 'CAPTURED');       // 큐 append가 실제로 fs에 반영된 시점
  p1.kill('SIGKILL');                        // Windows·POSIX 모두 무조건 강제 종료
                                              // (Node child_process 문서: Windows에서도
                                              //  SIGKILL은 예외적으로 지원되어 프로세스를
                                              //  무조건 종료시킨다 — taskkill 별도 호출 불필요)
  await waitForExit(p1);

  // 2) 두 번째(정상) 프로세스: 시작 시 큐 반영(D-02) 후 오늘 뷰 상태를 덤프하고 종료
  const p2 = spawn('npx', ['electron', '.', '--smoke'], { cwd: repoRoot });
  const out = await waitForStdout(p2, /SMOKE_(OK|FAIL)/);
  assert.match(out, new RegExp(marker));     // 캡처 제목이 오늘 뷰(인박스) 상태에 남아있는지 확인
});
```
**근거:** Node 공식 문서에 따르면 `subprocess.kill('SIGKILL')`은 Windows에서도(POSIX 시그널이 없음에도) "SIGKILL/SIGTERM/SIGINT/SIGQUIT만은 예외적으로 지원되며 프로세스를 무조건 강제 종료시킨다"고 명시되어 있다 `[CITED: nodejs.org/api/child_process.html, process.html#signal-events (Context7 /websites/nodejs_latest-v24_x_api)]` — 오케스트레이터가 제안한 "Windows `taskkill /F /PID` vs POSIX `SIGKILL`" 분기가 **불필요**하다는 뜻이다. `child.kill('SIGKILL')` 한 줄로 두 OS 모두 커버되며, `test/`의 하네스 코드를 OS 분기 없이 하나로 유지할 수 있다.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| PostgreSQL(Docker) + `pg.Pool` 비동기 쿼리 | `node:sqlite`(`DatabaseSync`) 동기 쿼리, 앱 데이터 폴더 내 단일 파일 | 이번 페이즈 | 외부 프로세스·네트워크 왕복 제거, 캡처 경로가 큐와 같은 "동기·의존성 없음" 성격을 갖게 됨 |
| 큐 30초 주기 flush + DB drain | 큐는 예외 폴백, 시작 시 1회만 드레인 | 이번 페이즈(D-01/D-02) | CONCERNS.md의 드레인 경합이 발생할 창 자체가 사실상 사라짐 |
| Postgres 멱등 `ALTER TABLE ADD COLUMN IF NOT EXISTS` | `PRAGMA user_version` 순번 마이그레이션 | 이번 페이즈(D-12) | SQLite 문법 제약(IF NOT EXISTS 없음)에 맞춘 표준 관용구로 전환 |

**Deprecated/outdated:**
- `main/db.mjs` 전체, `pg.Pool` 런타임 사용, `main/backup.mjs`(SQL 텍스트 덤프) — 이 페이즈에서 삭제. `pg`는 devDependency로 격하되어 Phase 3 이전 스크립트 전용으로만 남는다.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | SQLite의 `FILTER (WHERE ...)` 절은 (버전에 따라 컴파일 옵션이 다를 수 있어) `briefing()` 재작성 시 `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`로 바꿔야 한다고 가정했다 — 이 세션에서 이 프로젝트의 `node:sqlite`(SQLite 3.53.1)에 대해 `FILTER` 지원 여부를 직접 실행 검증하지 않았다 | Code Examples > SQL 변환 표 | 틀렸다면(즉 FILTER가 실제로 지원된다면) `briefing()` 재작성 시 불필요하게 장황한 CASE 문을 쓰게 될 뿐 — 기능 리스크는 낮다. 구현 단계에서 5분 내로 직접 확인 가능 |
| A2 | STOR-03 스모크 하네스를 위해 `--smoke` 모드에 "캡처 주입 후 종료하지 않고 대기" 하는 새 CLI 플래그(`--inject-capture=<title>` 등)를 추가해야 한다고 가정했다 — 실제 플래그 이름·구현 방식은 D-04가 "electron --smoke 안에서 검증"이라고만 규정했을 뿐 세부는 Claude's Discretion 영역이라 이 리서치가 임의로 스케치한 것 | Code Examples > 강제종료 스모크 하네스 | 틀렸다면 PLAN 단계에서 다른 주입 메커니즘(예: 임시 IPC 소켓, 파일 기반 트리거)으로 대체하면 되고, 근본 설계(두 프로세스 수명·SIGKILL·재기동 후 상태 확인)는 그대로 유효하다 |
| A3 | `settings.json`의 `db` 키(dbConfig)를 이 페이즈에서 함께 정리할지는 PLAN의 재량으로 남겨두었다 — "남겨도 무해하다"는 판단은 코드를 읽고 확인했지만(`main/index.mjs:407, 624-629`), RMV-06(grep 0건)과의 관계는 이 페이즈 범위 밖 판단이라 추정이 섞여 있다 | Runtime State Inventory | 틀렸다면(즉 남겨두면 안 되는 이유가 있다면) Phase 2에서 뒤늦게 정리해야 하는 추가 작업이 생기는 정도 — 데이터 무결성 리스크는 없음 |

## Open Questions

1. **`FILTER (WHERE ...)`이 이 프로젝트가 쓰는 SQLite 빌드에서 실제로 지원되는가?**
   - What we know: 표준 SQLite는 3.25(2018)부터 `FILTER` 절을 지원하지만 컴파일 옵션(`SQLITE_ENABLE_...`)에 따라 다를 수 있고, Node의 `node:sqlite`가 어떤 빌드 옵션으로 컴파일했는지는 이 세션에서 확인하지 않았다.
   - What's unclear: 확인하지 않았을 뿐 리스크는 낮다(A1 참고) — CASE 문으로 대체해도 결과가 동일하다.
   - Recommendation: `store.mjs` 작성 시 `SUM(CASE WHEN ... THEN 1 ELSE 0 END)` 패턴을 기본으로 쓰고, 시간이 남으면 `FILTER` 지원 여부를 한 번 실행해 더 짧은 SQL로 바꿀지 판단한다.

2. **`--smoke` 모드에 캡처 주입 플래그를 추가하는 것이 기존 SMOKE_PROBE 흐름과 충돌하지 않는가?**
   - What we know: 현재 `--smoke`는 렌더러 점검 후 반드시 `app.exit(ok?0:1)`로 종료한다(`main/index.mjs:1464-1465`). 강제종료 시나리오에서는 "종료하지 않고 대기"하는 별도 하위 모드가 필요하다.
   - What's unclear: 같은 `--smoke` 플래그 아래 새 옵션을 얹을지, 별도 플래그(`--smoke-crash-test` 등)로 완전히 분리할지는 정해지지 않았다.
   - Recommendation: PLAN 단계에서 별도 플래그로 분리하는 편을 권장 — 기존 SMOKE_PROBE 경로(REL-05가 두 OS 설치본에서 계속 의존)를 건드리지 않기 위함.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js (시스템) | 개발·테스트 실행 | ✓ | v24.13.0(시스템) `[VERIFIED: node -e 실행]` | — |
| Electron(devDependency, 프로젝트 로컬) | `node:sqlite` 런타임, 스모크 | ✓ | 43.3.0, 번들 Node 24.18.1, SQLite 3.53.1 `[VERIFIED: node_modules/electron/package.json, 스파이크 실행]` | — |
| Docker + PostgreSQL(로컬) | 이 페이즈의 **선행 조건 아님** — 오히려 이 페이즈가 제거 대상으로 삼는 의존성. Phase 3 이전 스크립트를 쓸 때까지는 필요 | ✓(현재 실행 중으로 추정, 이 세션에서 재확인 안 함) | — | 이 페이즈 완료 후에는 앱 실행에 불필요(그것이 목적) |
| macOS 실기기 | STOR-03 스모크의 "두 OS 빌드에서 돌아야 한다"(D-04) 요건 중 macOS 쪽 | ✗ (이 세션은 Windows에서만 실행) | — | STATE.md가 이미 이 갭을 기록 중(Phase 4용) — 이 페이즈의 macOS 검증은 실기기 확보 전까지 보류하고 Windows에서 먼저 통과시키는 것으로 진행 |

**Missing dependencies with no fallback:**
- macOS 실기기 — 이 페이즈의 스모크가 "두 OS에서 통과"를 요구하지만(D-04, REL-05 연결) 이 세션·현재 환경에서는 검증 불가. PLAN은 Windows 통과를 우선 완료 기준으로 삼고 macOS 검증은 실기기 확보 시점으로 미루는 것을 권장(Phase 4/5와 동일한 기존 제약).

**Missing dependencies with fallback:**
- 없음(Docker/PostgreSQL은 이 페이즈의 목적상 "없어도 되는" 상태가 정상이다).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node 내장 `node --test` (기존 187+건 테스트, 새 프레임워크 도입 없음) |
| Config file | none — `package.json`의 `"test": "node --test \"test/**/*.test.mjs\""` |
| Quick run command | `npm test` |
| Full suite command | `npm test && npm run smoke` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| STOR-01 | store.sqlite 단일 파일에 project/item/event가 저장된다, 외부 프로세스 불요 | unit | `node --test test/store.test.mjs` | ❌ Wave 0 (신규) |
| STOR-02 | store 쓰기 실패 시 큐 폴백에 남고 재시작 시 자동 반영 | unit | `node --test test/store.test.mjs`(store 오픈 실패 모킹) + `node --test test/queue.test.mjs`(기존 6건 중 drain 관련 재작성분) | ⚠️ 기존 파일 있으나 drain 테스트는 D-02에 맞춰 재작성 필요(`test/queue.test.mjs:39-46` "drain 도중 append된 항목은 꼬리에 살아남는다" 테스트가 새 구조에서 의미가 바뀜) |
| STOR-03 | 캡처 직후 강제 종료해도 유실 없음 | smoke(수동 아님, 자동화된 외부 프로세스 하네스) | `node --test test/capture-crash-smoke.test.mjs` (신규, `npm run smoke`와 별개로 `npm test`에 포함되거나 전용 스크립트로 분리) | ❌ Wave 0 (신규, 설계는 Code Examples 참고) |
| STOR-04 | user_version 기반 자동 마이그레이션, 미래 버전 감지 | unit | `node --test test/store.test.mjs`(v0→v1 마이그레이션, "미래 버전 DB는 열지 않는다" 케이스) | ❌ Wave 0 (신규) |
| STOR-05 | 제거 대상 테이블이 스키마에 없다 | unit(가드) | `node --test test/store.test.mjs`(`schemaTables()`가 `['project','item','event']`만 반환하는지 대조 — `test/backup.test.mjs:92-95` 패턴 계승) | ❌ Wave 0 (신규, 기존 `test/backup.test.mjs`는 D-09에 따라 삭제되고 이 가드만 이관) |
| (D-08 회귀 보증) | index.mjs 분할이 순수 이동이다 | regression | `npm test && npm run smoke` (분할 전/후 동일 결과 diff) | ✓ 기존 테스트 전체가 안전망 역할 |

### Sampling Rate
- **Per task commit:** `npm test` (전체 187+건, 로컬에서 수 초 내 완료 — 기존 관행)
- **Per wave merge:** `npm test && npm run smoke`
- **Phase gate:** `npm test && npm run smoke` 그린 + `test/capture-crash-smoke.test.mjs` 통과(최소 Windows) 후 `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `test/store.mjs`용 신규 테스트 파일(가칭 `test/store.test.mjs`) — STOR-01·02(부분)·04·05 커버, 임시 파일 DB(`fs.mkdtempSync` 패턴, 기존 `test/queue.test.mjs`/`test/backup.test.mjs`와 동일 관례) 사용
- [ ] `test/queue.test.mjs`의 "drain 도중 append된 항목은 꼬리에 살아남는다" 테스트(39-46행) — D-02의 "시작 시 1회 rename→반영→삭제" 구조에 맞춰 재작성
- [ ] `test/capture-crash-smoke.test.mjs`(또는 `tools/` 하위 러너 + 얇은 `node --test` 래퍼) — STOR-03 전용, `--smoke` 모드에 캡처 주입 서브모드 추가가 선행 조건
- [ ] 프레임워크 설치: 불필요 — `node --test`는 Node 내장

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | 단일 사용자 로컬 앱, 인증 없음(변경 없음) |
| V3 Session Management | no | 해당 없음 |
| V4 Access Control | no | OS 파일 권한이 유일한 경계(변경 없음) |
| V5 Input Validation | yes | `node:sqlite`의 prepared statement(`?`/`:name` 파라미터 바인딩)를 항상 사용 — 문자열 결합으로 SQL을 조립하지 않는다(캡처 제목·메모 등 사용자 입력 전부). PRAGMA 문만 예외(내부 계산값만 삽입, 사용자 입력 없음) |
| V6 Cryptography | no | 이 페이즈는 암호화 대상 데이터를 다루지 않는다(item.id는 `crypto.randomUUID()`로 이미 생성 — 변경 없음) |
| V7 Error Handling and Logging | yes | store 오류(손상/잠김/권한)를 사용자에게 노출할 때 내부 스택트레이스·파일 절대경로를 그대로 보여주지 않는다(D-03/D-15의 안내 문구는 이미 사람이 읽는 요약형) |
| V12 Files and Resources | yes | store 파일 경로는 `app.getPath('userData')` 고정값이며 사용자 입력을 경로에 섞지 않는다(경로 조작 불가) — Phase 3의 JSON import가 사용자 파일을 받을 때는 별도 검증이 필요하나 이 페이즈 범위 밖 |

### Known Threat Patterns for Electron + node:sqlite

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| SQL 인젝션(캡처 제목·메모 등 자유 텍스트를 문자열 결합으로 SQL에 삽입) | Tampering | `db.prepare(sql).run(...)`의 파라미터 바인딩만 사용, 문자열 결합 금지(기존 `db.mjs`도 이미 이 패턴을 지킴 — 유지만 하면 됨) |
| 손상된 DB 파일을 그대로 열어 앱이 예측 불가능한 상태로 진입 | Denial of Service | D-15: `PRAGMA integrity_check` 실패 시(errcode 26/11) 손상 파일을 격리하고 빈 DB로 재시작, 사용자에게 안내 |
| 큐/백업 파일에 남는 과거 데이터(예: 캘린더 토큰이 담긴 옛 이벤트) | Information Disclosure | 이 페이즈 범위 밖(Phase 5의 git 히스토리 스캔이 다룸) — 새 스키마 자체는 토큰류 필드를 갖지 않음 |

## Sources

### Primary (HIGH confidence — 이 세션에 직접 실행/열람하여 확인)
- 이 프로젝트에 설치된 `node_modules/electron/package.json` 직접 열람 — 버전 43.3.0
- `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd <script>`로 이 프로젝트의 실제 Electron 바이너리에서 `node:sqlite` 전체 스파이크 실행(프라그마, 트랜잭션, 파라미터 바인딩, RETURNING, 동시 잠금, 손상 파일 에러) — 로그 전문은 Code Examples 참고
- `main/db.mjs`, `main/queue.mjs`, `main/index.mjs`, `main/backup.mjs`, `main/brief.mjs`, `main/parse.mjs`, `test/queue.test.mjs`, `test/backup.test.mjs`, `package.json` 직접 열람(라인 번호 인용)
- Context7 `/websites/nodejs_latest-v24_x_api` — `node:sqlite` 안정성 등급(1.2 RC), `DatabaseSync` 생성자 옵션(timeout=busy_timeout, enableForeignKeyConstraints 기본 true), `subprocess.kill()`의 Windows SIGKILL 동작
- Context7 `/electron-userland/electron-builder` — `node_modules` 중 production dependencies만 패키징에 포함되는 동작(공식 소스 주석)

### Secondary (MEDIUM confidence)
- `.planning/research/SUMMARY.md`, `STACK.md`, `PITFALLS.md`, `ARCHITECTURE.md` — 이전 리서치 세션의 종합 결론(이번 세션은 이를 스파이크로 검증·보강)
- `.planning/codebase/CONCERNS.md`, `ARCHITECTURE.md` — 기존 코드베이스 맵

### Tertiary (LOW confidence)
- SQLite `FILTER (WHERE ...)` 절 지원 여부에 대한 판단(A1) — 이 세션에서 직접 실행 검증하지 않음, 표준 SQLite 문법 지식에 기반한 추정

## Metadata

**Confidence breakdown:**
- Standard stack (node:sqlite 채택): HIGH — 이 세션에 이 프로젝트의 실제 Electron 바이너리로 전체 기능 스파이크를 직접 실행해 확인
- Architecture(index.mjs 분할, store.mjs 경계): HIGH — 기존 코드를 직접 읽고 라인 번호까지 확인, 이전 세션 ARCHITECTURE.md와 정합
- SQL 변환(PG→SQLite): MEDIUM-HIGH — 핵심 구문(RETURNING, UPSERT, NULLS LAST, 파라미터 바인딩)은 실행 검증, `FILTER` 절만 미검증(A1)
- STOR-03 스모크 설계: MEDIUM — 메커니즘(SIGKILL 크로스플랫폼 동작)은 공식 문서로 검증, 정확한 CLI 플래그·주입 방식은 설계 스케치 수준(A2)

**Research date:** 2026-09-14
**Valid until:** 이 페이즈 실행 시점까지(Electron/Node 버전이 바뀌면 스파이크 재실행 권장 — 특히 `npm install`로 Electron이 업데이트된 경우)
