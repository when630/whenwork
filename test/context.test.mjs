// 캡처 컨텍스트 스크립트 — PowerShell을 실제로 돌리지 않고 스크립트 자체를 본다.
// 이 파일이 지키는 것은 두 가지 함정이다:
//   ① here-string(@"..."@) 안에 `$`가 있으면 PowerShell이 변수로 해석해 C#이 망가진다
//   ② pid를 문자열로 이어붙이면 그 자리에 명령이 들어갈 수 있다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { psScript } from '../main/context.mjs';

const csharp = (s) => s.slice(s.indexOf('Add-Type @"'), s.indexOf('"@'));

test('제외할 pid가 Pick 인자로 박힌다', () => {
  assert.match(psScript(1234), /\[FG\]::Pick\(1234\)/);
});

test('pid는 숫자로 굳어 명령이 끼어들 수 없다', () => {
  assert.match(psScript('0; Remove-Item C:\\'), /\[FG\]::Pick\(0\)/);
  assert.doesNotMatch(psScript('0; Remove-Item C:\\'), /Remove-Item/);
  assert.match(psScript(undefined), /\[FG\]::Pick\(0\)/);
});

test('C# 본문에 PowerShell이 해석할 $가 없다', () => {
  assert.doesNotMatch(csharp(psScript(1)), /\$/);
});

test('포그라운드 하나만 보지 않고 z-order를 따라 내려간다', () => {
  // 우리 창이 포그라운드가 된 뒤에 실행돼도 답이 같아야 한다 — 그게 이 스크립트의 존재 이유다
  const s = psScript(1);
  assert.match(s, /GetTopWindow/);
  assert.match(s, /GetWindowThreadProcessId/);
  assert.match(s, /DWMWA_CLOAKED/); // 클로킹된 유령 창을 고르면 엉뚱한 맥락이 남는다
});
