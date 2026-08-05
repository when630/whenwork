// 샌드박스 preload — ESM을 쓸 수 없으므로 CJS로 둔다 (claude-office 패턴).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whenwork', {
  // ── 퀵캡처
  save: (title) => ipcRenderer.invoke('capture:save', title),
  onReset: (cb) => ipcRenderer.on('capture:reset', () => cb()),

  // ── 오늘 뷰
  getState: () => ipcRenderer.invoke('today:getState'),
  onRefresh: (cb) => ipcRenderer.on('today:refresh', () => cb()),
  complete: (id) => ipcRenderer.invoke('item:complete', id),
  uncomplete: (id) => ipcRenderer.invoke('item:uncomplete', id),
  assign: (id, projectId) => ipcRenderer.invoke('item:assign', id, projectId),
  toWaiting: (id, who) => ipcRenderer.invoke('item:toWaiting', id, who),
  remove: (id) => ipcRenderer.invoke('item:remove', id),

  // ── 재개 카드 (M2)
  resumeGet: (projectId) => ipcRenderer.invoke('resume:get', projectId),
  resumeSync: (projectId) => ipcRenderer.invoke('resume:sync', projectId),
  resumeGenerate: (projectId) => ipcRenderer.invoke('resume:generate', projectId),
  openUrl: (url) => ipcRenderer.send('open:url', url),

  // ── 공통
  hide: () => ipcRenderer.send('win:hide'),
  openApp: () => ipcRenderer.send('app:open'),
});
