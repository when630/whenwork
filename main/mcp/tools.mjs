// AI 연결(MCP) 도구 — Claude 같은 AI 앱이 WHENWORK에 할 일을 넣고, 읽고, 끝내고, 마감·프로젝트를 정한다(D-P29).
// Electron을 모르는 순수 모듈이다 — store만 받는다(node --test로 검증).
//
// 지키는 것:
//   - 지우기·이름 바꾸기·프로젝트 만들기는 열지 않는다. 바꾸는 것은 완료·완료 취소·마감·프로젝트 지정뿐이고 모두 되돌릴 수 있다
//   - 할 일 추가는 앱의 캡처와 같은 저장 함수(insertCaptures)를 지난다 — 저장에 실패하면 실패라고 말한다
//   - 프로젝트는 이름이나 화면의 번호(1~9)로 가리킨다. 모르는 프로젝트를 새로 만들지 않는다(무료판 개수 제한을 우회하지 않게)
//   - 결과는 JSON 텍스트 — AI가 그대로 읽는다. 사용자에게 보일 말은 한국어
import crypto from 'node:crypto';
import { parseDue } from '../parse.mjs';

const MAX_TITLE = 300;
const VIEWS = ['today', 'inbox', 'waiting', 'all'];

const idArg = { type: 'string', description: 'list_tasks가 돌려준 할 일의 id' };
const projectArg = { type: 'string', description: '프로젝트 이름, 또는 화면의 프로젝트 번호(1~9)' };
const dueArg = { type: 'string', description: '마감일 — "오늘", "내일", "모레", "+3", "3일", "8/12", "2026-08-12". 빈 문자열이면 마감을 없앤다' };

export const TOOLS = [
  {
    name: 'add_task',
    description: 'WHENWORK에 할 일을 하나 추가한다. 프로젝트를 정하지 않으면 인박스로, 정하면 그 프로젝트의 할 일(오늘 탭)로 들어간다.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: '할 일 한 줄(300자까지)' }, project: projectArg, due: dueArg },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'WHENWORK의 할 일 목록을 읽는다. view: today(프로젝트에 넣은 할 일), inbox(아직 분류 안 한 것), waiting(남에게 맡기고 기다리는 것), all(셋 다). 완료한 것은 기본으로 빼고, 최근 12시간 안에 끝낸 것만 include_done으로 볼 수 있다.',
    inputSchema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: VIEWS, description: '기본 all' },
        project: projectArg,
        include_done: { type: 'boolean', description: '최근에 완료한 것도 포함(기본 false)' },
      },
    },
  },
  {
    name: 'list_projects',
    description: 'WHENWORK의 프로젝트 목록(화면 순서 = 번호)을 읽는다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'complete_task',
    description: '할 일을 완료로 표시한다. 잘못 표시했으면 uncomplete_task로 되돌린다.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] },
  },
  {
    name: 'uncomplete_task',
    description: '완료한 할 일을 다시 안 끝난 것으로 되돌린다.',
    inputSchema: { type: 'object', properties: { id: idArg }, required: ['id'] },
  },
  {
    name: 'set_due',
    description: '할 일의 마감일을 정하거나 없앤다.',
    inputSchema: { type: 'object', properties: { id: idArg, due: dueArg }, required: ['id', 'due'] },
  },
  {
    name: 'assign_project',
    description: '할 일을 프로젝트에 넣는다. 인박스에 있던 것은 그 프로젝트의 할 일(오늘 탭)이 된다. 프로젝트를 새로 만들지는 않는다.',
    inputSchema: { type: 'object', properties: { id: idArg, project: projectArg }, required: ['id', 'project'] },
  },
];

class ToolError extends Error {}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

export function createTools(store, { now = () => new Date(), newId = () => crypto.randomUUID() } = {}) {
  // 화면과 같은 순서(getViewState: sort, name) — 화면의 1~9 번호가 이 순서다. getProjects는 id로 정렬해 다를 수 있다
  const projects = () => store.getViewState().projects ?? [];

  function resolveProject(ref) {
    const s = String(ref ?? '').trim();
    if (!s) throw new ToolError('프로젝트를 정해 주세요');
    const list = projects();
    if (/^[1-9]$/.test(s)) {
      const p = list[Number(s) - 1];
      if (p) return p;
    }
    const exact = list.find((p) => p.name === s) ?? list.find((p) => p.name.toLowerCase() === s.toLowerCase());
    if (exact) return exact;
    const names = list.map((p, i) => `${i + 1} ${p.name}`).join(', ');
    throw new ToolError(`"${s}" 프로젝트가 없습니다 — 있는 프로젝트: ${names || '(없음)'}. 프로젝트는 WHENWORK에서 만들어 주세요`);
  }

  function item(id) {
    const it = store.findItem(id);
    if (!it || it.deleted_at) throw new ToolError(`그 할 일(${String(id ?? '').slice(0, 40)})을 찾지 못했습니다 — list_tasks로 id를 다시 확인해 주세요`);
    return it;
  }

  function due(raw) {
    const parsed = parseDue(raw, now());
    if (!parsed.ok) throw new ToolError(`마감일 "${raw}"을 알아듣지 못했습니다 — 예: 오늘, 내일, +3, 8/12, 2026-08-12`);
    return parsed.value;
  }

  const shape = (r, view) => ({
    id: r.id,
    title: r.title,
    view,
    project: r.project_name ?? null,
    due: r.due ?? null,
    done: !!r.done_at,
    ...(r.kind === 'waiting' ? { waiting_for: r.waiting_for ?? null } : {}),
  });

  const handlers = {
    add_task({ title, project, due: rawDue } = {}) {
      const t = String(title ?? '').trim().replace(/\s+/g, ' ');
      if (!t) throw new ToolError('할 일 내용이 비어 있습니다');
      if (t.length > MAX_TITLE) throw new ToolError(`할 일은 ${MAX_TITLE}자까지입니다`);
      // 저장 전에 모두 확인한다 — 반쯤 들어간 할 일을 남기지 않게
      const p = project != null && String(project).trim() ? resolveProject(project) : null;
      const d = rawDue != null && String(rawDue).trim() ? due(rawDue) : null;
      const id = newId();
      const r = store.insertCaptures([{ id, title: t, captured_at: now().toISOString(), context: null }]);
      if (!r?.inserted) throw new ToolError('할 일을 저장하지 못했습니다');
      if (p) store.assignProject(id, p.id);
      if (d) store.setDue(id, d);
      return { added: { id, title: t, view: p ? 'today' : 'inbox', project: p?.name ?? null, due: d } };
    },

    list_tasks({ view = 'all', project, include_done = false } = {}) {
      if (!VIEWS.includes(view)) throw new ToolError(`view는 ${VIEWS.join(', ')} 중 하나입니다`);
      const st = store.getViewState();
      const pick = (name) => (view === 'all' || view === name ? (st[name] ?? []).map((r) => shape(r, name)) : []);
      let rows = [...pick('today'), ...pick('inbox'), ...pick('waiting')];
      if (!include_done) rows = rows.filter((r) => !r.done);
      if (project != null && String(project).trim()) {
        const p = resolveProject(project);
        rows = rows.filter((r) => r.project === p.name);
      }
      return { count: rows.length, tasks: rows };
    },

    list_projects() {
      return { projects: projects().map((p, i) => ({ number: i + 1, name: p.name })) };
    },

    complete_task({ id } = {}) {
      const it = item(id);
      if (!it.done_at) store.completeItem(it.id);
      return { completed: { id: it.id, title: it.title } };
    },

    uncomplete_task({ id } = {}) {
      const it = item(id);
      if (it.done_at) store.uncompleteItem(it.id);
      return { reopened: { id: it.id, title: it.title } };
    },

    set_due({ id, due: rawDue } = {}) {
      const it = item(id);
      const d = due(rawDue);
      store.setDue(it.id, d);
      return { due_set: { id: it.id, title: it.title, due: d } };
    },

    assign_project({ id, project } = {}) {
      const it = item(id);
      const p = resolveProject(project);
      store.assignProject(it.id, p.id);
      return { assigned: { id: it.id, title: it.title, project: p.name } };
    },
  };

  const WRITES = new Set(['add_task', 'complete_task', 'uncomplete_task', 'set_due', 'assign_project']);

  return {
    list: () => TOOLS,
    isWrite: (name) => WRITES.has(name),
    call(name, args = {}) {
      const h = Object.hasOwn(handlers, name) ? handlers[name] : null;
      if (!h) return fail(`모르는 도구입니다: ${name}`);
      try {
        return text(h(args && typeof args === 'object' ? args : {}));
      } catch (e) {
        return fail(e instanceof ToolError ? e.message : '처리하지 못했습니다');
      }
    },
  };
}
