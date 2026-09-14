// WHENWORK — 트레이 상주. 퀵캡처(전역 단축키) → 로컬 큐 → PostgreSQL 동기화(D1).
//
// 엔트리포인트는 bootstrap() 호출 하나뿐이다(D-08). 앱 수명·창·트레이·단축키는
// main/lifecycle.mjs, 모든 IPC 핸들러는 main/ipc.mjs, 백그라운드 작업·타이머는
// main/jobs.mjs — 세 모듈이 lifecycle.mjs가 만든 ctx로만 상태를 주고받는다.
import { bootstrap } from './lifecycle.mjs';

bootstrap();
