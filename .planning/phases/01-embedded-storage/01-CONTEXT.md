# Phase 1: 내장 저장소 전환 - Context

**Gathered:** 2026-09-14
**Status:** Ready for planning

<domain>
## Phase Boundary

`main/index.mjs`(1479줄)를 동작 변경 없이 lifecycle / ipc / jobs로 분리한 뒤, PostgreSQL·Docker 저장소(`main/db.mjs`)를 `node:sqlite` 기반 단일 파일 저장소(`main/store.mjs`)로 교체한다. 새 스키마는 project·item·event만 만들고, 캡처 경로의 "절대 유실되지 않는다" 보장은 큐 선기록 + 즉시 반영으로 유지하며, 강제 종료 시나리오를 스모크로 증명한다. (STOR-01 ~ STOR-05)

이 단계에서 하지 않는 것: 레거시 기능(AI·이슈·캘린더·리뷰·리포 상태)의 UI·모듈 삭제(Phase 2), JSON 내보내기·가져오기·PG 데이터 이전(Phase 3), 플랫폼 분기(Phase 4), 개명·릴리스(Phase 5). 단, `db.mjs`가 사라지면서 성립 불가능해지는 SQL 덤프 백업(`main/backup.mjs`)만 이 단계에서 함께 제거한다.

</domain>

<decisions>
## Implementation Decisions

### 캡처 쓰기 경로와 큐의 역할
- **D-01:** 캡처는 지금처럼 `queue.append`(동기 `appendFileSync`)로 먼저 남기고, 같은 호출 흐름에서 `store.insertCaptures`를 동기로 즉시 시도한다. 큐 append는 fs만 의존해 store가 어떤 이유로든 못 열려도 실패하지 않는다. 30초 주기 `flush` 타이머는 없앤다. — **Reversibility:** costly — 캡처 경로(`capture:save`, `capture:followUp`)와 트레이 pending 표시, 스모크 프로브가 모두 이 순서를 전제로 다시 짜인다.
- **D-02:** 큐 파일은 실행 중에는 줄을 지우지 않는다(append-only). 시작 시 `queue.jsonl`을 rename으로 옆에 치우고(새 캡처는 새 파일로), 치운 파일을 전부 store에 반영(`INSERT OR IGNORE`, item.id 멱등)한 뒤 삭제한다. 현 `drain`의 읽기-쓰기 사이 경합(CONCERNS.md)은 이 구조로 사라진다. 하루 종일 안 끈 경우 큐가 수백 줄까지 자라는 것은 허용한다.
- **D-03:** 실행 중 store 즉시 반영이 throw하면 store를 닫고 다시 열어 한 번 더 시도한다. 그래도 실패하면 캡처 창은 평소처럼 "저장됨"을 보이고, 트레이 툴팁과 오늘 뷰 상단에 "N건이 기다리고 있어요 — 다시 시작하면 반영됩니다" 류의 대기 건수 표시를 한다. 지금 'DB 대기' 툴팁 자리를 그대로 쓴다. OS 알림은 띄우지 않는다.
- **D-04:** STOR-03(캡처 직후 강제 종료 시 유실 없음)은 `electron --smoke` 안에서 검증한다: 실제 앱 프로세스로 캡처를 보내고 외부에서 kill → 재기동 → 오늘 뷰 상태에 그 캡처가 있는지 검사. 이 스모크는 두 OS 빌드에서 돌아야 한다(REL-05와 연결). 새 테스트는 프로젝트 제약대로 고친 코드를 되돌려 실패를 확인한다.

### 전환 기간의 레거시 기능 처리
- **D-05:** `main/db.mjs`와 pg 풀은 Phase 1에서 삭제한다. `store.mjs`는 살아남는 함수(insertCaptures·getViewState·getProjects·프로젝트 CRUD·완료/취소·프로젝트 배정·마감·대기 전환·재촉·메모·이름 변경·소프트 삭제/복구/purge·getInbox·getHistory·briefing·logEvent)만 구현한다. 두 저장소가 공존하는 기간은 없다. — **Reversibility:** one-way — 삭제 후에는 PG 경로로 되돌릴 수 없고, 개인용 코드는 태그(`v-personal`)로만 보존된다.
- **D-06:** 레거시 IPC 핸들러(issue:*, resume:*, review:*, calendar:*, backup:*, inbox:classify, item:doneSuggest* 등)는 삭제하지 않고 무해한 스텁으로 둔다: 빈 배열·`{ ok: false }` 같은 값을 돌려주고 아무것도 쓰지 않는다. 관련 백그라운드 타이머(수집·캘린더·백업·리뷰·카드 프리웜)는 끈다. 앱은 뜨고 캡처·오늘 뷰·프로젝트·대기·인박스·브리핑은 완전히 동작하되 이슈 탭 등은 빈 화면이다. Phase 2가 스텁과 UI를 걷어낸다.
- **D-07:** `pg`는 `dependencies`에서 `devDependencies`로 옮긴다. 앱 런타임 import는 0건이어야 하고, Phase 3의 `tools/` 이전 스크립트만 쓴다. electron-builder가 devDependencies를 패키징하지 않으므로 설치본에 실리지 않는다. Phase 3 끝에 완전 제거.
- **D-08:** `main/index.mjs`는 리서치안대로 `main/lifecycle.mjs`(앱 수명·트레이·창·단축키·위치 기억), `main/ipc.mjs`(모든 `ipcMain` 핸들러), `main/jobs.mjs`(타이머·백그라운드 작업)로 3분할한다. 순수 이동이어야 하며, 분할 커밋 전후로 `npm test`와 `npm run smoke`가 동일하게 통과해야 한다. 저장소 교체는 분할이 끝난 뒤 별도 커밋으로 한다.
- **D-09:** `main/backup.mjs`와 `test/backup.test.mjs`는 Phase 1에서 함께 삭제한다(RMV-04의 일부 선행). 설정 UI의 백업 버튼은 D-06 스텁 처리. 대신 `store.mjs`에 "스키마가 만드는 테이블은 project·item·event 세 개뿐"을 검증하는 가드 테스트를 넣어 STOR-05를 증명한다.

### 새 스키마의 형태
- **D-10:** `timestamptz` 계열(captured_at·done_at·nudged_at·deleted_at·event.at)은 ISO 8601 UTC 문자열 TEXT(`2026-09-14T03:00:00.000Z`)로, `due`는 타임존 없는 `YYYY-MM-DD` TEXT로 저장한다. 사전순 정렬이 시간순과 일치해야 하고, JSON 내보내기(Phase 3)와 PG 이전에서 변환 없이 지나간다. — **Reversibility:** one-way — 저장 형식 변경은 데이터 마이그레이션과 내보내기 포맷 변경을 동반한다.
- **D-11:** item의 AI·이슈용 칼럼(suggested_project_id, issue_url, done_suggested_at, done_suggest_why, done_suggest_muted_at)과 project.repo_paths는 새 스키마에 처음부터 만들지 않는다. `store.getViewState`가 이 필드를 돌려주지 않아도 렌더러가 undefined를 falsy로 처리해 깨지지 않는지 스모크로 확인한다. Phase 3 이전 스크립트는 이 칼럼을 읽지 않는다. `item.context`(JSON)는 과거 fg·meeting 값 이전용으로 TEXT(JSON 직렬화)로 남긴다.
- **D-12:** 스키마 버전은 `PRAGMA user_version` + 순차 마이그레이션 배열로 관리한다. 시작 시 현재 버전을 읽고 다음 버전부터 마지막까지 각각 트랜잭션으로 적용한다. 새 DB도 v1부터 차례로 올라가 경로가 하나다. 한 번 배포된 마이그레이션은 수정하지 않는다. — **Reversibility:** costly — 배포 후 마이그레이션 체계를 바꾸면 이미 설치된 사용자의 DB마다 버전 해석이 달라진다.
- **D-13:** 앱이 자신보다 높은 `user_version`의 DB를 만나면(구버전으로 되돌린 사용자) store를 열지 않고 오늘 뷰에 "새 버전으로 만든 데이터입니다. 앱을 업데이트해 주세요" 안내를 표시한다. 캡처는 큐에 남아 업데이트 후 반영된다. 모르는 스키마에 쓰지 않는다.

### 저장소 파일 운영
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### 요구사항·로드맵
- `.planning/ROADMAP.md` — Phase 1 Goal·Success Criteria 5개, Research flag(node:sqlite 스파이크 선행)
- `.planning/REQUIREMENTS.md` — STOR-01 ~ STOR-05 원문. RMV-04(백업 제거)·DATA-03(가져오기 전 백업)·NAME-02(데이터 폴더 개명)는 이 단계 결정과 맞닿음
- `.planning/PROJECT.md` — Core Value("아무것도 깔지 않고 단축키로 던진 할 일을 절대 잃지 않는다"), Key Decisions, Constraints(테스트는 되돌려 실패 확인)
- `.planning/STATE.md` — Blockers/Concerns: node:sqlite RC 단계 API 스파이크 필요, 큐 drain 경합은 명시적 재설계 필요

### 리서치
- `.planning/research/SUMMARY.md` — node:sqlite 선택 근거, store.mjs 경계, 큐를 예외 폴백으로 축소하는 안(이번 결정은 큐 선기록을 유지하는 쪽으로 조정됨 — D-01)
- `.planning/research/STACK.md` — node:sqlite(Electron 43 → Node 24.17.0, DatabaseSync), better-sqlite3@13.0.3 폴백 조건, 번들러 미도입 유지
- `.planning/research/PITFALLS.md` — 큐/store 크래시 경합, 반쪽 삭제, 네이티브 모듈 함정(node:sqlite로 회피)
- `.planning/research/ARCHITECTURE.md` — lifecycle/ipc/jobs 분할과 store.mjs 목표 형태

### 코드베이스 맵
- `.planning/codebase/CONCERNS.md` — "Queue drain file replacement" 경합, `main/db.mjs` 테스트 부재, settings.json BOM 함정
- `.planning/codebase/ARCHITECTURE.md` — 현 3계층 구조, IPC 40+ 핸들러 목록, 데이터 흐름

### 원 설계
- `docs/01_설계.md` — §1 캡처 손실 제로, D1(로컬 큐 선기록), D2(DB는 캡처 경로 밖), 12.6(자동으로 도는 것은 실패가 드러나야 한다)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `main/queue.mjs`: append-only JSONL, Electron 무의존, `test/queue.test.mjs` 6건. `append`·`readAll`·`count`는 그대로 쓰고 `drain`만 D-02의 "시작 시 rename → 전체 반영 → 삭제"로 교체한다. 기존 테스트 중 "drain 도중 append된 항목은 꼬리에 살아남는다"는 새 구조에서 의미가 바뀌므로 재작성 대상
- `main/db.mjs`의 살아남는 함수 SQL(`insertCaptures`의 약어→프로젝트 해석과 raw 복원, `getViewState`의 12시간 완료 표시 창, `briefing`, `nudgeItem`, `purgeDeleted`): SQL은 SQLite 문법으로 옮기되 의미와 한국어 주석(왜)은 그대로 가져간다
- `main/settings.mjs`: 디바운스 JSON 설정, 이번 단계에서 건드리지 않음
- `main/index.mjs`의 `SMOKE_PROBE`·`CAPTURE_PROBE`: `--smoke` 모드 검사 골격. D-04의 kill·재기동 스모크는 이 위에 외부 러너(`tools/` 또는 `test/`)를 더해 프로세스를 두 번 띄우는 형태가 필요하다
- `test/backup.test.mjs`의 "EXPORT_TABLES와 schemaTables 대조" 패턴: D-09의 STOR-05 가드 테스트로 형태를 이어받는다

### Established Patterns
- 팩토리 함수(`createQueue(file)`, `createSettings(file)`, `createDb(config)`) → `createStore(file)`도 같은 형태. 순수 Node 모듈이라 `node --test`로 검증
- 캡처 경로는 동기·무의존(D1). `node:sqlite`의 `DatabaseSync`가 동기라 D-01의 "같은 호출에서 즉시 반영"이 자연스럽다
- 비치명 오류는 조용히 삼키고 기능을 막지 않음(`logEvent`의 try/catch, settings 읽기 실패 시 기본값). store 실패도 같은 태도 + D-03의 드러내기
- 소프트 삭제(`deleted_at`) + `PURGE_DAYS`(30일) 물리 삭제 — 새 스키마도 유지
- item.id는 캡처 시 `crypto.randomUUID()`로 만들어 큐에 실림 → `INSERT OR IGNORE`의 멱등 키(D-02)

### Integration Points
- `main/index.mjs` `flush()`(422행), `capture:save`(1042행), `capture:followUp`(1065행), `today:getState`(1079행): 저장소 교체가 닿는 핵심. 분할 후에는 `ipc.mjs`·`jobs.mjs`에 있게 된다
- `refreshTrayMenu()`와 'DB 대기' 툴팁: D-03 대기 건수 표시 자리
- `app.whenReady`(1408~1430행)의 타이머 등록: D-06에서 레거시 타이머를 끄고, D-02의 시작 시 큐 반영을 여기서 1회 호출
- `app.on('before-quit')` 계열: D-17의 `wal_checkpoint(TRUNCATE)`와 store close
- `package.json` `dependencies.pg` → `devDependencies`(D-07). `build.files`는 `main/**/*`라 새 모듈은 자동 포함
- 렌더러 `renderer/today.js`: `state.issues`·`state.repoStates`·`events`·done_suggest 필드가 비거나 없어도 렌더링이 깨지지 않는지(D-06·D-11) 스모크 확인 대상

</code_context>

<specifics>
## Specific Ideas

- 즉시 반영 실패 시 캡처 창은 사용자에게 실패를 보이지 않는다("저장됨"). 실패는 트레이 툴팁·오늘 뷰 상단의 대기 건수로만 드러난다 — "던진 게 오늘 뷰에 없네"를 유실로 오해하지 않게 하되, 캡처 순간을 불안하게 만들지 않는다
- 손상 DB는 지우지 않고 반드시 보존한다(`store.corrupt-*.sqlite`). 사용자가 나중에 되살릴 여지를 남긴다
- 파일 이름에는 앱 이름을 넣지 않는다(`store.sqlite`, `queue.jsonl`) — Phase 5 개명이 파일명을 건드리지 않게
- 스모크가 두 OS에서 도는 것이 전제라 kill 방식은 OS별 차이를 흡수해야 한다(Windows `taskkill /F` vs POSIX SIGKILL)

</specifics>

<deferred>
## Deferred Ideas

- **매일 store 파일 복사 백업**: 백업 대체 수단으로 논의됐으나 RMV-04 결정(백업은 JSON 내보내기가 대신)과 충돌해 채택하지 않음. 필요하면 Phase 3에서 JSON 내보내기의 자동 실행으로 검토
- **STOR-03의 node --test 수준 자식 프로세스 SIGKILL 테스트**: 사용자는 스모크 방식을 택했다. 단위 수준 재현은 Claude 재량으로 남김

</deferred>

---

*Phase: 01-내장 저장소 전환*
*Context gathered: 2026-09-14*
