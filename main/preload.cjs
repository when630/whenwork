// 샌드박스 preload — ESM을 쓸 수 없으므로 CJS로 둔다 (claude-office 패턴).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whenwork', {
  // ── 퀵캡처
  save: (title) => ipcRenderer.invoke('capture:save', title),
  onReset: (cb) => ipcRenderer.on('capture:reset', () => cb()),
  // 딥링크 whenwork://capture?text= 가 넘긴 글(when-protocol) — reset 뒤에 온다
  onPrefill: (cb) => ipcRenderer.on('capture:prefill', (_e, text) => cb(text)),
  // ── 오늘 뷰
  getState: () => ipcRenderer.invoke('today:getState'),
  onRefresh: (cb) => ipcRenderer.on('today:refresh', () => cb()),
  // 오늘 뷰를 보고 있을 때 인박스 단축키를 눌렀다 — 탭은 렌더러만 안다
  onInboxKey: (cb) => ipcRenderer.on('today:inboxKey', () => cb()),
  complete: (id) => ipcRenderer.invoke('item:complete', id),
  uncomplete: (id) => ipcRenderer.invoke('item:uncomplete', id),
  // keepKind — 대기 항목에 프로젝트만 붙일 때(대기를 풀지 않는다)
  assign: (id, projectId, keepKind) => ipcRenderer.invoke('item:assign', id, projectId, keepKind),
  toWaiting: (id, who) => ipcRenderer.invoke('item:toWaiting', id, who),
  rename: (id, title) => ipcRenderer.invoke('item:rename', id, title),
  setDue: (id, text) => ipcRenderer.invoke('item:due', id, text),
  setNote: (id, note) => ipcRenderer.invoke('item:note', id, note),
  nudge: (id) => ipcRenderer.invoke('item:nudge', id),
  nudgeUndo: (id, at, count) => ipcRenderer.invoke('item:nudgeUndo', id, at, count),
  historyGet: (days) => ipcRenderer.invoke('history:get', days),
  // 검색이 목록 밖(오래된 완료·지운 항목)까지 닿게 — 거르기는 렌더러가 한다
  searchArchive: () => ipcRenderer.invoke('search:archive'),
  remove: (id) => ipcRenderer.invoke('item:remove', id),
  restore: (id) => ipcRenderer.invoke('item:restore', id),

  // ── 프로젝트 관리
  projectCreate: (name) => ipcRenderer.invoke('project:create', name),
  projectUpdate: (id, fields) => ipcRenderer.invoke('project:update', id, fields),
  // 삭제는 인박스로 보낸 항목 id를 돌려준다 — 되돌릴 때 그것들을 함께 데려간다
  projectDelete: (id) => ipcRenderer.invoke('project:delete', id),
  projectRestore: (id, movedItemIds) => ipcRenderer.invoke('project:restore', id, movedItemIds),
  projectMove: (id, dir) => ipcRenderer.invoke('project:move', id, dir),

  // ── 설정
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  settingsOpenFile: () => ipcRenderer.invoke('settings:openFile'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  // key: 'hotkey'(퀵캡처) | 'inboxHotkey'. accel이 비면 기본 조합으로 돌린다
  hotkeySet: (accel, key) => ipcRenderer.invoke('hotkey:set', accel, key),
  dataExport: () => ipcRenderer.invoke('data:export'),
  dataImport: () => ipcRenderer.invoke('data:import'),

  // ── 공통
  hide: () => ipcRenderer.send('win:hide'),
  openApp: () => ipcRenderer.send('app:open'),
});

// Appearance is stored by the main process and broadcast to every app window.
contextBridge.exposeInMainWorld('whenAppearance', {
  initial: ipcRenderer.sendSync('appearance:get'),
  set: (patch) => ipcRenderer.invoke('appearance:set', patch),
  onChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('appearance:changed', listener);
    return () => ipcRenderer.removeListener('appearance:changed', listener);
  },
});
