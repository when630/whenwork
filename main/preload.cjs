// 샌드박스 preload — ESM을 쓸 수 없으므로 CJS로 둔다 (claude-office 패턴).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whenwork', {
  // ── 퀵캡처
  save: (title) => ipcRenderer.invoke('capture:save', title),
  // 열 때마다 초기화 — 프로젝트 약어 목록을 함께 받아 "#gw → GoWrite"를 그 자리에서 보여준다
  onReset: (cb) => ipcRenderer.on('capture:reset', (_e, projects) => cb(projects)),
  onProjects: (cb) => ipcRenderer.on('capture:projects', (_e, projects) => cb(projects)),

  // ── 오늘 뷰
  getState: () => ipcRenderer.invoke('today:getState'),
  onRefresh: (cb) => ipcRenderer.on('today:refresh', () => cb()),
  complete: (id) => ipcRenderer.invoke('item:complete', id),
  uncomplete: (id) => ipcRenderer.invoke('item:uncomplete', id),
  // keepKind — 대기 항목에 프로젝트만 붙일 때(대기를 풀지 않는다)
  assign: (id, projectId, keepKind) => ipcRenderer.invoke('item:assign', id, projectId, keepKind),
  toWaiting: (id, who) => ipcRenderer.invoke('item:toWaiting', id, who),
  rename: (id, title) => ipcRenderer.invoke('item:rename', id, title),
  setDue: (id, text) => ipcRenderer.invoke('item:due', id, text),
  setNote: (id, note) => ipcRenderer.invoke('item:note', id, note),
  nudge: (id) => ipcRenderer.invoke('item:nudge', id),
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
