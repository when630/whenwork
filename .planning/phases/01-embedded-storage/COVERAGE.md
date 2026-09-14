# Phase 1 — API Coverage

No external API integration: 이 페이즈는 PostgreSQL·Docker 저장소를 `node:sqlite`(Node 내장 모듈, 인프로세스)로 교체하고 `main/index.mjs`를 분할하며 강제종료 스모크를 추가할 뿐, 외부 API·SDK·서비스를 호출하는 코드는 새로 만들지 않는다.

## 탐지 결과와 판정 근거

`api-coverage.cjs` 탐지기는 `detected: true`를 돌려주었으나, 유일한 신호는 RESEARCH.md의 `## Architectural Responsibility Map` 문장 "`DatabaseSync`는 Node **API**이므로 메인 프로세스 전용"에서 명사 `api`가 걸린 것이다. 페이즈 범위를 다시 읽어 확인한 결과:

| 이 페이즈가 닿는 것 | 외부 API인가 | 근거 |
|---|---|---|
| `node:sqlite` (`DatabaseSync`) | 아니다 | Node.js 내장 모듈, 같은 프로세스 안에서 동작. 네트워크·레지스트리·계정이 없다 |
| `main/index.mjs` → `lifecycle`/`ipc`/`jobs` 분할 | 아니다 | 같은 프로세스 내부 모듈 경계 |
| Electron `ipcMain` 채널 | 아니다 | 앱 내부 프로세스 간 통신, 외부 서비스 아님 |
| 강제종료 스모크(`spawn` + `SIGKILL`) | 아니다 | OS 프로세스 제어, 서비스 호출 아님 |

기존에 외부 CLI/서비스를 부르던 코드(`gh`·`glab`·`claude`·Apps Script 캘린더)는 이 페이즈에서 **새로 통합하지 않고**, D-06에 따라 무해한 스텁으로 내려앉힌 뒤 Phase 2가 완전히 제거한다. 신규 npm 패키지 설치도 0건이다(RESEARCH.md `## Package Legitimacy Audit`).

따라서 커버리지 행렬을 만들 대상 자체가 없다.

---
*Declared: 2026-09-14 (plan-phase)*
