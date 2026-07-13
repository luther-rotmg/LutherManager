'use strict';

const { execFile } = require('child_process');

let windowManagerAddon = null;
let nativeLoadError = null;
try {
  const native = require('../native');
  windowManagerAddon = native.addon || null;
  nativeLoadError = native.loadError || null;
} catch (err) {
  nativeLoadError = err;
}

function runPowershell(script, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || err.message || 'powershell failed').trim();
        reject(new Error(detail));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}

function normalizeHandle(value) {
  if (value === null || value === undefined) return '0';
  if (typeof value === 'string') {
    const v = value.trim();
    if (!v) return '0';
    if (/^0x/i.test(v)) return String(parseInt(v, 16));
    return v;
  }
  return String(value);
}

class WindowHostBridge {
  constructor() {
    this.attachments = new Map(); // slotId -> { targetHwnd, hostHwnd, pid }
    this.nativeAddon = windowManagerAddon || null;
    this.nativeLoadError = nativeLoadError || null;
  }

  isSupported() {
    return process.platform === 'win32';
  }

  hasNativeAddon() {
    return !!(this.nativeAddon && process.platform === 'win32');
  }

  async listTopLevelWindows() {
    if (!this.isSupported()) return [];
    if (this.hasNativeAddon()) {
      try {
        const windows = this.nativeAddon.listTopLevelWindows();
        if (!Array.isArray(windows)) return [];
        return windows.map((w) => ({
          pid: Number(w.pid) || 0,
          processName: String(w.processName || ''),
          title: String(w.title || ''),
          hwnd: String(w.hwnd || '0'),
        }));
      } catch (err) {
      }
    }
    const script = [
      '$wins = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } |',
      'Select-Object Id, ProcessName, MainWindowTitle, MainWindowHandle;',
      '$wins | ConvertTo-Json -Compress',
    ].join(' ');
    const out = await runPowershell(script);
    if (!out) return [];
    let parsed = JSON.parse(out);
    if (!Array.isArray(parsed)) parsed = [parsed];
    return parsed.map((w) => ({
      pid: Number(w.Id) || 0,
      processName: String(w.ProcessName || ''),
      title: String(w.MainWindowTitle || ''),
      hwnd: String(w.MainWindowHandle || '0'),
    }));
  }

  async focusWindow(targetHwnd) {
    if (!this.isSupported()) return { ok: false, reason: 'unsupported-platform' };
    const hwnd = normalizeHandle(targetHwnd);
    if (this.hasNativeAddon()) {
      try {
        const ok = !!this.nativeAddon.focusWindow(hwnd);
        return { ok };
      } catch (err) {
      }
    }
    const script = [
      'Add-Type @\'',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class Win32 {',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
      '}',
      '\'@;',
      `$h = [IntPtr]::new(${hwnd});`,
      '[Win32]::ShowWindowAsync($h, 9) | Out-Null;', // SW_RESTORE
      '$ok = [Win32]::SetForegroundWindow($h);',
      'if ($ok) { "ok" } else { "fail" }',
    ].join(' ');
    const out = await runPowershell(script);
    return { ok: out === 'ok' };
  }

  async attachWindow({ slotId, targetHwnd, hostHwnd, pid }) {
    if (!this.isSupported()) return { ok: false, reason: 'unsupported-platform' };
    const child = normalizeHandle(targetHwnd);
    const parent = normalizeHandle(hostHwnd);
    if (this.hasNativeAddon()) {
      try {
        const ok = !!this.nativeAddon.attachWindow(child, parent);
        if (!ok) return { ok: false, reason: 'setparent-failed' };
        this.attachments.set(String(slotId), { targetHwnd: child, hostHwnd: parent, pid: Number(pid) || 0 });
        return { ok: true };
      } catch (err) {
      }
    }
    const script = [
      'Add-Type @\'',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class Win32 {',
      '  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);',
      '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);',
      '  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);',
      '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);',
      '}',
      '\'@;',
      '$GWL_STYLE=-16; $WS_CHILD=0x40000000; $WS_POPUP=0x80000000; $SWP_FRAMECHANGED=0x0020; $SWP_NOMOVE=0x0002; $SWP_NOSIZE=0x0001; $SWP_NOZORDER=0x0004;',
      `$c=[IntPtr]::new(${child});`,
      `$p=[IntPtr]::new(${parent});`,
      '$style=[Win32]::GetWindowLong($c, $GWL_STYLE);',
      '$style=($style -bor $WS_CHILD) -band (-bnot $WS_POPUP);',
      '[Win32]::SetWindowLong($c, $GWL_STYLE, $style) | Out-Null;',
      '$r=[Win32]::SetParent($c, $p);',
      '[Win32]::SetWindowPos($c, [IntPtr]::Zero, 0, 0, 1, 1, $SWP_NOMOVE -bor $SWP_NOSIZE -bor $SWP_NOZORDER -bor $SWP_FRAMECHANGED) | Out-Null;',
      'if ($r -eq [IntPtr]::Zero) { "fail" } else { "ok" }',
    ].join(' ');
    const out = await runPowershell(script);
    if (out !== 'ok') return { ok: false, reason: 'setparent-failed' };
    this.attachments.set(String(slotId), { targetHwnd: child, hostHwnd: parent, pid: Number(pid) || 0 });
    return { ok: true };
  }

  async resizeAttachedWindow(slotId, bounds) {
    if (!this.isSupported()) return { ok: false, reason: 'unsupported-platform' };
    const a = this.attachments.get(String(slotId));
    if (!a) return { ok: false, reason: 'not-attached' };
    const x = Number(bounds?.x ?? 0) | 0;
    const y = Number(bounds?.y ?? 0) | 0;
    const width = Math.max(1, Number(bounds?.width ?? 1) | 0);
    const height = Math.max(1, Number(bounds?.height ?? 1) | 0);
    if (this.hasNativeAddon()) {
      try {
        const ok = !!this.nativeAddon.resizeWindow(a.targetHwnd, x, y, width, height);
        return { ok };
      } catch (err) {
      }
    }
    const script = [
      'Add-Type @\'',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class Win32 {',
      '  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);',
      '}',
      '\'@;',
      `$h=[IntPtr]::new(${a.targetHwnd});`,
      `$ok=[Win32]::MoveWindow($h, ${x}, ${y}, ${width}, ${height}, $true);`,
      'if ($ok) { "ok" } else { "fail" }',
    ].join(' ');
    const out = await runPowershell(script);
    return { ok: out === 'ok' };
  }

  async detachWindow(slotId) {
    if (!this.isSupported()) return { ok: false, reason: 'unsupported-platform' };
    const a = this.attachments.get(String(slotId));
    if (!a) return { ok: true };
    if (this.hasNativeAddon()) {
      try {
        const ok = !!this.nativeAddon.detachWindow(a.targetHwnd);
        this.attachments.delete(String(slotId));
        return { ok };
      } catch (err) {
      }
    }
    const script = [
      'Add-Type @\'',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class Win32 {',
      '  [DllImport("user32.dll")] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);',
      '}',
      '\'@;',
      `$c=[IntPtr]::new(${a.targetHwnd});`,
      '$r=[Win32]::SetParent($c, [IntPtr]::Zero);',
      'if ($r -eq [IntPtr]::Zero) { "fail" } else { "ok" }',
    ].join(' ');
    const out = await runPowershell(script);
    this.attachments.delete(String(slotId));
    return { ok: out === 'ok' || out === 'fail' };
  }

  listAttachments() {
    return Array.from(this.attachments.entries()).map(([slotId, value]) => ({ slotId, ...value }));
  }
}

module.exports = {
  WindowHostBridge,
};
