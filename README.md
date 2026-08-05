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

설치본으로 쓰려면 `npm run build` → `dist/WHENWORK Setup <version>.exe`. 설치본은 로그인 시 자동 시작이 기본으로 켜진다(트레이에서 끌 수 있음).

### 조작

- `Ctrl+Alt+Space` — 퀵캡처 토글. 저장해도 창은 열려 있어 연달아 던질 수 있고, `Tab`이면 오늘 뷰로. 끝에 `#gw` 같은 약어를 붙이면 인박스를 건너뛰고 그 프로젝트로 바로 간다
- 트레이 클릭 — 오늘 뷰. `Tab` 탭 전환 · `↑↓`(`jk`) 이동 · `Space` 완료 · `E` 제목 · `D` 마감일 · `N` 메모 · `X` 삭제 · `Enter` 재개 카드
- 인박스 — `A` AI 분류 제안 → `Enter` 확정, `1~9` 직접 지정, `W` 대기로
- 프로젝트 탭 — `N` 추가 · `E` 이름 · `A` 약어 · `R` 리포 경로 · `Shift+↑↓` 순서 · `X` 보관
- 재개 카드 — AI 3문항(`claude -p`) + git 활동 + 내 GH/GL 이슈. `R` 재생성, `Enter`/`O` 이슈 열기
- 트레이 메뉴 — 주간 리뷰 초안 만들기, 지금 수집, 자동 시작, 창 위치 초기화

`npm test` 단위 테스트 · `npm run smoke` 부팅 스모크.

이슈 동기화는 `gh`/`glab` CLI 인증을 재사용한다. 프로젝트별 리포 경로는 DB `project.repo_paths`에 있다.

본문 글꼴로 [Pretendard](https://github.com/orioncactus/pretendard)(OFL)를 `renderer/fonts`에 동봉한다 — 라이선스 전문은 `PretendardOFL.txt`.

## 상태

| 단계 | 내용 | 상태 |
|---|---|---|
| M1 | 트레이 + 퀵캡처 + 로컬 큐 + PostgreSQL + 오늘 뷰 | ✅ 구현 (도그푸딩 중) |
| M2 | git 수집기 + 재개 카드 (`claude -p`) + GH/GL 이슈 | ✅ 구현 |
| M3 | 인박스 AI 분류 + 주간 리뷰 | ✅ 구현 |

주간 리뷰는 Obsidian 볼트의 `00_업무일지/YYYY년/MM월/00_주간리뷰_YYYY-Www.md`에 쓴다 — `AUTO:WEEKLY` 마커 안쪽만 갱신하므로 직접 덧붙인 메모는 남는다. 볼트 경로는 `userData/settings.json`의 `vaultRoot`로 바꿀 수 있다.
