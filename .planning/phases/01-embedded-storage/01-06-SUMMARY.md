---
phase: 01-embedded-storage
plan: 06
subsystem: infra
tags: [electron, sqlite, pg, packaging, cleanup]

# Dependency graph
requires:
  - phase: 01-05
    provides: "main/ipc.mjs·main/jobs.mjs가 전량 ctx.store로 위임 — main/db.mjs를 부르는 곳이 코드베이스 어디에도 없음(죽은 파일 확정)"
provides:
  - "main/db.mjs·main/backup.mjs·test/backup.test.mjs 삭제 — 두 저장소가 공존하는 기간 없음(D-05)"
  - "package.json — pg가 devDependencies로 이동, dependencies 키 자체가 사라짐(D-07)"
  - "git tag v-personal(98c17e3) — 개인용 PostgreSQL 버전이 온전히 돌던 마지막 지점"
  - "git tag v-personal-lastmix(d9416cc) — 분할·새 저장소·PG 코드가 전부 공존하는 유일한 지점"
affects: [01-07, phase-3-data-migration, phase-5-release]

# Actuals (#2632)
actuals:
  tokens: 15300
  tasks: 2
  commits: 1

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "pg는 devDependencies에만 존재 — electron-builder는 production dependencies만 asar에 담으므로 설치본에 pg가 실리지 않는다(npm run build로 실측 확인)"

key-files:
  created: []
  modified:
    - package.json
    - package-lock.json
    - main/lifecycle.mjs
    - main/store.mjs

key-decisions:
  - "v-personal 태그를 두 지점(both)에 나눠 달았다 — v-personal(98c17e3, 이 페이즈 시작 직전, PostgreSQL 앱이 마지막으로 온전히 돌던 지점)과 v-personal-lastmix(d9416cc, main/db.mjs 삭제 직전 HEAD, 분할·새 저장소·PG 코드가 전부 공존하는 유일한 지점). 사용자 결정: 돌아갈 지점과 비교할 지점을 분리해 둘 다 잃지 않는다 — Phase 5 공개 리포 분리 때 무엇을 남길지 한 번 정한다"
  - "STOR-05 가드 테스트는 이미 01-02에서 test/store.test.mjs로 이관되어 있었다 — test/backup.test.mjs의 '스키마의 모든 테이블이 백업에 담긴다' 대조를 다시 옮길 필요 없이 그대로 삭제했다(D-09 선행 확인)"
  - "main/lifecycle.mjs·main/store.mjs에 남아 있던 'main/db.mjs' 리터럴 문자열 주석 3곳을 '이전 PostgreSQL 저장소 모듈'로 바꿔 썼다 — plan의 acceptance criteria(`! grep -rln \"db\\.mjs|backup\\.mjs\" main/ test/ renderer/`)가 코드가 아니라 주석 속 문자열에도 걸리는 리터럴 검사였기 때문(Rule 3, 스코프는 두 파일의 주석 세 줄뿐, 로직 변경 없음)"
  - "package.json의 pg 이동은 npm install --package-lock-only로 lockfile만 재동기화했다 — 새 설치·버전 변경 없음(plan 지시대로). postinstall(tools/make-icon.mjs)이 함께 돌아 build/ 아이콘을 재생성했으나 build/는 gitignore 대상이라 git 상태에 영향 없음"

patterns-established: []

requirements-completed: [STOR-01]

coverage:
  - id: D1
    description: "main/db.mjs·main/backup.mjs·test/backup.test.mjs 세 파일이 워킹트리와 git 인덱스에서 삭제됨"
    requirement: "STOR-01"
    verification:
      - kind: other
        ref: "test ! -f main/db.mjs && test ! -f main/backup.mjs && test ! -f test/backup.test.mjs && echo DELETED_OK — DELETED_OK 출력 확인"
        status: pass
      - kind: other
        ref: "git diff --diff-filter=D --name-only HEAD~1 HEAD — main/backup.mjs, main/db.mjs, test/backup.test.mjs 정확히 세 건만 출력"
        status: pass
    human_judgment: false
  - id: D2
    description: "package.json의 pg가 devDependencies로만 존재하고 dependencies에는 없다 — electron-builder 설치본(app.asar)에 실리지 않는다"
    requirement: "STOR-01"
    verification:
      - kind: other
        ref: "node -e 검증 스크립트(pg is still a runtime dependency / pg missing from devDependencies 둘 다 확인) — PG_CHECK_OK"
        status: pass
      - kind: other
        ref: "npm run build (electron-builder --win) 성공 후 @electron/asar listPackage로 dist/win-unpacked/resources/app.asar 안 pg 관련 엔트리 0건 확인"
        status: pass
    human_judgment: false
  - id: D3
    description: "리포 전체에서 db.mjs/backup.mjs 리터럴 문자열과 'pg' 런타임 import가 사라짐 — 죽은 참조 없음"
    requirement: "STOR-01"
    verification:
      - kind: other
        ref: "! grep -rln \"db\\.mjs|backup\\.mjs\" main/ test/ renderer/ — 매치 없음(exit 1)"
        status: pass
      - kind: other
        ref: "! grep -rn \"'pg'\" main/ renderer/ — 매치 없음(exit 1)"
        status: pass
    human_judgment: false
  - id: D4
    description: "v-personal·v-personal-lastmix 두 태그가 정확한 커밋에 생성되어 개인용 PostgreSQL 버전으로 되돌아갈 표식이 git에 남는다"
    requirement: "STOR-01"
    verification:
      - kind: other
        ref: "git tag --list 'v-personal*' — v-personal, v-personal-lastmix 둘 다 출력. git for-each-ref로 각 태그가 98c17e3/d9416cc를 가리키는지 확인"
        status: pass
    human_judgment: false
  - id: D5
    description: "npm test·npm run smoke가 통과하고, 통과 수 감소 폭(219→205)이 삭제된 test/backup.test.mjs의 테스트 수(14건)와 정확히 일치한다 — 다른 테스트가 함께 끊기지 않았다"
    requirement: "STOR-01"
    verification:
      - kind: unit
        ref: "npm test — 205/205 pass (기존 219건 - test/backup.test.mjs 14건)"
        status: pass
      - kind: automated_ui
        ref: "npm run smoke → SMOKE_OK hotkey=false pending=0"
        status: pass
    human_judgment: false
  - id: D6
    description: "Docker 컨테이너를 정지시킨 상태에서 앱을 띄워 캡처·오늘 뷰·프로젝트·대기·인박스·완료 이력이 전부 동작한다"
    requirement: "STOR-01"
    verification: []
    human_judgment: true
    rationale: "이 샌드박스는 전역 단축키·트레이가 등록되지 않아(01-01~01-05 SUMMARY와 동일한 한계) 실제 데스크톱에서 단축키로 캡처해 오늘 뷰까지 눈으로 확인하는 절차는 여기서 재현할 수 없다. npm run smoke가 Docker 없이(store.sqlite 단독) SMOKE_OK로 통과하는 것으로 저장소 계층의 무Docker 동작은 증명했지만, 실제 데스크톱 조작(단축키·트레이·완료 이력 UI)의 최종 확인은 사람 몫이다."

# Metrics
duration: 7min
completed: 2026-09-15
status: complete
---

# Phase 1 Plan 6: PostgreSQL 코드 삭제와 v-personal 태그 보존 Summary

**`main/db.mjs`·`main/backup.mjs`·`test/backup.test.mjs`를 삭제하고 `pg`를 `devDependencies`로 격하해, 앱이 PostgreSQL·Docker 없이 완전히 동작함을 되돌릴 수 없는 상태로 확정했다. 삭제 전에 개인용 버전을 `v-personal`(온전히 돌던 마지막 지점)과 `v-personal-lastmix`(분할·새 저장소·PG 코드 공존 지점) 두 태그로 나눠 보존했다.**

## Performance

- **Duration:** 약 7분 (Task 2 코드 작업 기준 — 직전 커밋 d9416cc 2026-09-15T10:11:45+09:00 ~ Task 2 커밋 920821a 2026-09-15T10:18:34+09:00. Task 1의 `checkpoint:decision`은 이 continuation dispatch 이전에 오케스트레이터가 사용자에게 제시하고 `both`로 해결함)
- **Started:** 2026-09-15T01:11:45Z (근사, d9416cc 직후)
- **Completed:** 2026-09-15T01:18:34Z
- **Tasks:** 2/2 (Task 1은 태그 생성만, 커밋 없음 — git tag는 커밋이 아님)
- **Files modified:** 7 (delete 3 + modify 4: package.json, package-lock.json, main/lifecycle.mjs, main/store.mjs)

## Accomplishments
- `main/db.mjs`(997줄, PostgreSQL 풀·스키마·CRUD)와 `main/backup.mjs`(54줄, SQL 덤프 백업), `test/backup.test.mjs`(101줄, 14개 테스트)를 `git rm`으로 삭제 — STOR-05 가드는 이미 01-02에서 `test/store.test.mjs`로 이관돼 있어 별도 이관 없이 안전하게 지웠다
- `package.json`의 `pg`를 `dependencies`에서 `devDependencies`로 옮기고 `dependencies` 키 자체를 제거, 버전(`^8.13.0`)은 그대로, 새 설치 없음(`npm install --package-lock-only`로 lockfile만 재동기화)
- `main/lifecycle.mjs`·`main/store.mjs`에 남아 있던 "main/db.mjs" 리터럴 문자열 주석 3곳을 의미는 그대로 두고 문자열만 바꿔, plan의 리터럴 grep acceptance criteria가 통과하게 함
- `v-personal`(98c17e3, annotated tag → d931015) 태그를 이 페이즈 시작 직전 커밋("docs(01): create phase plan")에, `v-personal-lastmix`(d9416cc, annotated tag → ba34bdf)를 삭제 직전 HEAD(01-05 완료 커밋)에 생성
- `npm test` 205/205(219건에서 삭제된 `test/backup.test.mjs`의 정확히 14건만 감소 — 다른 테스트 영향 없음 확인), `npm run smoke` → `SMOKE_OK`, `npm run build`(electron-builder --win) 성공 후 `app.asar` 내부에 `pg` 관련 엔트리 0건임을 `@electron/asar`로 직접 확인

## Task Commits

Task 1(`checkpoint:decision`)은 태그 생성만 수행하며 커밋을 만들지 않습니다(git tag는 커밋 대상이 아님). Task 2는 단일 커밋으로 완결했습니다:

1. **Task 1: v-personal 태그를 어느 지점에 달 것인가** - 태그만 생성, 커밋 없음 (`v-personal`→98c17e3, `v-personal-lastmix`→d9416cc)
2. **Task 2: PostgreSQL 코드 삭제와 pg 격하** - `920821a` (chore)

**Plan metadata:** (다음 커밋에서 추가 — 이 SUMMARY.md/STATE.md/ROADMAP.md/REQUIREMENTS.md)

## Files Created/Modified
- `main/db.mjs` (삭제, 997줄) - PostgreSQL 풀·스키마·CRUD. 아무도 부르지 않는 죽은 파일이었음(01-05 SUMMARY 확인)
- `main/backup.mjs` (삭제, 54줄) - SQL 덤프 백업. Phase 3의 JSON 내보내기가 대신함(D-09)
- `test/backup.test.mjs` (삭제, 101줄, 14개 테스트) - STOR-05 가드는 이미 `test/store.test.mjs`로 이관되어 안전하게 삭제
- `package.json` (수정) - `pg`를 `devDependencies`로 이동, `dependencies` 키 제거
- `package-lock.json` (수정) - `npm install --package-lock-only`로 루트 `devDependencies`/`dependencies` 블록과 `pg`·`pg-*` 서브패키지들의 `"dev": true` 표시 재동기화
- `main/lifecycle.mjs` (수정, 3줄) - 죽은 `main/db.mjs` 참조 주석 정리
- `main/store.mjs` (수정, 2곳) - 죽은 `main/db.mjs` 참조 주석 정리

## Decisions Made
- v-personal 태그 위치: 사용자가 `both`를 선택 — `v-personal`(되돌아갈 지점, 98c17e3)과 `v-personal-lastmix`(비교할 지점, d9416cc)를 분리해 둘 다 보존. 근거: 돌아갈 지점과 비교할 지점을 분리해 둘 다 잃지 않는다, Phase 5 공개 리포 분리 때 무엇을 남길지 한 번 정한다
- STOR-05 가드가 이미 01-02에서 이관돼 있음을 `<read_first>` 지시대로 사전 확인해, 별도 이관 작업 없이 `test/backup.test.mjs` 삭제로 바로 진행
- 죽은 참조 주석 3곳 정리는 plan의 `<files>` 선언(package.json, main/db.mjs, main/backup.mjs, test/backup.test.mjs) 밖의 `main/lifecycle.mjs`·`main/store.mjs`를 건드렸지만, acceptance criteria가 요구하는 리터럴 grep 통과를 위한 필수 최소 수정이었다(로직 변경 없음, 주석 문자열만)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] plan의 `<files>` 선언 밖 파일(main/lifecycle.mjs, main/store.mjs)의 죽은 참조 주석 수정**
- **Found during:** Task 2 acceptance criteria 사전 검증(`grep -rln "db\.mjs\|backup\.mjs" main/ test/ renderer/`)
- **Issue:** plan의 `<files>`는 `package.json, main/db.mjs, main/backup.mjs, test/backup.test.mjs` 넷만 선언했지만, acceptance criteria는 `main/ test/ renderer/` 전체에서 `db\.mjs`·`backup\.mjs` 리터럴 문자열이 하나도 없어야 한다고 요구했다. `main/lifecycle.mjs:375`(01-05가 남긴 "main/db.mjs는 이제 아무도 부르지 않는 죽은 파일" 주석)와 `main/store.mjs:1,536`(01-02가 남긴 "main/db.mjs 대체" 등 주석) 세 곳이 이 리터럴 검사에 걸렸다 — import가 아니라 순수 설명 주석이었지만 grep은 문자열 단위로 본다
- **Fix:** 세 곳의 주석에서 리터럴 "db.mjs" 문자열만 "이전 PostgreSQL 저장소 모듈"로 바꾸고 의미·논리는 그대로 두었다
- **Files modified:** main/lifecycle.mjs, main/store.mjs
- **Verification:** `! grep -rln "db\.mjs\|backup\.mjs" main/ test/ renderer/` — 매치 없음(exit 1). `npm test` 205/205 영향 없음
- **Committed in:** 920821a (Task 2 커밋)

---

**Total deviations:** 1 auto-fixed (1 blocking — plan 파일 범위 밖 주석 3줄, acceptance criteria 통과를 위한 최소 수정)
**Impact on plan:** 로직·동작 변경 없음, 순수 주석 텍스트 교정. 스코프 크리프 없음 — plan이 명시한 acceptance criteria 자체가 요구한 결과다.

## Issues Encountered
None beyond the deviation documented above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `main/db.mjs`·`main/backup.mjs`·`test/backup.test.mjs`가 리포에서 완전히 사라졌고, `pg`는 `devDependencies`로만 남아 설치본에 실리지 않는다(`npm run build`로 실측 확인) — D-05·D-07·D-09가 전부 되돌릴 수 없는 상태로 완료됨
- `v-personal`(98c17e3)·`v-personal-lastmix`(d9416cc) 두 태그가 로컬에 존재 — Phase 3의 PostgreSQL 데이터 이전 스크립트나 Phase 5의 공개 리포 분리 작업이 필요하면 이 지점들을 참조할 수 있다(태그는 push하지 않았다)
- `docker-compose.yml`과 `db` npm 스크립트는 그대로 남아 있다 — Phase 3 이전 스크립트가 컨테이너를 읽어야 한다(D-05/CONTEXT 결정대로)
- 01-07은 여전히 pending이며 STOR-01을 함께 선언한 마지막 sibling 플랜이다 — `requirements.mark-complete`는 이번에도 실행했지만 STOR-01은 이미 01-02에서 Complete로 표시돼 있어 no-op이었다(파일 변경 없음)
- 이 샌드박스는 전역 단축키·트레이가 등록되지 않아(01-01~01-05 SUMMARY와 동일한 한계) 실제 Windows 데스크톱에서 Docker/PostgreSQL을 완전히 끈 상태로 캡처·완료·프로젝트 생성·대기 전환·마감 지정이 전부 동작하는지 한 번 더 눈으로 확인하는 것을 권한다(D6 human_judgment)
- 블로커 없음

## Self-Check: PASSED

- FOUND: package.json, package-lock.json, main/lifecycle.mjs, main/store.mjs (수정 확인) / main/db.mjs, main/backup.mjs, test/backup.test.mjs (삭제 확인 — `test ! -f` 세 건 모두 통과)
- FOUND commit: 920821a
- Re-ran plan-level `<verification>`: `git tag --list 'v-personal*'` 둘 다 출력, `test ! -f main/db.mjs && test ! -f main/backup.mjs && test ! -f test/backup.test.mjs` → DELETED_OK, `node -e` pg 위치 검증 → PG_CHECK_OK, `npm test` exit 0(205/205), `npm run smoke` → SMOKE_OK, `npm run build` 성공 + app.asar 내 pg 엔트리 0건
- `plan_head_before: d9416ccf8174ac9871fa26f7dda9a0b3c2c0631a`, `commits: 1` (측정: `git rev-list --count d9416cc..HEAD`)

---
*Phase: 01-embedded-storage*
*Completed: 2026-09-15*
