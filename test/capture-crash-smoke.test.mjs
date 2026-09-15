// test/capture-crash-smoke.test.mjs — STOR-03: 캡처 직후 강제 종료해도 유실이 없음을
// 두 프로세스 수명에 걸쳐 재현하는 하네스(D-04). 실제 Electron 프로세스를 --smoke로 띄워
// 진짜 saveCapture 경로로 캡처하고, 밖에서 SIGKILL로 죽인 뒤 다시 띄워 오늘 뷰 상태에서
// 그 캡처를 찾는다. OS 분기는 두지 않는다 — Node 공식 문서 기준 SIGKILL은 Windows에서도
// 예외적으로 지원되어 무조건 강제 종료다(RESEARCH 근거).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import electronPath from 'electron';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const INJECT_TIMEOUT_MS = 60_000;
const SMOKE_TIMEOUT_MS = 60_000;

// 자식이 stdout/stderr에 pattern(문자열 또는 정규식)을 낼 때까지 기다린다. 시간 상한을
// 넘기면 자식을 죽이고 지금까지 모인 stdout·stderr를 실패 메시지에 담아 던진다 —
// 조용한 타임아웃은 진단이 불가능하다.
function waitForOutput(child, pattern, timeoutMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let settled = false;
    const check = () => {
      const combined = out + err;
      const hit =
        pattern instanceof RegExp ? combined.match(pattern) : combined.includes(pattern) ? [combined] : null;
      if (hit) {
        settled = true;
        clearTimeout(timer);
        resolve({ match: hit[0], stdout: out, stderr: err });
      }
    };
    child.stdout.on('data', (d) => {
      out += d.toString();
      check();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
      check();
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // 이미 죽었으면 무시
      }
      reject(
        new Error(
          `${timeoutMs}ms 안에 "${pattern}"를 보지 못했다.\n--- stdout ---\n${out}\n--- stderr ---\n${err}`
        )
      );
    }, timeoutMs);
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

test('캡처 직후 강제 종료해도 재기동 시 그 캡처가 오늘 뷰 인박스에 있다', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whenwork-crash-smoke-'));
  const marker = `crash-${Date.now()}`;
  let p1;
  let p2;
  try {
    // 1) 첫 프로세스: 진짜 캡처 경로(saveCapture)로 표식을 저장하고, CAPTURE_INJECTED가
    //    나올 때까지 기다린다 — 이 시점이 큐 append가 실제로 fs에 반영된 시점이다.
    p1 = spawn(
      electronPath,
      ['.', '--smoke', '--smoke-data=' + dataDir, '--inject-capture=' + marker],
      { cwd: repoRoot }
    );
    const injected = await waitForOutput(p1, 'CAPTURE_INJECTED', INJECT_TIMEOUT_MS);
    assert.match(injected.stdout, /CAPTURE_INJECTED\s+\S+/, 'CAPTURE_INJECTED 뒤에 id가 없다');

    // 2) 정상 종료 훅을 전혀 태우지 않고 무조건 강제 종료한다. OS 분기 없이 SIGKILL 한 줄 —
    //    Node 공식 문서 기준 Windows에서도 예외적으로 지원되어 무조건 강제 종료된다.
    p1.kill('SIGKILL');
    const exited = await waitForExit(p1);
    assert.ok(
      exited.signal === 'SIGKILL' || exited.code !== 0,
      `강제 종료가 정상 종료로 보였다: code=${exited.code} signal=${exited.signal}`
    );

    // 3) 같은 --smoke-data로 재기동 — 시작 시 1회 큐 반영(D-02)이 저장소에 밀어 넣는다.
    p2 = spawn(electronPath, ['.', '--smoke', '--smoke-data=' + dataDir], { cwd: repoRoot });
    const done = await waitForOutput(p2, /SMOKE_(OK|FAIL)/, SMOKE_TIMEOUT_MS);
    await waitForExit(p2);

    assert.match(done.stdout, /SMOKE_OK/, `재기동한 프로세스가 SMOKE_OK를 내지 않았다:\n${done.stdout}`);

    const rendererLine = done.stdout.split('\n').find((l) => l.includes('renderer='));
    assert.ok(rendererLine, `renderer= 줄을 찾지 못했다:\n${done.stdout}`);
    const jsonStart = rendererLine.indexOf('renderer=') + 'renderer='.length;
    const jsonEnd = rendererLine.indexOf('} capture=') + 1;
    const renderer = JSON.parse(rendererLine.slice(jsonStart, jsonEnd));
    assert.ok(
      Array.isArray(renderer.inbox) && renderer.inbox.includes(marker),
      `재기동 후 오늘 뷰 인박스에서 표식을 찾지 못했다: ${JSON.stringify(renderer.inbox)}\n` +
        `--- p2 stdout ---\n${done.stdout}`
    );
  } finally {
    // WR-05: waitForOutput이 타임아웃해 내부에서 이미 SIGKILL한 경로에서는, 여기서 곧바로
    // rmSync를 부르면 Windows에서 자식이 아직 store.sqlite(-wal 포함) 핸들을 쥔 채 종료
    // 처리 중일 수 있어 EBUSY/EPERM으로 삭제가 실패하거나 원래 실패 원인을 가리는 2차
    // 예외가 난다. kill 후 실제 종료를 기다리고, 삭제도 재시도를 둔다.
    for (const child of [p1, p2]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // 이미 죽었으면 무시
        }
        await waitForExit(child);
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
