// main/jobs.mjs — 백그라운드 작업과 타이머 등록 (D-08 분할, main/index.mjs에서 이동)
//
// Phase 2: 제거 대상 기능의 배경 작업을 전부 걷어냈다. 남는 것은 큐 반영 1회, 아침 브리핑,
// purge뿐이다 — 모두 저장소(store.mjs)만 거치고 외부 프로세스를 부르지 않는다.
import { Notification } from 'electron';
import { briefDecision, briefingLines, dayKey, NOTIFY_AT_DEFAULT, STALE_WAITING_DAYS } from './brief.mjs';

const PURGE_DAYS = 30; // 소프트 삭제한 항목을 실제로 비우기까지 두는 기간
const BRIEFING_CHECK_MS = 60_000;
const COLLECT_DELAY_MS = 30_000; // 켜자마자 부팅이 무거워지지 않도록 조금 뒤에

// ── D-08: 백그라운드 작업·타이머 등록. ctx를 받아 그 안의 store/queue/settings/tray를 쓴다.
//
// IPC 핸들러가 불러야 하는 함수는 ctx.jobs에 붙여 둔다 — IPC 핸들러 모듈이 여기서 꺼내 쓴다.
// jobs.mjs는 IPC 핸들러 모듈을 import하지 않는다.
export function scheduleJobs(ctx) {
  // ── 큐 → 저장소, 앱 시작 시 딱 1회(D-01/D-02). 실행 중에는 다시 부르지 않는다 —
  // 주기 타이머로 되살리면 CONCERNS.md가 지적한 읽기-쓰기 경합이 그대로 돌아온다
  // (RESEARCH Pitfall 3). 반영에 실패한 파일은 replayPending이 알아서 남겨 두고
  // 다음 기동이 재시도한다 — 여기서는 그 실패를 세지 않는다(ctx.pending은 "이번
  // 실행에서 즉시 반영에 실패한 캡처 수"이지 큐 줄 수가 아니다).
  function replayQueueOnce() {
    try {
      ctx.queue.replayPending((entries) => ctx.store.insertCaptures(entries));
      ctx.pending = 0;
    } catch {
      // replayPending 자체는 던지지 않는 계약이지만 안전망으로 남겨둔다
    }
    ctx.refreshTrayMenu();
  }

  // ── 아침 브리핑 (오픈이슈 #3). 판단은 main/brief.mjs (테스트 대상), 여기서는 알림만 띄운다.
  // 일정·지난주 리뷰는 이 페이즈에서 걷어낸 기능이라 인자 없이 부른다 — briefingLines()가
  // events/review를 falsy 가드로 이미 감싸고 있어 문구가 깨지지 않는다(RESEARCH Pitfall 1).
  async function maybeBrief() {
    if (!Notification.isSupported()) return;
    const today = dayKey();
    const decision = briefDecision({
      at: ctx.settings.get('notifyAt') ?? NOTIFY_AT_DEFAULT,
      lastBriefing: ctx.settings.get('lastBriefing'),
      enabled: ctx.settings.get('notifyEnabled') !== false,
    });
    if (decision === 'wait') return;
    if (decision === 'skip') {
      ctx.settings.set('lastBriefing', today); // 창을 놓친 날은 넘기고 내일 다시
      return;
    }
    if (!ctx.store.status().ok) return; // 저장소가 붙은 뒤에 — 시도로 치지 않는다
    try {
      const parts = briefingLines(ctx.store.briefing(STALE_WAITING_DAYS));
      ctx.settings.set('lastBriefing', today);
      if (!parts.length) return; // 챙길 게 없으면 조용히
      const note = new Notification({ title: '오늘 WHENWORK', body: parts.join(' · ') });
      note.on('click', () => ctx.showToday());
      note.show();
    } catch {
      // 브리핑 실패는 조용히 — 다음 날 다시
    }
  }

  // 되돌릴 수 있는 창이 지난 삭제분을 실제로 비운다. 기동 시 1회, 실패는 조용히 삼킨다.
  function purgeOnce() {
    try {
      ctx.store.purgeDeleted(PURGE_DAYS);
    } catch {
      // 실패해도 다음 기동이 다시 시도한다
    }
  }

  // IPC 핸들러(main/ipc.mjs)가 불러야 하는 것 — ctx.jobs에 붙여 둔다.
  ctx.jobs = {
    replayQueueOnce,
    maybeBrief,
    purgeOnce,
  };

  // ── 타이머 등록. 큐 반영은 여기서 딱 한 번(D-02) — !SMOKE 가드 밖이다. 01-07의 강제종료
  // 스모크가 두 번째 기동에서 큐 반영이 실제로 일어나는지를 보므로, 스모크에서도 이 호출은 돈다.
  replayQueueOnce();

  if (!ctx.SMOKE) {
    setTimeout(purgeOnce, COLLECT_DELAY_MS); // 오래 전에 지운 것만 실제로 비운다 — 되돌릴 창을 지난 뒤다
    setTimeout(maybeBrief, COLLECT_DELAY_MS); // 켠 직후 한 번 (저장소가 붙을 시간을 준다)
    setInterval(maybeBrief, BRIEFING_CHECK_MS);
  }
}
