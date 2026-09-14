// main/jobs.mjs — 백그라운드 작업과 타이머 등록 (D-08 분할, main/index.mjs에서 이동)
import { app, Notification } from 'electron';
import path from 'node:path';
import { collectProject } from './collect.mjs';
import { collectRepoStates } from './repo.mjs';
import { syncProjectIssues } from './issues.mjs';
import { generateResumeCard, generateWeeklyReview, suggestDoneItems } from './ai.mjs';
import { isoWeek, weekRange } from './parse.mjs';
import { writeWeekly, weeklyPath, statsLine } from './vault.mjs';
import { writeBackup, backupDue } from './backup.mjs';
import { syncCalendar } from './calendar.mjs';
import {
  briefDecision,
  briefingLines,
  reviewDue,
  dayKey,
  NOTIFY_AT_DEFAULT,
  STALE_WAITING_DAYS,
} from './brief.mjs';

const FLUSH_MS = 30_000;
const COLLECT_MS = 6 * 60 * 60 * 1000; // git·이슈 백그라운드 수집 주기 (설계의 "일 1회"보다 촘촘하게)
const COLLECT_DELAY_MS = 30_000; // 켜자마자 긁으면 부팅이 무거워진다 — 조금 뒤에
const PURGE_DAYS = 30; // 소프트 삭제한 항목을 실제로 비우기까지 두는 기간
const CALENDAR_MS = 15 * 60 * 1000;
const BRIEFING_CHECK_MS = 60_000;
const CARD_COOLDOWN_MS = 10 * 60 * 1000; // AI 호출이 실패하면 카드를 열 때마다 몇 분씩 다시 매달리지 않도록 잠시 쉰다
const CARD_STALE_HOURS = 24;

// ── D-08: 백그라운드 작업·타이머 등록. ctx를 받아 그 안의 db/queue/settings/tray 등을 쓴다.
//
// IPC 핸들러가 불러야 하는 함수는 ctx.jobs에 붙여 둔다 — IPC 핸들러 모듈이 여기서 꺼내 쓴다.
// jobs.mjs는 IPC 핸들러 모듈을 import하지 않는다.
export function scheduleJobs(ctx) {
  // review:get(IPC 핸들러)이 생성 중 여부를 읽어야 해서 클로저가 아니라 ctx에 둔다
  ctx.reviewing = false;
  // resume:generate(IPC 핸들러)가 직접 검사하고, resumePayload/buildResumeCard/prewarmCards가 갱신한다
  ctx.generatingCards = new Set(); // 프로젝트별 claude -p 중복 호출 방지
  // settings:get(IPC 핸들러)이 읽어야 해서 ctx에 둔다
  ctx.lastCalendarError = null;

  // ── 큐 → DB. 실패는 조용히 — 큐가 원본을 들고 있으니 다음 기회에 다시 흘린다.
  async function flush() {
    try {
      ctx.dbOnline = await ctx.db.online();
      if (!ctx.dbOnline) return;
      await ctx.queue.drain((entries) => ctx.db.insertCaptures(entries));
    } catch {
      ctx.dbOnline = false;
    }
    ctx.refreshTrayMenu();
  }

  // ── 백그라운드 수집 (일과 중 언제 카드를 열어도 최신이도록)
  let collecting = false;
  async function collectAll() {
    if (collecting || !(await ctx.db.online().catch(() => false))) return;
    collecting = true;
    try {
      for (const p of await ctx.db.getProjects()) {
        if (!p.repo_paths?.length) continue;
        await collectProject(ctx.db, p);
        // 커밋(한 일)과 같은 박자로 "덜 한 일"도 읽는다 — 둘 다 리포가 원본이라 한 번에 훑는다
        await collectRepoStates(ctx.db, p).catch(() => {});
        await syncProjectIssues(ctx.db, p);
      }
      ctx.settings.set('lastCollect', new Date().toISOString());
      await syncCalendarNow();
    } catch {
      // 수집 실패는 조용히 — 다음 주기에 다시 시도한다
    } finally {
      collecting = false;
    }
    // 새로 긁은 커밋을 근거로 카드를 미리 만들어 둔다. collecting을 푼 뒤에 부르는 이유는
    // claude -p가 몇 분씩 걸릴 수 있어 그동안 「지금 수집」이 막히면 안 되기 때문이다.
    // 완료 제안은 그 뒤에 잇는다 — claude -p를 겹쳐 부르지 않는다(구독 한도, 오픈이슈 #4).
    prewarmCards().then(maybeSuggestDone).catch(() => {});
  }

  // ── `claude -p` 호출 계량 (오픈이슈 #4)
  //
  // 사용량이 Claude Code와 같은 구독 한도를 쓰는데 "초과 시 빈도 조정"이라 적어두고도
  // 호출 수를 재는 창구가 없었다. 실패와 걸린 시간까지 남겨야 조정할 근거가 된다
  // (카드 생성은 사람이 부른 게 아니라 백그라운드로 도는 쪽이 많아 화면 이벤트로는 안 잡힌다).
  async function withAiLog(job, fn) {
    const started = Date.now();
    const secs = () => Math.round((Date.now() - started) / 1000);
    try {
      const out = await fn();
      ctx.db.logEvent('ai_call', `${job}:ok:${secs()}s`);
      return out;
    } catch (err) {
      ctx.db.logEvent('ai_call', `${job}:fail:${secs()}s`);
      throw err;
    }
  }

  // ── 주간 리뷰 초안 (D5·오픈이슈 #1)
  //
  // DB에 저장하고 볼트 파일로도 내보낸다. 앱의 리뷰 탭은 DB 쪽을 읽으므로 볼트가 없어도 볼 수 있다.

  // weekOffset: 0=이번 주, -1=지난 주
  function weekOf(weekOffset = 0) {
    const base = new Date();
    base.setDate(base.getDate() + weekOffset * 7);
    const { from, to } = weekRange(base);
    const last = new Date(to.getTime() - 86400000);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { base, from, to, week: isoWeek(base), label: `${fmt(from)} ~ ${fmt(last)}` };
  }

  async function makeWeeklyReview(weekOffset = 0, { notify: useNotification = false } = {}) {
    if (ctx.reviewing) return { ok: false, busy: true };
    ctx.reviewing = true;
    const notify = (body) => {
      if (useNotification) new Notification({ title: 'WHENWORK 주간 리뷰', body }).show();
    };
    try {
      if (!(await ctx.db.online())) {
        notify('DB 꺼짐 — 만들 수 없음');
        return { ok: false, error: 'DB 꺼짐' };
      }
      const w = weekOf(weekOffset);
      const range = { label: w.label };
      notify('초안 생성 중… (claude -p)');
      const material = await ctx.db.weeklyMaterial(w.from, w.to);
      // 지표는 사실이라 AI를 거칠 이유가 없다 — 초안 맨 위에 한 줄로 앱이 직접 붙인다
      const draft = await withAiLog('weekly_review', () => generateWeeklyReview(range, material));
      const body = `${statsLine(material.stats)}\n\n${draft}`;
      const root = ctx.vaultRoot();
      let saved = null;
      if (root) {
        try {
          const file = weeklyPath(root, w.base, w.week);
          writeWeekly(file, body, { week: w.week, range });
          saved = file;
        } catch {
          // 볼트에 못 써도 DB에는 남는다 — 앱에서는 그대로 볼 수 있다
        }
      }
      await ctx.db.saveReview({ year: w.week.year, week: w.week.week, body, range_label: w.label, file: saved });
      await ctx.db.logEvent('weekly_review', saved ?? `${w.week.year}-W${w.week.week}`);
      notify(
        saved
          ? `저장됨 — ${path.basename(saved)}`
          : root
            ? '생성됨 (볼트 저장 실패 — 앱에서 확인)'
            : '생성됨 (볼트 경로 미설정 — 설정 탭에서 지정)'
      );
      backupNow().catch(() => {}); // 리뷰를 만든 주에는 백업도 한 번 남는다 — 기다리지 않는다
      return { ok: true, review: await ctx.db.getReview(w.week.year, w.week.week), ...w, label: w.label };
    } catch (err) {
      const msg = String(err?.message ?? err).slice(0, 160);
      notify(`실패 — ${msg}`);
      return { ok: false, error: msg };
    } finally {
      ctx.reviewing = false;
    }
  }

  const weekTag = (w) => `${w.year}-W${String(w.week).padStart(2, '0')}`;

  // ── 지난주 리뷰를 스스로 만든다. 백업과 같은 이유다(12.6) — 사람이 누르기를 기다렸더니
  // 그 주 수요일에 만든 32주 초안이 주가 끝난 뒤에도 그대로 남았다. 알림 설정과 무관하게 돌고,
  // 카드를 미리 데워두는 것(prewarmCards)과 같은 뜻이다: 열었을 때 이미 있어야 읽는 습관이 붙는다.
  // 판단은 main/brief.mjs의 reviewDue (테스트 대상).
  async function maybeReview() {
    if (ctx.reviewing) return;
    const w = weekOf(-1);
    const lastTry = ctx.settings.get('lastReviewTry');
    // 값싼 조건부터 — 오늘 이미 실패했거나 아직 끝나지 않은 주면 DB를 건드리지 않는다.
    // 같은 함수를 두 번 부르는 이유는 규칙을 여기에 베껴 쓰지 않기 위해서다.
    if (!reviewDue({ weekEnd: w.to, lastTry })) return;
    if (!(await ctx.db.online().catch(() => false))) return; // DB가 붙은 뒤에 — 시도로 치지 않는다
    const existing = await ctx.db.getReview(w.week.year, w.week.week).catch(() => null);
    if (!reviewDue({ weekEnd: w.to, generatedAt: existing?.generated_at, lastTry })) return;
    const res = await makeWeeklyReview(-1);
    if (res.busy) return;
    if (res.ok) {
      ctx.settings.remove('lastReviewError'); // 지난 실패는 성공으로 지운다
      ctx.refreshTrayMenu();
      return; // 만들었다고 따로 알리지는 않는다 — 아침 브리핑이 대신 전한다
    }
    ctx.settings.set('lastReviewTry', dayKey()); // 실패한 날은 더 두드리지 않는다 (AI 호출이 붙어 있다)
    ctx.settings.set('lastReviewError', res.error ?? '원인 불명');
    ctx.refreshTrayMenu();
  }

  // 브리핑에 붙일 리뷰 한 마디. 한 주에 한 번만 — 매일 붙으면 잔소리가 된다.
  // 태그는 알림을 실제로 띄운 뒤에 찍는다(호출부) — 띄우지 못한 아침을 썼다고 치면 그 주는 조용해진다.
  async function reviewNotice() {
    const w = weekOf(-1);
    const tag = weekTag(w.week);
    if (ctx.settings.get('lastReviewNotice') === tag) return null;
    if (new Date() < w.to) return null; // 아직 끝나지 않은 주를 두고 할 말은 없다
    const existing = await ctx.db.getReview(w.week.year, w.week.week).catch(() => null);
    const fresh = existing?.generated_at && new Date(existing.generated_at) >= w.to;
    return { tag, state: fresh ? 'ready' : 'pending' };
  }

  // ── 캘린더 (오픈이슈 #6)
  //
  // Apps Script 웹앱을 주기적으로 긁어 DB에 캐시한다. 실패해도 캐시는 그대로 둬서
  // 네트워크가 끊긴 동안에도 오늘 일정은 계속 보인다. 마지막 오류는 설정 화면에 드러낸다.
  let syncingCalendar = false;

  async function syncCalendarNow() {
    const url = ctx.settings.get('calendarUrl');
    if (!url || syncingCalendar) return { ok: false, skipped: true };
    syncingCalendar = true;
    try {
      if (!(await ctx.db.online().catch(() => false))) return { ok: false, error: 'DB 꺼짐' };
      const res = await syncCalendar(ctx.db, url);
      ctx.lastCalendarError = null;
      ctx.settings.set('lastCalendarSync', new Date().toISOString());
      return res;
    } catch (err) {
      ctx.lastCalendarError = String(err?.message ?? err).slice(0, 200);
      return { ok: false, error: ctx.lastCalendarError };
    } finally {
      syncingCalendar = false;
    }
  }

  // 오늘 0시부터 내일 0시까지 — 오늘 뷰가 쓰는 창
  async function todayEvents() {
    if (!ctx.settings.get('calendarUrl')) return [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    try {
      return await ctx.db.getCalendar(base, new Date(base.getTime() + 86400000));
    } catch {
      return [];
    }
  }

  // ── 백업
  //
  // 데이터가 도커 볼륨 하나에만 있는 상태를 없앤다. 하루 한 번 스스로 남기고,
  // 주간 리뷰를 만들 때도 곁들여 돌리며, 트레이에서 직접 돌릴 수도 있다.
  const BACKUP_DIR_DEFAULT = path.join(app.getPath('userData'), 'backups');
  let backingUp = false;
  async function backupNow() {
    if (backingUp) return { ok: false, busy: true };
    backingUp = true;
    try {
      if (!(await ctx.db.online())) return { ok: false, error: 'DB 꺼짐' };
      const dir = ctx.settings.get('backupDir') || BACKUP_DIR_DEFAULT;
      const file = writeBackup(dir, await ctx.db.exportAll());
      ctx.settings.set('lastBackup', new Date().toISOString());
      ctx.settings.remove('lastBackupError'); // 지난 실패는 성공으로 지운다
      ctx.refreshTrayMenu();
      return { ok: true, file };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err).slice(0, 160) };
    } finally {
      backingUp = false;
    }
  }

  // 하루 한 번. 알림 설정과 무관하게 돈다 — 백업은 아침 브리핑을 꺼둔 날에도 필요하다.
  // 판단은 main/backup.mjs의 backupDue (테스트 대상).
  async function maybeBackup() {
    if (
      !backupDue({ lastBackup: ctx.settings.get('lastBackup'), lastTry: ctx.settings.get('lastBackupTry') })
    ) {
      return;
    }
    if (!(await ctx.db.online().catch(() => false))) return; // DB가 붙은 뒤에 — 시도로 치지 않는다
    const res = await backupNow();
    if (res.ok || res.busy) return; // 성공은 조용히. lastBackup이 갱신돼 오늘 몫은 끝난다
    const why = res.error ?? '원인 불명';
    ctx.settings.set('lastBackupTry', dayKey()); // 실패한 날은 더 두드리지 않는다
    ctx.settings.set('lastBackupError', why);
    ctx.refreshTrayMenu();
    // 백업만은 조용히 실패하면 안 된다 — 사본이 없다는 걸 모르는 채로 지내게 된다.
    // 하루 한 번만 시도하므로 이 알림도 하루 한 번을 넘지 않는다.
    if (Notification.isSupported()) {
      new Notification({ title: 'WHENWORK 백업 실패', body: `${why} — 트레이에서 다시 시도할 수 있다` }).show();
    }
  }

  // ── 아침 브리핑 (오픈이슈 #3). 판단은 main/brief.mjs (테스트 대상), 여기서는 알림만 띄운다.
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
    if (!(await ctx.db.online().catch(() => false))) return; // DB가 붙은 뒤에 다시 시도한다
    try {
      // 리뷰를 먼저 세운다 — 아침에 켠 날은 둘이 같은 박자로 시작해서, 기다리지 않으면
      // 브리핑이 늘 "아직"이라고 말하게 된다. 생성 중이거나 이미 있으면 바로 돌아온다.
      await maybeReview().catch(() => {});
      const notice = await reviewNotice().catch(() => null);
      const parts = briefingLines(await ctx.db.briefing(STALE_WAITING_DAYS), {
        events: await todayEvents(),
        review: notice?.state ?? null,
      });
      ctx.settings.set('lastBriefing', today);
      if (!parts.length) return; // 챙길 게 없으면 조용히
      const note = new Notification({ title: '오늘 WHENWORK', body: parts.join(' · ') });
      note.on('click', () => ctx.showToday());
      note.show();
      if (notice) ctx.settings.set('lastReviewNotice', notice.tag);
    } catch {
      // 브리핑 실패는 조용히 — 다음 날 다시
    }
  }

  // ── 완료 제안 (12.11)
  //
  // 실사용에서 완료 체크가 나흘째 0이었다 — 진짜 일은 커밋·이슈에서 끝나고, 앱에 체크하는 것은
  // 이중 장부 정리라 아무도 하지 않는다. 그래서 앱이 거꾸로 제안한다: 원본 이슈가 닫힌 것은
  // 그 자체가 근거라 AI 없이 그대로, 나머지는 최근 커밋·닫힌 이슈를 근거로 claude -p가 고른다.
  // 완료를 찍는 것은 여전히 사람이다(6절) — 앱이 대신 체크하면 item이 사람 입력의 원본이 아니게 된다.
  // 하루 한 번이면 충분하고(근거의 대부분은 어제의 커밋이다), 실패한 날은 더 두드리지 않는다(리뷰와 같은 규칙).
  async function maybeSuggestDone() {
    const today = dayKey();
    if (ctx.settings.get('lastDoneSuggest') === today || ctx.settings.get('lastDoneSuggestTry') === today) return;
    if (!(await ctx.db.online().catch(() => false))) return; // DB가 붙은 뒤에 — 시도로 치지 않는다
    try {
      const { todos, commits, closedIssues } = await ctx.db.doneSuggestMaterial();
      const fromIssue = todos
        .filter((t) => t.issue_state && t.issue_state !== 'open')
        .map((t) => ({ id: t.id, why: t.issue_state === 'merged' ? '원본 머지됨' : '원본 이슈 닫힘' }));
      const seen = new Set(fromIssue.map((s) => s.id));
      // 근거가 있는 프로젝트의 할 일만 묻는다 — 근거 없는 항목까지 물으면 지어내기를 부른다
      const evidenced = new Set([...commits, ...closedIssues].map((r) => r.project_id));
      const candidates = todos.filter(
        (t) => !seen.has(t.id) && t.project_id && evidenced.has(t.project_id)
      );
      const fromAi = candidates.length
        ? await withAiLog('done_suggest', () => suggestDoneItems(candidates, { commits, closedIssues }))
        : [];
      const pairs = [...fromIssue, ...fromAi];
      if (pairs.length) {
        await ctx.db.setDoneSuggestions(pairs);
        // 창을 열어둔 채였으면 제안 줄이 바로 선다 — 닫혀 있으면 다음에 열 때 refresh가 온다
        if (ctx.todayWin && !ctx.todayWin.isDestroyed()) ctx.todayWin.webContents.send('today:refresh');
      }
      await ctx.db.logEvent('done_suggest', `${pairs.length}/${todos.length}`);
      ctx.settings.set('lastDoneSuggest', today);
    } catch {
      ctx.settings.set('lastDoneSuggestTry', today); // AI 호출이 붙어 있다 — 실패한 날은 쉰다
    }
  }

  // ── M2: 재개 카드
  async function findProject(projectId) {
    return (await ctx.db.getProjects()).find((p) => p.id === projectId) ?? null;
  }

  const cardFailure = new Map();

  async function resumePayload(projectId) {
    const failedAt = cardFailure.get(projectId) ?? 0;
    const card = await ctx.db.getResumeCard(projectId);
    return {
      ok: true,
      card,
      // 카드를 만든 뒤로 쌓인 커밋 수 — 카드가 얼마나 낡았는지는 시각보다 이 숫자가 정확하다
      fresh: card ? await ctx.db.newActivityCount(projectId, card.generated_at) : 0,
      activities: await ctx.db.getActivities(projectId, 10),
      issues: await ctx.db.getIssues(projectId, 12), // 이슈에 PR/MR까지 섞이므로 조금 넉넉하게
      promoted: await ctx.db.promotedIssueUrls(projectId), // 이미 할 일로 세운 이슈
      generating: ctx.generatingCards.has(projectId),
      retryAfter: failedAt + CARD_COOLDOWN_MS > Date.now() ? failedAt + CARD_COOLDOWN_MS : null,
    };
  }

  // 카드 한 장을 실제로 만든다 — 화면의 R와 백그라운드 선갱신이 같은 경로를 쓴다.
  async function buildResumeCard(projectId) {
    if (ctx.generatingCards.has(projectId)) throw new Error('busy');
    ctx.generatingCards.add(projectId);
    try {
      const p = await findProject(projectId);
      if (!p) throw new Error('프로젝트 없음');
      const view = await ctx.db.getViewState();
      // 자료를 먼저 모으고 AI 호출만 감싼다 — 계량에 DB 시간이 섞이지 않게
      const material = {
        activities: await ctx.db.getActivities(projectId, 15),
        doneItems: await ctx.db.getDoneItems(projectId, 7),
        issues: await ctx.db.getIssues(projectId, 14),
        todos: view.today.filter((t) => t.project_id === projectId && !t.done_at),
      };
      const card = await withAiLog('resume_card', () => generateResumeCard(p, material));
      await ctx.db.saveResumeCard(projectId, card);
      cardFailure.delete(projectId);
    } catch (err) {
      cardFailure.set(projectId, Date.now());
      throw err;
    } finally {
      ctx.generatingCards.delete(projectId);
      // 백그라운드로 만드는 동안 사용자가 그 카드를 열어놓았을 수 있다 — 스켈레톤에 갇히지 않게 알린다
      if (ctx.todayWin && !ctx.todayWin.isDestroyed()) ctx.todayWin.webContents.send('card:done', projectId);
    }
  }

  // 카드를 **열 때가 아니라 수집 뒤에** 미리 만들어 둔다. 열어서 30초를 기다리면
  // "프로젝트 열기 전에 카드부터 본다"(M2 완료 판정)는 습관이 붙지 않는다.
  // 대상은 커밋이 새로 들어온 프로젝트뿐이고(projectsNeedingCard), 한 번에 한 장씩 만든다.
  let prewarming = false;
  async function prewarmCards() {
    if (prewarming) return;
    prewarming = true;
    try {
      for (const t of await ctx.db.projectsNeedingCard(CARD_STALE_HOURS)) {
        if (ctx.generatingCards.has(t.id)) continue;
        const failedAt = cardFailure.get(t.id) ?? 0;
        if (failedAt + CARD_COOLDOWN_MS > Date.now()) continue; // 방금 실패한 것은 쉬게 둔다
        try {
          await buildResumeCard(t.id);
        } catch {
          // 실패는 조용히 — 다음 수집 주기에 다시 시도한다 (사용자가 R로 직접 만들 수도 있다)
        }
      }
    } catch {
      // DB가 꺼져 있는 등 — 다음 주기에
    } finally {
      prewarming = false;
    }
  }

  // IPC 핸들러(Task 3의 main/ipc)가 불러야 하는 함수 — ctx.jobs에 붙여 둔다
  ctx.jobs = {
    flush,
    collectAll,
    maybeBrief,
    maybeBackup,
    maybeReview,
    syncCalendarNow,
    todayEvents,
    makeWeeklyReview,
    backupNow,
    buildResumeCard,
    resumePayload,
    findProject,
    weekOf,
    withAiLog,
    prewarmCards,
    BACKUP_DIR_DEFAULT,
  };

  // ── 타이머 등록. lifecycle.mjs의 app.whenReady에 있던 블록을 그대로 옮겨 담는다.
  setInterval(flush, FLUSH_MS);
  flush();

  if (!ctx.SMOKE) {
    setTimeout(collectAll, COLLECT_DELAY_MS);
    setInterval(collectAll, COLLECT_MS);
    // 오래 전에 지운 것만 실제로 비운다 — 되돌릴 창을 지난 뒤다
    setTimeout(() => ctx.db.purgeDeleted(PURGE_DAYS).catch(() => {}), COLLECT_DELAY_MS);
    setTimeout(maybeBrief, COLLECT_DELAY_MS); // 켠 직후 한 번 (DB가 붙을 시간을 준다)
    setInterval(maybeBrief, BRIEFING_CHECK_MS);
    setTimeout(maybeBackup, COLLECT_DELAY_MS); // 백업도 같은 박자로 — 시각은 따지지 않는다
    setInterval(maybeBackup, BRIEFING_CHECK_MS);
    // 리뷰도 마찬가지로 자립한다 — 브리핑을 꺼둔 날에도, 브리핑이 먼저 돌지 않은 날에도
    setTimeout(maybeReview, COLLECT_DELAY_MS);
    setInterval(maybeReview, BRIEFING_CHECK_MS);
    // 캘린더는 git보다 자주 바뀐다 — 6시간 주기와 따로 돈다
    setInterval(syncCalendarNow, CALENDAR_MS);
  }
}
