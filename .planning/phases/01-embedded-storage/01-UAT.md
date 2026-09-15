---
status: testing
phase: 01-embedded-storage
source: [01-VERIFICATION.md]
started: 2026-09-15T01:46:48Z
updated: 2026-09-15T01:46:48Z
---

## Current Test

number: 1
name: 트레이·오늘 뷰의 대기 건수/저장소 안내와 조용한 실패(D-03)
expected: |
  캡처 창은 실패를 보이지 않고, 트레이 툴팁·오늘 뷰 상단에 대기 건수/손상 안내가 조용히 드러나며, OS 알림은 뜨지 않는다 (D-03). 출처: 01-03-PLAN.md Task 3 <human-check>
awaiting: user response

## Tests

### 1. 트레이·오늘 뷰의 대기 건수/저장소 안내와 조용한 실패(D-03)
test: 실제 Windows 데스크톱에서 앱을 띄워 전역 단축키(Ctrl+Alt+Space)로 캡처하고, 트레이 툴팁·오늘 뷰 상단에서 대기 건수·저장소 안내가 정상 렌더링되는지 눈으로 확인한다. store.sqlite가 있는 폴더를 잠근 뒤 캡처해 (a) 캡처 창이 평소처럼 저장됨만 보이고 (b) OS 알림이 뜨지 않으며 (c) 트레이 툴팁·오늘 뷰 상단에만 대기 건수가 뜨는지 확인한다
expected: 캡처 창은 실패를 보이지 않고, 트레이 툴팁·오늘 뷰 상단에 대기 건수/손상 안내가 조용히 드러나며, OS 알림은 뜨지 않는다 (D-03). 출처: 01-03-PLAN.md Task 3 <human-check>
result: [pending]

### 2. 레거시 백그라운드 작업·트레이 메뉴 제거와 아침 브리핑(D-06)
test: 앱을 몇 분 띄워 두고 트레이 메뉴를 연다. 수집·백업·주간 리뷰 항목이 없고 git·gh·glab·claude 프로세스가 하나도 뜨지 않는지 확인한다. 아침 브리핑 시각을 방금 지난 시각으로 설정을 바꿨을 때 OS 알림이 한 번 뜨는지 확인한다
expected: 레거시 백그라운드 작업(수집·백업·주간 리뷰·재개 카드·완료 제안)이 전혀 동작하지 않고, 남은 배경 작업은 큐 반영(1회)·아침 브리핑·purge뿐이다 (D-06). 출처: 01-05-PLAN.md Task 2 <human-check>
result: [pending]

### 3. macOS 실기기에서 강제 종료 캡처 생존 재현(D-04)
test: macOS 실기기에서 `npm run smoke:crash`를 한 번 더 돌린다
expected: Windows와 동일하게 캡처 직후 SIGKILL → 재기동 → 오늘 뷰 인박스에 캡처가 있음이 재현된다. macOS 실기기 확보 전까지는 blocked — Phase 4/5(REL-05)로 이월된 항목. 출처: 01-07-PLAN.md Task 2 <human-check>
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps
