# Phase 1: 내장 저장소 전환 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-14
**Phase:** 1-내장 저장소 전환
**Areas discussed:** 캡처 쓰기 경로와 큐의 역할, 전환 기간의 레거시 기능 처리, 새 스키마의 형태, 저장소 파일 운영

---

## 캡처 쓰기 경로와 큐의 역할

### 캡처 한 건이 들어왔을 때 어디에 먼저 쓸까?

| Option | Description | Selected |
|--------|-------------|----------|
| 큐 선기록 유지 → 즉시 store 반영 | 지금 D1 설계 그대로. appendFileSync로 큐에 먼저 남기고 바로 store.insert를 동기로 시도. 큐 append는 fs만 의존해 절대 실패하지 않는다 | ✓ |
| store 직접 쓰기 → 실패 시에만 큐 | 리서치 권고. 평소엔 한 번만 쓰지만 유실 방어선이 try/catch 하나에 걸린다 | |
| 큐만 쓰고 store 반영은 백그라운드 | 지금 구조 그대로 두고 저장소만 교체. 30초 주기 drain의 경합 문제를 계속 안고 간다 | |

**User's choice:** 큐 선기록 유지 → 즉시 store 반영

### store에 반영된 큐 줄은 언제·어떻게 지울까?

| Option | Description | Selected |
|--------|-------------|----------|
| 시작 시 1회 전체 반영 후 파일 교체 | 실행 중에는 append만. 시작 시 rename으로 옆으로 옮기고 전부 반영(INSERT OR IGNORE, id 멱등) 후 삭제. 읽기-쓰기 경합이 구조적으로 사라진다 | ✓ |
| 즉시 반영 성공 시 tmp+rename 재작성 | 큐 파일이 항상 미반영 항목만 들고 있어 pending 숫자가 정직하지만 캡처마다 파일 전체를 다시 쓴다 | |
| 시작 시 1회 + 오늘 뷰 열 때마다 재시도 | 재시작 없이도 오늘 뷰에 나타나지만 실행 중 드레인 경로가 다시 생긴다 | |

**User's choice:** 시작 시 1회 전체 반영 후 파일 교체

### 실행 중 store 즉시 반영 실패 시 사용자에게 어떻게 보이나?

| Option | Description | Selected |
|--------|-------------|----------|
| 재오픈 1회 재시도 → 대기 건수 표시 | store를 닫고 다시 열어 한 번 더. 그래도 실패면 캡처 창은 '저장됨', 트레이 툴팁·오늘 뷰 상단에 'N건 대기 — 다시 시작하면 반영' | ✓ |
| 조용히 큐에만 남기고 다음 시작 시 반영 | STOR-02 문구 그대로. '던진 게 오늘 뷰에 없네'가 유실처럼 보일 수 있다 | |
| 재시도 없이 즉시 알림 + 대기 건수 표시 | 실패 순간 OS 알림. 일시적 디스크 잠김에도 알림이 떠 불안감을 준다 | |

**User's choice:** 재오픈 1회 재시도 → 대기 건수 표시

### STOR-03 강제 종료 테스트 형태?

| Option | Description | Selected |
|--------|-------------|----------|
| node --test에서 자식 프로세스 SIGKILL | Electron 없이 동작. 캡처 경로가 순수 모듈이어야 한다는 제약을 강제 | |
| electron --smoke 안에서 실제 앱 kill | 실제 앱 프로세스로 캡처 → 외부 kill → 재기동 → 오늘 뷰 상태 검사. 가장 실제에 가깝다 | ✓ |
| 둘 다 | 단위 + 스모크 | |

**User's choice:** electron --smoke 안에서 실제 앱 kill
**Notes:** 추천은 node --test였으나 사용자는 실제 앱 프로세스 검증을 택했다. 두 OS 빌드에서 돌아야 하므로 kill 방식의 OS 차이를 흡수해야 한다.

---

## 전환 기간의 레거시 기능 처리

### Phase 1 종료 시점 레거시 기능 상태?

| Option | Description | Selected |
|--------|-------------|----------|
| db.mjs 삭제, 레거시 IPC는 무해한 스텁 | store.mjs는 살아남는 함수만. 레거시 IPC는 빈 값 반환, 타이머 꺼짐. 두 저장소 공존 기간 없음 | ✓ |
| db.mjs를 남기고 store.mjs와 병행 | 레거시 기능은 PG가 있으면 계속 동작하지만 item이 두 곳에 있게 된다 | |
| Phase 1에서 IPC·타이머 호출부까지 제거, UI만 남김 | 제거 작업을 반쯤 떠안게 되고 스모크 범위가 커진다 | |

**User's choice:** db.mjs 삭제, 레거시 IPC는 무해한 스텁

### pg 패키지 위치?

| Option | Description | Selected |
|--------|-------------|----------|
| devDependencies로 이동 | 런타임 import 0건. tools/ 이전 스크립트만 사용. 설치본에 실리지 않음 | ✓ |
| Phase 1에서 완전 제거 | 이전 스크립트가 pg_dump 산출물을 읽어야 해 수동 단계가 하나 더 생긴다 | |
| Phase 3까지 dependencies 유지 | 설치본에 쓰지 않는 pg가 들어간다 | |

**User's choice:** devDependencies로 이동

### main/index.mjs 순수 리팩터 경계?

| Option | Description | Selected |
|--------|-------------|----------|
| lifecycle / ipc / jobs 3분할 | 리서치안. 레거시 코드가 ipc·jobs에 모이고 lifecycle은 거의 안 건든다 | ✓ |
| 기능 도메인별 분할 | 파일 수가 많고 공유 상태 전달 설계가 필요 | |
| 저장소 경로만 추출하는 최소 분할 | 로드맵의 '구조 정리 선행'을 절반만 한다 | |

**User's choice:** lifecycle / ipc / jobs 3분할

### db.mjs 삭제로 깨지는 backup.mjs·backup.test.mjs 처리?

| Option | Description | Selected |
|--------|-------------|----------|
| backup.mjs와 테스트를 Phase 1에서 함께 삭제 | SQL 덤프는 PG 전용. 설정 백업 버튼은 스텁. store.mjs에 STOR-05 가드 테스트로 대체 | ✓ |
| backup을 store 파일 복사로 바꿔 유지 | RMV-04 결정과 갈리고 Phase 1 범위가 늘어난다 | |
| 테스트에서 db 의존 부분만 버리고 backup.mjs는 스텁 | 항상 실패로 끝나는 모듈이 Phase 2까지 남는다 | |

**User's choice:** backup.mjs와 테스트를 Phase 1에서 함께 삭제

---

## 새 스키마의 형태

### timestamptz·date의 SQLite 표현?

| Option | Description | Selected |
|--------|-------------|----------|
| ISO 8601 UTC 문자열 + due는 YYYY-MM-DD | 사람이 읽고 사전순 정렬이 시간순. JSON 내보내기·PG 이전에서 변환 없음 | ✓ |
| 정수 epoch 밀리세컨드 | 비교가 싸지만 파일을 열어보면 읽지 못하고 매번 변환 | |

**User's choice:** ISO 8601 UTC 문자열 + due는 YYYY-MM-DD

### item의 AI·이슈용 칼럼과 project.repo_paths?

| Option | Description | Selected |
|--------|-------------|----------|
| 처음부터 만들지 않음 | STOR-05 정신을 칼럼까지. 렌더러가 undefined를 falsy로 처리하는지 스모크 확인 | ✓ |
| 일단 만들고 Phase 2 마이그레이션에서 제거 | 첫 업데이트부터 v2 마이그레이션이 필요하고 공개판 첫 스키마에 죽은 칼럼이 실린다 | |

**User's choice:** 처음부터 만들지 않음

### 스키마 버전 이행 방식(STOR-04)?

| Option | Description | Selected |
|--------|-------------|----------|
| user_version + 순차 마이그레이션 배열 | 각 단계 트랜잭션. 새 DB도 v1부터 차례로. 한 번 쓴 마이그레이션은 수정하지 않음 | ✓ |
| 매 시작 CREATE IF NOT EXISTS + 칼럼 존재 검사 | 지금 PG 방식 이식. 데이터 변형 이행을 표현할 수 없다 | |

**User's choice:** user_version + 순차 마이그레이션 배열

### 앱보다 높은 user_version의 DB를 만났을 때?

| Option | Description | Selected |
|--------|-------------|----------|
| 열지 않고 안내, 캡처는 큐로 계속 | '새 버전으로 만든 데이터입니다. 앱을 업데이트해 주세요'. 모르는 스키마에 쓰지 않는다 | ✓ |
| 그냥 열어서 쓴다 | 새 제약·칼럼을 모르는 상태에서 쓰기 실패나 데이터 어긋남 가능 | |

**User's choice:** 열지 않고 안내, 캡처는 큐로 계속

---

## 저장소 파일 운영

### DB 파일 위치·이름?

| Option | Description | Selected |
|--------|-------------|----------|
| userData/store.sqlite | 앱 이름과 무관. Phase 5 개명 때 파일명 불변 | ✓ |
| userData/whenwork.db | 앱 이름 포함. Phase 5에서 함께 이전해야 한다 | |
| userData/data/store.sqlite | 하위 폴더로 모으지만 queue.jsonl은 밖에 있다 | |

**User's choice:** userData/store.sqlite

### 시작 시 DB 손상 대응?

| Option | Description | Selected |
|--------|-------------|----------|
| 손상 파일을 옆으로 치우고 새 DB로 시작 + 안내 | SQLITE_CORRUPT·NOTADB 같은 진짜 손상에서만 이동. 잠김·권한 오류에서는 이동하지 않음. 원본 보존 | ✓ |
| 열지 않고 안내만, 사용자가 조치 | 비개발자 사용자는 할 수 있는 일이 없어 앱이 방치된다 | |
| 자동 복구 시도 후 실패 시 옆으로 | node:sqlite에 .recover가 없어 직접 구현해야 한다 | |

**User's choice:** 손상 파일을 옆으로 치우고 새 DB로 시작 + 안내

### 스키마 마이그레이션 직전 자동 백업?

| Option | Description | Selected |
|--------|-------------|----------|
| 이행 직전 파일 복사, 최근 몇 개만 보관 | userData/backups/store-v{이전}-{날짜}.sqlite. 버전이 오를 때만. 백업 실패는 이행을 막지 않음 | ✓ |
| 백업 없이 트랜잭션에만 의지 | '성공했는데 값이 잘못 변환된' 경우 되돌릴 길이 없다 | |

**User's choice:** 이행 직전 파일 복사, 최근 몇 개만 보관

### WAL 내구성·종료 처리?

| Option | Description | Selected |
|--------|-------------|----------|
| synchronous=FULL + 종료 시 wal_checkpoint(TRUNCATE) | 모든 커밋 fsync. 종료 시 단일 파일 상태 | ✓ |
| synchronous=NORMAL | 정전·OS 충돌 시 마지막 커밋 유실 가능 | |

**User's choice:** synchronous=FULL + 종료 시 wal_checkpoint(TRUNCATE)

---

## Claude's Discretion

- node:sqlite 스파이크 합격 기준과 better-sqlite3 전환 판정 조건
- store.mjs 단위 테스트 범위, STOR-03 단위 수준 재현 추가 여부
- 테이블 DDL 세부(인덱스, foreign_keys, FK 동작, event.id 형태)
- 스텁 IPC 반환 형태, 스모크 검사 항목, 마이그레이션 배열 파일 배치
- 백업 보관 개수, 큐 rename 파일 이름 규칙, 안내 문구 최종 표현

## Deferred Ideas

- 매일 store 파일 복사 백업 — RMV-04(백업은 JSON 내보내기가 대신)와 충돌해 채택하지 않음
- STOR-03의 node --test 자식 프로세스 SIGKILL 테스트 — 사용자는 스모크 방식을 택함
