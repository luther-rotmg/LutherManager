import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { SDKBridge } from './bridge/index.js';
import type { BridgeDeps, ScriptLogLevel, ScriptPanelInboundEvent } from './bridge/BridgeDeps.js';
import { decryptScript } from '../util/ScriptDecryptor.js';
import type { ScriptRuntimePayload } from '../util/ScriptDecryptor.js';
import { getScriptExecutionSession, runWithScriptExecutionSession } from './ScriptExecutionContext.js';

export interface ScriptInfo {
  id: string;
  name: string;
  developer: string;
  version: string;
  path: string;
  rootPath: string;
  entry: string;
  status: 'idle' | 'running' | 'error';
  error?: string;
  /** User-facing status from the running script (“Killing gods”, “Trading”), via ScriptUi.setActivity */
  activity?: string;
  /** Epoch milliseconds for the current run, only present while running. */
  startedAt?: number;
  /** Current run duration in milliseconds, only present while running. */
  runtimeMs?: number;
  /** Headless account this run is bound to, only present while running. */
  accountId?: string;
  /** Every active instance of this script, separated by bound headless account. */
  runs?: ScriptRunInfo[];
}

export interface ScriptRunInfo {
  accountId?: string;
  startedAt: number;
  runtimeMs: number;
  activity?: string;
}

export interface MarketplaceScriptInfo {
  id: string;
  name: string;
  status: 'idle' | 'running';
}

interface ScriptManifest {
  name?: unknown;
  developer?: unknown;
  version?: unknown;
  entry?: unknown;
}

interface ScriptInstance {
  onStart(): void;
  onLoop(): number;
  onStop(): void;
}

interface RunningScript {
  scriptId: string;
  instance: ScriptInstance;
  timer: NodeJS.Timeout;
  startedAt: number;
  accountId?: string;
  runtimeRoot?: string;
}

const SCRIPT_MANIFEST = 'hive.script.json';

export class ScriptHost {
  private scriptsDir: string;
  private running = new Map<string, RunningScript>();
  private readonly starting = new Set<string>();
  private logCallback?: (id: string, line: string, level: ScriptLogLevel) => void;
  private bridgeInstalled = false;
  private readonly scriptSession: { scriptId: string | undefined; accountId?: string };
  /** Latest activity line per account-bound run, for dashboard cards. */
  private scriptActivityByRun = new Map<string, string>();
  /** DevServer notifies dashboard WS clients when activity or runnable state changes (optional). */
  private scriptsStateNotify?: () => void;

  /**
   * In-memory cache of decrypted marketplace module classes.
   * Populated on first `startMarketplace()` call. Reused on subsequent starts
   * after stop — avoids re-fetching from the server every time.
   * Lives for the process lifetime. Nothing is written to disk.
   */
  private marketplaceModuleCache: Map<string, { ModuleClass: new () => ScriptInstance; name: string }> = new Map();

  constructor(scriptSession: { scriptId: string | undefined; accountId?: string }) {
    this.scriptSession = scriptSession;
    this.scriptsDir = join(
      process.env.USERPROFILE || homedir(),
      'Documents',
      'Hive',
      'Scripts'
    );
  }

  /** DevServer pushes updated script list (`activity`, status) to dashboard sockets when set. */
  setScriptsStateNotify(cb?: () => void): void {
    this.scriptsStateNotify = cb;
  }

  private emitScriptsStateChanged(): void {
    try {
      this.scriptsStateNotify?.();
    } catch {
      /* ignore broadcaster errors */
    }
  }

  /**
   * Bridge calls (chat, async timers, etc.) often run outside `withScriptId`, so
   * `scriptSession.scriptId` is cleared. Use the session id when set; otherwise
   * attribute to the only running script when unambiguous.
   */
  private resolveActivityRunKey(deps: BridgeDeps): string | undefined {
    const session = deps.getScriptSession?.() ?? deps.scriptSession;
    const sid = String(session.scriptId ?? '').trim();
    if (sid) return this.runtimeKey(sid, session.accountId);
    if (this.running.size === 1) {
      return this.running.keys().next().value as string;
    }
    return undefined;
  }

  /** Patch @luthermanager/sdk stubs with host implementations (`chat`, `party`, `events`, ...). Call once at startup. */
  installBridge(deps: BridgeDeps): void {
    if (this.bridgeInstalled) return;
    deps.scriptPanelConfigDir ??= join(dirname(this.scriptsDir), 'ScriptConfigs');
    deps.setScriptActivityLabel = (label) => {
      const runKey = this.resolveActivityRunKey(deps);
      if (!runKey) return;
      if (label == null || String(label).trim() === '') {
        this.scriptActivityByRun.delete(runKey);
      } else {
        this.scriptActivityByRun.set(runKey, String(label).trim());
      }
      this.emitScriptsStateChanged();
    };
    deps.getScriptSession = () => getScriptExecutionSession() ?? deps.scriptSession;
    deps.runInScriptSession = (session, fn) => runWithScriptExecutionSession(session, fn);
    SDKBridge.install(deps);
    this.bridgeInstalled = true;
  }

  /** Called by DevServer to forward logs to WebSocket */
  onLog(cb: (id: string, line: string, level: ScriptLogLevel) => void) {
    this.logCallback = cb;
  }

  private withScriptId<T>(id: string, fn: () => T, accountId?: string): T {
    const prev = this.scriptSession.scriptId;
    const prevAccountId = this.scriptSession.accountId;
    this.scriptSession.scriptId = id;
    this.scriptSession.accountId = accountId;
    try {
      return runWithScriptExecutionSession({ scriptId: id, accountId }, fn);
    } finally {
      this.scriptSession.scriptId = prev;
      this.scriptSession.accountId = prevAccountId;
    }
  }

  private log(id: string, line: string, level: ScriptLogLevel = 'info') {
    const msg = `[${id}] ${line}`;
    if (level === 'error') console.error(msg);
    else if (level === 'warn') console.warn(msg);
    else console.log(msg);
    this.logCallback?.(id, msg, level);
  }

  private runtimeKey(scriptId: string, accountId?: string): string {
    const account = String(accountId ?? '').trim();
    return account ? `${scriptId}\u0000${account}` : scriptId;
  }

  /**
   * Loads local scripts from a unique directory so Node cannot reuse any
   * statically imported child module from an earlier run.
   */
  private createRuntimeCopy(script: ScriptInfo): { entryPath: string; runtimeRoot: string } {
    const runtimeBase = join(dirname(this.scriptsDir), 'ScriptRuntime');
    mkdirSync(runtimeBase, { recursive: true });
    const runtimeRoot = mkdtempSync(join(runtimeBase, `${script.id}-`));
    const packageRoot = join(runtimeRoot, 'package');
    cpSync(script.rootPath, packageRoot, {
      recursive: true,
      filter: (source) => {
        const rel = relative(script.rootPath, source);
        if (!rel) return true;
        const topLevel = rel.split(/[\\/]/, 1)[0];
        return topLevel !== 'node_modules' && topLevel !== '.git';
      },
    });
    return { entryPath: resolve(packageRoot, script.entry), runtimeRoot };
  }

  private removeRuntimeCopy(runtimeRoot: string | undefined): void {
    if (!runtimeRoot) return;
    try {
      rmSync(runtimeRoot, { recursive: true, force: true });
    } catch {
      /* runtime cleanup must not prevent script lifecycle completion */
    }
  }

  private runsForScript(scriptId: string): Array<{ key: string; entry: RunningScript }> {
    const runs: Array<{ key: string; entry: RunningScript }> = [];
    for (const [key, entry] of this.running) {
      if (entry.scriptId === scriptId) runs.push({ key, entry });
    }
    return runs;
  }

  private isInside(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
  }

  private parseManifest(scriptRoot: string): ScriptInfo {
    const manifestPath = join(scriptRoot, SCRIPT_MANIFEST);
    const folderName = basename(scriptRoot);

    if (!existsSync(manifestPath)) {
      throw new Error(`Missing ${SCRIPT_MANIFEST}`);
    }

    let manifest: ScriptManifest;
    try {
      const manifestText = readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
      manifest = JSON.parse(manifestText) as ScriptManifest;
    } catch (err: any) {
      throw new Error(`Invalid ${SCRIPT_MANIFEST}: ${err.message}`);
    }

    const name = String(manifest.name ?? '').trim();
    const developer = String(manifest.developer ?? '').trim();
    const version = String(manifest.version ?? '').trim();
    const entry = String(manifest.entry ?? '').trim();

    if (!name) throw new Error(`${SCRIPT_MANIFEST} is missing "name"`);
    if (!developer) throw new Error(`${SCRIPT_MANIFEST} is missing "developer"`);
    if (!version) throw new Error(`${SCRIPT_MANIFEST} is missing "version"`);
    if (!entry) throw new Error(`${SCRIPT_MANIFEST} is missing "entry"`);
    if (entry.includes('\\')) throw new Error(`${SCRIPT_MANIFEST} entry must use forward slashes`);
    if (!entry.endsWith('.mjs')) throw new Error(`${SCRIPT_MANIFEST} entry must point to a .mjs file`);

    const rootPath = resolve(scriptRoot);
    const entryPath = resolve(scriptRoot, entry);
    if (!this.isInside(rootPath, entryPath)) {
      throw new Error(`${SCRIPT_MANIFEST} entry must stay inside the script folder`);
    }
    if (!existsSync(entryPath)) {
      throw new Error(`Entry file not found: ${entry}`);
    }
    if (!statSync(entryPath).isFile()) {
      throw new Error(`Entry is not a file: ${entry}`);
    }

    const activeRuns = this.runsForScript(folderName);
    const runs: ScriptRunInfo[] = activeRuns.map(({ key, entry: runningEntry }) => ({
      accountId: runningEntry.accountId,
      startedAt: runningEntry.startedAt,
      runtimeMs: Math.max(0, Date.now() - runningEntry.startedAt),
      activity: this.scriptActivityByRun.get(key),
    }));
    const primaryRun = runs[0];

    return {
      id: folderName,
      name,
      developer,
      version,
      path: entryPath,
      rootPath,
      entry,
      status: runs.length ? 'running' : 'idle',
      activity: primaryRun?.activity,
      startedAt: primaryRun?.startedAt,
      runtimeMs: primaryRun?.runtimeMs,
      accountId: runs.length === 1 ? primaryRun?.accountId : undefined,
      runs,
    };
  }

  private getScript(id: string): ScriptInfo | undefined {
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.') || id === 'node_modules') {
      return undefined;
    }
    const scriptRoot = join(this.scriptsDir, id);
    if (!existsSync(scriptRoot)) return undefined;
    try {
      if (!statSync(scriptRoot).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    try {
      return this.parseManifest(scriptRoot);
    } catch (err: any) {
      return {
        id,
        name: id,
        developer: 'Unknown',
        version: 'Unknown',
        path: scriptRoot,
        rootPath: scriptRoot,
        entry: '',
        status: 'error',
        error: err.message,
      };
    }
  }

  /** Scans the Scripts folder for script package folders with .mjs entries. */
  list(): ScriptInfo[] {
    if (!existsSync(this.scriptsDir)) {
      return [];
    }

    return readdirSync(this.scriptsDir)
      .filter((name) => name !== 'node_modules' && !name.startsWith('.'))
      .map((name) => join(this.scriptsDir, name))
      .filter((entryPath) => {
        try {
          return statSync(entryPath).isDirectory();
        } catch {
          return false;
        }
      })
      .map((scriptRoot) => {
        try {
          return this.parseManifest(scriptRoot);
        } catch (err: any) {
          const id = basename(scriptRoot);
          return {
            id,
            name: id,
            developer: 'Unknown',
            version: 'Unknown',
            path: scriptRoot,
            rootPath: scriptRoot,
            entry: '',
            status: 'error',
            error: err.message,
          } as ScriptInfo;
        }
      });
  }

  /** Loads and starts a script package by folder id. */
  async start(id: string, accountId?: string): Promise<{ ok: boolean; error?: string }> {
    const runKey = this.runtimeKey(id, accountId);
    if (this.running.has(runKey) || this.starting.has(runKey)) {
      return { ok: false, error: 'Already running for this account' };
    }

    this.scriptActivityByRun.delete(runKey);
    this.emitScriptsStateChanged();

    const script = this.getScript(id);
    if (!script) {
      return { ok: false, error: `Script package not found: ${id}` };
    }
    if (script.status === 'error') {
      return { ok: false, error: script.error ?? 'Script package is invalid' };
    }
    if (!script.path.endsWith('.mjs')) {
      return { ok: false, error: 'Only .mjs script entries are supported' };
    }

    this.starting.add(runKey);
    let runtimeRoot: string | undefined;
    let runtimeAdopted = false;
    try {
      const runtime = this.createRuntimeCopy(script);
      runtimeRoot = runtime.runtimeRoot;
      const fileUrl = pathToFileURL(runtime.entryPath).href;
      const mod = await import(fileUrl);

      const ScriptClass = mod.default;
      if (!ScriptClass) {
        return { ok: false, error: 'Script has no default export' };
      }

      const instance = new ScriptClass() as ScriptInstance;
      if (
        typeof instance.onStart !== 'function' ||
        typeof instance.onLoop !== 'function' ||
        typeof instance.onStop !== 'function'
      ) {
        return { ok: false, error: 'Script must implement onStart(), onLoop(), and onStop()' };
      }

      {
        const diagBag = (globalThis as unknown as { __hiveSDK?: { Hive?: { ui?: { status?: unknown; panel?: { define?: unknown } } } } }).__hiveSDK;
        const diagUi = diagBag?.Hive?.ui;
        const diagStatusSrc = typeof diagUi?.status === 'function' ? Function.prototype.toString.call(diagUi.status).slice(0, 60) : String(diagUi?.status);
        console.error('[ScriptHost] DIAG pre-onStart: bag=%s Hive=%s ui=%s status=%s panel.define=%s\n  status.src=%s',
          !!diagBag, !!diagBag?.Hive, !!diagUi, typeof diagUi?.status, typeof diagUi?.panel?.define, diagStatusSrc);
      }

      this.withScriptId(id, () => {
        this.log(id, `Starting ${script.name} v${script.version} by ${script.developer}...`);
        instance.onStart();
      }, accountId);

      const startedAt = Date.now();
      const schedule = () => {
        if (!this.running.has(runKey)) return;
        this.withScriptId(id, () => {
          try {
            const delay = instance.onLoop();
            if (typeof delay === 'number' && delay < 0) {
              this.log(id, 'Script requested stop (onLoop returned < 0).');
              this.stop(id, accountId);
              return;
            }
            const timer = setTimeout(schedule, typeof delay === 'number' ? delay : 600);
            this.running.set(runKey, {
              scriptId: id,
              instance,
              timer,
              startedAt,
              accountId,
              runtimeRoot,
            });
          } catch (err: any) {
            this.log(id, `Error in onLoop: ${err.message}`, 'error');
            this.stop(id, accountId);
          }
        }, accountId);
      };

      const timer = setTimeout(schedule, 0);
      this.running.set(runKey, {
        scriptId: id,
        instance,
        timer,
        startedAt,
        accountId,
        runtimeRoot,
      });
      runtimeAdopted = true;
      this.withScriptId(id, () => this.log(id, `Running ${script.name} v${script.version} by ${script.developer}.`), accountId);

      this.emitScriptsStateChanged();

      return { ok: true };
    } catch (err: any) {
      console.error('[ScriptHost] start() caught error for', id, ':\n', err?.stack || err?.message || String(err));
      return { ok: false, error: err.message };
    } finally {
      this.starting.delete(runKey);
      if (!runtimeAdopted) this.removeRuntimeCopy(runtimeRoot);
    }
  }

  private stopRuntime(runKey: string): { ok: boolean; error?: string } {
    const entry = this.running.get(runKey);
    if (!entry) {
      return { ok: false, error: 'Not running' };
    }

    clearTimeout(entry.timer);
    this.running.delete(runKey);
    const id = entry.scriptId;
    try {
      SDKBridge.panelRegistry?.destroyForScript(id, entry.accountId);
    } catch {
      /* registry teardown errors shouldn't block script stop */
    }
    this.withScriptId(id, () => {
      try {
        entry.instance.onStop();
        this.log(id, 'Stopped.');
      } catch (err: any) {
        this.log(id, `Error in onStop: ${err.message}`, 'error');
      }
    }, entry.accountId);
    this.removeRuntimeCopy(entry.runtimeRoot);

    this.scriptActivityByRun.delete(runKey);
    this.emitScriptsStateChanged();

    return { ok: true };
  }

  /** Stops one account-bound run, or every run of the script when accountId is omitted. */
  stop(id: string, accountId?: string): { ok: boolean; error?: string } {
    const account = String(accountId ?? '').trim();
    if (account) return this.stopRuntime(this.runtimeKey(id, account));
    const runs = this.runsForScript(id);
    if (runs.length === 0) return { ok: false, error: 'Not running' };
    for (const run of runs) this.stopRuntime(run.key);
    return { ok: true };
  }

  /**
   * Load and start a marketplace script from an encrypted server payload.
   *
   * First call: decrypts the payload, imports the module via data: URL (no disk write),
   * caches the module class in memory, then starts the loop.
   *
   * Subsequent calls (after stop): skips decryption+import and uses the cached class.
   *
   * @param scriptId  The marketplace script UUID (used as the running key)
   * @param name      Display name for logs
   * @param payload   Encrypted payload from POST /api/marketplace/scripts/{id}/runtime
   * @param userId    The authenticated user's ID (for key derivation)
   * @param hwid      The client's HWID from getClientToken() (for key derivation)
   */
  async startMarketplace(
    scriptId: string,
    name: string,
    payload: ScriptRuntimePayload | null,
    userId: string,
    hwid: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const runKey = this.runtimeKey(scriptId);
    if (this.running.has(runKey)) {
      return { ok: false, error: 'Already running' };
    }

    this.scriptActivityByRun.delete(runKey);
    this.emitScriptsStateChanged();

    let cached = this.marketplaceModuleCache.get(scriptId);

    if (!cached) {
      // First run — must have a payload to decrypt
      if (!payload) {
        return { ok: false, error: 'No payload provided and script not cached' };
      }

      try {
        const source = decryptScript(payload, userId, hwid);
        // Load via data: URL — stays in the V8 module cache only, never touches disk
        const encoded = Buffer.from(source).toString('base64');
        const mod = await import(`data:text/javascript;base64,${encoded}`);
        const ModuleClass = mod.default;
        if (typeof ModuleClass !== 'function') {
          return { ok: false, error: 'Script has no default export class' };
        }
        cached = { ModuleClass, name };
        this.marketplaceModuleCache.set(scriptId, cached);
      } catch (err: any) {
        return { ok: false, error: `Failed to load script: ${err.message}` };
      }
    }

    try {
      const instance = new cached.ModuleClass() as ScriptInstance;
      if (
        typeof instance.onStart !== 'function' ||
        typeof instance.onLoop !== 'function' ||
        typeof instance.onStop !== 'function'
      ) {
        return { ok: false, error: 'Script must implement onStart(), onLoop(), and onStop()' };
      }

      this.withScriptId(scriptId, () => {
        this.log(scriptId, `Starting marketplace script: ${cached!.name}...`);
        instance.onStart();
      });

      const startedAt = Date.now();
      const schedule = () => {
        if (!this.running.has(runKey)) return;
        this.withScriptId(scriptId, () => {
          try {
            const delay = instance.onLoop();
            if (typeof delay === 'number' && delay < 0) {
              this.log(scriptId, 'Script requested stop (onLoop returned < 0).');
              this.stopRuntime(runKey);
              return;
            }
            const timer = setTimeout(schedule, typeof delay === 'number' ? delay : 600);
            this.running.set(runKey, { scriptId, instance, timer, startedAt });
          } catch (err: any) {
            this.log(scriptId, `Error in onLoop: ${err.message}`, 'error');
            this.stopRuntime(runKey);
          }
        });
      };

      const timer = setTimeout(schedule, 0);
      this.running.set(runKey, { scriptId, instance, timer, startedAt });
      this.withScriptId(scriptId, () => this.log(scriptId, `Running marketplace script: ${cached!.name}.`));

      this.emitScriptsStateChanged();

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /** Returns true if the marketplace module is cached (already fetched+decrypted this session). */
  isMarketplaceCached(scriptId: string): boolean {
    return this.marketplaceModuleCache.has(scriptId);
  }

  /** Stops all running scripts */
  stopAll() {
    for (const runKey of Array.from(this.running.keys())) this.stopRuntime(runKey);
  }

  isRunning(id: string, accountId?: string): boolean {
    const account = String(accountId ?? '').trim();
    return account
      ? this.running.has(this.runtimeKey(id, account))
      : this.runsForScript(id).length > 0;
  }

  getScriptsDir(): string {
    return this.scriptsDir;
  }

  /**
   * DevServer calls this for dashboard widget events (button clicks, slider
   * changes, user-closed-popout). Routes into the script's handler with the
   * right scriptId pushed onto the bridge session.
   */
  dispatchPanelEvent(evt: ScriptPanelInboundEvent): void {
    SDKBridge.panelRegistry?.dispatchEvent(
      evt,
      (id, accountId, fn) => this.withScriptId(id, fn, accountId),
    );
  }

  /** Snapshot of a script's panel (so dashboards joining late can hydrate). */
  getPanelSnapshot(scriptId: string, accountId?: string): { def: unknown; isOpen: boolean } | undefined {
    return SDKBridge.panelRegistry?.snapshot(scriptId, accountId);
  }

  /** All script ids with a registered panel — used to bootstrap dashboard state. */
  panelInstances(): Array<{ scriptId: string; accountId?: string }> {
    return SDKBridge.panelRegistry?.instances() ?? [];
  }
}
