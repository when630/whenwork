# WHENWORK

개인용 프로젝트별 업무 관리 트레이 앱 (Windows, Electron).

여러 프로젝트를 오가며 일하는 1인 사용자를 위해 세 가지 공백을 메운다:

1. **할 일 캡처** — 글로벌 단축키(`Ctrl+Alt+Space`) 원라인 퀵캡처, 분류는 나중에
2. **재개 컨텍스트** — git 활동 + AI 요약으로 "마지막 작업 / 멈춘 지점 / 다음 액션 1개" 카드
3. **대기 추적** — waiting-for 항목과 경과일

"한 일"은 git에서 자동 수집하고, 손 입력은 "할 일"에만 국한한다. AI 가공은 `claude -p`(구독 OAuth)로 수행하며, AI 생성물은 언제든 버리고 재생성 가능하다.

## 문서

- [설계 v1.1](docs/01_설계.md) — 배경·아키텍처·설계 결정(D1~D6)·데이터 모델·마일스톤
- [UI 목업 v0.2](docs/mockups/index.html) — 퀵캡처·오늘 뷰·재개 카드 정적 목업 (브라우저로 열기)

## 실행

```bash
npm install        # postinstall이 트레이 아이콘을 굽는다
docker compose up -d   # PostgreSQL (localhost:5433) — 없어도 캡처는 동작 (로컬 큐)
npm start
```

- `Ctrl+Alt+Space` — 퀵캡처
- 트레이 클릭 — 오늘 뷰 (Tab 탭 전환 · ↑↓ 이동 · Space 완료 · 1~9 프로젝트 지정 · W 대기 · X 삭제)
- `npm test` — 큐 단위 테스트, `npm run smoke` — 부팅 스모크

## 상태

| 단계 | 내용 | 상태 |
|---|---|---|
| M1 | 트레이 + 퀵캡처 + 로컬 큐 + PostgreSQL + 오늘 뷰 | ✅ 구현 (도그푸딩 중) |
| M2 | git 수집기 + 재개 카드 (`claude -p`) + GH/GL 이슈 | 예정 |
| M3 | 인박스 AI 분류 + 주간 리뷰 | 예정 |
