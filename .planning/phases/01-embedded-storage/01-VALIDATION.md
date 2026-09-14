---
phase: "1"
slug: "embedded-storage"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: false
created: "2026-09-14"
updated: "2026-09-14"
---

# Phase 1 — Validation Strategy

> 실행 중 피드백 샘플링을 위한 페이즈 검증 계약. 모든 계획의 `<verify>` 명령이 이 표와 일치해야 한다.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node 내장 `node --test` (신규 프레임워크 도입 없음) |
| **Config file** | none — `package.json`의 `"test": "node --test \"test/**/*.test.mjs\""` |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test && npm run smoke` |
| **Estimated runtime** | 기존 단위 테스트 ~수 초 · `npm run smoke` ~5초 · `npm run smoke:crash` ~30초(Electron 2회 기동) |

`main/store.mjs`는 Electron을 import하지 않는 순수 Node 모듈이라 시스템 Node로 직접 테스트된다. 계획 단계에서 확인: 시스템 Node 24.13.0이 `node:sqlite`를 플래그 없이 로드하며(stderr에 `ExperimentalWarning` 1줄 — 테스트 실패 요인 아님) SQLite 3.50.4를 쓴다. Electron 43.3.0 번들은 Node 24.18.1 / SQLite 3.53.1이다. `FILTER`·`NULLS LAST`·`RETURNING`·`AUTOINCREMENT`는 두 빌드 모두에서 동작 확인됨.

---

## Sampling Rate

- **작업 커밋마다:** `npm test`
- **계획(wave) 병합마다:** `npm test && npm run smoke`
- **`/gsd-verify-work` 전:** `npm test && npm run smoke && npm run smoke:crash` 전부 그린
- **Max feedback latency:** 60초 (강제종료 스모크 포함 시 120초)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 1-01-01 | 01 | 1 | STOR-01 | T-01-01-02 | 프로브 문자열 이동 중 초기화 깨짐 없음 | regression | `npm test` · `npm run smoke` | ✅ | ⬜ pending |
| 1-01-02 | 01 | 1 | STOR-01 | T-01-01-01 | IPC 인자 검증 로직 유지 | regression | `npm test` · `npm run smoke` | ✅ | ⬜ pending |
| 1-01-03 | 01 | 1 | STOR-01 | T-01-01-01 | preload 채널 전수 이동 | regression | `npm test` · `npm run smoke` | ✅ | ⬜ pending |
| 1-02-01 | 02 | 2 | STOR-04 | — | (checkpoint:decision — v1 DDL 확정) | n/a | n/a | n/a | ⬜ pending |
| 1-02-02 | 02 | 2 | STOR-01, STOR-05 | T-01-02-01 | 파라미터 바인딩만 사용 | unit + smoke | `node --test test/store.test.mjs` · `npm run smoke` | ❌ W0 | ⬜ pending |
| 1-02-03 | 02 | 2 | STOR-04 | T-01-02-02/03/05 | 손상만 격리, 상위 버전에 쓰기 0건 | unit | `node --test test/store.test.mjs` | ❌ W0 | ⬜ pending |
| 1-03-01 | 03 | 3 | STOR-02 | T-01-03-01 | rename 후 성공한 파일만 삭제 | unit | `node --test test/queue.test.mjs` | ⚠️ 재작성 | ⬜ pending |
| 1-03-02 | 03 | 3 | STOR-02 | T-01-03-02/05 | 멱등 반영, 주기 타이머 없음 | regression | `npm test` · `npm run smoke` | ✅ | ⬜ pending |
| 1-03-03 | 03 | 3 | STOR-02 | T-01-03-03/04 | 안내에 내부 정보 미노출 | regression + human | `npm test` · `npm run smoke` + 사람 확인 | ✅ | ⬜ pending |
| 1-04-01 | 04 | 3 | STOR-01, STOR-05 | T-01-04-01/02/04 | 바인딩 사용, purge 경계 정확 | unit | `node --test test/store.test.mjs` | ❌ W0 | ⬜ pending |
| 1-04-02 | 04 | 3 | STOR-01 | T-01-04-03 | 축소 briefing이 문구 로직을 통과 | unit | `node --test test/store.test.mjs` · `node --test test/brief.test.mjs` | ❌ W0 | ⬜ pending |
| 1-05-01 | 05 | 4 | STOR-01 | T-01-05-01/02/03 | 스텁 무해, 채널 삭제 0건 | smoke | `npm test` · `npm run smoke` | ✅ | ⬜ pending |
| 1-05-02 | 05 | 4 | STOR-01 | T-01-05-04 | 외부 CLI 호출 타이머 0건 | smoke + human | `npm test` · `npm run smoke` + 사람 확인 | ✅ | ⬜ pending |
| 1-06-01 | 06 | 5 | STOR-01 | T-01-06-01 | (checkpoint:decision — v-personal 태그 위치) | n/a | n/a | n/a | ⬜ pending |
| 1-06-02 | 06 | 5 | STOR-01 | T-01-06-02/03/04 | 가드 이관 확인, pg 미배포 | regression | `npm test` · `npm run smoke` · `node -e`(package.json 검사) | ✅ | ⬜ pending |
| 1-07-01 | 07 | 6 | STOR-03 | T-01-07-02 | 주입 모드는 `--smoke`에서만 | smoke | `npm run smoke` | ✅ | ⬜ pending |
| 1-07-02 | 07 | 6 | STOR-03 | T-01-07-01/03/04 | 임시 폴더 격리, 진짜 하드 킬 | smoke(외부 프로세스 하네스) | `npm run smoke:crash` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/store.test.mjs` — 신규. STOR-01·04·05와 STOR-02 일부를 덮는다 (01-02가 만들고 01-04가 넓힌다). `fs.mkdtempSync` 임시 파일 DB 관례는 `test/queue.test.mjs`에서 이어받는다
- [ ] `test/queue.test.mjs` — 재작성. "drain 도중 append" 테스트(39-46행)가 D-02의 rename 구조에서 의미가 바뀐다 (01-03)
- [ ] `test/capture-crash-smoke.test.mjs` — 신규. STOR-03 전용 두 프로세스 하네스. `--smoke`의 캡처 주입 서브모드가 선행 조건 (01-07)
- [ ] 프레임워크 설치: 불필요 — `node --test`는 Node 내장

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| 캡처 실패 시 캡처 창은 저장됨만, 대기 건수는 트레이·오늘 뷰에만 | STOR-02 (D-03) | 트레이 툴팁과 OS 알림 부재는 화면 밖 상태라 자동으로 관측하기 어렵다 | 저장소 파일을 잠근 뒤 캡처 → 캡처 창 문구, 트레이 툴팁, 오늘 뷰 상단, OS 알림 미발생을 눈으로 확인 (01-03 Task 3) |
| 백그라운드에서 외부 CLI가 하나도 뜨지 않음 | STOR-01 (D-06) | 프로세스 생성 부재는 시간 축 관측이라 단위 테스트로 잡기 어렵다 | 앱을 몇 분 띄워 두고 작업 관리자에서 git·gh·glab·claude 프로세스 부재 확인 (01-05 Task 2) |
| macOS에서 강제종료 스모크 통과 | STOR-03 (D-04, REL-05) | macOS 실기기 미확보 (RESEARCH `## Environment Availability`) | 실기기 확보 후 `npm run smoke:crash` 1회. 이 페이즈는 Windows 통과까지가 완료 기준이며 갭을 SUMMARY에 명시한다 |

---

## Validation Sign-Off

- [x] 모든 작업에 `<automated>` verify 또는 Wave 0 의존이 있다 (checkpoint 2건 제외)
- [x] 샘플링 연속성: 자동 검증 없는 작업이 3연속으로 이어지지 않는다
- [x] Wave 0이 신규/재작성 테스트 파일 3개를 모두 덮는다
- [x] watch 모드 플래그 없음
- [x] 피드백 지연 < 120초
- [x] `nyquist_compliant: true`

**Approval:** pending
