// main/update.mjs — GitHub Releases를 보고 새 버전을 알린다.
//
// **플랫폼에 따라 할 수 있는 일이 다르다.** electron-builder 공식 문서가 못 박은 대로
// macOS 자동 업데이트는 코드 서명이 필수다 — Squirrel.Mac이 서명을 확인하고 거부하므로
// 미서명 배포에서는 내려받아 설치하는 경로 자체가 없다. 그래서 여기서 갈린다:
//
//   Windows (canAutoUpdate: true)  — 확인 → 내려받기 → 다음 실행에 설치
//   macOS   (canAutoUpdate: false) — 확인 → 알리고 받는 곳으로 보낸다
//
// 두 경우 모두 **사용자가 모르는 채로 바뀌지 않는다**. 내려받은 뒤에도 바로 재시작하지
// 않고, 다음에 앱을 끌 때 설치한다(autoInstallOnAppQuit). 퀵캡처 앱이 쓰려는 순간
// 스스로 재시작하면 그 캡처가 갈 곳이 없어진다 — 이 앱에서 그것보다 나쁜 일은 없다.
import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { platform } from './platform/index.mjs';

// electron-updater는 CommonJS다 — ESM에서는 구조분해로 꺼내야 한다
// (electron-builder#7976의 알려진 상호운용 문제).
const { autoUpdater } = electronUpdater;

const RELEASES_URL = 'https://github.com/when630/whenwork/releases/latest';

// 켜자마자 확인하지 않는다 — 부팅이 무거워지고, 첫 캡처가 느려지면 앱의 쓸모가 준다.
const FIRST_CHECK_MS = 60_000;
// 하루 한 번. 트레이 앱은 몇 주씩 떠 있어 주기 확인이 곧 유일한 확인 기회다.
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

// 화면과 트레이가 함께 읽는 상태. 문자열 하나로 두지 않는 이유는 "확인 중"과
// "받는 중 40%"가 서로 다른 말을 해야 하기 때문이다.
export function createUpdateState() {
  return {
    status: 'idle', // idle | checking | available | downloading | ready | error | unsupported
    version: null, // 새 버전 문자열
    percent: 0,
    error: null, // 사람이 읽을 수 있는 한 줄 (내부 경로·스택 없음)
    checkedAt: null,
  };
}

// 상태를 한 줄 말로. 트레이 메뉴와 설정 화면이 같은 문구를 쓴다 —
// 두 곳이 다른 말을 하면 사용자는 어느 쪽이 맞는지 알 수 없다.
export function updateLine(state, { canAutoUpdate = true, current = '' } = {}) {
  switch (state.status) {
    case 'checking':
      return '업데이트 확인 중…';
    case 'available':
      return canAutoUpdate
        ? `새 버전 ${state.version} — 내려받는 중`
        : `새 버전 ${state.version} 있음 — 눌러서 받기`;
    case 'downloading':
      return `새 버전 ${state.version} 내려받는 중 ${Math.round(state.percent)}%`;
    case 'ready':
      return `새 버전 ${state.version} 준비됨 — 종료할 때 설치됩니다`;
    case 'error':
      return `업데이트 확인 실패 — ${state.error}`;
    case 'unsupported':
      return '업데이트 확인은 설치본에서만 동작합니다';
    default:
      return current ? `최신 버전 (${current})` : '최신 버전';
  }
}

export function setupUpdater(ctx) {
  ctx.update = createUpdateState();

  const notifyRenderer = () => {
    ctx.refreshTrayMenu?.();
    ctx.todayWin?.webContents.send('today:refresh');
  };

  // 개발 실행(electron.exe)에는 설치할 대상이 없다. 여기서 막지 않으면
  // electron-updater가 dev-app-update.yml을 찾다가 매번 오류를 뱉는다.
  if (!app.isPackaged) {
    ctx.update.status = 'unsupported';
    ctx.checkForUpdate = async () => ctx.update;
    ctx.installUpdate = () => false;
    return ctx.update;
  }

  // 받는 것까지만 자동이고, 설치는 앱을 끌 때 한다(위 주석의 이유).
  autoUpdater.autoDownload = platform.canAutoUpdate;
  autoUpdater.autoInstallOnAppQuit = true;
  // 평상시에는 조용히 — 기본 console 로거가 stdout을 채운다. 다만 --check-update는
  // "왜 실패하는지"를 보려고 있는 모드라 거기서만 켠다(실패 원인이 요청 헤더나 피드
  // 파싱처럼 이벤트로는 드러나지 않는 자리에 있을 때 이것 말고는 볼 방법이 없다).
  autoUpdater.logger = process.argv.includes('--check-update') ? console : null;

  autoUpdater.on('checking-for-update', () => {
    ctx.update.status = 'checking';
    notifyRenderer();
  });

  autoUpdater.on('update-not-available', () => {
    ctx.update.status = 'idle';
    ctx.update.version = null;
    ctx.update.checkedAt = new Date().toISOString();
    notifyRenderer();
  });

  autoUpdater.on('update-available', (info) => {
    ctx.update.status = 'available';
    ctx.update.version = info?.version ?? null;
    ctx.update.checkedAt = new Date().toISOString();
    notifyRenderer();
    // 자동 설치가 불가능한 쪽(미서명 macOS)에서는 여기서 한 번 알린다 —
    // 알리지 않으면 새 버전이 나온 줄을 영영 모른다.
    if (!platform.canAutoUpdate) {
      ctx.notify?.(`새 버전 ${ctx.update.version}`, '눌러서 받는 곳으로 갑니다', {
        onClick: () => shell.openExternal(RELEASES_URL),
      });
    }
  });

  autoUpdater.on('download-progress', (p) => {
    ctx.update.status = 'downloading';
    ctx.update.percent = p?.percent ?? 0;
    notifyRenderer();
  });

  autoUpdater.on('update-downloaded', (info) => {
    ctx.update.status = 'ready';
    ctx.update.version = info?.version ?? ctx.update.version;
    notifyRenderer();
    ctx.notify?.(`새 버전 ${ctx.update.version} 준비됨`, '앱을 종료할 때 설치됩니다');
  });

  autoUpdater.on('error', (err) => {
    // 네트워크가 없거나 릴리스가 아직 없는 것은 흔한 일이다 — 조용히 실패하되
    // 상태에는 남긴다. 사용자가 설정에서 볼 수 있고, 그 이상 방해하지 않는다.
    ctx.update.status = 'error';
    ctx.update.error = friendlyUpdateError(err);
    // 진단용 원본 — --check-update만 읽는다. 화면·IPC로는 나가지 않는다(01-02 규칙).
    ctx.update.rawError = String(err?.message ?? err ?? '').slice(0, 300);
    notifyRenderer();
  });

  ctx.checkForUpdate = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // 이벤트 핸들러가 이미 상태를 적었다 — 여기서 또 던지지 않는다
    }
    return ctx.update;
  };

  // macOS(미서명)에서는 "설치"가 받는 곳을 여는 것이다. 없는 기능을 있는 척하지 않는다.
  ctx.installUpdate = () => {
    if (!platform.canAutoUpdate) {
      shell.openExternal(RELEASES_URL);
      return false;
    }
    if (ctx.update.status !== 'ready') return false;
    ctx.quitting = true;
    autoUpdater.quitAndInstall();
    return true;
  };

  setTimeout(() => ctx.checkForUpdate(), FIRST_CHECK_MS);
  setInterval(() => ctx.checkForUpdate(), CHECK_INTERVAL_MS);

  return ctx.update;
}

// 사용자에게 보여줄 한 줄. **내부 경로·스택·URL을 넣지 않는다**(01-02 규칙).
export function friendlyUpdateError(err) {
  const msg = String(err?.message ?? err ?? '');
  if (/ENOTFOUND|EAI_AGAIN|ENETUNREACH|ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
    return '네트워크에 연결할 수 없습니다';
  }
  // electron-updater는 릴리스가 하나도 없을 때 404가 아니라 이 문장을 낸다 —
  // 패키징본으로 실제 확인해서 알았다(--check-update). 404만 보면 놓친다.
  if (/404|No published versions/i.test(msg)) return '아직 올라온 릴리스가 없습니다';
  if (/403|rate limit/i.test(msg)) return 'GitHub 요청 한도에 걸렸습니다 — 잠시 뒤 다시';
  // 릴리스를 막 공개한 뒤 몇 분간은 GitHub 피드가 아직 그것을 모른다 — 실제로 406이
  // 왔고, 그동안 "원인을 알 수 없습니다"가 떴다. 곧 풀리는 일이므로 그렇게 말한다.
  if (/406|Cannot parse releases feed|Unable to find latest version/i.test(msg)) {
    return 'GitHub가 아직 최신 릴리스를 알려주지 않습니다 — 잠시 뒤 다시';
  }
  if (/signature|code sign/i.test(msg)) return '서명 확인에 실패했습니다 — 직접 내려받아 주세요';
  return '원인을 알 수 없습니다';
}
