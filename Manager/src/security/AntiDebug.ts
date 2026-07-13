export interface DebugDetectionResult {
  detected: boolean;
  reasons: string[];
}

/**
 * Anti-debugger detection for the Node.js proxy process.
 *
 * Only uses checks with zero false positives:
 *   1. execArgv flags (--inspect*, --debug*)
 *   2. NODE_OPTIONS injection
 *   3. V8 inspector API (active debugger session)
 *   4. Debug port (gated on inspector flag presence)
 *
 * Removed from previous version (false positive sources):
 *   - Timing probe: fires on slow hardware, VMs, loaded systems
 *   - Process scan (tasklist): flags legitimate tools like Wireshark, Fiddler
 */
export class AntiDebug {
  private static readonly INSPECTOR_FLAGS = [
    '--inspect', '--inspect-brk', '--inspect-port',
    '--debug',   '--debug-brk',   '--debug-port',
  ];

  private static checkExecArgv(): string | null {
    const found = process.execArgv.find(arg =>
      AntiDebug.INSPECTOR_FLAGS.some(flag => arg.toLowerCase().startsWith(flag))
    );
    return found ? `inspector flag in execArgv: ${found}` : null;
  }

  private static checkNodeOptions(): string | null {
    const nodeOpts = process.env.NODE_OPTIONS ?? '';
    const found = AntiDebug.INSPECTOR_FLAGS.find(flag =>
      nodeOpts.toLowerCase().includes(flag)
    );
    return found ? `inspector flag in NODE_OPTIONS: ${found}` : null;
  }

  private static checkInspectorActive(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const inspector = require('inspector') as typeof import('inspector');
      const url = inspector.url();
      if (url) return `V8 inspector active: ${url}`;
    } catch { /* not available */ }
    return null;
  }

  private static checkDebugPort(): string | null {
    // Only meaningful when an --inspect/--debug flag was actually passed.
    // process.debugPort defaults to 9229 in ALL Node processes — checking
    // it without the flag gate is a guaranteed false positive.
    const hasInspectArg = process.execArgv.some(a =>
      a.startsWith('--inspect') || a.startsWith('--debug')
    );
    if (!hasInspectArg) return null;

    const port = (process as NodeJS.Process & { debugPort?: number }).debugPort;
    if (typeof port === 'number' && port !== 0) {
      return `debug port bound: ${port}`;
    }
    return null;
  }

  static detect(): DebugDetectionResult {
    const reasons: string[] = [];
    for (const check of [
      AntiDebug.checkExecArgv,
      AntiDebug.checkNodeOptions,
      AntiDebug.checkInspectorActive,
      AntiDebug.checkDebugPort,
    ]) {
      const result = check();
      if (result !== null) reasons.push(result);
    }
    return { detected: reasons.length > 0, reasons };
  }

  static blockInspectorSignal(): void {
    try {
      process.on('SIGUSR1', () => {});
    } catch { /* Windows — harmless */ }
  }
}
