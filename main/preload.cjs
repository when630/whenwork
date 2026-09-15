// 샌드박스 preload — ESM을 쓸 수 없으므로 CJS로 둔다 (claude-office 패턴).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whenwork', {
  // ── 퀵캡처
  save: (title) => ipcRenderer.invoke('capture:save', title),
  onReset: (cb) => ipcRenderer.on('capture:reset', () => cb()),
  // ── 오늘 뷰
  getState: () => ipcRenderer.invoke('today:getState'),
  onRefresh: (cb) => ipcRenderer.on('today:refresh', () => cb()),
  // 퀵캡처에서 Tab으로 건너온 길 — 방금 던진 것을 정리하러 왔으므로 인박스부터 본다
  onFromCapture: (cb) => ipcRenderer.on('today:fromCapture', () => cb()),
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
  remove: (id) => ipcRenderer.invoke('item:remove', id),
  restore: (id) => ipcRenderer.invoke('item:restore', id),

  // ── 프로젝트 관리
  projectCreate: (name) => ipcRenderer.invoke('project:create', name),
  projectUpdate: (id, fields) => ipcRenderer.invoke('project:update', id, fields),
  projectArchive: (id) => ipcRenderer.invoke('project:archive', id),
  projectMove: (id, dir) => ipcRenderer.invoke('project:move', id, dir),

  // ── 설정
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  settingsOpenFile: () => ipcRenderer.invoke('settings:openFile'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  hotkeySet: (accel) => ipcRenderer.invoke('hotkey:set', accel),
  dataExport: () => ipcRenderer.invoke('data:export'),
  dataImport: () => ipcRenderer.invoke('data:import'),

  // ── 공통
  hide: () => ipcRenderer.send('win:hide'),
  openApp: () => ipcRenderer.send('app:open'),
});
