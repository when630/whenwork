---
status: partial
phase: 01-embedded-storage
source: [01-VERIFICATION.md]
started: 2026-09-15T01:46:48Z
updated: 2026-09-15T02:48:50.036Z
---

## Current Test

[testing complete]

## Tests

### 1. 트레이·오늘 뷰의 대기 건수/저장소 안내와 조용한 실패(D-03)
test: 실제 Windows 데스크톱에서 앱을 띄워 전역 단축키(Ctrl+Alt+Space)로 캡처하고, 트레이 툴팁·오늘 뷰 상단에서 대기 건수·저장소 안내가 정상 렌더링되는지 눈으로 확인한다. store.sqlite가 있는 폴더를 잠근 뒤 캡처해 (a) 캡처 창이 평소처럼 저장됨만 보이고 (b) OS 알림이 뜨지 않으며 (c) 트레이 툴팁·오늘 뷰 상단에만 대기 건수가 뜨는지 확인한다
expected: 캡처 창은 실패를 보이지 않고, 트레이 툴팁·오늘 뷰 상단에 대기 건수/손상 안내가 조용히 드러나며, OS 알림은 뜨지 않는다 (D-03). 출처: 01-03-PLAN.md Task 3 <human-check>
result: pass
note: "캡처→큐→저장소 경로는 실증됨(queue.jsonl 3줄 → store item 3건, 11:43). 폴더 잠금 시 조용한 실패(D-03 (a)(b)(c))는 미관측 — 남은 확인 항목"

### 2. 레거시 백그라운드 작업·트레이 메뉴 제거와 아침 브리핑(D-06)
test: 앱을 몇 분 띄워 두고 트레이 메뉴를 연다. 수집·백업·주간 리뷰 항목이 없고 git·gh·glab·claude 프로세스가 하나도 뜨지 않는지 확인한다. 아침 브리핑 시각을 방금 지난 시각으로 설정을 바꿨을 때 OS 알림이 한 번 뜨는지 확인한다
expected: 레거시 백그라운드 작업(수집·백업·주간 리뷰·재개 카드·완료 제안)이 전혀 동작하지 않고, 남은 배경 작업은 큐 반영(1회)·아침 브리핑·purge뿐이다 (D-06). 출처: 01-05-PLAN.md Task 2 <human-check>
result: pass
note: "코드·프로세스 수준 확인: 앱 자식 프로세스는 electron뿐(git·gh·glab·claude 없음), 트레이 메뉴 6개 항목에 수집·백업·주간리뷰 없음(lifecycle.mjs:642-674), 남은 타이머는 purge·maybeBrief뿐(jobs.mjs:94-96). 트레이 메뉴 렌더링과 아침 브리핑 OS 알림 팝업은 미관측 — lastBriefing이 오늘로 찍혀 있어 오늘은 구조상 안 뜸(brief.mjs briefDecision)"

### 3. macOS 실기기에서 강제 종료 캡처 생존 재현(D-04)
test: macOS 실기기에서 `npm run smoke:crash`를 한 번 더 돌린다
expected: Windows와 동일하게 캡처 직후 SIGKILL → 재기동 → 오늘 뷰 인박스에 캡처가 있음이 재현된다. macOS 실기기 확보 전까지는 blocked — Phase 4/5(REL-05)로 이월된 항목. 출처: 01-07-PLAN.md Task 2 <human-check>
result: blocked
blocked_by: physical-device
reason: "macOS 실기기 없음 — Phase 4/5(REL-05)로 이월"

## Summary

total: 3
passed: 2
issues: 0
pending: 0
skipped: 0
blocked: 1

## Gaps
