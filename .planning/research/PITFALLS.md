# Pitfalls Research

**Domain:** Electron 트레이 앱 — 개인용 → 공개 미서명 Windows+macOS 배포, 내장 저장소 전환
**Researched:** 2026-09-14
**Confidence:** MEDIUM (공식 문서·electron/electron-builder GitHub 이슈로 교차 확인. 실제 macOS 빌드/서명 검증은 미실행 — README 안내 문구와 xattr 동작은 현장 검증 필요)

## Critical Pitfalls

### Pitfall 1: 네이티브 모듈 ABI 불일치로 "설치는 되는데 실행이 안 되는" 앱

**What goes wrong:**
`better-sqlite3` 같은 네이티브 모듈은 `npm install` 시 호스트 Node.js의 ABI로 컴파일된다. Electron은 자체 Node/V8을 내장하므로, 이 바이너리를 그대로 패키징하면 "Module did not self-register" 또는 세그폴트로 앱이 시작조차 안 된다. 개발 중 `npm start`(로�트 Node로 실행되는 게 아니라 Electron으로 실행되긴 하지만 devDependency 캐시가 맞아 떨어져 우연히 동작)에서는 문제가 안 보이다가, `electron-builder`로 패키징한 설치본에서만 터지는 경우가 흔하다.

**Why it happens:**
`npm install`이 기본적으로 시스템 Node 헤더로 빌드하고, `electron-builder`의 `npmRebuild`가 켜져 있어도 대상 아키텍처(Windows x64, macOS arm64/x64)별로 각각 리빌드해야 하는데 CI 없이 로컬 빌드만 하면 지금 개발 중인 OS/아키텍처 것만 맞고 나머지는 누락되기 쉽다.

**How to avoid:**
- `@electron/rebuild`를 postinstall 또는 빌드 스크립트에 명시적으로 넣어 Electron 헤더로 리빌드
- `electron-builder`의 `build.asarUnpack: ["**/*.node", "**/better-sqlite3/**"]` 설정 — asar 안에 있으면 네이티브 바이너리를 fs가 직접 열 수 없어 로드 실패
- Windows·macOS 빌드를 각각 그 OS에서(또는 CI 매트릭스로) 실행. 크로스 컴파일에 의존하지 않는다
- 패키징된 설치본으로 스모크 테스트(`npm run smoke`)를 두 OS 모두에서 돌려야 "빌드 성공 = 실행 성공"을 확인할 수 있음 — 소스만 돌리는 테스트로는 절대 못 잡음

**Warning signs:**
- 개발 중(`npm start`)엔 잘 되는데 패키징한 설치본에서만 DB 관련 에러
- `Error: The module was compiled against a different Node.js version` 류 메시지
- macOS에서 Apple Silicon 기기로 x64 빌드를 실행했을 때만(Rosetta 경유) 문제

**Phase to address:**
저장소 교체(내장 스토리지 도입) 초기 단계 — 코드를 채우기 전에 "네이티브 모듈이 두 OS 설치본에서 로드되는가"를 먼저 스파이크로 확인해야 함

---

### Pitfall 2: macOS Universal(arm64+x64) 빌드가 네이티브 모듈과 충돌

**What goes wrong:**
electron-builder의 mac universal 빌드는 `.asar`를 `app-x64.asar`/`app-arm64.asar`로 쪼개고 라우팅 `index.js`를 주입한다. 이 과정에서 `.app` 내부 레이아웃이 바뀌어, 코드가 `.node` 파일 경로나 `loadFile` 경로를 하드코딩하고 있으면 조용히 깨진다. 네이티브 모듈은 fat binary로 병합이 안 되기 때문에 universal 빌드 자체가 실패하거나, 실행은 되지만 한쪽 아키텍처에서만 DB가 로드된다.

**Why it happens:**
"macOS 하나만 빌드하면 되지" 하는 기대와 달리, Apple Silicon과 Intel Mac에 각각 맞는 바이너리가 필요하고, universal은 이를 하나로 합치려는 시도이지 만능 해법이 아니다. better-sqlite3 같은 네이티브 모듈이 있으면 오히려 복잡도만 커진다.

**How to avoid:**
- Universal 빌드를 시도하지 말고 **arm64와 x64를 별도 아티팩트로 빌드**해서 GitHub Releases에 각각 올린다 (미서명 배포에서 사용자가 파일 하나 더 받는 것쯤은 감수 가능한 트레이드오프)
- 부득이 universal이 필요하면 `x64ArchFiles`/`singleArchFiles` glob으로 네이티브 모듈을 명시적으로 아키텍처별 유지 설정
- CI(GitHub Actions)에서 `macos-latest`(arm64) 러너로 arm64를, 필요하면 Intel 러너 또는 Rosetta로 x64를 각각 빌드

**Warning signs:**
- `electron-builder --mac --universal` 빌드 로그에 네이티브 모듈 경고
- Apple Silicon 기기에서만, 또는 Intel 기기에서만 DB 초기화 실패

**Phase to address:**
macOS 빌드 파이프라인 구성 단계 — Windows 빌드가 안정된 뒤, macOS를 "빌드 성공"이 아니라 "두 아키텍처 모두 설치·실행 확인"까지로 완료 기준을 잡아야 함

---

### Pitfall 3: 미서명 macOS 앱의 "손상되었습니다" 첫 실행 차단

**What goes wrong:**
macOS는 인터넷에서 다운로드한 파일에 `com.apple.quarantine` 확장 속성을 붙인다. 서명·공증이 안 된 앱은 Gatekeeper가 이를 열 때 "손상되었기 때문에 열 수 없습니다"라는, 실제로는 손상이 아닌 오해의 소지가 큰 오류를 낸다. README에 안내가 없으면 비개발자 사용자는 여기서 100% 이탈한다 — 이 마일스톤의 존재 이유("아무 준비 없이 쓴다")를 정면으로 배반하는 지점.

**Why it happens:**
공증(Notarization)에는 Apple Developer Program 가입($99/년)과 공증 파이프라인이 필요한데, 이번 마일스톤은 명시적으로 서명·공증을 범위 밖에 뒀다(비용·CI 이유).

**How to avoid:**
- README 최상단(설치 섹션 바로 아래)에 macOS 사용자용 정확한 명령을 굵게 안내: `xattr -cr /Applications/WHENWORK.app` (Finder 우클릭 방법도 병기)
- 이 안내는 "선택적 팁"이 아니라 설치 과정의 필수 단계로 취급 — 스크린샷 포함
- 가능하면 앱 첫 실행 실패 시 사용자가 볼 문구(OS 다이얼로그)에 대응하는 캡처를 README에 넣어 "이 화면을 보면 이 명령을 쓰세요"로 연결
- Windows SmartScreen 우회 안내와 나란히, "미서명 앱을 받았을 때"라는 공통 섹션으로 묶어 신뢰도를 준다

**Warning signs:**
- 도그푸딩 단계에서 macOS 사용자(자신 포함) 첫 설치 시 이 오류를 실제로 보지 못했다면 안내 문구도 검증되지 않은 것 — 반드시 quarantine 속성이 실제로 붙는 경로(GitHub Releases에서 브라우저로 직접 다운로드)로 테스트
- README를 안 읽고 오는 사용자를 가정하면 실패율이 높음 — 릴리스 노트/다운로드 페이지에도 중복 안내 고려

**Phase to address:**
macOS 릴리스 준비 단계(README/배포 문서화) — 코드가 아니라 문서·릴리스 산출물이 완료 기준에 포함돼야 함

---

### Pitfall 4: 전역 단축키가 "등록됐다고 나오는데" 실제로는 안 먹는 macOS 무음 실패

**What goes wrong:**
`globalShortcut.register()`가 macOS에서 다른 앱/시스템이 이미 쓰는 조합이면 조용히 실패한다. 더 나쁜 것은 `globalShortcut.isRegistered()`가 실제 등록 여부와 무관하게 `true`를 반환할 수 있어, 코드가 "성공"이라 믿고 사용자에게 아무 경고도 안 보여준다. 또한 이 API는 내부적으로 Accessibility 권한이 필요한 이벤트 감시(NSEvent 글로벌 모니터)를 쓰는 경우가 있어, 권한을 안 준 상태에서는 등록 자체가 무의미해진다.

**Why it happens:**
Windows에서 개발·검증하면 이 문제가 전혀 드러나지 않는다(Windows는 훨씬 관대함). macOS 전용 엣지 케이스라 개인 개발 단계에서 못 보고 지나가기 쉽다.

**How to avoid:**
- macOS에서 `systemPreferences.isTrustedAccessibilityClient(false)`로 권한 상태를 앱 시작 시 확인하고, 없으면 사용자에게 시스템 설정 열기 안내
- 단축키 등록 후 실제 동작 여부를 별도로 검증하기 어렵다는 전제 하에, PROJECT.md가 이미 요구한 "단축키 충돌 시 사용자가 바꿀 수 있다"를 macOS에서도 반드시 검증 — 기본값(`Ctrl+Alt+Space`)이 macOS 시스템/Spotlight 단축키와 겹치지 않는지 별도 확인 (Spotlight는 기본 `Cmd+Space`라 직접 충돌은 아니지만 사용자 커스텀 단축키와는 겹칠 수 있음)
- 첫 실행 시 단축키가 실제로 동작하는지 사용자가 눈으로 확인할 수 있는 온보딩(예: "지금 눌러보세요" 안내)을 넣으면 무음 실패를 사용자가 스스로 발견

**Warning signs:**
- Windows에서만 QA하고 macOS 실기기 테스트를 건너뛴 상태
- 단축키 변경 UI는 있는데 "저장됨" 이후 실제 동작 확인 절차가 없음

**Phase to address:**
macOS 플랫폼 분기 구현 단계(트레이·단축키·창 위치) — Windows 전용 코드를 OS별로 가르는 바로 그 단계에서 함께 검증

---

### Pitfall 5: 미서명 배포 설정 누락으로 macOS 빌드 자체가 안 뜨거나 알림에 "Electron"이 뜸

**What goes wrong:**
`electron-builder`의 mac 설정에서 서명을 끄는 방법을 정확히 안 하면 두 가지 실패가 난다. (1) `hardenedRuntime`을 켜둔 채 `identity: null`이면 앱이 아예 실행이 안 됨. (2) Info.plist가 실제 앱 이름/번들 ID로 재작성되기 전에 서명(심지어 ad-hoc 서명)이 이뤄지면 알림·시스템 UI에 제품명 대신 "Electron"이 뜬다 — 공개 배포 앱치고 신뢰도가 크게 떨어지는 인상.

**Why it happens:**
"서명 안 함 = 아무 설정도 안 함"으로 오해하기 쉬운데, electron-builder는 기본값이 서명을 시도하다가 인증서가 없으면 실패하거나 ad-hoc 서명으로 대체하는 등 플랫폼별 기본 동작이 있어 명시적 비활성화가 필요하다.

**How to avoid:**
- `build.mac`에 `"identity": null, "hardenedRuntime": false, "gatekeeperAssess": false` 명시
- 번들 ID(`appId`)와 `productName`이 patched 먼저 되고 서명이 나중이라는 순서를 electron-builder 표준 파이프라인에 맡기고 커스텀 사이닝 스크립트를 건드리지 않는다
- 빌드 후 `.app/Contents/Info.plist`의 `CFBundleName`/`CFBundleIdentifier`가 `com.when630.whenwork`/`WHENWORK`인지, 알림 테스트로 제품명이 뜨는지 실제 확인

**Warning signs:**
- 로컬에서 "빌드는 성공했다"만 확인하고 알림·Dock/트레이 아이콘 툴팁에 뜨는 이름을 안 봄
- CI 없이 로컬 macOS 빌드를 매번 수동으로 함 (설정 드리프트 위험)

**Phase to address:**
macOS 빌드 설정(electron-builder mac 타깃) 단계

---

### Pitfall 6: 죽지 않는 죽은 코드 — 기능 제거가 "화면만" 지우고 끝남

**What goes wrong:**
Electron은 IPC 채널을 강타입으로 강제하지 않는다. `ipcMain.handle('resume:sync', ...)` 같은 핸들러, `preload.cjs`의 `contextBridge` 노출 함수, `settings.json`의 관련 키, DB 테이블/컬럼, 테스트의 mock이 각각 별개 파일에 흩어져 있어 "탭 하나 지웠다"고 끝나지 않는다. UI에서 안 보이니 안전해 보이지만, IPC 핸들러가 남아있으면 공격 표면(입력 검증 없는 진입점)이 그대로 남고, 죽은 브랜치가 새 기능 추가 시 혼란을 일으킨다.

**Why it happens:**
main↔preload↔renderer 3중 동기화를 강제하는 타입 시스템이 없다(vanilla JS + `.mjs`/`.cjs` 분리). "지웠다"의 기준이 사람마다 다르다 — renderer 탭 삭제만 하고 IPC/DB/설정은 남기는 실수가 흔함.

**How to avoid:**
- 제거 대상 기능(재개 카드·AI 분류·완료 제안·주간 리뷰·git/gh/glab·캘린더·Obsidian)마다 **4계층 체크리스트**를 만들어 순서대로 지운다: ① `renderer/*.js` UI/탭 ② `preload.cjs` 노출 함수 ③ `main/index.mjs`의 `ipcMain.handle`/`.on` ④ `main/*.mjs` 모듈 파일 자체(`ai.mjs`, `issues.mjs`, `repo.mjs`, `calendar.mjs`, `vault.mjs` 등 통삭제) ⑤ `settings.json` 스키마의 관련 키 ⑥ DB 테이블(`activity`, `issue`, `resume_card`, `repo_state`, `cal_event`, `review`) ⑦ 해당 테스트 파일
- grep으로 제거한 모듈명(`ai`, `issues`, `repo`, `calendar`, `vault`, `resume`, `review`)을 전체 코드베이스에서 검색해 잔존 참조가 0인지 확인하는 것을 완료 기준으로 삼는다
- `npm test`가 통과해도 안심하지 않는다 — 제거된 모듈을 mock하던 테스트가 "테스트 자체가 삭제돼서" 통과하는 착시가 있을 수 있음(커버리지 감소 확인 필요)

**Warning signs:**
- `git grep -n "ai.mjs\|issues.mjs\|repo.mjs\|calendar.mjs\|vault.mjs"` 실행 시 삭제 대상 파일 밖에서도 히트
- `settings.json` 스키마에 `calendarUrl`, `vaultRoot` 같은 키가 UI에서는 안 보이는데 코드엔 남음
- 테스트 총 개수가 줄었는데 "당연히 줄었겠지"로 넘어가고 어떤 테스트가 없어졌는지 diff를 안 봄

**Phase to address:**
기능 제거(디펜던시 제거) 단계 — 저장소 교체보다 먼저 하거나 최소한 병행. 제거가 안 끝난 상태로 저장소 교체를 하면 옮길 필요 없는 테이블(`resume_card` 등)까지 이전 스크립트가 신경 써야 해서 이중 작업이 됨

---

### Pitfall 7: PostgreSQL → 내장 저장소 이전에서 타임존·JSONB·소프트삭제가 조용히 깨짐

**What goes wrong:**
- `timestamptz` 컬럼은 PostgreSQL이 세션 타임존 기준으로 표시하지만 저장은 UTC다. 내장 저장소(SQLite류)로 옮기면 타임존 인식 타입이 없어 "그냥 문자열"이 되고, 이전 스크립트가 로컬 시간으로 잘못 변환해서 옮기면 마감일이 하루씩 밀리는 버그가 데이터에 영구히 박힌다.
- `item.context`(포그라운드 창 제목) 같은 JSONB 필드는 내장 저장소에서 TEXT로 직렬화해야 하는데, 이전 스크립트가 `JSON.stringify` 이스케이프를 빠뜨리거나 반대로 이중 인코딩하면 새 앱에서 파싱 에러 또는 깨진 문자열로 표시됨
- 소프트 삭제(`deleted_at` 등)된 행을 이전 스크립트가 걸러내지 않으면 "지웠던 항목이 부활"하는, 도그푸딩에서 이미 겪은 것과 같은 유형의 신뢰 손상 버그가 재발
- UUID vs 정수 PK: 기존 스키마가 정수 PK라면 그대로 옮기면 되지만, 만약 UUID를 쓰는 테이블이 있다면 내장 저장소의 PK 타입/인덱스 전략이 달라 이전 스크립트에서 타입 캐스팅 누락이 나기 쉬움

**Why it happens:**
"한 번만 옮기면 되는" 개인 마이그레이션이라 테스트를 안 쓰고 수작업 스크립트로 밀어붙이기 쉽다. 이전은 되돌릴 수 없는 단발성 작업이라 실수가 발견됐을 때 이미 원본을 지웠으면 복구가 안 됨.

**How to avoid:**
- 이전 스크립트 실행 전 PostgreSQL 덤프(`pg_dump`)를 반드시 보존 — 실패 시 재실행 가능하게
- 모든 타임스탬프는 UTC ISO 8601 문자열로 저장하고, 렌더러 표시 시점에만 로컬 변환 — "저장은 UTC, 표시는 로컬"을 이전 스크립트와 새 저장소 양쪽에 동일하게 적용
- `item.context` JSONB → TEXT 변환은 라운드트립 테스트(옮긴 값을 다시 파싱해서 원본과 비교)를 이전 스크립트 자체에 포함
- 이전 대상 쿼리에 `WHERE deleted_at IS NULL`(또는 동등 조건)을 명시하고, 소프트 삭제된 행을 옮길지 버릴지 결정을 이전 스크립트 코드에 주석으로 남긴다
- 이전 후 건수 비교(원본 행 수 vs 이전된 행 수, 테이블별)를 스크립트 마지막에 자동 출력해 육안 확인

**Warning signs:**
- 이전 후 "며칠 지난 항목"의 마감일이 하루 어긋나 보임 (타임존 버그 전형적 증상)
- `item.context`에 `\"` 이스케이프가 그대로 텍스트로 보임
- 완료 처리했던 항목이 새 앱 인박스에 다시 나타남

**Phase to address:**
데이터 이전 단계 — 저장소 교체가 끝나고 스키마가 확정된 후, 실제 이전 실행 전에 별도 검증 단계(드라이런 + 건수 비교)를 둔다

---

### Pitfall 8: 동기 파일 쓰기 + 큐 드레인 경합이 저장소 교체 후에도 그대로 남음

**What goes wrong:**
CONCERNS.md가 이미 지적한 `fs.appendFileSync()` 동기 쓰기와, 큐 드레인이 "읽기→처리→다시 읽기→쓰기" 사이에서 동시 append가 끼어들면 데이터 유실이 나는 구조는 저장소를 PostgreSQL에서 내장 스토리지로 바꿔도 **그대로 상속**된다. "저장소만 바꾸면 된다"고 생각하고 큐 레이어를 안 건드리면, 캡처 손실 제로라는 이 프로젝트의 제1 목적이 새 저장소에서도 여전히 취약한 채로 남는다.

**Why it happens:**
큐(queue.mjs)와 저장소(db.mjs)는 별개 레이어라 "저장소 교체" 작업 범위에서 큐는 안 건드려도 된다고 오판하기 쉽다. 하지만 큐가 최종적으로 쓰는 대상이 저장소이므로, 저장소가 SQLite류로 바뀌면 "drain 중 SQLite에 쓰다가 앱이 크래시하면?" 같은 새로운 실패 모드가 추가된다.

**How to avoid:**
- 큐 드레인을 원자적으로 만든다: 읽은 엔트리 처리 후 새 파일에 써서 `rename()`하는 방식(임시 파일 → 원자적 교체)으로 바꾸고, 동시 append 상황을 테스트 케이스로 추가
- 내장 저장소 쓰기 자체는 트랜잭션으로 감싸 "쓰다 만" 상태가 안 생기게 함(SQLite류라면 WAL 모드 + 트랜잭션이 기본 제공하는 원자성을 활용)
- 앱 비정상 종료(강제 종료, 정전) 시나리오를 수동으로 재현해(빌드된 앱을 작업 관리자로 강제 종료하며 캡처 반복) 큐/저장소 양쪽이 손상 없이 재시작되는지 확인 — 이것이 "완료 판정"의 실질적 근거가 되어야 함
- 정기 백업(내장 저장소 파일을 설정 주기로 복사)을 export 기능과 별개로 최소 하나는 유지 — export/import는 사용자가 수동으로 트리거하는 것이라 자동 백업 대체재가 아님

**Warning signs:**
- 큐 관련 테스트가 "순차적 happy path"만 있고 동시 append 테스트가 없음(CONCERNS.md에 이미 명시)
- 저장소 교체 PR/커밋에 `queue.mjs` 변경이 전혀 없음

**Phase to address:**
저장소 교체 단계에서 큐-저장소 연결부를 함께 재설계. 별도 phase로 분리하지 말고 저장소 phase의 완료 기준에 "크래시 재현 테스트"를 포함시킨다

---

### Pitfall 9: git 히스토리에 남은 캘린더 웹훅 토큰이 공개 저장소에 그대로 노출

**What goes wrong:**
CONCERNS.md가 확인한 대로 `settings.json`의 `calendarUrl`에 OAuth/웹훅 토큰이 평문으로 들어간 적이 있다. 현재 코드에서 마스킹돼 있어도, 과거 커밋(`cbd39ad 캘린더 연동`, 이후 커밋들)에 토큰이 포함된 파일이 커밋됐다면 `git log`/`git blame`으로 누구나 꺼내볼 수 있다. 저장소를 공개로 전환하는 순간 이 토큰은 인터넷에 영구 노출된다.

**Why it happens:**
설정 파일이 `.gitignore`에 없거나, 초기 개발 중 실제 값이 든 파일을 실수로 커밋한 뒤 나중에 값만 지우고 히스토리는 그대로 둔 경우가 전형적이다.

**How to avoid:**
- 공개 전환 전에 `git log -p --all -- '**/settings.json' '**/*.env' '**/*secret*'` 등으로 전체 히스토리를 훑어 토큰·URL·개인 경로가 커밋된 적이 있는지 확인
- 발견되면 **토큰을 먼저 무효화(구글 Apps Script 웹앱 재배포로 URL 회전)**한 뒁, `git filter-repo`(BFG보다 최신 권장)로 히스토리에서 제거
- 이번 마일스톤은 어차피 캘린더 연동 자체를 코드에서 통째로 제거하므로, "히스토리 청소"보다 간단한 대안으로 **공개용으로는 새 저장소(fresh history)로 시작**하는 선택지도 검토할 가치가 있다 — 개인용 히스토리는 별도 private 저장소나 로컬에 보존하고, 공개 저장소는 현재 상태의 스냅샷 커밋 하나로 시작
- 어느 쪽이든 결정 후 공개 전 마지막 관문(체크리스트)에 "히스토리 스캔 완료" 항목을 둔다

**Warning signs:**
- `git log --all --source --oneline -- '*calendar*' '*settings*'`에서 값이 실제로 박힌 커밋이 나옴
- README/스크린샷/fixtures에 실제 Apps Script URL, 실제 프로젝트 약어(`#약어` 예시로 실제 회사/개인 프로젝트명), 실제 DB 계정명이 남아있음

**Phase to address:**
공개 릴리스 준비(배포 직전) 단계 — 코드 제거 phase가 끝난 뒤, 저장소를 public으로 바꾸기 **직전**에 마지막 게이트로 반드시 확인. 코드에서 기능을 지운 것과 히스토리를 청소하는 것은 별개 작업임을 로드맵에 명시

---

### Pitfall 10: Windows SmartScreen "일반적이지 않음" 경고를 README 없이 방치

**What goes wrong:**
미서명 NSIS 설치본은 다운로드 수가 적은 초반에 SmartScreen이 "Windows의 PC 보호" 화면으로 실행을 차단한다. "추가 정보 → 실행" 2단계 클릭이 필요한데, 비개발자 사용자는 이 화면에서 대부분 포기하거나 바이러스로 오인해 삭제한다.

**Why it happens:**
SmartScreen 평판은 서명 여부와 무관하게 다운로드 수·신고 이력 기반 평판 시스템(Microsoft SmartScreen Application Reputation)에 의존하는데, 신규 미서명 앱은 항상 이 상태에서 출발한다. 서명해도 초반엔 평판이 없어 경고가 뜰 수 있고, 미서명이면 사실상 계속 뜬다.

**How to avoid:**
- README에 Windows 설치 섹션 바로 아래 "추가 정보 → 실행하기" 스크린샷 포함 (macOS xattr 안내와 대칭되는 위치에)
- NSIS `perMachine: false`(현재 설정 유지 — 사용자 권한 설치라 관리자 권한 프롬프트가 추가로 뜨지 않음, SmartScreen 경고와는 별개 이슈지만 겹치면 사용자 이탈이 배가됨)로 경고를 하나라도 줄인다
- 자동 시작(트레이 상주 앱의 필수 기능)을 레지스트리 Run 키로 구현할 경우, 이 역시 백신·Windows Defender가 "시작 프로그램에 추가된 미서명 앱"으로 재차 플래그할 수 있음을 감안해 README에 함께 언급

**Warning signs:**
- 도그푸딩/지인 테스트에서 "설치가 안 된다"는 피드백이 실제로는 SmartScreen 화면에서 멈춘 것인지 확인 안 함

**Phase to address:**
Windows 배포 문서화 단계(README) — macOS Gatekeeper 안내와 같은 phase에서 "미서명 배포 안내" 섹션으로 함께 작성

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|-----------------|-----------------|
| macOS universal 빌드 대신 arm64/x64 개별 아티팩트 배포 | 네이티브 모듈 fat-binary 문제 회피, 빌드 단순화 | 사용자가 자기 CPU 아키텍처를 골라야 함(비개발자에겐 살짝 부담) | 이번 마일스톤처럼 서명·CI 예산이 0일 때는 항상 허용 — universal이 오히려 더 위험 |
| PostgreSQL 이전 스크립트를 1회성 수작업으로 작성(재사용 고려 안 함) | 빠른 작업 | 실수 발견 후 재실행 시 중복 삽입/부분 실패 처리가 없으면 복구 어려움 | 원본 덤프를 반드시 보존하고 스크립트가 idempotent(같은 입력 재실행해도 안전)하면 허용 |
| 큐 원자성 개선을 저장소 교체와 별도 phase로 미룸 | 저장소 교체 범위를 좁혀 빨리 끝냄 | 캡처 손실 제로라는 핵심 가치가 새 저장소에서도 미검증 상태로 "완료"됨 | 절대 미루지 않음 — 이 프로젝트의 Core Value 자체이므로 같은 phase에서 검증까지 끝낸다 |
| 히스토리 청소 대신 fresh-history 공개 저장소로 새로 시작 | filter-repo 작업·force-push 리스크 회피, 빠름 | 커밋 히스토리(도그푸딩 학습 과정)를 공개 저장소에서 잃음 | 개인 히스토리를 private 백업으로 남긴다는 전제 하에 허용 — 오히려 이번 케이스엔 권장 |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|-----------------|-------------------|
| electron-builder + better-sqlite3(또는 유사 네이티브 모듈) | asarUnpack 설정을 빠뜨리고 "빌드는 성공"만 확인 | `asarUnpack`에 `**/*.node`와 모듈 디렉터리를 명시하고, 패키징된 설치본으로 실제 실행 테스트 |
| electron-builder mac 서명 끄기 | `identity: null`만 설정하고 `hardenedRuntime`은 기본값(true)으로 방치 | `hardenedRuntime: false`, `gatekeeperAssess: false`를 함께 설정 |
| GitHub Releases 배포 | 설치 파일만 올리고 SHA256 체크섬·서명 부재에 대한 안내 없이 방치 | README에 "미서명 배포이니 공식 GitHub Releases에서만 받으라"는 안내 + 체크섬 병기(무결성 확인 수단으로) |
| 자동 시작(로그인 아이템) | Windows 레지스트리 Run 키와 macOS `setLoginItemSettings`/LaunchAgent를 각각 별도 구현 없이 한쪽만 테스트 | `app.setLoginItemSettings`로 통일하되 두 OS 모두에서 "재부팅 후 실제로 트레이에 뜨는지" 수동 검증 |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|-----------------|
| 큐 파일 전체를 매번 읽고 쓰는 drain (`queue.mjs` 기존 구조) | 캡처가 쌓일수록 drain이 느려짐 | in-memory 큐 길이 캐시, append/drain 시에만 갱신 | 이벤트 로그가 수만 건 쌓인 개인 이전 데이터 기준에서는 드러날 수 있음 — 이전 직후 첫 drain에서 체감 가능 |
| 렌더러 오늘 뷰가 500+ 항목에서 버벅임 (CONCERNS.md 기존 지적) | 스크롤 끊김 | 가상 스크롤 또는 지연 렌더링 | 저장소 교체 자체와는 무관하지만 이전된 개인 데이터(수년치 이벤트)가 한 번에 로드되면 이 한계에 바로 부딪힘 |
| 내장 저장소 파일 단일 동기 쓰기 트랜잭션 남발 | 캡처마다 디스크 fsync 대기로 UI 랙 | 배치 커밋(예: WAL 모드 + 주기적 체크포인트) | 저장소를 SQLite류로 바꾼 직후, 트랜잭션 경계를 안 정하면 바로 나타남 |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| 공개 저장소에 캘린더 웹훅 토큰이 git 히스토리로 남음 | 토큰 탈취로 사용자(개발자 본인)의 캘린더 웹훅 악용 | 공개 전 히스토리 스캔 + 토큰 무효화(URL 재발급) + filter-repo 또는 fresh-history |
| macOS 서명 비활성화 설정을 하드닝 없이 방치(`hardenedRuntime: false`) | 앱이 코드 인젝션에 더 취약한 상태로 배포됨 — 서명 안 하는 이상 근본 해결은 없지만 표면적을 넓히지는 말아야 함 | preload에서 이미 하듯 `contextBridge` + `contextIsolation`(Electron 43 기본값 true) 유지, `nodeIntegration: false` 유지, CSP 메타 태그를 렌더러 HTML에 명시적으로 추가 |
| GitHub Releases 미서명 배포에 체크섬/무결성 확인 수단 없음 | 사용자가 위조된 다운로드 링크(피싱 사이트)로 유도됐을 때 구분 불가 | 릴리스 노트에 SHA256 체크섬 게시, README에 "공식 Releases 페이지에서만 받으라" 명시 |
| 설정 파일에 남은 개인 정보(DB 계정, 볼트 경로, 실제 프로젝트 약어)가 fixtures/스크린샷에 노출 | 개인정보·업무 맥락 노출 | README/스크린샷 재촬영 시 더미 데이터(`#예시프로젝트` 등)로 교체, 실제 캡처 화면 사용 금지 |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-------------------|
| macOS 첫 실행 Gatekeeper 오류를 안내 없이 방치 | 비개발자 사용자 100% 이탈 | README 최상단에 xattr 안내 + 스크린샷, 가능하면 릴리스 페이지에도 중복 |
| Windows SmartScreen 경고 화면에서 "추가 정보" 버튼 위치를 안 알려줌 | 사용자가 바이러스로 오인해 삭제 | 스크린샷과 함께 "이 화면이 뜨면 정상입니다" 안내 |
| 단축키 충돌 시 무음 실패(Pitfall 4) | 캡처가 아예 안 됨을 사용자가 원인 모른 채 방치 | 단축키 등록 실패/충돌을 감지해 트레이 알림 또는 설정 화면 배지로 즉시 알림 |
| export/import를 "가져오기만 되고 병합은 안 됨"으로 설계해놓고 안내 없음 | 사용자가 기존 데이터가 사라진 줄 알고 당황 | import 시 "덮어쓰기/병합" 동작을 명시적으로 안내하는 확인 다이얼로그 |

## "Looks Done But Isn't" Checklist

- [ ] **네이티브 모듈 빌드:** "electron-builder가 성공했다"는 소스 컴파일 성공일 뿐 — 두 OS의 실제 설치본을 실행해 DB 읽기/쓰기까지 확인했는지
- [ ] **기능 제거:** renderer 탭만 지우고 끝나지 않았는지 — `ipcMain.handle`, `preload.cjs`, `settings.json` 키, DB 테이블, 테스트까지 4~7계층 모두 확인했는지 (Pitfall 6)
- [ ] **PostgreSQL 이전:** 건수만 맞춰보고 끝내지 않았는지 — 타임존 오프셋, JSONB 라운드트립, 소프트삭제 필터링을 개별로 검증했는지 (Pitfall 7)
- [ ] **macOS 배포:** "빌드가 나왔다"만 확인하고 끝내지 않았는지 — 인터넷에서 실제로 다운로드해 quarantine 속성이 붙은 상태로 첫 실행까지 재현했는지 (Pitfall 3)
- [ ] **공개 저장소 전환:** README·설정 화면만 검토하고 git 히스토리는 안 본 것 아닌지 (Pitfall 9)
- [ ] **캡처 손실 제로:** 저장소만 바꾸고 크래시 재현 테스트(강제 종료 중 캡처)를 안 한 것은 아닌지 — 이게 이 프로젝트의 Core Value 자체 (Pitfall 8)

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|----------------|------------------|
| 네이티브 모듈 ABI 불일치로 배포 후 발견 | LOW | `@electron/rebuild` 추가 + asarUnpack 설정 후 재빌드·재배포 (배포 전 발견이면 코드 수정만) |
| git 히스토리에 토큰 노출 후 이미 공개됨 | HIGH | 토큰 즉시 무효화(최우선) → `git filter-repo`로 히스토리 재작성 → force-push → GitHub Support에 캐시된 검색 인덱스 삭제 요청 → 모든 클론 재클론 안내 |
| PostgreSQL 이전 후 타임존 버그 발견(원본 DB 아직 살아있음) | MEDIUM | 원본에서 재이전 스크립트 수정 후 재실행. 원본이 이미 지워졌다면 Docker 볼륨 백업 유무에 따라 HIGH로 상승 — 그래서 이전 전 덤프 보존이 필수 |
| macOS 사용자가 첫 실행에서 대거 이탈(README 안내 늦게 추가) | LOW | README 갱신은 즉시 반영 가능. 이미 이탈한 사용자는 재유입 유도가 어려워 실질 손실은 있음 |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|-------------------|----------------|
| 네이티브 모듈 ABI/asarUnpack (1) | 내장 저장소 도입 phase | 두 OS 패키징된 설치본으로 스모크 테스트 실행, DB read/write 확인 |
| macOS universal 빌드 충돌 (2) | macOS 빌드 설정 phase | arm64 실기기 + x64(또는 Rosetta) 각각 설치·실행 |
| Gatekeeper "손상됨" 오류 (3) | 배포 문서화(README) phase | 실제로 브라우저에서 다운로드해 quarantine 재현 후 안내대로 해제되는지 확인 |
| 전역 단축키 무음 실패 (4) | macOS 플랫폼 분기 구현 phase | Accessibility 권한 거부 상태에서 등록 실패가 사용자에게 보이는지 확인 |
| 미서명 설정 누락 (5) | macOS 빌드 설정 phase | 알림 테스트에서 제품명이 정확히 뜨는지 확인 |
| 기능 제거 후 죽은 코드 (6) | 기능 제거(디펜던시 정리) phase | 삭제 대상 모듈명 전체 grep 결과 0건, 테스트 수 변화 diff 검토 |
| 이전 시 타임존/JSONB/소프트삭제 (7) | 데이터 이전 phase | 드라이런 + 원본/이전본 건수 비교 + 라운드트립 파싱 테스트 |
| 큐-저장소 경합/크래시 유실 (8) | 내장 저장소 도입 phase (큐 재설계 포함) | 강제 종료 재현 테스트로 캡처 유실 0건 확인 |
| git 히스토리 토큰 노출 (9) | 공개 릴리스 준비(배포 직전) phase | `git log -p --all` 전체 스캔 완료를 게이트 항목으로 명시 |
| Windows SmartScreen 안내 부재 (10) | 배포 문서화(README) phase | README에 스크린샷 포함 안내 존재 여부 확인 |

## Sources

- [Debugging native Node.js addons with Electron on macOS](https://felixrieseberg.com/debugging-native-node-js-addons-with-electron/)
- [electron-builder — Architecture & Multi-Arch Builds](https://www.electron.build/docs/architecture/)
- [electron-builder — macOS](https://www.electron.build/docs/mac/)
- [electron, electron-builder, node, sqlite3 and universal Mac builds (x64 and arm64) — Medium](https://medium.com/@andreialex.patru/electron-electron-builder-node-sqlite3-and-universal-mac-builds-x64-and-arm64-fb7c50e1fff4)
- [Handling macOS Gatekeeper as an Unsigned Indie Dev: The xattr Struggle — DEV Community](https://dev.to/hiyoyok/handling-macos-gatekeeper-as-an-unsigned-indie-dev-the-xattr-struggle-1028)
- [electron/electron#21975 — globalShortcut still registered if accelerator already taken (macOS)](https://github.com/electron/electron/issues/21975)
- [Electron globalShortcut docs](https://www.electronjs.org/docs/latest/api/global-shortcut)
- [electron-builder — Code Signing for macOS](https://www.electron.build/docs/features/code-signing/code-signing-mac/)
- [electron-builder — macOS Notarization](https://www.electron.build/docs/features/code-signing/notarization/)
- [Signing, Notarizing, and Publishing an Electron App for macOS](https://www.artmann.co/articles/signing-notarizing-and-publishing-an-electron-app-for-mac-os)
- [Electron docs — Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron docs — Dock Menu / LSUIElement](https://www.electronjs.org/docs/latest/tutorial/macos-dock/)
- [Electron docs — Tray](https://www.electronjs.org/docs/latest/tutorial/tray)
- [How To Remove Secrets From The Git History — Warp](https://www.warp.dev/terminus/remove-secret-git-history)
- [BFG & git-filter-repo: Cleaning Leaked Secrets from Git History](https://www.elegantsoftwaresolutions.com/blog/bfg-git-filter-repo-cleaning-leaked-secrets-from-history)
- 프로젝트 내부: `.planning/codebase/CONCERNS.md` (동기 큐 쓰기, 드레인 경합, 설정 파일 평문 토큰, 테스트 부재 — 기존 코드 실측)
- 프로젝트 내부: `.planning/PROJECT.md` (범위·제약·의사결정)

---
*Pitfalls research for: Electron 트레이 앱의 개인용→공개 미서명 Windows+macOS 전환*
*Researched: 2026-09-14*
