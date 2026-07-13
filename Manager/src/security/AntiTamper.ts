import { AntiDebug } from './AntiDebug.js';
import { AntiHook } from './AntiHook.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TamperViolation {
  category: 'debugger' | 'hook';
  details: string[];
}

export type ViolationHandler = (violations: TamperViolation[]) => void;

// ─── AntiTamper ──────────────────────────────────────────────────────────────

/**
 * Anti-tamper orchestrator for the proxy process (forked child).
 *
 * In packaged Electron builds (HIVE_ROOT set), all checks are
 * skipped — the main process (security.cjs) is the authoritative gate
 * and has already verified integrity before forking this child.
 *
 * In dev mode, runs debugger + hook detection on startup and periodically.
 * File integrity checks are handled exclusively by security.cjs.
 */
export class AntiTamper {
  private static violationHandler: ViolationHandler = AntiTamper.defaultHandler;
  private static monitorInterval: ReturnType<typeof setInterval> | null = null;
  private static isPackagedChild = false;
  private static isProd = false;

  static setViolationHandler(handler: ViolationHandler): void {
    AntiTamper.violationHandler = handler;
  }

  static initialize(root: string, isProd: boolean): void {
    AntiTamper.isProd = isProd;
    AntiTamper.isPackagedChild = isProd && !!process.env.HIVE_ROOT;

    // Block late debugger attachment always
    AntiDebug.blockInspectorSignal();

    // Capture hook baselines (harmless even if we skip detection later)
    AntiHook.captureBaseline();

    // Run initial sweep (skips in packaged builds)
    AntiTamper.sweep();
  }

  static startMonitoring(intervalMs = 30_000): void {
    if (AntiTamper.isPackagedChild) return; // Nothing to monitor
    if (AntiTamper.monitorInterval !== null) return;

    AntiTamper.monitorInterval = setInterval(() => {
      AntiTamper.sweep();
    }, intervalMs);
    AntiTamper.monitorInterval.unref();
  }

  static stopMonitoring(): void {
    if (AntiTamper.monitorInterval !== null) {
      clearInterval(AntiTamper.monitorInterval);
      AntiTamper.monitorInterval = null;
    }
  }

  static sweep(): void {
    // In packaged Electron builds, security.cjs already ran all checks
    // before forking. The child runs obfuscated code inside the ASAR
    // which breaks toString baselines and file path resolution.
    if (AntiTamper.isPackagedChild) return;

    const violations: TamperViolation[] = [];

    // Debugger / hook checks are only meaningful in production.
    // In dev mode tsx legitimately patches fs/crypto for TS compilation,
    // which would cause constant false positives and prevent startup.
    if (AntiTamper.isProd) {
      // 1. Anti-debugger / anti-attach
      const debugResult = AntiDebug.detect();
      if (debugResult.detected) {
        violations.push({ category: 'debugger', details: debugResult.reasons });
      }

      // 2. Anti-hook
      const hookResult = AntiHook.detect();
      if (hookResult.hooked) {
        violations.push({ category: 'hook', details: hookResult.targets });
      }
    }

    if (violations.length > 0) {
      AntiTamper.violationHandler(violations);
    }
  }

  private static defaultHandler(violations: TamperViolation[]): void {
    for (const v of violations) {
      process.stderr.write(`[AntiTamper] ${v.category}: ${v.details.join(', ')}\n`);
    }
    process.exit(1);
  }
}
