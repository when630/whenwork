# 광고·광고 제거·Pro — 설계 (초안)

> 무료 앱에 광고 칸을 두고, 광고 제거(일회성)와 Pro(연 구독)를 판다. Pro는 프로젝트 무제한·자동 클라우드 백업·기기 간 동기화. 2026-11-10 초안. 배경 논의: 광고망 현실, 사업자등록(간이과세), MoR 수수료, 서버 비용.

## 지키는 것 (모든 결정보다 위)

1. **캡처는 어떤 결제 상태에서도 막히지 않는다.** 라이선스 서버가 죽어도, 키가 만료돼도, 오프라인이어도 캡처 경로(`capture:save` → `queue.append` → `store.insertCaptures`)는 결제 코드를 한 줄도 지나지 않는다.
2. **지금 무료인 기능은 Pro로 옮기지 않는다.** 오늘·인박스·대기·검색·아침 브리핑·내보내기·가져오기는 계속 무료다. 자동 업데이트가 켜져 있어 옮기면 기존 사용자가 업데이트로 기능을 잃는다.
3. **내 데이터를 꺼내는 길은 무료로 남는다.** 내보내기·가져오기는 제한·잠금이 없다.
4. **광고는 캡처 창에 절대 나오지 않는다.** 오늘 뷰 아래 한 줄만.
5. **추적하지 않는다.** 광고 노출에 기기·사용자 식별자를 보내지 않는다.

## 상품

| 상품 | 가격(안) | 결제 | 주는 것 |
|---|---|---|---|
| 무료 | 0 | — | 전부 + 광고 한 줄 + 프로젝트 3개 |
| 광고 제거 | 9,900원 | 일회성 | 광고 숨김 (영구) |
| Pro | 연 19,800원 | 연 구독 | 광고 숨김 + 프로젝트 무제한 + 클라우드 백업 + 동기화 |

- 건당 고정 수수료 $0.50 때문에 4,900원 이하는 수수료가 19% 이상이다 — 광고 제거는 9,900원 아래로 내리지 않는다.
- Pro 구독이 끝나면 광고 제거를 따로 산 적이 없는 한 광고가 돌아오고 프로젝트 제한이 다시 걸린다(D-P05의 유예 규칙).

## 결정

### 단계

- **D-P01:** 세 단계로 낸다. 앞 단계에서 실제 결제가 나오는지 보고 다음 단계에 시간을 쓴다.
  - **1단계 — 수익 골격:** 엔타이틀먼트 모듈, 라이선스 서버(Worker), 광고 칸, 광고 제거·Pro 결제, 프로젝트 3개 제한. Pro는 이때 "프로젝트 무제한 + 광고 제거"만으로 판다(백업·동기화는 출시 예정으로 표기).
  - **2단계 — 자동 클라우드 백업.**
  - **3단계 — 기기 간 동기화.** 스키마 이행이 선행돼야 한다(D-P14).
  — **Reversibility:** cheap — 순서는 언제든 바꿀 수 있다. 단, 1단계 없이 2·3단계는 성립하지 않는다.

### 엔타이틀먼트 — 앱이 "무엇을 허용하나"를 묻는 단 하나의 길

- **D-P02:** `main/entitlements.mjs`에 순수 함수 `entitlements(license, now)`를 둔다. 반환값은 `{ ads: bool, projectLimit: number, backup: bool, sync: bool, plan: 'free'|'adfree'|'pro', expiresAt }`. 앱의 다른 어디도 라이선스 원문을 직접 해석하지 않는다. 날짜 경계·유예·만료는 전부 이 함수의 단위 테스트로 증명한다(`parse.mjs`·`brief.mjs`와 같은 위치). — **Reversibility:** cheap
- **D-P03:** 판정 결과는 `today:getState`에 `ent` 필드로 실어 렌더러에 준다. 렌더러는 그 값으로 그리기만 하고 스스로 판단하지 않는다.

### 라이선스

- **D-P04:** 결제·키 발급은 Lemon Squeezy(MoR)를 1순위로 한다. 일회성·구독 모두 라이선스 키를 자체 발급하고 활성화·검증 API가 있어, 1단계에서 별도 계정 체계가 필요 없다. **앱은 Lemon Squeezy를 직접 부르지 않고 내 Worker(`/v1/license/*`)만 부른다** — MoR을 Paddle 등으로 바꿔도 앱 업데이트가 필요 없게. 2026-01 Stripe Managed Payments 전환 공지가 있어 한국 정산 가능 여부를 출시 전 확인한다(미해결 Q1). — **Reversibility:** cheap(Worker 뒤에 숨겼으므로)
- **D-P05:** 활성화 흐름: 설정 탭에서 키 입력 → Worker `POST /v1/license/activate {key, instance}` → Worker가 MoR에 활성화(기기당 1 인스턴스, 키당 3대) → `{ plan, expiresAt, checkedAt }`를 **Ed25519로 서명한 토큰**으로 돌려준다 → 앱은 내장 공개키로 검증 후 `userData/license.json`에 저장한다. 오프라인 규칙:
  - 광고 제거: 한 번 활성화되면 영구. 재검증은 주 1회 시도하되 실패해도 회수하지 않는다. 환불(서버가 `revoked`를 명시적으로 돌려줄 때)만 회수한다.
  - Pro: `expiresAt + 14일`까지 유효. 그 안에 재검증이 한 번이라도 성공하면 갱신된다. 네트워크 실패는 회수 사유가 아니다 — "서버에 닿지 못함"과 "구독 끝남"을 구분한다.
  - 시계 되돌리기는 막지 않는다(양심 판매 전제, D-P07).
  — **Reversibility:** costly — 토큰 형식과 공개키는 배포된 앱에 박힌다. 키 교체가 필요해질 때를 위해 토큰에 `kid`(키 번호)를 넣고 앱은 공개키 목록을 갖는다.
- **D-P06:** `instance`는 첫 실행 때 만드는 무작위 UUID(`userData/instance-id`)다. 하드웨어 정보·사용자명은 쓰지 않는다.
- **D-P07:** 클라이언트는 MIT로 공개되므로 로컬 제한(광고·프로젝트 수)은 누구나 빌드해서 풀 수 있다. 이를 막으려 하지 않는다(난독화·무결성 검사 없음). 우회할 수 없는 건 서버 기능(백업·동기화)뿐이고, 그건 서버가 매 요청마다 키를 확인한다. 서버 코드는 비공개 리포(`whenwork-server`)에 둔다.

### 광고

- **D-P08:** 광고 칸은 오늘 뷰 `footer` 위 한 줄(텍스트 + 작은 라벨 "광고"). 캡처 창·알림·트레이 메뉴에는 넣지 않는다. 닫기 버튼이 곧 "광고 제거" 안내다.
- **D-P09:** 광고 소스는 외부 광고망이 아니다 — 데스크톱용 광고망(Overwolf·Playwire)은 게임·대형 트래픽 위주이고, AdSense·애드핏은 웹·모바일용이라 정책 위반 소지가 있다. 대신 Worker가 내려주는 `ads.json`(직접 판 스폰서, Pro 안내, 형제 앱 WHENCOMMAND 홍보)을 하루 1회 받아 캐시한다. 받기 실패·오프라인이면 앱에 내장된 하우스 광고(Pro 안내)를 보인다. 요청에는 앱 버전·OS만 담는다.
- **D-P10:** 클릭은 `https://<도메인>/go/<광고id>` 리다이렉트로 집계한다(광고 id별 카운트만, 사용자 식별자 없음). 외부 브라우저로 연다(`shell.openExternal`), 앱 안에서 웹을 띄우지 않는다.

### 프로젝트 3개 제한

- **D-P11:** 제한은 **새로 만들기와 지운 프로젝트 되살리기**에만 건다 — 활성 프로젝트가 `projectLimit` 이상이면 `project:create`·`project:restore`가 `{ ok: false, reason: 'limit' }`을 돌려주고 렌더러가 Pro 안내를 띄운다. 검사는 `ipc.mjs`에서 한다. `store.mjs`에는 넣지 않는다 — 가져오기(`importAll`)·PG 이전 도구가 같은 저장소 함수를 지나도 잘리지 않게.
- **D-P12:** 이미 3개를 넘게 쓰는 사용자(그랜드파더)는 아무것도 잃지 않는다. 기존 프로젝트·항목 배정·이름 변경·삭제는 모두 그대로 된다. 줄여야 새로 만들 수 있을 뿐이다. 가져오기도 개수 제한 없이 그대로 들어간다(원칙 3) — JSON을 고쳐 우회할 수 있지만 D-P07대로 받아들인다.
- **D-P13:** 지운 프로젝트(소프트 삭제)는 세지 않는다. `status = 'active'`만 센다.

### 자동 클라우드 백업 (2단계)

- 내보내기와 같은 JSON(`validateExport`가 통과하는 형식)을 **기기에서 암호화**(AES-256-GCM, 키는 사용자가 정한 백업 암호에서 scrypt로 유도)한 뒤 Worker를 거쳐 R2에 올린다. 서버는 내용을 읽을 수 없다. 암호를 잊으면 복구할 수 없다는 것을 설정 화면에서 한 번 확인받는다.
- 하루 1회(앱이 켜져 있을 때, 마지막 백업 후 변경이 있을 때만). 보관: 최근 7일치 + 주 1개씩 4주.
- 복원은 지금의 가져오기와 같은 경로(직전 상태 자동 백업 후 교체)를 탄다.
- 예상 비용: 사용자당 ~10MB, 유료 1,000명에 ~10GB → R2 무료 범위.

### 기기 간 동기화 (3단계)

- **D-P14 (선행 스키마 이행):** 지금 스키마로는 동기화가 안 된다. v4 마이그레이션으로
  - `project.uid TEXT`(UUID) 추가 — `INTEGER AUTOINCREMENT` id는 두 기기에서 겹친다. item은 이미 TEXT UUID라 그대로.
  - `item.updated_at`, `project.updated_at` 추가 — 모든 쓰기 함수가 갱신.
  - 소프트 삭제 30일 정리(purge)가 행을 지우기 전에 동기화가 삭제를 전파했는지 확인. 아니면 삭제가 다른 기기에서 되살아난다.
  — **Reversibility:** one-way — 배포된 마이그레이션은 고치지 않는다(D-12).
- 방식(초안): 행 단위 last-write-wins + 필드별 `updated_at`. 행을 기기에서 암호화해 Worker(Durable Object, 계정당 1개)에 변경 로그로 쌓고, 변경이 생겼을 때·창을 열 때 주고받는다. 주기적 폴링은 하지 않는다(요청 수 = 비용).
- 캡처 경로와 분리한다: 동기화는 store에 반영된 뒤의 행만 읽는다. 큐·`insertCaptures`는 동기화를 모른다.
- `docs/03_요구사항.md`의 Out of Scope "멀티 디바이스 동기화·계정"을 이 단계에서 해제한다(Pro 한정, 계정 = 라이선스 키).

## 배포 — 진입점

- **D-P15:** 진입점은 **자체 도메인의 랜딩 페이지 하나**다(Cloudflare Pages, 무료). GitHub Releases 페이지는 비개발자에게 "어느 파일을 받아야 하지"부터 막힌다. 랜딩 페이지가 맡는 것:
  - OS를 감지해 큰 다운로드 버튼 하나(Windows → Microsoft Store, macOS → dmg)
  - 가격·구매 버튼(MoR 결제창으로), 라이선스 키 입력 방법
  - 환불 정책·이용약관·개인정보처리방침 — MoR 스토어 심사(KYC·KYB)와 전자상거래 고지에 필요하다
  - macOS 첫 실행 경고 넘기는 법(그림으로)
  - 광고 문의(스폰서 판매, D-P09)
  같은 도메인 아래에 Worker(`/v1/*`, `/go/*`)를 둔다. — **Reversibility:** cheap
- **D-P16:** Windows의 기본 배포처는 **Microsoft Store**로 한다. 개인 개발자 등록이 무료이고(2025-09~), 스토어가 패키지에 서명하므로 SmartScreen 경고가 사라진다 — Azure 서명(연 ~17만 원) 없이 Q2가 풀린다. 게임이 아닌 앱은 자체 결제를 쓰고 수수료 0%라 라이선스 구조(D-P04)를 그대로 쓴다. electron-builder `appx` 타깃을 추가한다.
  - 스토어판의 업데이트는 스토어가 한다 — `update.mjs`의 자동 업데이트를 스토어판에서는 끈다(`process.windowsStore`).
  - MSIX 패키지에서 확인할 것: 전역 단축키, `whenwork://` 프로토콜(매니페스트 선언), 로그인 시 시작, `userData` 경로 가상화, 단일 인스턴스 락, `~/.when/apps` 매니페스트 쓰기.
  - **기존 NSIS 설치본에서 스토어판으로 옮기는 사용자의 데이터가 그대로 보이는지** 반드시 검증한다. 다른 경로로 갈리면 첫 실행에서 옛 `store.sqlite`를 찾아 가져오기를 제안한다(원칙: 잃지 않는다).
  — **Reversibility:** costly — 두 설치 형태가 공존하는 순간 업데이트 경로·데이터 경로가 둘이 된다.
  - **검증 결과 (2026-11-10, Windows 11 26200, 개발자 모드 loose 등록, electron-builder 26.15.3 appx):**
    - ✅ 빌드, `whenwork://` 프로토콜(매니페스트 자동 선언), 딥링크 `today`·`capture`, 전역 단축키 두 개(열기·토글·Esc), 단일 인스턴스.
    - ✅ 기존 `%APPDATA%\whenwork`가 있으면 패키지판도 그 폴더를 그대로 연다 — NSIS → 스토어 이동 시 데이터가 이어진다. 패키지판 실행 동안 원본 `store.sqlite` 해시 불변.
    - ❌→✅ **새로 설치한 사람의 데이터는 가상화된다**(`%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\…`). 앱을 지우면 데이터도 지워지고, NSIS판에서 보이지 않으며, 설정 탭이 보여주는 경로가 탐색기에 없다. 매니페스트에 `desktop6:FileSystemWriteVirtualization=disabled` + `rescap:unvirtualizedResources`(MinVersion 10.0.17763)를 넣으면 진짜 `%APPDATA%`에 쓰이고, **패키지를 제거해도 데이터가 남는다**(실측). → 스토어 빌드는 이 매니페스트로 낸다(`appx.customManifestPath`). `unvirtualizedResources`는 제한 capability라 Partner Center 제출 때 사유를 적어야 한다 — "사용자 데이터가 앱 제거로 사라지지 않게, NSIS판과 같은 경로를 공유하기 위해". 거절되면 가상화를 받아들이고 첫 실행 안내 + 제거 전 내보내기 안내로 대신한다.
    - ✅ 로그인 시 자동 실행: `setLoginItemSettings`는 MSIX에서 효과가 없다 → 매니페스트에 `desktop:StartupTask`(`WhenworkStartup`, Enabled=true)를 선언했다. 첫 실행 뒤 `State=2`(켜짐) 실측. 앱은 켜고 끌 수 없으므로(Electron에 API 없음) 트레이 메뉴는 체크박스 대신 "로그인 시 자동 시작 설정…"으로 `ms-settings:startupapps`를 연다(`platform.loginItemBySystem`).
    - ✅ 자동 업데이트: `process.windowsStore`(Electron이 패키지 ID로 판정 — 개발자 모드 등록에서도 true)면 `platform.store`, `canAutoUpdate=false`, `update.mjs`는 확인 자체를 하지 않고 "스토어가 업데이트합니다". 패키지 안 `--check-update`로 `status=store` 실측.
    - ✅ 프로토콜: 스토어판은 `setAsDefaultProtocolClient`를 부르지 않는다(매니페스트가 등록, NSIS판의 진짜 키를 건드리지 않게).
    - ✅ 스토어 타일 이미지: `tools/make-icon.mjs`가 `build/appx/`(StoreLogo·Square44 + targetsize 16~256·Square150·Wide310)를 굽고 electron-builder가 `resources.pri`를 만든다. 언어 `ko-KR`.
    - ⚠ 미확인: 트레이 아이콘·메뉴를 눈으로(스크립트로 읽을 수 없다), 알림의 앱 이름·아이콘(패키지판은 AUMID가 패키지에서 온다), `~/.when/apps` 매니페스트의 `verify` 경로(`C:\Program Files\WindowsApps\…` — 다른 앱이 존재 확인을 할 수 있는지).
  - **빌드:** `npm run build:store` → `dist/WHENWORK-<버전>-win-x64.appx`. `package.json`의 `appx.identityName`·`publisher`는 자리표시자(`when630.WHENWORK`, `CN=WHENWORK-Dev`)다 — Partner Center에서 앱 이름을 예약하면 받는 Package/Identity/Name과 Publisher(`CN=<GUID>`)로 바꿔야 제출된다. 서명은 스토어가 한다.
  - **로컬 시험:** 개발자 모드에서 appx를 풀어 `Add-AppxPackage -Register <폴더>\AppxManifest.xml`. 서명 없는 appx 직접 설치(`-AllowUnsigned`)는 "실행 가능한 활성화를 포함할 수 없다"(0x80073D2B)로 막힌다.
  - 스토어 버튼 아래에 "스토어를 쓸 수 없나요? 설치 파일 직접 받기"(GitHub exe)를 둔다 — 회사 PC는 스토어가 정책으로 막힌 경우가 많고, 퀵캡처는 업무 PC에서 쓰일 앱이다.
  - 스토어 등록에는 개인정보처리방침 URL이 필요하다 → 랜딩 페이지가 스토어 제출보다 먼저다.
- **D-P17:** GitHub Releases는 계속 원본으로 둔다(NSIS exe·dmg). 랜딩 페이지가 `releases/latest/download/<파일명>`으로 늘 최신을 가리키도록 버전 없는 이름의 사본도 함께 올린다. 랜딩 페이지의 "다른 설치 방법"과 macOS 버튼이 여기를 가리킨다. macOS는 Apple Developer 보류 동안 dmg 직접 배포뿐이다(Mac App Store는 Apple Developer가 필요).

## 서버 구성

```
앱 ──HTTPS──▶ Cloudflare Worker (whenwork-server, 비공개)
                ├─ /v1/license/activate|validate  → Lemon Squeezy License API
                ├─ /v1/ads.json, /go/<id>          → KV
                ├─ /v1/backup/*   (2단계)          → R2
                └─ /v1/sync/*     (3단계)          → Durable Objects
```

- 1단계는 Workers 무료 플랜(일 10만 요청)으로 충분하다. 동기화를 켜면 유료 플랜(월 $5)으로 올린다.
- 앱 쪽 네트워크 코드는 `main/cloud.mjs` 한 곳. 타임아웃 5초, 실패는 삼키고 상태만 남긴다(지금 `update.mjs`와 같은 태도).

## 비용 (연, 환율 1,400원 가정 — 출시 전 재확인)

| 항목 | 1단계 | 3단계까지 |
|---|---|---|
| Cloudflare | 0 | 약 8.5만 원 |
| 도메인 | 약 2만 원 | 약 2만 원 |
| Windows 서명 | 0 — Microsoft Store가 서명 (D-P16) | 0 |
| Microsoft Store 등록 | 0 (개인 무료) | 0 |
| 랜딩 페이지 (Cloudflare Pages) | 0 | 0 |
| Apple Developer | **보류** — 추후 추가 | 보류 |
| MoR 수수료 | 5% + $0.50 / 건, 미국 밖 구매 +1.5% 보고 있음(확인 필요) | 같음 |

보류의 결과: macOS는 첫 실행 경고와 자동 업데이트 불가가 그대로 남는다. 결제·라이선스에는 영향 없다.

## 법·운영

- 판매 시작 전 간이과세자 사업자등록. 통신판매업 신고는 MoR 구조·간이과세로 면제 범위인지 확인.
- 개인정보처리방침 페이지: 1단계는 라이선스 키·instance id·앱 버전·OS만 다룬다. 2·3단계는 E2E 암호화라 서버가 내용을 보지 못한다는 점을 명시.
- 환불·해지는 MoR이 처리한다. 앱은 서버가 `revoked`를 줄 때만 회수한다.

## 미해결

- **Q1:** Lemon Squeezy의 한국 판매자 정산 가능 여부(Stripe Managed Payments 전환 이후). 안 되면 Paddle + Worker가 키를 직접 발급하는 구조로 바꾼다(D-P04 덕에 앱은 그대로).
- **Q2:** ~~Windows 서명~~ → Microsoft Store로 대체(D-P16). 남은 질문: MSIX에서 D-P16의 확인 목록이 모두 통과하는가. 하나라도 막히면 그때 Azure 서명(연 ~17만 원)으로 돌아간다.
- **Q5:** 도메인 이름.
- **Q3:** 구독이 끝난 Pro 사용자의 클라우드 백업 보관 기간(예: 90일 후 삭제).
- **Q4:** 무료 사용자가 광고를 닫으면 그날 하루 숨길지, 항상 다시 보일지.

## 1단계 작업 목록

1. `main/entitlements.mjs` + 테스트 (유예·만료·revoked·그랜드파더 경계)
2. `main/license.mjs` — 토큰 저장·서명 검증·재검증 타이머(`jobs.mjs`에 등록) + 테스트(위조 토큰 거부를 되돌려 실패 확인)
3. `ipc.mjs` — `project:create`·`project:restore` 제한, `license:activate|deactivate`, `today:getState`에 `ent`
4. `renderer/today.js` — 광고 줄, 설정 탭 "라이선스" 필드, 제한 도달 안내
5. `whenwork-server` — Worker 라이선스·광고 엔드포인트, Ed25519 서명 키
6. 랜딩 페이지(다운로드·가격·약관·개인정보처리방침)
7. MSIX 빌드 검증(D-P16 확인 목록) → Microsoft Store 제출
8. 스모크: 라이선스 서버가 응답하지 않을 때 캡처·오늘 뷰가 그대로 도는지(`capture-crash-smoke`와 같은 방식)
