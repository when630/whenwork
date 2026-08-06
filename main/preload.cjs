// 샌드박스 preload — ESM을 쓸 수 없으므로 CJS로 둔다 (claude-office 패턴).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whenwork', {
  // ── 퀵캡처
  save: (title) => ipcRenderer.invoke('capture:save', title),
  onReset: (cb) => ipcRenderer.on('capture:reset', () => cb()),
  // 약어 목록은 렌더러가 직접 가져간다 — 갓 만든 창은 push를 받을 수 없다
  projects: () => ipcRenderer.invoke('capture:projects'),

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
  classifyInbox: () => ipcRenderer.invoke('inbox:classify'),
  historyGet: (days) => ipcRenderer.invoke('history:get', days),
  captureFollowUp: (title, meeting) => ipcRenderer.invoke('capture:followUp', title, meeting),
  remove: (id) => ipcRenderer.invoke('item:remove', id),
  restore: (id) => ipcRenderer.invoke('item:restore', id),

  // ── 프로젝트 관리
  projectCreate: (name) => ipcRenderer.invoke('project:create', name),
  projectUpdate: (id, fields) => ipcRenderer.invoke('project:update', id, fields),
  projectRepos: (id, paths) => ipcRenderer.invoke('project:repos', id, paths),
  projectArchive: (id) => ipcRenderer.invoke('project:archive', id),
  projectMove: (id, dir) => ipcRenderer.invoke('project:move', id, dir),

  // ── 재개 카드 (M2)
  resumeGet: (projectId, log) => ipcRenderer.invoke('resume:get', projectId, log),
  resumeSync: (projectId) => ipcRenderer.invoke('resume:sync', projectId),
  resumeGenerate: (projectId) => ipcRenderer.invoke('resume:generate', projectId),
  // 백그라운드로 만들어진 카드가 완성됐다는 신호 (열어둔 채 기다리는 경우)
  onCardDone: (cb) => ipcRenderer.on('card:done', (_e, projectId) => cb(projectId)),
  openUrl: (url) => ipcRenderer.send('open:url', url),
  promoteIssue: (projectId, issue) => ipcRenderer.invoke('issue:promote', projectId, issue),

  // ── 주간 리뷰 (M3)
  reviewGet: (weekOffset) => ipcRenderer.invoke('review:get', weekOffset),
  reviewGenerate: (weekOffset) => ipcRenderer.invoke('review:generate', weekOffset),
  reviewOpenFile: (file) => ipcRenderer.invoke('review:openFile', file),
  onOpenReview: (cb) => ipcRenderer.on('today:openReview', () => cb()),

  // ── 설정
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  settingsPickFolder: (current) => ipcRenderer.invoke('settings:pickFolder', current),
  settingsOpenFile: () => ipcRenderer.invoke('settings:openFile'),
  backupNow: () => ipcRenderer.invoke('backup:now'),
  calendarSync: () => ipcRenderer.invoke('calendar:sync'),

  // ── 공통
  hide: () => ipcRenderer.send('win:hide'),
  openApp: () => ipcRenderer.send('app:open'),
});
