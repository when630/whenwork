import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink, fromArgv, buildManifest, COMMANDS } from '../main/deeplink.mjs';

test('딥링크: whenwork://<명령>?<인자> 를 푼다, 값은 URL 디코딩', () => {
  assert.deepEqual(parseDeepLink('whenwork://add?text=%ED%9A%8C%EC%9D%98%20%EC%A4%80%EB%B9%84'), { command: 'add', args: { text: '회의 준비' } });
  assert.deepEqual(parseDeepLink('whenwork://today'), { command: 'today', args: {} });
  assert.deepEqual(parseDeepLink('whenwork://inbox/'), { command: 'inbox', args: {} });
  assert.deepEqual(parseDeepLink('WHENWORK://Capture?text=a%20b'), { command: 'capture', args: { text: 'a b' } });
  assert.deepEqual(parseDeepLink('whenwork://add'), { command: 'add', args: {} }); // 빈 인자 — 받는 쪽이 캡처 창으로 대신한다
});

test('딥링크: 다른 스킴·모르는 명령·쓰레기는 null', () => {
  assert.equal(parseDeepLink('whennote://open'), null);
  assert.equal(parseDeepLink('whenwork://delete-everything'), null);
  assert.equal(parseDeepLink('https://example.com'), null);
  assert.equal(parseDeepLink(''), null);
  assert.equal(parseDeepLink(null), null);
});

test('fromArgv: argv 어디에 있든 첫 whenwork:// 를 집는다', () => {
  assert.equal(fromArgv(['C:\\WHENWORK.exe', '--allow-file-access', 'whenwork://today']), 'whenwork://today');
  assert.equal(fromArgv(['electron', '.', '--smoke']), null);
  assert.equal(fromArgv(undefined), null);
});

test('매니페스트: 규약 v1 모양이고 광고한 명령을 앱이 전부 받는다 (when-protocol)', () => {
  const m = buildManifest({ platformName: 'win32', exePath: null, packaged: false });
  assert.equal(m.protocol, 1);
  assert.equal(m.id, 'whenwork');
  assert.equal(m.scheme, 'whenwork');
  assert.match(m.verify.win32, /WHENWORK\.exe$/);
  assert.match(m.verify.darwin, /\.app$/);
  assert.equal(m.commands.length, COMMANDS.length);
  for (const c of m.commands) {
    assert.match(c.id, /^[a-z][a-z0-9-]{1,31}$/);
    assert.ok(c.title.trim());
    for (const a of c.args ?? []) assert.equal(a.type, 'string');
    assert.equal(parseDeepLink(`whenwork://${c.id}`)?.command, c.id);
  }
});

test('매니페스트: 패키징본은 실제 실행 파일을 verify에 적는다 — macOS는 .app 번들까지만', () => {
  assert.equal(buildManifest({ platformName: 'win32', exePath: 'D:\\Apps\\WHENWORK\\WHENWORK.exe', packaged: true }).verify.win32, 'D:\\Apps\\WHENWORK\\WHENWORK.exe');
  assert.equal(buildManifest({ platformName: 'darwin', exePath: '/Applications/WHENWORK.app/Contents/MacOS/WHENWORK', packaged: true }).verify.darwin, '/Applications/WHENWORK.app');
  assert.match(buildManifest({ platformName: 'win32', exePath: 'D:\\x\\electron.exe', packaged: false }).verify.win32, /%LOCALAPPDATA%/);
});
