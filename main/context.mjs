// 캡처 순간의 포그라운드 창 제목을 조용히 기록한다 (프로젝트 인지 ①안).
// 실패해도 캡처에는 영향이 없어야 하므로 항상 null로 조용히 물러난다.
//
// PowerShell 5.1의 출력 인코딩은 코드페이지(cp949)를 타서 한글 창 제목이 깨진다 —
// UTF-8 바이트를 Base64로 감싸 받아 Node에서 푼다.
import { execFile } from 'node:child_process';

const PS_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$sb = New-Object System.Text.StringBuilder 512
[void][FG]::GetWindowText([FG]::GetForegroundWindow(), $sb, 512)
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($sb.ToString()))
`;

export function foregroundTitle(timeoutMs = 1500) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const title = Buffer.from(stdout.trim(), 'base64').toString('utf8').trim();
          resolve(title || null);
        } catch {
          resolve(null);
        }
      }
    );
    child.on('error', () => resolve(null));
  });
}
