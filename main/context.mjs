// 캡처 순간에 "사용자가 보고 있던 창" 제목을 조용히 기록한다 (프로젝트 인지 ①안).
// 실패해도 캡처에는 영향이 없어야 하므로 항상 null로 조용히 물러난다.
//
// ※ GetForegroundWindow 하나로는 안 된다. PowerShell 기동(Add-Type의 C# 컴파일)이 400ms쯤
//   걸리는데 그 사이 우리 퀵캡처 창이 이미 포그라운드가 되어 있다 — 실사용 13건 전부
//   컨텍스트가 "퀵캡처"(우리 창 제목)로 남아 기능이 죽어 있었고 인박스 AI 분류에는
//   노이즈만 들어갔다. 그래서 **우리 프로세스가 가진 창을 후보에서 빼고** z-order에서
//   가장 위인 실제 창을 고른다. 시점에 의존하지 않으므로 창을 띄운 뒤에 실행돼도 답이 같다.
//
// PowerShell 5.1의 출력 인코딩은 코드페이지(cp949)를 타서 한글 창 제목이 깨진다 —
// UTF-8 바이트를 Base64로 감싸 받아 Node에서 푼다.
import { execFile } from 'node:child_process';

// 후보에서 빼는 것: 안 보이는 창 · 클로킹된 UWP 유령 창(Win11에 흔하다) · 도구 창 · 제목 없는 창.
// C# 쪽에 `$`를 두지 않는다 — here-string(@"..."@)이 PowerShell 변수로 해석한다.
// pid는 스크립트 본문에 박히므로 여기서 숫자로 굳힌다 (문자열이 그대로 들어가면 명령이 된다).
export const psScript = (pid) => {
  const skipPid = Number(pid) >>> 0;
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetTopWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  const uint GW_HWNDNEXT = 2;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x80;
  const int DWMWA_CLOAKED = 14;

  static string Title(IntPtr h) {
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    StringBuilder sb = new StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static bool Usable(IntPtr h, uint skip) {
    if (h == IntPtr.Zero || !IsWindowVisible(h)) return false;
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    if (pid == 0 || pid == skip) return false;
    if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return false;
    int cloaked = 0;
    if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return false;
    return Title(h).Length > 0;
  }

  // 포그라운드가 우리 창이 아니면 그게 답이고, 우리 창이면 z-order를 따라 내려가며 첫 실제 창을 찾는다
  public static string Pick(uint skip) {
    IntPtr fg = GetForegroundWindow();
    if (Usable(fg, skip)) return Title(fg);
    for (IntPtr h = GetTopWindow(IntPtr.Zero); h != IntPtr.Zero; h = GetWindow(h, GW_HWNDNEXT)) {
      if (Usable(h, skip)) return Title(h);
    }
    return "";
  }
}
"@
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([FG]::Pick(${skipPid})))
`;
};

// excludePid: 이 프로세스가 가진 창은 후보에서 뺀다. 기본값은 우리 자신 —
// Windows에서 BrowserWindow의 HWND는 main 프로세스 소유이므로 이것으로 우리 창 전부가 걸러진다.
export function foregroundTitle({ excludePid = process.pid, timeoutMs = 3000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript(excludePid)],
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
