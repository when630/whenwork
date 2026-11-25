# AI 연결 (MCP)

> Claude Desktop·Claude Code 같은 AI 앱이 WHENWORK에 할 일을 넣고, 읽고, 완료·마감·프로젝트를 정하게 한다. 2026-11-22, 0.4.1에 들어간다.

## D-P29 결정

- **방향**: WHENWORK가 MCP **서버**다. AI 앱이 WHENWORK를 도구로 쓴다. 앱 안에 AI를 넣지 않는다.
- **실행**: AI 앱이 `WHENWORK.exe`를 **Node 모드**(`ELECTRON_RUN_AS_NODE=1`)로 띄워 `main/mcp/server.mjs`를 돌린다. 따로 설치할 것이 없다.
  - Electron 화면 앱 모드는 Windows에서 표준 출력이 나오지 않는다(실측) — 그래서 Node 모드다.
  - 배포판의 RunAsNode 퓨즈는 켜져 있고, Node 모드에서 `app.asar` 안의 ESM을 그대로 불러올 수 있다(실측).
- **저장소**: 앱과 같은 `store.sqlite`를 연다. 앱이 꺼져 있어도 된다. 두 프로세스가 같은 파일에 쓰므로 `busy_timeout 5000`을 둔다. 손상 복구(격리·새로 만들기)는 **앱만** 한다 — MCP 쪽은 `createStore(file, { recover: false })`.
- **화면 갱신**: MCP가 바꾸면 `userData/mcp-signal`을 건드리고, 앱이 그 폴더를 지켜보다 오늘 뷰를 새로 그린다.
- **켜고 끄기**: 기본은 꺼짐. 설정 → AI 연결 (MCP)(A). `settings.json`의 `mcpEnabled === true`일 때만 도구를 실행하고, 부를 때마다 확인한다(끄면 바로 막힌다).
- **도구 7개**: `add_task`(제목·프로젝트·마감), `list_tasks`(today·inbox·waiting·all, 프로젝트, 완료 포함 여부), `list_projects`, `complete_task`, `uncomplete_task`, `set_due`, `assign_project`.
  - 지우기·이름 바꾸기·프로젝트 만들기는 **열지 않는다**. 바꾸는 것은 모두 되돌릴 수 있다.
  - 프로젝트는 이름이나 화면 번호(1~9)로 — 화면과 같은 순서(`getViewState`). 모르는 프로젝트를 만들지 않는다(무료판 개수 제한을 우회하지 않게).
  - 추가는 모든 확인을 통과한 뒤 앱의 캡처와 같은 `insertCaptures`로 저장한다.
- **설정 복사**: 설정 화면이 이 PC의 실제 경로로 Claude Desktop JSON(`mcpServers.whenwork`)과 Claude Code 명령(`claude mcp add whenwork --scope user -e ELECTRON_RUN_AS_NODE=1 -- …`)을 만들어 클립보드에 넣는다.
- **개인정보**: WHENWORK는 아무것도 보내지 않는다. 다만 연결한 AI 앱은 읽은 할 일을 그 AI 서비스로 보낸다 — 설정 화면에 적는다.
- **Microsoft Store판** (2026-11-23): 패키지 안 실행 파일(`WindowsApps`)은 다른 프로그램이 경로로 띄울 수 없고, 설치 폴더 이름에 버전이 들어가 업데이트마다 바뀐다. 그래서
  - 매니페스트에 **실행 별칭 `whenwork.exe`**(`uap3:AppExecutionAlias`)를 선언하고, 복사되는 설정의 command를 `%LOCALAPPDATA%\Microsoft\WindowsApps\whenwork.exe`로 한다.
  - 서버 스크립트 경로를 적지 않고 `-e`로 **실행 파일이 자기 위치(`resources/app.asar`)에서 찾게** 한다(`SELF_LOADER`) — 업데이트로 경로가 바뀌어도 끊기지 않는다.
  - 실측: Store 패키지를 개발자 모드로 등록해 별칭 + Node 모드 환경 변수 + `-e` 로더로 초기화·추가·목록 성공, 확인 뒤 등록 해제. 앱이 복사해 줄 로더와 시험한 로더가 같은 문자열임을 확인.
  - 이 변경은 첫 심사(0.4.0) 통과 뒤의 Store 업데이트에 담는다. 설치 파일판은 경로를 그대로 적는다(설치 위치가 업데이트에도 같다).
- **Claude 말고 다른 AI 앱** (2026-11-26): 서버는 표준 MCP(stdio)라 그대로 두고, 복사 형식만 늘린다. 2026-11 각 공식 문서로 확인.
  - 일반 설정(`mcpServers.whenwork` — command·args·env): Claude Desktop, Cursor(`~/.cursor/mcp.json`), Windsurf, Gemini CLI(`~/.gemini/settings.json`) 등이 같은 모양이라 단추 하나로 둔다.
  - VS Code(Copilot): 최상위가 `servers`, stdio는 `"type": "stdio"`가 필수 — 사용자 `mcp.json`(명령 팔레트 → MCP: Open User Configuration).
  - Codex CLI: `~/.codex/config.toml`의 `[mcp_servers.whenwork]` + `[mcp_servers.whenwork.env]`. 값은 JSON 문자열로 적는다(TOML 기본 문자열과 이스케이프가 같다).
  - 원격(URL) MCP만 받는 앱(ChatGPT 데스크톱 등)은 대상이 아니다 — 서버가 이 PC 밖으로 나가지 않는 것이 원칙.

## 확인

- `test/mcp.test.mjs` 15개 — 도구, 프로토콜, 실제 표준 입출력, 꺼짐/켜짐, 화면 알림, 손상 복구 금지, 번호 순서. 규칙 10개를 일부러 깨 모두 잡힘.
- 실제 앱(개발 실행): 설정에서 켜기 → 설정 복사 → 그 명령 그대로 MCP 서버 실행 → 할 일 추가가 떠 있는 앱 화면에 새로고침 없이 나타남 → 완료가 앱에 반영 → 끄면 바로 막힘.
- 배포판(`electron-builder --dir`): `app.asar` 안의 서버를 Node 모드로 실행해 추가·목록 확인.
- 다른 AI 앱 형식(2026-11-26): 테스트 2개 추가(VS Code·Codex 모양, 설치판·Store판, 형식 선택) — 규칙 5개를 깨 모두 잡힘. 실제 Codex CLI(임시 `CODEX_HOME`)가 복사될 TOML을 읽어 command·args·env를 그대로 보여 줌(한글 경로·Store `-e` 로더 포함).
