import http from 'http';
import https from 'https';
import net from 'net';
import { copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, extname, dirname, basename, resolve } from 'path';
import sharp from 'sharp';
import { execFileSync, spawn } from 'child_process';
// NOTE: DevServer runs in a forked Node child process (electron/main.cjs
// → fork(distApp, ...)), NOT in the Electron main process. So
// `require('electron')` is unavailable here — opening folders must go
// through child_process directly. The `cmd /c start "" "<path>"` shape
// is the reliable Windows pattern (delegates to the shell which knows
// how to open folders); macOS / Linux have their own openers.
import { WebSocketServer, WebSocket } from 'ws';
import { XMLParser } from 'fast-xml-parser';
import { PacketInspector, type CapturedPacket } from './PacketInspector.js';
import { PacketLab } from './PacketLab.js';
import type { PluginManager } from '../../plugins/PluginManager.js';
import type { Proxy } from '../../proxy/Proxy.js';
import type { GameWorldState } from '../../state/GameWorldState.js';
import type { GameDataLoader } from '../../game-data/GameDataLoader.js';
import { Logger } from '../../util/Logger.js';
import { RuntimeScheduler } from '../../util/RuntimeScheduler.js';
import type { HeadlessChatMessage, HeadlessFleet, HeadlessSessionSummary } from '../../headless/HeadlessFleet.js';
import {
  createProxyAgent,
  parseProxyConfig,
  testProxy as testNetworkProxy,
  type PacketTraffic,
  type ProxyConfig,
  type ProxyProtocol,
} from 'headless-client';
import { getHiveDataDir, getHiveDocumentsDir } from '../../util/rotmgAssetExtractor.js';

// ── Debug logging ─────────────────────────────────────────────────────────────
const DEBUG_LOG_PATH = join(process.env.USERPROFILE || '', 'Documents', 'Hive', 'debug.log');
function debugLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { writeFileSync(DEBUG_LOG_PATH, line, { flag: 'a' }); } catch { /* ignore */ }
}

function extractUserIdFromJwt(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return undefined;
    const payload = parts[1];
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const o = JSON.parse(json) as { sub?: string; userId?: string };
    const id = o.sub ?? o.userId;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}
// ─────────────────────────────────────────────────────────────────────────────
import { getClientToken, clearCachedHwid } from '../../util/Hwid.js';
import { ConditionEffect } from '../../constants/ConditionEffect.js';
import { getMarketCatalogStub } from '../marketCatalogStub.js';
import type { ScriptHost } from '../../scripts/ScriptHost.js';
import type {
  BridgeClientRef,
  ScriptPanelInboundEvent,
  ScriptPanelOutboundMessage,
} from '../../scripts/bridge/BridgeDeps.js';
import { getVaultStore } from '../../scripts/bridge/inventory/VaultStore.js';
import packetDefinitions from '../../packets/packetDefinitions.generated.js';
import packetLabNameOnly from '../../packets/packetLabNameOnly.generated.js';
import packetStatus from '../../packets/packetStatus.generated.js';
import {
  activatePowerPlan,
  applyClientRoleRuleToSeedPid,
  applyResolvedRolesMultiboxClusters,
  bringRealmPidMainWindowForeground,
  emptyWorkingSetForPids,
  getForegroundPid,
  getRelatedRealmProcessIds,
  listExaltProcesses,
  listPowerPlans,
  sampleWindowsThermalSignals,
  resizeRestoreRealmPidCluster,
  setAllExaltPriority,
  spreadAffinityEven,
  tuningSupported,
  moveRotmgLaunchedWindowAfterSpawn,
  SUGGESTED_REALM_POWER_HINTS,
} from '../process/rotmgWindowsClientTune.js';
import { registerCredentialLaunch } from '../process/credentialLaunchRegistry.js';
import type { PriorityPreset } from '../process/rotmgWindowsClientTune.js';
import type { ExaltProcessRow } from '../process/rotmgWindowsClientTune.js';
import { loadExaltTuneSettings, saveExaltTuneSettings, tuneSettingsPath } from '../process/exaltTuneSettings.js';
import type { ExaltTuneSettings } from '../process/exaltTuneSettings.js';
import {
  stopExaltTuneWatchdog,
  syncExaltTuneWatchdogFromDisk,
} from '../process/exaltTuneWatchdog.js';
import {
  applyTuningPresetToDisk,
  getEffectiveMultiboxRoleRules,
  type TuningPresetName,
} from '../process/tuningPresets.js';
import {
  applyEffectiveMultiboxPolicyFromDisk,
  applyMultiboxPresetAndLivePolicy,
  applyRolePrioritiesFromDisk,
  restoreAllClientTuning,
} from '../process/exaltRoleGovernor.js';
import {
  captureProcessBaselineOverwrite,
  restoreProcessBaseline,
} from '../process/exaltProcessBaseline.js';
import {
  clientRolesPath,
  loadExaltClientRoles,
  resolveClusterRole,
  saveExaltClientRoles,
  type ClientRole,
} from '../process/exaltClientRoles.js';
import { isThermalBackgroundDemotionActive } from '../process/thermalStressLayer.js';

/** `taskkill /IM msedge.exe /F /T` — frees RAM from stray Edge renderer processes (Windows only). */
function killMicrosoftEdgeProcessesBestEffort(): {
  ok: boolean;
  /** True if taskkill succeeded and at least terminated the matching image (exit 0). */
  ran: boolean;
  error?: string;
} {
  if (process.platform !== 'win32') {
    return { ok: false, ran: false, error: 'Windows only.' };
  }
  try {
    execFileSync('taskkill', ['/IM', 'msedge.exe', '/F', '/T'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, ran: true };
  } catch (err) {
    const message = String((err as Error).message || '');
    const stderr = (err as { stderr?: Buffer })?.stderr ? String((err as { stderr?: Buffer }).stderr) : '';
    const combined = `${message} ${stderr}`;
    if (/not found|no running instance|not running/i.test(combined)) {
      return { ok: true, ran: false };
    }
    Logger.warn('DevServer', `kill-msedge: ${combined.trim()}`);
    return { ok: false, ran: false, error: combined.trim() || message };
  }
}

const BOT_API_URL = '';
const DEFAULT_PLUGIN_CONFIG_ID = 'default';
const DEFAULT_PLUGIN_CONFIG_NAME = 'default';

type GemStatusResponse = {
  gem_balance: number;
  active: boolean;
  active_subs?: Array<{ plan_name: string }>;
  next_deduction_at: string | null;
};

type EventContext = {
  planTier: string;
  serverName: string;
  className: string;
};

type DisabledEventTracker = {
  start(): void;
  stop(): void;
  track(name: string, props?: Record<string, unknown>): void;
};

function fingerprintObject(value: unknown): string {
  return Buffer.from(JSON.stringify(value ?? {})).toString('base64url').slice(0, 16);
}

class DisabledBotApiClient {
  loggedIn = false;

  getAccessToken(): string | null { return null; }
  loginWithTokens(..._args: unknown[]): void { this.loggedIn = false; }
  logout(): void { this.loggedIn = false; }

  async login(..._args: unknown[]): Promise<GemStatusResponse> {
    throw new Error('Hive backend login has been removed.');
  }

  async checkGems(..._args: unknown[]): Promise<GemStatusResponse> {
    return { gem_balance: 0, active: false, active_subs: [], next_deduction_at: null };
  }

  async getBundles(..._args: unknown[]): Promise<Array<Record<string, unknown>>> { return []; }
  async createStripeCheckout(..._args: unknown[]): Promise<{ checkout_url: string; payment_id: string }> {
    throw new Error('Payments have been removed.');
  }
  async getOwnedScripts(..._args: unknown[]): Promise<Array<{
    id: string;
    script_id: string;
    script_name: string;
    expires_at: string | null;
    gems_paid: number;
  }>> { return []; }
  async getScriptRuntime(..._args: unknown[]): Promise<never> {
    throw new Error('Marketplace scripts have been removed.');
  }

}

function unparkRealmPidCluster(rel: readonly number[]): void {
  const s = loadExaltClientRoles();
  const rm = new Set(rel);
  const next = s.parkedPids.filter((p) => !rm.has(p));
  if (next.length !== s.parkedPids.length) saveExaltClientRoles({ parkedPids: next });
}

/** Multibox: foreground PID + persisted parked set → per-row/cluster role hints. */
async function enrichWindowTuningExaltPayload(): Promise<{
  processes: ExaltProcessRow[];
  logicalProcessors: number;
  foregroundPid: number | null;
  clientRolesPath: string;
}> {
  const raw = await listExaltProcesses();
  const fg = await getForegroundPid();
  const running = new Set(raw.processes.map((p) => p.pid));

  let rolesSt = loadExaltClientRoles();
  const parkedPruned = rolesSt.parkedPids.filter((p) => running.has(p));
  if (parkedPruned.length !== rolesSt.parkedPids.length) {
    rolesSt = saveExaltClientRoles({ parkedPids: parkedPruned });
  }

  const parkedSet = new Set(rolesSt.parkedPids);
  const uniq = [...new Set(raw.processes.map((p) => p.pid))].sort((a, b) => a - b);

  const pidCluster = new Map<number, number[]>();
  const pidRole = new Map<number, ClientRole>();
  let accounted = new Set<number>();
  const roleTable = getEffectiveMultiboxRoleRules();

  for (const seed of uniq) {
    if (accounted.has(seed)) continue;
    const rel = await getRelatedRealmProcessIds(seed);
    for (const id of rel) {
      accounted.add(id);
      pidCluster.set(id, rel);
    }
    const role = resolveClusterRole(rel, fg, parkedSet);
    for (const id of rel) pidRole.set(id, role);
  }

  const processes: ExaltProcessRow[] = raw.processes.map((row) => {
    const rol = pidRole.get(row.pid) ?? 'background';
    const cluster = pidCluster.get(row.pid) ?? [row.pid];
    return {
      ...row,
      role: rol,
      clusterPids: cluster,
      trimEligible: roleTable[rol].trimEligible,
    };
  });

  return {
    processes,
    logicalProcessors: raw.logicalProcessors,
    foregroundPid: fg,
    clientRolesPath: clientRolesPath(),
  };
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
};

/** Atlas basenames (no .png) — order must match RotMGAssetExtractor `ImageBuffer.spriteSheets`. */
const WIKI_EXTRACT_ATLAS_BASES = ['groundTiles', 'characters', 'characters_masks', 'mapObjects'] as const;

interface WikiSpriteFrame {
  atlasId: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface WikiSpriteSheetCache {
  gameDataDir: string;
  sheetMtime: number;
  byGroup: Map<string, Map<number, WikiSpriteFrame>>;
}

interface DashboardAccountRecord {
  id: string;
  label: string;
  email: string;
  password: string;
  serverName: string;
  notes: string;
  preferredScriptId: string;
  createdAt: number;
  updatedAt: number;
  proxyId: string;
  proxyProtocol: ProxyProtocol;
  proxy: string;
  proxyUsername: string;
  proxyPassword: string;
}

type DashboardAccountProxySelection = Pick<
  DashboardAccountRecord,
  'proxyId' | 'proxyProtocol' | 'proxy' | 'proxyUsername' | 'proxyPassword'
>;

interface DashboardAccountOverviewItem {
  objectType: number;
  objectTypeHex: string;
  name: string;
  uniqueId: string | null;
  enchantIds: number[];
}

interface DashboardAccountEquipmentToken {
  objectType: number;
  uniqueId: string | null;
}

interface DashboardAccountOverviewCharacter {
  charId: number;
  classType: number;
  classTypeHex: string;
  className: string;
  level: number;
  exp: number;
  fame: number;
  seasonal: boolean;
  dead: boolean;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  attack: number;
  defense: number;
  speed: number;
  dexterity: number;
  vitality: number;
  wisdom: number;
  equipment: DashboardAccountOverviewItem[];
  inventory: DashboardAccountOverviewItem[];
  backpacks: DashboardAccountOverviewItem[];
}

interface DashboardAccountOverviewStorageSection {
  items: DashboardAccountOverviewItem[];
  totalCount: number;
  uniqueCount: number;
}

interface DashboardAccountOverview {
  accountName: string;
  totalFame: number;
  aliveFame: number;
  bestCharFame: number;
  maxNumChars: number;
  characters: DashboardAccountOverviewCharacter[];
  vault: DashboardAccountOverviewStorageSection;
  gifts: DashboardAccountOverviewStorageSection;
  temporaryGifts: DashboardAccountOverviewStorageSection;
  materialStorage: DashboardAccountOverviewStorageSection;
  potions: DashboardAccountOverviewStorageSection;
}

interface DashboardAccountOverviewCacheRecord {
  accountId: string;
  email: string;
  updatedAt: number;
  overview: DashboardAccountOverview;
}

type DashboardProxyStatus = 'untested' | 'working' | 'failed';

interface DashboardProxyRecord {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastTestAt: number;
  lastLatencyMs: number;
  lastStatus: DashboardProxyStatus;
  lastError: string;
}

interface HeadlessPacketRecord {
  id: number;
  accountId: string;
  timestamp: number;
  direction: 'C->S' | 'S->C';
  packetId: number;
  name: string;
  size: number;
  payloadHex: string;
  payloadTruncated: boolean;
}

interface HeadlessViewerOptions {
  includeTiles: boolean;
  includeObjects: boolean;
  includeSelfProjectiles: boolean;
  includeOtherProjectiles: boolean;
  includePathfindingPath: boolean;
  includeDodgePath: boolean;
}

interface HeadlessViewerSubscription extends HeadlessViewerOptions {
  accountId: string;
  radius: number;
  mapName: string;
  tileKeys: Set<string>;
}

const VIEWER_DODGE_PATH_HORIZON_MS = 450;

/**
 * Dev dashboard HTTP + WebSocket server.
 * Serves the packet inspector UI on localhost:3000.
 */
export class DevServer {
  private static readonly HEADLESS_CHAT_HISTORY_LIMIT = 300;
  private static readonly HEADLESS_PACKET_HISTORY_LIMIT = 500;
  private static readonly HEADLESS_PACKET_PAYLOAD_LIMIT = 512;
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private inspector: PacketInspector;
  private lab: PacketLab;
  private proxy: Proxy | null = null;
  private pluginManager: PluginManager;
  private gameClientConnected = false;
  private ipToServerName: Record<string, string> = {};
  private detectedGamePath: string | null = null;
  private configPath: string;
  private config: {
    rotmgPath?: string;
    /**
     * Folder containing RotMGAssetExtractor output: either `.../RotMG-extractor-output`
     * (with `GameData/` inside) or the `GameData` directory itself (must contain
     * `spritesheet.xml` and `images/`).
     */
    rotmgExtractorGameDataPath?: string;
    lastPluginConfigId?: string;
    singleClientOnly?: boolean;
  } = {
    singleClientOnly: true,
  };
  /** Parsed `spritesheet.xml` from extractor dump; invalidated when mtime changes. */
  private wikiSpriteSheetCache: WikiSpriteSheetCache | null = null;
  private serverNames: string[] = [];
  private servers: Record<string, string> = {};
  private botApiClient: DisabledBotApiClient;
  private eventTracker: DisabledEventTracker | null = null;
  /** Last server name we emitted a telemetry event for, so server_switch only fires on change. */
  private lastTelemetryServerName = '';
  /** Highest session fame gained while the current game session was active — used for session_fame on disconnect. */
  private lastSessionFamePeak = 0;
  /**
   * Tracks the last plan tier we saw from /gems/status, so plan_purchase_completed only
   * fires on a true upgrade transition (free → paid) rather than every refresh. Null until
   * the first status arrives — we never emit on that first observation.
   */
  private lastKnownPlanTier: string | null = null;
  /** Latest plan tier the dashboard learned ('free' until we hear from /gems/status). */
  private currentPlanTier: string = 'free';
  /** Dashboard bot-api session start, in epoch ms. Set on first successful auth seed. */
  private botApiSessionStartedAt: number | null = null;
  private lastSeedToken: string | null = null;
/** Cached `gameWikiCatalog` WebSocket payload (built once per process; omit `force` on client to reuse). */
  private gameWikiCatalogJson: string | null = null;
  private dashboardAccountStoragePrepared = false;
  private readonly headlessChatHistory = new Map<string, HeadlessChatMessage[]>();
  private readonly headlessPacketHistory = new Map<string, HeadlessPacketRecord[]>();
  private readonly headlessPacketSubscriptions = new Map<WebSocket, string>();
  private readonly headlessViewerSubscriptions = new Map<WebSocket, HeadlessViewerSubscription>();
  private readonly pendingHeadlessViewerTicks = new Set<string>();
  private headlessViewerTickScheduled = false;
  private headlessPacketSequence = 0;

  private getConfigsDir(): string {
    return join(getHiveDocumentsDir(), 'configs');
  }

  private getActivePluginConfigId(): string {
    return this.sanitizeConfigId(this.config.lastPluginConfigId || DEFAULT_PLUGIN_CONFIG_ID);
  }

  private getAccountsFile(): string {
    return join(this.getHiveDocumentsDir(), '_accounts.json');
  }

  private getProxiesFile(): string {
    return join(this.getHiveDocumentsDir(), '_proxies.json');
  }

  private getAccountsCacheDir(): string {
    return join(this.getHiveDocumentsDir(), 'Accounts');
  }

  private getHiveDocumentsDir(): string {
    return join(process.env.USERPROFILE || process.env.HOME || '.', 'Documents', 'Hive');
  }

  /** Preserve existing Hive data while migrating it to Hive. */
  private prepareDashboardAccountStorage(): void {
    if (this.dashboardAccountStoragePrepared) return;
    this.dashboardAccountStoragePrepared = true;

    const targetDir = this.getHiveDocumentsDir();
    const targetAccountsFile = this.getAccountsFile();
    const targetCacheDir = this.getAccountsCacheDir();
    this.ensureDir(targetDir);
    this.ensureDir(targetCacheDir);

    const legacyDir = getHiveDocumentsDir();
    const legacyAccountsFile = join(legacyDir, '_accounts.json');
    if (!existsSync(targetAccountsFile) && existsSync(legacyAccountsFile)) {
      copyFileSync(legacyAccountsFile, targetAccountsFile);
    }

    const legacyCacheDir = join(legacyDir, 'Accounts');
    if (!existsSync(legacyCacheDir)) return;
    for (const file of readdirSync(legacyCacheDir)) {
      if (extname(file).toLowerCase() !== '.json') continue;
      const target = join(targetCacheDir, file);
      if (!existsSync(target)) copyFileSync(join(legacyCacheDir, file), target);
    }
  }

  private getDashboardAccountOverviewCacheFile(accountId: string): string {
    return join(this.getAccountsCacheDir(), `${String(accountId || '').trim()}.json`);
  }

  // ── Telemetry helpers ─────────────────────────────────────────────────────

  /**
   * Pick the most relevant plan from /payments/gems/status active_subs so the
   * telemetry heartbeat reports a useful tier rather than always "free".
   *
   * Ranking order matches the marketing tiers; unknown tiers are accepted as-is.
   */
  private recordPlanTierFromStatus(status: GemStatusResponse | null): void {
    const rank: Record<string, number> = { developer: 4, premium: 3, dodge: 2, free: 1 };
    let best = 'free';
    if (status && Array.isArray(status.active_subs) && status.active_subs.length > 0) {
      let bestRank = 0;
      for (const sub of status.active_subs) {
        const name = String(sub.plan_name || '').trim().toLowerCase();
        if (!name) continue;
        const r = rank[name] ?? 0;
        if (r > bestRank) {
          bestRank = r;
          best = name;
        }
      }
    }
    const previous = this.lastKnownPlanTier;
    this.currentPlanTier = best;
    this.lastKnownPlanTier = best;
    // Fire conversion event only on a true upgrade transition. Skipping the
    // first observation prevents a spurious purchase event on every login.
    if (
      previous !== null
      && previous !== best
      && (rank[best] ?? 0) > (rank[previous] ?? 0)
    ) {
      try {
        this.eventTracker?.track('plan_purchase_completed', {
          from: previous,
          to: best,
        });
      } catch { /* swallow */ }
    }
  }

  private bucketPluginCount(n: number): string {
    if (n <= 0) return '0';
    if (n <= 2) return '1-2';
    if (n <= 5) return '3-5';
    if (n <= 10) return '6-10';
    if (n <= 20) return '11-20';
    return '20+';
  }

  private collectEventContext(): EventContext {
    const planTier = this.currentPlanTier || 'free';
    let serverName = '';
    let className = '';
    if (this.currentClient?.playerData) {
      const pd = this.currentClient.playerData;
      const serverIp = this.currentClient.state?.conTargetAddress || '';
      serverName = this.ipToServerName[serverIp] || serverIp || '';
      const liveType = this.worldState?.getEntityType(this.currentClient.objectId ?? 0);
      const cid = Number.isFinite(Number(liveType)) && Number(liveType) > 0
        ? Math.trunc(Number(liveType))
        : (Number.isFinite(Number(pd.classType)) && Number(pd.classType) > 0 ? Math.trunc(Number(pd.classType)) : 0);
      if (cid > 0) {
        try { className = this.getObjectDisplayName(cid) || ''; } catch { className = ''; }
      }
    }
    return { planTier, serverName, className };
  }

  /**
   * Build the current telemetry snapshot. Called from inside TelemetryEmitter
   * once per heartbeat — keep it cheap and side-effect-free.
   */
  private ensureDir(path: string): void {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  private generateDashboardAccountId(): string {
    return `acct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private generateDashboardProxyId(): string {
    return `proxy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private normalizeProxyProtocol(value: unknown): ProxyProtocol {
    const protocol = String(value || 'socks5').trim().toLowerCase().replace(/:$/, '');
    if (protocol === 'http' || protocol === 'https' || protocol === 'socks4' || protocol === 'socks5') {
      return protocol;
    }
    return 'socks5';
  }

  private normalizeDashboardAccountRecord(raw: any, index = 0): DashboardAccountRecord {
    const now = Date.now();
    const id = String(raw?.id || '').trim() || `${this.generateDashboardAccountId()}-${index}`;
    const createdAt = Number(raw?.createdAt || 0) > 0 ? Number(raw.createdAt) : now;
    const updatedAt = Number(raw?.updatedAt || 0) > 0 ? Number(raw.updatedAt) : now;
    return {
      id,
      label: String(raw?.label || '').trim(),
      email: String(raw?.email || '').trim(),
      password: String(raw?.password || ''),
      serverName: String(raw?.serverName || 'USWest').trim() || 'USWest',
      notes: String(raw?.notes || ''),
      preferredScriptId: String(raw?.preferredScriptId || '').trim(),
      createdAt,
      updatedAt,
      proxyId: String(raw?.proxyId || '').trim(),
      proxyProtocol: this.normalizeProxyProtocol(raw?.proxyProtocol || String(raw?.proxy || '').split('://')[0]),
      proxy: String(raw?.proxy || ''),
      proxyUsername: String(raw?.proxyUsername || ''),
      proxyPassword: String(raw?.proxyPassword || ''),
    };
  }

  private readDashboardAccounts(): DashboardAccountRecord[] {
    try {
      this.prepareDashboardAccountStorage();
      const dir = this.getHiveDocumentsDir();
      this.ensureDir(dir);
      const filePath = this.getAccountsFile();
      debugLog(`readDashboardAccounts: dir="${dir}" file="${filePath}" exists=${existsSync(filePath)}`);
      if (!existsSync(filePath)) {
        debugLog(`readDashboardAccounts: file not found, returning []`);
        return [];
      }
      const raw = readFileSync(filePath, 'utf8');
      debugLog(`readDashboardAccounts: raw content (first 200 chars): ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(raw) as { accounts?: unknown[] };
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
      debugLog(`readDashboardAccounts: parsed ${accounts.length} account(s)`);
      return accounts.map((account, index) => this.normalizeDashboardAccountRecord(account, index));
    } catch (err) {
      debugLog(`readDashboardAccounts: ERROR: ${(err as Error).message}`);
      Logger.warn('DevServer', `accounts read failed: ${(err as Error).message}`);
      return [];
    }
  }

  private writeDashboardAccounts(accounts: DashboardAccountRecord[]): void {
    this.prepareDashboardAccountStorage();
    this.ensureDir(this.getHiveDocumentsDir());
    writeFileSync(this.getAccountsFile(), JSON.stringify({ accounts }, null, 2), 'utf8');
  }

  private normalizeDashboardProxyRecord(raw: any, index = 0): DashboardProxyRecord {
    const now = Date.now();
    const createdAt = Number(raw?.createdAt || 0) > 0 ? Number(raw.createdAt) : now;
    const updatedAt = Number(raw?.updatedAt || 0) > 0 ? Number(raw.updatedAt) : now;
    const status = String(raw?.lastStatus || 'untested');
    return {
      id: String(raw?.id || '').trim() || `${this.generateDashboardProxyId()}-${index}`,
      name: String(raw?.name || '').trim(),
      protocol: this.normalizeProxyProtocol(raw?.protocol),
      host: String(raw?.host || '').trim(),
      port: Math.trunc(Number(raw?.port || 0)),
      username: String(raw?.username || ''),
      password: String(raw?.password || ''),
      enabled: raw?.enabled !== false,
      createdAt,
      updatedAt,
      lastTestAt: Math.max(0, Number(raw?.lastTestAt || 0) || 0),
      lastLatencyMs: Math.max(0, Math.trunc(Number(raw?.lastLatencyMs || 0) || 0)),
      lastStatus: status === 'working' || status === 'failed' ? status : 'untested',
      lastError: String(raw?.lastError || ''),
    };
  }

  private dashboardProxyToConfig(proxy: DashboardProxyRecord): ProxyConfig {
    const addressHasPort = /^\[[^\]]+\]:\d+/.test(proxy.host) || /^[^:\s]+:\d+(?::|$)/.test(proxy.host);
    const address = proxy.host.includes('://') || proxy.host.includes('@') || addressHasPort
      ? proxy.host
      : `${proxy.host}:${proxy.port}`;
    return parseProxyConfig(address, {
      protocol: proxy.protocol,
      ...(proxy.username ? { username: proxy.username } : {}),
      ...(proxy.password ? { password: proxy.password } : {}),
    });
  }

  private readDashboardProxies(): DashboardProxyRecord[] {
    try {
      this.ensureDir(this.getHiveDocumentsDir());
      const filePath = this.getProxiesFile();
      if (!existsSync(filePath)) return [];
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { proxies?: unknown[] };
      const proxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
      return proxies.map((proxy, index) => this.normalizeDashboardProxyRecord(proxy, index));
    } catch (error) {
      Logger.warn('DevServer', `proxies read failed: ${(error as Error).message}`);
      return [];
    }
  }

  private writeDashboardProxies(proxies: DashboardProxyRecord[]): void {
    this.ensureDir(this.getHiveDocumentsDir());
    writeFileSync(this.getProxiesFile(), JSON.stringify({ proxies }, null, 2), 'utf8');
  }

  private async testDashboardProxies(ids?: Set<string>): Promise<DashboardProxyRecord[]> {
    const proxies = this.readDashboardProxies();
    const selected = proxies.filter((proxy) => !ids || ids.has(proxy.id));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < selected.length) {
        const proxy = selected[cursor++];
        const testedAt = Date.now();
        try {
          const result = await testNetworkProxy(this.dashboardProxyToConfig(proxy));
          proxy.lastTestAt = testedAt;
          proxy.lastLatencyMs = result.latencyMs;
          proxy.lastStatus = result.ok ? 'working' : 'failed';
          proxy.lastError = result.error || '';
        } catch (error) {
          proxy.lastTestAt = testedAt;
          proxy.lastLatencyMs = 0;
          proxy.lastStatus = 'failed';
          proxy.lastError = error instanceof Error ? error.message : String(error);
        }
      }
    };
    const workerCount = Math.min(8, Math.max(1, selected.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    this.writeDashboardProxies(proxies);
    return proxies;
  }

  private resolveDashboardAccountProxy(account: DashboardAccountRecord): ProxyConfig | undefined {
    if (account.proxyId) {
      const managed = this.readDashboardProxies().find((proxy) => proxy.id === account.proxyId);
      if (!managed) throw new Error('The account references a proxy that no longer exists.');
      if (!managed.enabled) throw new Error(`Proxy "${managed.name || managed.host}" is disabled.`);
      return this.dashboardProxyToConfig(managed);
    }
    if (!account.proxy.trim()) return undefined;
    return parseProxyConfig(account.proxy, {
      protocol: account.proxyProtocol,
      ...(account.proxyUsername ? { username: account.proxyUsername } : {}),
      ...(account.proxyPassword ? { password: account.proxyPassword } : {}),
    });
  }

  private readDashboardAccountOverviewCache(accountId: string): DashboardAccountOverviewCacheRecord | null {
    try {
      this.prepareDashboardAccountStorage();
      const id = String(accountId || '').trim();
      if (!id) return null;
      this.ensureDir(this.getAccountsCacheDir());
      const filePath = this.getDashboardAccountOverviewCacheFile(id);
      if (!existsSync(filePath)) return null;
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DashboardAccountOverviewCacheRecord>;
      if (!parsed || typeof parsed !== 'object' || !parsed.overview || typeof parsed.overview !== 'object') return null;
      if (!this.isDashboardOverviewCacheComplete(parsed.overview as DashboardAccountOverview)) return null;
      return {
        accountId: id,
        email: String(parsed.email || '').trim(),
        updatedAt: Number(parsed.updatedAt || 0) > 0 ? Number(parsed.updatedAt) : Date.now(),
        overview: parsed.overview as DashboardAccountOverview,
      };
    } catch (err) {
      Logger.warn('DevServer', `accounts overview cache read failed for ${accountId}: ${(err as Error).message}`);
      return null;
    }
  }

  private isDashboardOverviewCacheComplete(overview: DashboardAccountOverview): boolean {
    const characters = Array.isArray(overview?.characters) ? overview.characters : [];
    const storageSections = ['vault', 'gifts', 'temporaryGifts', 'materialStorage', 'potions'];
    const hasCompleteItem = (item: unknown): boolean => {
      return !!item
        && typeof item === 'object'
        && Array.isArray((item as DashboardAccountOverviewItem).enchantIds)
        && Object.prototype.hasOwnProperty.call(item, 'uniqueId');
    };
    return characters.every((character) => {
      const equipment = character?.equipment;
      const inventory = character?.inventory;
      const backpacks = character?.backpacks;
      return [equipment, inventory, backpacks].every((items) => Array.isArray(items) && items.every(hasCompleteItem));
    }) && storageSections.every((key) => {
      const section = ((overview as unknown) as Record<string, unknown>)[key] as DashboardAccountOverviewStorageSection | undefined;
      return !!section && Array.isArray(section.items) && section.items.every(hasCompleteItem);
    });
  }

  private readAllDashboardAccountOverviewCaches(): Record<string, DashboardAccountOverviewCacheRecord> {
    const result: Record<string, DashboardAccountOverviewCacheRecord> = {};
    try {
      this.prepareDashboardAccountStorage();
      this.ensureDir(this.getAccountsCacheDir());
      const files = readdirSync(this.getAccountsCacheDir()).filter((file) => extname(file).toLowerCase() === '.json');
      for (const file of files) {
        const accountId = file.slice(0, -5);
        const cached = this.readDashboardAccountOverviewCache(accountId);
        if (cached) result[accountId] = cached;
      }
    } catch (err) {
      Logger.warn('DevServer', `accounts overview cache list failed: ${(err as Error).message}`);
    }
    return result;
  }

  private writeDashboardAccountOverviewCache(accountId: string, email: string, overview: DashboardAccountOverview): DashboardAccountOverviewCacheRecord {
    this.prepareDashboardAccountStorage();
    const record: DashboardAccountOverviewCacheRecord = {
      accountId: String(accountId || '').trim(),
      email: String(email || '').trim(),
      updatedAt: Date.now(),
      overview,
    };
    this.ensureDir(this.getAccountsCacheDir());
    writeFileSync(this.getDashboardAccountOverviewCacheFile(record.accountId), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  private deleteDashboardAccountOverviewCache(accountId: string): void {
    try {
      this.prepareDashboardAccountStorage();
      const id = String(accountId || '').trim();
      if (!id) return;
      const filePath = this.getDashboardAccountOverviewCacheFile(id);
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (err) {
      Logger.warn('DevServer', `accounts overview cache delete failed for ${accountId}: ${(err as Error).message}`);
    }
  }

  private pruneDashboardAccountOverviewCaches(accounts: DashboardAccountRecord[]): void {
    try {
      this.prepareDashboardAccountStorage();
      const validIds = new Set(accounts.map((account) => String(account.id || '').trim()).filter(Boolean));
      this.ensureDir(this.getAccountsCacheDir());
      const files = readdirSync(this.getAccountsCacheDir()).filter((file) => extname(file).toLowerCase() === '.json');
      for (const file of files) {
        const accountId = file.slice(0, -5);
        if (!validIds.has(accountId)) this.deleteDashboardAccountOverviewCache(accountId);
      }
    } catch (err) {
      Logger.warn('DevServer', `accounts overview cache prune failed: ${(err as Error).message}`);
    }
  }

  private formatObjectTypeHex(objectType: number): string {
    const safeType = Number.isFinite(objectType) ? Math.max(0, Math.trunc(objectType)) : 0;
    return `0x${safeType.toString(16)}`;
  }

  private getObjectDisplayName(objectType: number): string {
    if (!Number.isFinite(objectType) || objectType < 0) return 'Empty';
    const def = this.gameData?.getObject(objectType);
    const label = String(def?.displayId || def?.id || '').trim();
    return label || `Type ${Math.trunc(objectType)}`;
  }

  private buildDashboardOverviewItem(
    token: DashboardAccountEquipmentToken,
    uniqueLookup?: Map<string, string[]>,
  ): DashboardAccountOverviewItem {
    const objectType = Number.isFinite(token.objectType) ? Math.trunc(token.objectType) : -1;
    let enchantIds: number[] = [];
    if (objectType >= 0 && uniqueLookup instanceof Map) {
      const exactKey = `${objectType}#${String(token.uniqueId || '').trim()}`;
      const fallbackKey = `${objectType}#`;
      const exactBucket = uniqueLookup.get(exactKey);
      const fallbackBucket = uniqueLookup.get(fallbackKey);
      const encoded = exactBucket?.length
        ? String(exactBucket.shift() || '').trim()
        : (fallbackBucket?.length ? String(fallbackBucket.shift() || '').trim() : '');
      enchantIds = this.decodeDashboardEnchantIds(encoded);
    }
    return {
      objectType,
      objectTypeHex: this.formatObjectTypeHex(objectType),
      name: this.getObjectDisplayName(objectType),
      uniqueId: token.uniqueId,
      enchantIds,
    };
  }

  private resetSessionStats(): void {
    this.sessionStartedAt = 0;
    this.fameSectionStart = null;
    this.fameAccumulated = 0;
    this.lastKnownFame = 0;
    if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
  }

  /**
   * Begin a new reconnect segment. Commits the previous segment's fame into fameAccumulated,
   * then waits for the first real (non-zero) fame reading before anchoring the new baseline.
   * A fallback timer accepts a zero baseline after FAME_INIT_WAIT_MS if nothing better arrives.
   */
  private startFameSegment(): void {
    // Commit whatever was gained in the segment that just ended
    if (this.fameSectionStart != null) {
      this.fameAccumulated += Math.max(0, this.lastKnownFame - this.fameSectionStart);
    }
    this.fameSectionStart = null;
    if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
    // Fallback: if currentFame never rises above 0 (e.g. new character), accept 0 as baseline
    this.fameInitTimer = setTimeout(() => {
      this.fameInitTimer = null;
      if (this.fameSectionStart == null) {
        this.fameSectionStart = this.lastKnownFame;
      }
    }, DevServer.FAME_INIT_WAIT_MS);
  }

  private getSessionStats(currentFame: number): { uptimeMs: number; fameGained: number; averageFpm: number } {
    const now = Date.now();
    if (!this.sessionStartedAt) this.sessionStartedAt = now;
    // Track last seen fame every poll so disconnect handler can commit accurately
    if (Number.isFinite(currentFame) && currentFame > 0) this.lastKnownFame = currentFame;
    // Anchor segment baseline once we have a real non-zero value
    if (this.fameSectionStart == null && Number.isFinite(currentFame) && currentFame > 0) {
      this.fameSectionStart = currentFame;
      if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
    }
    const sectionGain = (this.fameSectionStart != null && Number.isFinite(currentFame))
      ? Math.max(0, currentFame - this.fameSectionStart)
      : 0;
    const fameGained = this.fameAccumulated + sectionGain;
    const uptimeMs = Math.max(0, now - this.sessionStartedAt);
    const averageFpm = uptimeMs > 0 ? (fameGained / (uptimeMs / 60000)) : 0;
    return { uptimeMs, fameGained, averageFpm };
  }

  private parseCharListNumber(raw: unknown): number {
    const value = Number(raw);
    return Number.isFinite(value) ? value : 0;
  }

  private parseCharListBoolean(raw: unknown): boolean {
    const value = String(raw ?? '').trim().toLowerCase();
    return value === '1' || value === 'true';
  }

  private parseCharListObjectTypes(raw: unknown, minimumLength = 0): number[] {
    const parsed = String(raw ?? '')
      .split(',')
      .map((value) => {
        const n = Number.parseInt(String(value ?? '').trim(), 10);
        return Number.isFinite(n) ? n : -1;
      });
    while (parsed.length < minimumLength) parsed.push(-1);
    return parsed;
  }

  private parseDashboardEquipmentTokens(raw: unknown, minimumLength = 0): DashboardAccountEquipmentToken[] {
    const parsed = String(raw ?? '')
      .split(',')
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .map((value) => {
        const hashIndex = value.indexOf('#');
        const objectTypeText = hashIndex >= 0 ? value.slice(0, hashIndex).trim() : value;
        const uniqueIdText = hashIndex >= 0 ? value.slice(hashIndex + 1).trim() : '';
        const objectType = Number.parseInt(objectTypeText, 10);
        return {
          objectType: Number.isFinite(objectType) ? objectType : -1,
          uniqueId: uniqueIdText || null,
        } satisfies DashboardAccountEquipmentToken;
      });
    while (parsed.length < minimumLength) {
      parsed.push({ objectType: -1, uniqueId: null });
    }
    return parsed;
  }

  private buildDashboardUniqueItemLookup(rawUniqueItemInfo: unknown): Map<string, string[]> {
    const lookup = new Map<string, string[]>();
    const uniqueNode = rawUniqueItemInfo && typeof rawUniqueItemInfo === 'object'
      ? rawUniqueItemInfo as Record<string, unknown>
      : null;
    const rawItemData = uniqueNode?.ItemData;
    const entries = Array.isArray(rawItemData) ? rawItemData : (rawItemData ? [rawItemData] : []);
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const node = entry as Record<string, unknown>;
      const objectType = Number.parseInt(String(node['@_type'] ?? '').trim(), 10);
      if (!Number.isFinite(objectType)) continue;
      const uniqueId = String(node['@_id'] ?? '').trim();
      const encoded = String(node['#text'] ?? '').trim();
      if (!encoded) continue;
      const key = `${objectType}#${uniqueId}`;
      const bucket = lookup.get(key);
      if (bucket) bucket.push(encoded);
      else lookup.set(key, [encoded]);
    }
    return lookup;
  }

  private decodeDashboardEnchantIds(code: string | null | undefined): number[] {
    const rawCode = String(code || '').trim();
    if (!rawCode) return [];
    try {
      const normalized = rawCode
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(rawCode.length / 4) * 4, '=');
      const bytes = Buffer.from(normalized, 'base64');
      if (bytes.length <= 3) return [];
      const enchantIds: number[] = [];
      for (let pos = 3; pos + 1 < bytes.length; pos += 2) {
        const value = bytes.readUInt16LE(pos);
        if (value === 0xfffd) break;
        enchantIds.push(value === 0xfffe ? 0 : value);
      }
      return enchantIds;
    } catch {
      return [];
    }
  }

  private buildDashboardOverviewItems(
    tokens: DashboardAccountEquipmentToken[],
    uniqueLookup: Map<string, string[]>,
    keepEmpty = true,
  ): DashboardAccountOverviewItem[] {
    const items = tokens.map((token) => this.buildDashboardOverviewItem(token, uniqueLookup));
    return keepEmpty ? items : items.filter((item) => Number(item.objectType) >= 0);
  }

  private buildDashboardStorageSection(
    tokenGroups: DashboardAccountEquipmentToken[][],
    uniqueLookup: Map<string, string[]>,
  ): DashboardAccountOverviewStorageSection {
    const items: DashboardAccountOverviewItem[] = [];
    tokenGroups.forEach((tokens) => {
      items.push(...this.buildDashboardOverviewItems(tokens, uniqueLookup, false));
    });
    const uniqueTypes = new Set(items.map((item) => Number(item.objectType)).filter((objectType) => Number.isFinite(objectType) && objectType >= 0));
    return {
      items,
      totalCount: items.length,
      uniqueCount: uniqueTypes.size,
    };
  }

  private parseCharListError(xml: string): string | null {
    const error = xml.match(/<Error>([^<]*)<\/Error>/i)?.[1]?.trim();
    if (!error) return null;
    return this.parseVerifyError(`<Error>${error}</Error>`);
  }

  private async fetchCharListXml(
    accessToken: string,
    proxy?: ProxyConfig,
  ): Promise<{ xml: string } | { error: string }> {
    const body = new URLSearchParams({
      do_login: 'false',
      accessToken,
      game_net: 'Unity',
      play_platform: 'Unity',
      game_net_user_id: '',
      muleDump: 'true',
      __source: 'ExaltAccountManager',
    }).toString();

    return new Promise((resolve) => {
      const req = https.request(
        'https://www.realmofthemadgod.com/char/list',
        {
          method: 'POST',
          agent: proxy ? createProxyAgent(proxy) : undefined,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            'X-Unity-Version': '2019.3.14f1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const error = this.parseCharListError(data);
            if (error) {
              resolve({ error });
              return;
            }
            if (!data.includes('<Chars')) {
              resolve({ error: `Unexpected char list response${res.statusCode ? ` (${res.statusCode})` : ''}.` });
              return;
            }
            resolve({ xml: data });
          });
        },
      );
      req.on('error', (err) => {
        Logger.error('DevServer', `char/list request failed: ${err.message}`);
        resolve({ error: `Failed to load character list: ${err.message}` });
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ error: 'Character list request timed out.' });
      });
      req.write(body, 'utf8');
      req.end();
    });
  }

  private async fetchDashboardAccountOverviewRemote(
    accountId: string,
    email: string,
    password: string,
    proxy?: ProxyConfig,
  ): Promise<{ cache: DashboardAccountOverviewCacheRecord } | { error: string }> {
    const clientToken = getClientToken();
    if (!clientToken) return { error: 'Client token unavailable.' };

    const verifyResult = await this.verifyDecaAccount(email, password, clientToken, proxy);
    if ('error' in verifyResult) return { error: verifyResult.error };

    const charListResult = await this.fetchCharListXml(verifyResult.token, proxy);
    if ('error' in charListResult) return { error: charListResult.error };

    const overview = this.parseDashboardAccountOverview(email, charListResult.xml);
    if ('error' in overview) return { error: overview.error };

    return {
      cache: this.writeDashboardAccountOverviewCache(accountId, email, overview),
    };
  }

  private parseDashboardAccountOverview(
    email: string,
    xml: string,
  ): DashboardAccountOverview | { error: string } {
    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (name) => name === 'Char' || name === 'ItemData',
      });
      const parsed = parser.parse(xml) as {
        Chars?: {
          Account?: Record<string, unknown>;
          Char?: Array<Record<string, unknown>> | Record<string, unknown>;
        };
      };
      const charsNode = parsed?.Chars;
      if (!charsNode) return { error: 'Character list payload was missing <Chars>.' };

      const accountNode = (charsNode.Account ?? {}) as Record<string, unknown>;
      const accountStats = (accountNode.Stats ?? {}) as Record<string, unknown>;
      const accountUniqueLookup = this.buildDashboardUniqueItemLookup(accountNode.UniqueItemInfo);
      const giftUniqueLookup = this.buildDashboardUniqueItemLookup((charsNode as Record<string, unknown>).UniqueGiftItemInfo ?? accountNode.UniqueGiftItemInfo);
      const temporaryGiftUniqueLookup = this.buildDashboardUniqueItemLookup((charsNode as Record<string, unknown>).UniqueTemporaryGiftItemInfo ?? accountNode.UniqueTemporaryGiftItemInfo);
      const vaultChestNodes = Array.isArray((accountNode.Vault as Record<string, unknown> | undefined)?.Chest)
        ? ((accountNode.Vault as Record<string, unknown>).Chest as unknown[])
        : ((accountNode.Vault as Record<string, unknown> | undefined)?.Chest ? [(accountNode.Vault as Record<string, unknown>).Chest] : []);
      const materialChestNodes = Array.isArray((accountNode.MaterialStorage as Record<string, unknown> | undefined)?.Chest)
        ? ((accountNode.MaterialStorage as Record<string, unknown>).Chest as unknown[])
        : ((accountNode.MaterialStorage as Record<string, unknown> | undefined)?.Chest ? [(accountNode.MaterialStorage as Record<string, unknown>).Chest] : []);
      const rawCharacters = Array.isArray(charsNode.Char)
        ? charsNode.Char
        : (charsNode.Char ? [charsNode.Char] : []);
      const characters = rawCharacters.map((rawChar) => {
        const classType = this.parseCharListNumber(rawChar.ObjectType);
        const uniqueLookup = this.buildDashboardUniqueItemLookup(rawChar.UniqueItemInfo);
        const backpackSlots = Math.max(0, this.parseCharListNumber(rawChar.BackpackSlots));
        const backpackCount = Math.max(0, Math.min(8, Math.floor(backpackSlots / 8)));
        const allTokens = this.parseDashboardEquipmentTokens(rawChar.Equipment, 12 + (backpackCount * 8));
        const equipmentTokens = allTokens.slice(0, 4);
        const inventoryTokens = allTokens.slice(4, 12);
        const backpackTokens = allTokens.slice(12);
        return {
          charId: this.parseCharListNumber(rawChar['@_id']),
          classType,
          classTypeHex: this.formatObjectTypeHex(classType),
          className: this.getObjectDisplayName(classType),
          level: this.parseCharListNumber(rawChar.Level),
          exp: this.parseCharListNumber(rawChar.Exp),
          fame: this.parseCharListNumber(rawChar.CurrentFame),
          seasonal: this.parseCharListBoolean(rawChar.Seasonal),
          dead: this.parseCharListBoolean(rawChar.Dead),
          hp: this.parseCharListNumber(rawChar.HitPoints),
          maxHp: this.parseCharListNumber(rawChar.MaxHitPoints),
          mp: this.parseCharListNumber(rawChar.MagicPoints),
          maxMp: this.parseCharListNumber(rawChar.MaxMagicPoints),
          attack: this.parseCharListNumber(rawChar.Attack),
          defense: this.parseCharListNumber(rawChar.Defense),
          speed: this.parseCharListNumber(rawChar.Speed),
          dexterity: this.parseCharListNumber(rawChar.Dexterity),
          vitality: this.parseCharListNumber(rawChar.HpRegen),
          wisdom: this.parseCharListNumber(rawChar.MpRegen),
          equipment: this.buildDashboardOverviewItems(equipmentTokens, uniqueLookup, true),
          inventory: this.buildDashboardOverviewItems(inventoryTokens, uniqueLookup, true),
          backpacks: this.buildDashboardOverviewItems(backpackTokens, uniqueLookup, true),
        } satisfies DashboardAccountOverviewCharacter;
      });
      characters.sort(
        (a, b) => b.level - a.level || b.fame - a.fame || a.className.localeCompare(b.className) || a.charId - b.charId,
      );

      return {
        accountName: String(accountNode.Name || '').trim() || email,
        totalFame: this.parseCharListNumber(accountStats.TotalFame),
        aliveFame: this.parseCharListNumber(accountStats.Fame),
        bestCharFame: this.parseCharListNumber(accountStats.BestCharFame ?? accountStats.BestFame),
        maxNumChars: this.parseCharListNumber(accountNode.MaxNumChars),
        characters,
        vault: this.buildDashboardStorageSection(vaultChestNodes.map((value) => this.parseDashboardEquipmentTokens(value, 0)), accountUniqueLookup),
        gifts: this.buildDashboardStorageSection([this.parseDashboardEquipmentTokens(accountNode.Gifts, 0)], giftUniqueLookup),
        temporaryGifts: this.buildDashboardStorageSection([this.parseDashboardEquipmentTokens(accountNode.TemporaryGifts, 0)], temporaryGiftUniqueLookup),
        materialStorage: this.buildDashboardStorageSection(materialChestNodes.map((value) => this.parseDashboardEquipmentTokens(value, 0)), accountUniqueLookup),
        potions: this.buildDashboardStorageSection([this.parseDashboardEquipmentTokens(accountNode.Potions, 0)], accountUniqueLookup),
      };
    } catch (err) {
      Logger.warn('DevServer', `char/list parse failed: ${(err as Error).message}`);
      return { error: 'Failed to parse character list.' };
    }
  }

  private sanitizeConfigId(name: string): string {
    const cleaned = name
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '-')
      .toLowerCase();
    return cleaned || `config-${Date.now()}`;
  }

  private buildPluginConfigSnapshot(name: string): {
    id: string;
    name: string;
    createdAt: number;
    updatedAt: number;
    plugins: Array<{ id: string; enabled: boolean; settings: Record<string, unknown> }>;
  } {
    const now = Date.now();
    const plugins = this.pluginManager.getPlugins().map((p) => {
      const settings: Record<string, unknown> = {};
      // Persist only value settings; skip action buttons (load should never "click" UI buttons).
      for (const s of p.settings || []) {
        if (s.type === 'button') continue;
        settings[s.key] = s.value;
      }
      return { id: p.id, enabled: !!p.enabled, settings };
    });
    return {
      id: this.sanitizeConfigId(name),
      name: name.trim() || 'Unnamed Config',
      createdAt: now,
      updatedAt: now,
      plugins,
    };
  }

  // ── Autosave: persist current plugin state on every change ─────────────
  // Settings used to reset on restart because nothing wrote the live state
  // (only the manual "Save config" did). We now debounce-write the whole
  // current state to a reserved "Autosave" config and point
  // lastPluginConfigId at it, so tryAutoLoadLastPluginConfig() restores it
  // on next launch — no manual save needed.
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  private writeAutosaveSnapshot(): void {
    if (this.getActivePluginConfigId() !== DEFAULT_PLUGIN_CONFIG_ID) return;
    try {
      const snapshot = this.buildPluginConfigSnapshot(DEFAULT_PLUGIN_CONFIG_NAME);
      const dir = this.getConfigsDir();
      this.ensureDir(dir);
      const filePath = join(dir, snapshot.id + '.json');
      if (existsSync(filePath)) {
        try {
          const oldCfg = JSON.parse(readFileSync(filePath, 'utf8')) as { createdAt?: number };
          if (Number(oldCfg.createdAt) > 0) snapshot.createdAt = Number(oldCfg.createdAt);
        } catch {}
        snapshot.updatedAt = Date.now();
      }
      writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
      this.config.lastPluginConfigId = snapshot.id;
      this.saveConfig();
      this.broadcastConfig();
    } catch (err) {
      Logger.warn('DevServer', `autosave failed: ${(err as Error).message}`);
    }
  }

  private scheduleAutosave(): void {
    if (this.getActivePluginConfigId() !== DEFAULT_PLUGIN_CONFIG_ID) return;
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      this.writeAutosaveSnapshot();
    }, 800);
  }

  private applyPluginConfigSnapshot(snapshot: any): { ok: boolean; message: string } {
    if (!snapshot || !Array.isArray(snapshot.plugins)) {
      return { ok: false, message: 'Invalid config format: plugins[] is required.' };
    }
    const livePlugins = this.pluginManager.getPlugins();
    for (const p of snapshot.plugins as Array<any>) {
      if (!p || typeof p.id !== 'string') continue;
      const live = livePlugins.find((lp) => lp.id === p.id);
      const liveSettingByKey = new Map<string, { type?: string }>();
      for (const s of live?.settings || []) {
        liveSettingByKey.set(String(s.key), { type: String((s as any).type || '') });
      }
      if (typeof p.enabled === 'boolean') {
        this.pluginManager.togglePlugin(p.id, p.enabled);
      }
      if (p.settings && typeof p.settings === 'object') {
        for (const [key, value] of Object.entries(p.settings as Record<string, unknown>)) {
          // Never execute button settings from a config replay.
          const st = liveSettingByKey.get(String(key));
          if (st?.type === 'button') continue;
          this.pluginManager.updateSetting(p.id, key, value);
        }
      }
    }
    this.broadcastPluginState();
    return { ok: true, message: `Loaded config "${String(snapshot.name || snapshot.id || 'config')}".` };
  }

  public tryAutoLoadDefaultPluginConfig(): void {
    try {
      const safeId = DEFAULT_PLUGIN_CONFIG_ID;
      const filePath = join(this.getConfigsDir(), safeId + '.json');
      if (!existsSync(filePath)) {
        this.ensureDir(this.getConfigsDir());
        const snapshot = this.buildPluginConfigSnapshot(DEFAULT_PLUGIN_CONFIG_NAME);
        writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
        this.config.lastPluginConfigId = snapshot.id;
        this.saveConfig();
        this.broadcastConfig();
        Logger.log('DevServer', 'Initialized default plugin config');
        return;
      }
      const raw = readFileSync(filePath, 'utf8');
      const snapshot = JSON.parse(raw);
      const result = this.applyPluginConfigSnapshot(snapshot);
      if (!result.ok) {
        Logger.warn('DevServer', `Auto-load config failed: ${result.message}`);
        return;
      }
      this.config.lastPluginConfigId = safeId;
      this.saveConfig();
      this.broadcastConfig();
      Logger.log('DevServer', `Auto-loaded plugin config: ${safeId}`);
    } catch (err) {
      Logger.warn('DevServer', `Auto-load config error: ${(err as Error).message}`);
    }
  }

  constructor(
    inspector: PacketInspector,
    pluginManager: PluginManager,
    private publicDir: string,
    private worldState?: GameWorldState,
    private gameData?: GameDataLoader,
    private headlessFleet?: HeadlessFleet,
  ) {
    this.inspector = inspector;
    this.inspector.setDefaultMode('summary');
    this.pluginManager = pluginManager;

    // Packet Lab — captures undefined packets for live analysis
    this.lab = new PacketLab();
    this.headlessFleet?.on('changed', (sessions) => {
      this.broadcastHeadlessSessions(sessions);
      this.syncViewerOtherProjectileTracking();
    });
    this.headlessFleet?.on('damage', (accountId, snapshot) => this.broadcastHeadlessDamage(accountId, snapshot));
    this.headlessFleet?.on('chat', (accountId, message) => this.broadcastHeadlessChat(accountId, message));
    this.headlessFleet?.on('packet', (accountId, traffic) => this.captureHeadlessPacket(accountId, traffic));
    this.headlessFleet?.on('viewerTick', (accountId) => this.queueHeadlessViewerTick(accountId));
    this.inspector.subscribe((pkt) => {
      if (pkt.captureMode === 'full') this.lab.capture(pkt);
      this.observeTradePacket(pkt);
    });
    this.lab.on('update', () => {
      const msg = JSON.stringify({ type: 'labUpdate', unknowns: this.lab.getUnknowns() });
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      }
    });

    // Load config for persisted settings (e.g. custom RotMG path)
    this.configPath = join(publicDir, '..', '..', '..', 'data', 'config.json');
    try {
      if (existsSync(this.configPath)) {
        const raw = JSON.parse(readFileSync(this.configPath, 'utf8'));
        this.config = {
          rotmgPath: raw.rotmgPath,
          rotmgExtractorGameDataPath: raw.rotmgExtractorGameDataPath,
          lastPluginConfigId: raw.lastPluginConfigId,
          singleClientOnly: true,
        };
      }
    } catch (err) {
      Logger.warn('DevServer', `Failed to load config.json: ${(err as Error).message}`);
    }
    // Bot API client for gem-gated plugin system
    Logger.log('DevServer', `configPath: ${this.configPath} (exists: ${existsSync(this.configPath)})`);
    this.botApiClient = new DisabledBotApiClient();
    this.eventTracker = null;
    // Defer start() until we know we have a logged-in session — both services are
    // no-ops when not logged in anyway; we kick them off when the seed token arrives.

    // Load server name mappings from data/servers.json
    const serversPath = join(publicDir, '..', '..', '..', 'data', 'servers.json');
    try {
      if (existsSync(serversPath)) {
        this.servers = JSON.parse(readFileSync(serversPath, 'utf8'));
        this.serverNames = Object.keys(this.servers).sort();
        // Build reverse map: IP → server name
        for (const [name, ip] of Object.entries(this.servers)) {
          this.ipToServerName[ip] = name;
        }
        Logger.log('DevServer', `Loaded ${this.serverNames.length} server name mappings`);
      }
    } catch (err) {
      Logger.warn('DevServer', `Failed to load servers.json: ${(err as Error).message}`);
    }

    // HTTP server for static files
    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));

    // WebSocket server for real-time packet streaming
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (ws) => this.handleWsConnection(ws));

    // Subscribe to dashboard-only plugin logs
    this.pluginManager.onDashboardLog((pluginName, message) => {
      const msg = JSON.stringify({ type: 'pluginLog', plugin: pluginName, message });
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    });

    // Subscribe to structured plugin data broadcasts
    this.pluginManager.onBroadcastData((pluginId, type, data) => {
      const msg = JSON.stringify({ type: 'pluginData', pluginId, dataType: type, data });
      for (const client of this.wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    });

    this.config.lastPluginConfigId = DEFAULT_PLUGIN_CONFIG_ID;
  }

  private playerDataIntervalStop: (() => void) | null = null;
  private readonly runtimeScheduler = new RuntimeScheduler();
  private currentClient: any = null;
  private connectedClients = new Map<string, any>(); // clientId → ClientConnection
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionStartedAt = 0;
  /** Fame at the start of the current reconnect segment. Null until first non-zero reading. */
  private fameSectionStart: number | null = null;
  /** Fame accumulated from all prior reconnect segments this session. */
  private fameAccumulated: number = 0;
  /** Last observed fame value — captured each poll so disconnect handler can commit it. */
  private lastKnownFame: number = 0;
  /** Fallback timer: accept 0-fame baseline if no positive value arrives within FAME_INIT_WAIT_MS. */
  private fameInitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hard-reset timer: wipe accumulated fame if player doesn't reconnect within FAME_RESET_MS. */
  private fameResetTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DISCONNECT_GRACE_MS = 3000;
  private static readonly FAME_INIT_WAIT_MS = 5_000;
  private static readonly FAME_RESET_MS = 120_000;
  private tradeSession: {
    active: boolean;
    ourSlotCount: number;
    partnerSlotCount: number;
    ourOffer: boolean[];
    partnerOffer: boolean[];
    partnerOfferFromTradeChanged: boolean[];
    partnerName: string;
  } = {
    active: false,
    ourSlotCount: 12,
    partnerSlotCount: 12,
    ourOffer: [],
    partnerOffer: [],
    partnerOfferFromTradeChanged: [],
    partnerName: '',
  };
  private scriptHost: ScriptHost | undefined;
  private bridgeClientRef: BridgeClientRef | null = null;
  private focusedInspectorClientId: string | null = null;

  /** Shared ref for script SDK bridge — same client as `currentClient`. */
  setBridgeClientRef(ref: BridgeClientRef): void {
    this.bridgeClientRef = ref;
  }

  private lastUnresolvedClasses: string[] | null = null;

  /**
   * Current player position for display.
   */
  private getEffectivePlayerPos(): { x: number; y: number } | null {
    return this.currentClient?.playerData?.pos ?? null;
  }

  /**
   * Attach to a Proxy to track game client connection state.
   */
  attachProxy(proxy: Proxy): void {
    this.proxy = proxy;
    proxy.on('clientConnected', (client: any) => {
      const previousClientId = this.currentClient?.clientId ? String(this.currentClient.clientId) : null;
      const wasConnected = this.gameClientConnected;
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      // Reconnected before the fame hard-reset fired — keep accumulated fame
      if (this.fameResetTimer) {
        clearTimeout(this.fameResetTimer);
        this.fameResetTimer = null;
      }
      this.gameClientConnected = true;
      if (!wasConnected) {
        this.sessionStartedAt = 0; // restart uptime for this connected segment
        this.startFameSegment();   // commit prior segment; wait for first real fame
        // Fire-and-forget game event so admins can see connect spikes.
        try {
          const serverIp = client?.state?.conTargetAddress || '';
          const serverName = this.ipToServerName[serverIp] || serverIp || '';
          this.eventTracker?.track('game_connected', { server: serverName });
        } catch { /* never let telemetry break the connect path */ }
      }
      this.currentClient = client;
      const clientId: string = client.clientId || 'default';
      this.connectedClients.set(clientId, client);
      this.inspector.setClientMode(clientId, 'full');
      if (previousClientId && previousClientId !== clientId) {
        this.inspector.setClientMode(previousClientId, 'summary');
      }
      this.focusedInspectorClientId = clientId;
      if (this.bridgeClientRef) this.bridgeClientRef.current = client;
      this.broadcastGameClientState();
      this.broadcastClientList();
    });

    proxy.on('clientDisconnected', (client: any) => {
      const clientId: string = client?.clientId || 'default';
      this.connectedClients.delete(clientId);
      this.inspector.clearClientMode(clientId);
      if (this.currentClient === client) this.currentClient = null;
      if (this.focusedInspectorClientId === clientId) {
        const fallback = this.connectedClients.values().next().value;
        const fallbackId = fallback?.clientId ? String(fallback.clientId) : null;
        this.focusedInspectorClientId = fallbackId;
        if (fallbackId) this.inspector.setClientMode(fallbackId, 'full');
      }
      if (this.bridgeClientRef && this.bridgeClientRef.current === client) {
        this.bridgeClientRef.current = undefined;
      }
      this.resetTradeSession();
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.connectedClients.size === 0) {
          this.gameClientConnected = false;
          // Commit the current fame segment into fameAccumulated
          if (this.fameSectionStart != null) {
            const segGain = Math.max(0, this.lastKnownFame - this.fameSectionStart);
            this.fameAccumulated += segGain;
            if (this.fameAccumulated > this.lastSessionFamePeak) {
              this.lastSessionFamePeak = this.fameAccumulated;
            }
          }
          this.fameSectionStart = null;
          if (this.fameInitTimer) { clearTimeout(this.fameInitTimer); this.fameInitTimer = null; }
          this.sessionStartedAt = 0;
          // Telemetry — use peak so server-switch reconnects don't zero it out
          try {
            if (this.eventTracker && this.lastSessionFamePeak > 0) {
              this.eventTracker.track('session_fame', {
                fame: this.lastSessionFamePeak,
                last_server: this.lastTelemetryServerName || '',
              });
            }
          } catch { /* swallow */ }
          this.lastSessionFamePeak = 0;
          this.lastTelemetryServerName = '';
          // Don't wipe fameAccumulated yet — player may reconnect (server change, dungeon).
          // Schedule a hard reset: if they haven't reconnected in FAME_RESET_MS, clear it.
          if (this.fameResetTimer) clearTimeout(this.fameResetTimer);
          this.fameResetTimer = setTimeout(() => {
            this.fameResetTimer = null;
            this.fameAccumulated = 0;
            this.lastKnownFame = 0;
          }, DevServer.FAME_RESET_MS);
          try { this.eventTracker?.track('game_disconnected'); } catch { /* swallow */ }
        }
        this.broadcastGameClientState();
        this.broadcastClientList();
      }, DevServer.DISCONNECT_GRACE_MS);
    });

    // ── Game-event telemetry hooks ──────────────────────────────────────────
    // Death: one event per character death with class + best-effort fame total.
    proxy.hookPacket('DEATH', (_client: any, packet: any) => {
      try {
        const data = (packet?.data ?? {}) as { killedBy?: string; charId?: number; objectType?: number };
        const className = this.currentClient?.playerData?.classType
          ? this.getObjectDisplayName(this.currentClient.playerData.classType)
          : '';
        const sessionFame = this.currentClient?.playerData
          ? this.getSessionStats(this.currentClient.playerData.currentFame ?? 0).fameGained
          : null;
        this.eventTracker?.track('character_death', {
          class: className || '',
          killed_by: typeof data.killedBy === 'string' ? data.killedBy.slice(0, 64) : '',
          char_id: typeof data.charId === 'number' ? data.charId : null,
          session_fame: typeof sessionFame === 'number' ? sessionFame : null,
        });
      } catch { /* never let telemetry break the packet path */ }
    });

    // Map entry: one event per dungeon/realm entry. Skips reconnections to the
    // same map within 5s (Nexus → server hop chatter).
    let lastMapName = '';
    let lastMapAtMs = 0;
    proxy.hookPacket('MAPINFO', (_client: any, packet: any) => {
      try {
        const data = (packet?.data ?? {}) as { name?: string };
        const name = String(data.name || '').trim();
        const now = Date.now();
        if (!name) return;
        if (name === lastMapName && (now - lastMapAtMs) < 5000) return;
        lastMapName = name;
        lastMapAtMs = now;
        this.eventTracker?.track('map_enter', { map: name.slice(0, 64) });
      } catch { /* swallow */ }
    });

    // Broadcast player data periodically (2x/sec)
    this.playerDataIntervalStop = this.runtimeScheduler.scheduleRepeating(500, () => {
      if (this.connectedClients.size > 1) this.broadcastClientList();
      if (this.currentClient?.playerData) {
        const pd = this.currentClient.playerData;
        const clientId: string = this.currentClient.clientId || 'default';
        const sessionStats = this.getSessionStats(pd.currentFame);
        const serverIp = this.currentClient.state?.conTargetAddress || '';
        const serverName = this.ipToServerName[serverIp] || serverIp;
        // Server-switch event: emit only when the name changes.
        if (serverName && serverName !== this.lastTelemetryServerName) {
          const prev = this.lastTelemetryServerName;
          this.lastTelemetryServerName = serverName;
          if (prev) {
            this.eventTracker?.track('server_switch', { from: prev, to: serverName });
          }
        }
        if (sessionStats.fameGained > this.lastSessionFamePeak) {
          this.lastSessionFamePeak = sessionStats.fameGained;
        }
        const liveObjectType = this.worldState?.getEntityType(this.currentClient.objectId ?? 0);
        const effectiveObjectType = Number.isFinite(Number(liveObjectType)) && Number(liveObjectType) > 0
          ? Math.trunc(Number(liveObjectType))
          : (Number.isFinite(Number(pd.classType)) && Number(pd.classType) > 0 ? Math.trunc(Number(pd.classType)) : null);

        let questTargetObjectType: number | null = null;
        const qOidRaw = pd.questObjectId;
        const qOid =
          typeof qOidRaw === 'number' && Number.isFinite(qOidRaw)
            ? Math.trunc(qOidRaw)
            : Number.isFinite(Number(qOidRaw))
              ? Math.trunc(Number(qOidRaw))
              : NaN;
        if (Number.isFinite(qOid) && qOid > 0 && this.worldState) {
          const resolved = this.worldState.resolveQuestTargetObjectType(qOid, this.gameData);
          if (resolved != null && resolved > 0) questTargetObjectType = resolved;
        }
        // HP/MP regen formulas (same as RotmgPlayer): HP/s = 2*(1+0.12*VIT), MP/s = WIS/10
        const totalVit = pd.vitality + pd.vitalityBonus + pd.exaltedVitality;
        const totalWis = pd.wisdom + pd.wisdomBonus + pd.exaltedWisdom;
        const hpRegenPerSec = Math.round((2 * (1 + 0.12 * totalVit)) * 10) / 10;
        const mpRegenPerSec = Math.round((totalWis / 10) * 10) / 10;
        const conditionEffects = Object.keys(ConditionEffect).filter((name) =>
          pd.hasConditionEffect(name as keyof typeof ConditionEffect)
        );

        const effectivePos = this.getEffectivePlayerPos();
        const msg = JSON.stringify({
          type: 'playerData',
          clientId,
          name: pd.name || '',
          classType: pd.classType,
          skin: pd.skin,
          tex1: pd.tex1,
          tex2: pd.tex2,
          sessionUptimeMs: sessionStats.uptimeMs,
          sessionFameGained: sessionStats.fameGained,
          sessionAverageFpm: Math.round(sessionStats.averageFpm * 10) / 10,
          gameId: this.currentClient.state?.gameId ?? null,
          objectId: this.currentClient.objectId ?? null,
          objectType: effectiveObjectType,
          level: pd.level,
          hp: pd.health,
          maxHp: pd.maxHealth,
          mana: pd.mana,
          maxMana: pd.maxMana,
          healthBonus: pd.healthBonus,
          manaBonus: pd.manaBonus,
          hpRegenPerSec,
          mpRegenPerSec,
          attack: pd.attack,
          attackBonus: pd.attackBonus,
          exaltedAttack: pd.exaltedAttack,
          defense: pd.defense,
          defenseBonus: pd.defenseBonus,
          exaltedDefense: pd.exaltedDefense,
          speed: pd.speed,
          speedBonus: pd.speedBonus,
          exaltedSpeed: pd.exaltedSpeed,
          dexterity: pd.dexterity,
          dexterityBonus: pd.dexterityBonus,
          exaltedDexterity: pd.exaltedDexterity,
          vitality: pd.vitality,
          vitalityBonus: pd.vitalityBonus,
          exaltedVitality: pd.exaltedVitality,
          wisdom: pd.wisdom,
          wisdomBonus: pd.wisdomBonus,
          exaltedWisdom: pd.exaltedWisdom,
          exaltedMaxHP: pd.exaltedMaxHP,
          exaltedMaxMP: pd.exaltedMaxMP,
          stars: pd.stars,
          fame: pd.currentFame,
          guild: pd.guildName || '',
          pos: effectivePos ?? pd.pos,
          map: pd.mapName,
          questObjectId: pd.questObjectId,
          questTargetObjectType,
          server: serverName,
          hpPct: pd.health / Math.max(1, pd.maxHealth || 1),
          mpPct: pd.mana / Math.max(1, pd.maxMana || 1),
          teleportAllowed: !!pd.teleportAllowed,
          hasBackpack: !!pd.hasBackpack,
          backpackTier: pd.backpackTier,
          hasBackpackExtender: pd.hasBackpackExtender,
          inventory: Array.isArray(pd.inventory) ? pd.inventory.slice() : [],
          backpack: Array.isArray(pd.backpack) ? pd.backpack.slice() : [],
          conditionEffects,
        });
        for (const client of this.wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
          }
        }
      }
    });
  }

  /**
   * Set the auto-detected game directory (legacy GameHooker path; optional now).
   */
  setDetectedGamePath(path: string | null): void {
    this.detectedGamePath = path;
  }

  /**
   * Get the effective RotMG exe path (user override or auto-detected).
   */
  private getRotmgPath(): string | null {
    return this.config.rotmgPath || this.detectedGamePath;
  }

  /** Case-insensitive `name.png` lookup under a Drawings-style directory (Windows-friendly). */
  private findCaseInsensitiveDrawingsPng(dir: string, baseName: string): string | null {
    const wanted = `${baseName}.png`.toLowerCase();
    if (!existsSync(dir)) return null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.png')) continue;
        if (f.toLowerCase() === wanted) return join(dir, f);
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * BFS for `baseName.png` under `root` (bounded depth + max dirs) for nested extractor / Drawings layouts.
   */
  private findCaseInsensitivePngUnderTree(
    root: string,
    baseName: string,
    maxDepth: number,
    maxDirsVisited: number,
  ): string | null {
    const wanted = `${baseName}.png`.toLowerCase();
    if (!existsSync(root)) return null;
    let rootAbs: string;
    try {
      rootAbs = resolve(root);
    } catch {
      return null;
    }
    const queue: { dir: string; depth: number }[] = [{ dir: rootAbs, depth: 0 }];
    const seen = new Set<string>();
    let visited = 0;
    while (queue.length > 0 && visited < maxDirsVisited) {
      const next = queue.shift();
      if (!next) break;
      const { dir, depth } = next;
      const key = dir.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      visited++;
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const full = join(dir, name);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isFile()) {
          if (!name.toLowerCase().endsWith('.png')) continue;
          if (name.toLowerCase() === wanted) return full;
        } else if (st.isDirectory() && depth < maxDepth) {
          const bn = name.toLowerCase();
          if (bn === 'node_modules' || bn === '.git') continue;
          queue.push({ dir: full, depth: depth + 1 });
        }
      }
    }
    return null;
  }

  /**
   * Resolve `file` from objects.xml &lt;Texture&gt;&lt;File&gt; to an on-disk PNG (Exalt layouts).
   */
  private resolveWikiTexturePngPath(fileBase: string): string | null {
    const safe = fileBase.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe) return null;
    const base = this.getRotmgPath();
    if (!base) return null;
    const roots: string[] = [];
    if (base.toLowerCase().endsWith('.exe')) {
      roots.push(dirname(base), base);
    } else {
      roots.push(base);
    }
    const drawingDirs: string[] = [];
    for (const root of roots) {
      drawingDirs.push(
        join(root, 'Drawings'),
        join(root, 'Resources', 'Drawings'),
        join(root, 'App', 'Drawings'),
        join(root, 'Production', 'Drawings'),
        join(root, 'assets', 'Drawings'),
        join(root, 'Assets', 'Drawings'),
        join(root, 'Resources', 'App', 'Drawings'),
        join(root, 'Resources', 'Embedded', 'Drawings'),
      );
    }
    const exGd = this.resolveExtractorGameDataDir();
    if (exGd) {
      for (const d of this.listWikiExtractorLoosePngFlatDirs(exGd)) {
        drawingDirs.push(d);
      }
    }
    const local = process.env.LOCALAPPDATA;
    if (local) {
      drawingDirs.push(
        join(local, 'RealmOfTheMadGod', 'Drawings'),
        join(local, 'RealmOfTheMadGod', 'Production', 'Drawings'),
        join(local, 'RotMG Exalt', 'Drawings'),
      );
    }
    for (const dir of drawingDirs) {
      if (!existsSync(dir)) continue;
      const hit = this.findCaseInsensitiveDrawingsPng(dir, safe);
      if (hit) return hit;
      const nested = this.findCaseInsensitivePngUnderTree(dir, safe, 3, 200);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * Bundled copy under `data/rotmg-extractor-game/GameData/` (spritesheet.xml + images/), when present.
   * Populated locally from RotMGAssetExtractor output; see docs/game-wiki-extractor.md.
   */
  private resolveBundledExtractorGameDataDir(): string | null {
    const autoExtracted = join(this.publicDir, '..', '..', '..', 'data');
    if (existsSync(join(autoExtracted, 'spritesheet.xml')) && existsSync(join(autoExtracted, 'images'))) return autoExtracted;
    const nested = join(this.publicDir, '..', '..', '..', 'data', 'rotmg-extractor-game', 'GameData');
    if (existsSync(join(nested, 'spritesheet.xml')) && existsSync(join(nested, 'images'))) return nested;
    // Auto-extracted data written by rotmgAssetExtractor at startup
    const realmDir = getHiveDataDir();
    if (existsSync(join(realmDir, 'spritesheet.xml')) && existsSync(join(realmDir, 'images'))) return realmDir;
    return null;
  }

  /**
   * Resolve RotMGAssetExtractor `GameData` directory (contains `spritesheet.xml` + `images/`).
   * Uses Settings path when set; otherwise falls back to the bundled repo copy.
   */
  private resolveExtractorGameDataDir(): string | null {
    const raw = (this.config.rotmgExtractorGameDataPath || '').trim();
    if (raw) {
      const abs = resolve(raw);
      const direct = join(abs, 'spritesheet.xml');
      if (existsSync(direct) && existsSync(join(abs, 'images'))) return abs;
      const nested = join(abs, 'GameData');
      if (existsSync(join(nested, 'spritesheet.xml')) && existsSync(join(nested, 'images'))) return nested;
    }
    return this.resolveBundledExtractorGameDataDir();
  }

  /** Atlas ids in spritesheet.xml map directly to our extracted atlas order after converting to zero-based. */
  private mapWikiAtlasRawToSheetIndex(rawAtlasId: number): number {
    const a = Math.trunc(rawAtlasId) - 1;
    if (a < 0 || a >= WIKI_EXTRACT_ATLAS_BASES.length) return -1;
    return a;
  }

  private parseWikiSpritesheetXml(xml: string): Map<string, Map<number, WikiSpriteFrame>> {
    const out = new Map<string, Map<number, WikiSpriteFrame>>();
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
    let parsed: unknown;
    try {
      parsed = parser.parse(xml);
    } catch {
      return out;
    }
    const root = (parsed as { DecompiledSpriteSheet?: { SpriteGroups?: { SpriteGroup?: unknown } } })
      .DecompiledSpriteSheet;
    if (!root?.SpriteGroups) return out;
    let groups = root.SpriteGroups.SpriteGroup;
    if (groups == null) return out;
    if (!Array.isArray(groups)) groups = [groups];
    for (const g of groups as Record<string, unknown>[]) {
      const name = String(g['@_Name'] ?? '').trim();
      if (!name) continue;
      let sprites = g.Sprite;
      const inner = new Map<number, WikiSpriteFrame>();
      if (sprites != null) {
        if (!Array.isArray(sprites)) sprites = [sprites];
        for (const s of sprites as Record<string, unknown>[]) {
          const idx = Number(s['@_Index']);
          const atlasId = Number(s['@_AtlasId']);
          const x = Number(s['@_X']);
          const y = Number(s['@_Y']);
          const w = Number(s['@_W']);
          const h = Number(s['@_H']);
          if (!Number.isFinite(idx) || !Number.isFinite(atlasId)) continue;
          inner.set(idx, {
            atlasId,
            x: Number.isFinite(x) ? x : 0,
            y: Number.isFinite(y) ? y : 0,
            w: Number.isFinite(w) ? w : 0,
            h: Number.isFinite(h) ? h : 0,
          });
        }
      }
      out.set(name.toLowerCase(), inner);
    }
    return out;
  }

  private ensureLoadedWikiSpriteCache(gameDataDir: string): void {
    const sheetPath = join(gameDataDir, 'spritesheet.xml');
    if (!existsSync(sheetPath)) return;
    let mtime = 0;
    try {
      mtime = statSync(sheetPath).mtimeMs;
    } catch {
      return;
    }
    if (
      this.wikiSpriteSheetCache &&
      this.wikiSpriteSheetCache.gameDataDir === gameDataDir &&
      this.wikiSpriteSheetCache.sheetMtime === mtime
    ) {
      return;
    }
    const xml = readFileSync(sheetPath, 'utf8');
    const byGroup = this.parseWikiSpritesheetXml(xml);
    this.wikiSpriteSheetCache = { gameDataDir, sheetMtime: mtime, byGroup };
    Logger.log('DevServer', `Game Wiki: loaded extractor spritesheet (${byGroup.size} groups)`);
  }

  private lookupWikiSpriteFrame(fileBase: string, index: number): WikiSpriteFrame | null {
    if (!this.wikiSpriteSheetCache) return null;
    const g = this.wikiSpriteSheetCache.byGroup.get(fileBase.toLowerCase());
    if (!g) return null;
    return g.get(index) ?? null;
  }

  private async tryServeExtractorWikiSprite(
    gameDataDir: string,
    safe: string,
    index: number,
    res: http.ServerResponse,
  ): Promise<boolean> {
    this.ensureLoadedWikiSpriteCache(gameDataDir);
    const frame = this.lookupWikiSpriteFrame(safe, index);
    if (!frame || frame.w <= 0 || frame.h <= 0) return false;

    const sheetIdx = this.mapWikiAtlasRawToSheetIndex(frame.atlasId);
    if (sheetIdx < 0) return false;

    const imagesDir = join(gameDataDir, 'images');
    const atlasBase = WIKI_EXTRACT_ATLAS_BASES[sheetIdx];
    const atlasPath = this.findCaseInsensitiveDrawingsPng(imagesDir, atlasBase);
    if (!atlasPath) return false;

    let meta: sharp.Metadata;
    try {
      meta = await sharp(atlasPath).metadata();
    } catch {
      return false;
    }
    const iw = meta.width ?? 0;
    const ih = meta.height ?? 0;
    if (
      frame.x < 0 ||
      frame.y < 0 ||
      frame.x + frame.w > iw ||
      frame.y + frame.h > ih
    ) {
      return false;
    }

    try {
      const buf = await sharp(atlasPath)
        .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
        .png()
        .toBuffer();
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
        'X-Wiki-Sprite-Cropped': '1',
      });
      res.end(buf);
      return true;
    } catch (err) {
      Logger.warn('DevServer', `Game Wiki extractor crop failed: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Flat dirs that may hold per-sheet PNGs: RotMGAssetExtractor `GameData/images/`, and
   * [exalt-extractor](https://github.com/rotmg-network/exalt-extractor) `output/spritesheets/`.
   */
  private listWikiExtractorLoosePngFlatDirs(gameDataDir: string): string[] {
    const parent = dirname(gameDataDir);
    return [
      join(gameDataDir, 'images'),
      join(gameDataDir, 'spritesheets'),
      join(gameDataDir, 'Spritesheets'),
      join(parent, 'spritesheets'),
      join(parent, 'Spritesheets'),
      join(parent, 'images'),
    ];
  }

  private findExtractorLoosePngFlat(gameDataDir: string, safe: string): string | null {
    for (const d of this.listWikiExtractorLoosePngFlatDirs(gameDataDir)) {
      const h = this.findCaseInsensitiveDrawingsPng(d, safe);
      if (h) return h;
    }
    return null;
  }

  private findExtractorLoosePng(gameDataDir: string, safe: string): string | null {
    const flatHit = this.findExtractorLoosePngFlat(gameDataDir, safe);
    if (flatHit) return flatHit;
    const parent = dirname(gameDataDir);
    return (
      this.findCaseInsensitivePngUnderTree(gameDataDir, safe, 6, 600) ??
      this.findCaseInsensitivePngUnderTree(parent, safe, 6, 1000)
    );
  }

  /**
   * When extractor `images/` contains a standalone sheet (e.g. `beacons32x32.png`) but spritesheet
   * crop failed (missing group, lite atlas, etc.), serve that PNG so the wiki can still grid-slice by index.
   */
  private tryServeWikiExtractorImagesLooseSheet(
    gameDataDir: string,
    safe: string,
    res: http.ServerResponse,
  ): boolean {
    const hit = this.findExtractorLoosePng(gameDataDir, safe);
    if (!hit) return false;
    try {
      const buf = readFileSync(hit);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
      return true;
    } catch {
      return false;
    }
  }

  private serveDrawingsWikiTextureFullSheet(
    safe: string,
    res: http.ServerResponse,
  ): boolean {
    const resolved = this.resolveWikiTexturePngPath(safe);
    if (!resolved) {
      Logger.warn(
        'DevServer',
        `Game Wiki texture not found for "${safe}" (set RotMG path and/or extractor GameData in Settings)`,
      );
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not_found');
      return true;
    }
    try {
      const buf = readFileSync(resolved);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
      return true;
    } catch (err) {
      Logger.warn('DevServer', `Game Wiki texture read failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('read_error');
      return true;
    }
  }

  /**
   * Serve a RotMG drawings sheet PNG (e.g. lofiObj3) from extractor dump (cropped by index) or Exalt Drawings.
   */
  private tryServeWikiTextureFile(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (req.method !== 'GET' || !req.url?.startsWith('/api/wiki-texture-file')) return false;
    const qIdx = req.url.indexOf('?');
    const q = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';
    const params = new URLSearchParams(q);
    const rawFile = (params.get('file') || '').trim();
    const safe = rawFile.replace(/[^a-zA-Z0-9_]/g, '');
    if (!safe || safe.length > 80) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad_file');
      return true;
    }

    const rawIndex = params.get('index');
    let index: number | null = null;
    if (rawIndex != null && rawIndex !== '') {
      const hex = /^0x/i.test(String(rawIndex).trim());
      const n = parseInt(String(rawIndex).trim().replace(/^0x/i, ''), hex ? 16 : 10);
      index = Number.isFinite(n) ? n : null;
    }

    const gameDataDir = this.resolveExtractorGameDataDir();

    void (async () => {
      try {
        if (gameDataDir && index !== null) {
          const ok = await this.tryServeExtractorWikiSprite(gameDataDir, safe, index, res);
          if (ok) return;
        }
        if (gameDataDir && !res.headersSent && this.tryServeWikiExtractorImagesLooseSheet(gameDataDir, safe, res)) {
          return;
        }
        if (!this.getRotmgPath()) {
          if (!res.headersSent) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('not_found');
          }
          return;
        }
        if (!res.headersSent) {
          this.serveDrawingsWikiTextureFullSheet(safe, res);
        }
      } catch (err) {
        Logger.warn('DevServer', `Game Wiki texture handler: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('error');
        }
      }
    })();

    return true;
  }

  private isSingleClientOnlyEnabled(): boolean {
    return this.config.singleClientOnly !== false;
  }

  private getRunningProcessCount(imageName: string): number {
    try {
      const output = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const lines = String(output || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines.filter((line) => !line.startsWith('INFO:')).length;
    } catch (err) {
      Logger.warn('DevServer', `Failed to inspect ${imageName} processes: ${(err as Error).message}`);
      return 0;
    }
  }

  private getRunningRotmgExaltProcessCount(): number {
    return this.getRunningProcessCount('RotMG Exalt.exe');
  }

  private terminateProcessByImageName(imageName: string): boolean {
    try {
      execFileSync('taskkill', ['/IM', imageName, '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      return true;
    } catch (err) {
      const message = String((err as Error).message || '');
      if (message.toLowerCase().includes('not found') || message.toLowerCase().includes('no running instance')) {
        return false;
      }
      Logger.warn('DevServer', `Failed to terminate ${imageName}: ${message}`);
      return false;
    }
  }


  private getSingleClientLaunchBlockError(): string | null {
    if (!this.isSingleClientOnlyEnabled()) return null;
    if (this.getRunningRotmgExaltProcessCount() < 1) return null;
    return 'Close the existing RotMG Exalt process and launch again. We only support 1 account at a time right now, but later multiple accounts with proxies will be supported.';
  }

  /**
   * Launch the RotMG Exalt executable.
   */
  private launchGame(): { ok: boolean; error?: string } {
    const launchBlockError = this.getSingleClientLaunchBlockError();
    if (launchBlockError) {
      return { ok: false, error: launchBlockError };
    }
    const gamePath = this.getRotmgPath();
    if (!gamePath) {
      return { ok: false, error: 'RotMG path not configured and auto-detection failed.' };
    }

    const exePath = join(gamePath, 'RotMG Exalt.exe');
    if (!existsSync(exePath)) {
      return { ok: false, error: `RotMG Exalt.exe not found at: ${exePath}` };
    }

    try {
      const child = spawn(exePath, [], {
        cwd: gamePath,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      Logger.log('DevServer', `Launched RotMG from: ${exePath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      Logger.error('DevServer', `Failed to launch RotMG: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Call Deca account/verify to get session tokens for launch.
   */
  private async verifyDecaAccount(
    email: string,
    password: string,
    clientToken: string,
    proxy?: ProxyConfig,
  ): Promise<
    | { token: string; tokenTimestamp: string; tokenExpiration: string }
    | { error: string }
  > {
    const body = new URLSearchParams({
      guid: email,
      password,
      clientToken,
      game_net: 'Unity',
      play_platform: 'Unity',
      game_net_user_id: '',
    }).toString();

    return new Promise((resolve) => {
      const req = https.request(
        'https://www.realmofthemadgod.com/account/verify',
        {
          method: 'POST',
          agent: proxy ? createProxyAgent(proxy) : undefined,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
            'X-Unity-Version': '2019.3.14f1',
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            const token = this.parseVerifySuccess(data);
            if (token) {
              resolve(token);
              return;
            }
            const errMsg = this.parseVerifyError(data);
            resolve({ error: errMsg });
          });
        },
      );
      req.on('error', (err) => {
        Logger.error('DevServer', `account/verify request failed: ${err.message}`);
        resolve({ error: `Network error: ${err.message}` });
      });
      req.setTimeout(15000, () => {
        req.destroy();
        resolve({ error: 'Request timed out.' });
      });
      req.write(body, 'utf8');
      req.end();
    });
  }

  private parseVerifySuccess(xml: string): { token: string; tokenTimestamp: string; tokenExpiration: string } | null {
    const token = xml.match(/<AccessToken>([^<]*)<\/AccessToken>/)?.[1];
    const tokenTimestamp = xml.match(/<AccessTokenTimestamp>([^<]*)<\/AccessTokenTimestamp>/)?.[1];
    const tokenExpiration = xml.match(/<AccessTokenExpiration>([^<]*)<\/AccessTokenExpiration>/)?.[1];
    if (token && tokenTimestamp && tokenExpiration) {
      return { token, tokenTimestamp, tokenExpiration };
    }
    return null;
  }

  private parseVerifyError(xml: string): string {
    const raw = xml.match(/<Error>([^<]*)<\/Error>/)?.[1]?.trim() ?? '';
    const lower = raw.toLowerCase();
    if (lower.includes('password') || raw === 'PasswordError') return 'Wrong password.';
    if (lower.includes('wait') || lower.includes('try again later')) return 'Too many requests. Try again later.';
    if (lower.includes('captcha')) return 'Captcha required. Try again in a browser first.';
    if (lower.includes('suspended')) return 'Account suspended.';
    if (lower.includes('account in use')) return 'Account already in use.';
    if (lower.includes('token for different machine') || lower.includes('different machine'))
      return 'Token for different machine. Click "Refresh HWID" in the accounts menu (⋯) and try again. If it still fails, log in once via the official launcher to re-bind the account.';
    if (raw) return raw;
    return 'Login failed.';
  }

  private clampLaunchWindowSize(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }

  /**
   * Windowed launch extras for Unity player (width/height always honored; x/y best-effort — not all builds respect them).
   */
  private buildCredentialLaunchWindowExtras(opts?: {
    compactWindow?: boolean;
    windowRect?: { x: number; y: number; width: number; height: number };
  }): string[] {
    const rect = opts?.windowRect;
    if (rect && Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
      const w = this.clampLaunchWindowSize(rect.width, 320, 7680);
      const h = this.clampLaunchWindowSize(rect.height, 240, 4320);
      const x = this.clampLaunchWindowSize(rect.x, -32000, 32000);
      const y = this.clampLaunchWindowSize(rect.y, -32000, 32000);
      return [
        '-screen-fullscreen',
        '0',
        '-screen-width',
        String(w),
        '-screen-height',
        String(h),
        '-screen-x',
        String(x),
        '-screen-y',
        String(y),
        '-popupwindow',
        '-nolog',
      ];
    }
    if (opts?.compactWindow) {
      return ['-screen-fullscreen', '0', '-screen-width', '640', '-screen-height', '360', '-popupwindow', '-nolog'];
    }
    return [];
  }

  /**
   * Verify with Deca then launch RotMG Exalt with token-based args (LoginGUI-style: verify only, no bind).
   * @param compactWindow Unity window size below in-game minimum (MAC multibox launch sidebar).
   * @param windowRect Optional pixel placement + size (virtual desktop coords from dashboard layout editor).
   */
  private async launchGameWithCredentials(
    email: string,
    password: string,
    serverName: string,
    opts?: {
      compactWindow?: boolean;
      windowRect?: { x: number; y: number; width: number; height: number };
      /** Dashboard saved-account id when the client sends it */
      accountId?: string | null;
      /** Dashboard display label when the client sends it */
      accountLabel?: string | null;
      /** Current credential-editor proxy values, including edits not saved yet. */
      accountProxy?: DashboardAccountProxySelection | null;
    },
  ): Promise<{ ok: boolean; error?: string }> {
    if (this.headlessFleet) {
      const accountId = String(opts?.accountId || email).trim();
      try {
        const savedAccount = opts?.accountId
          ? this.readDashboardAccounts().find((account) => account.id === opts.accountId)
          : undefined;
        const proxyAccount = opts?.accountProxy
          ? this.normalizeDashboardAccountRecord({
              ...(savedAccount || {}),
              ...opts.accountProxy,
              id: accountId,
              email,
              password,
              serverName,
            })
          : savedAccount;
        const proxy = proxyAccount ? this.resolveDashboardAccountProxy(proxyAccount) : undefined;
        await this.headlessFleet.connect({
          id: accountId,
          email,
          password,
          label: String(opts?.accountLabel || email).trim(),
          serverName,
          proxy,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }
    const launchBlockError = this.getSingleClientLaunchBlockError();
    if (launchBlockError) {
      return { ok: false, error: launchBlockError };
    }
    const gamePath = this.getRotmgPath();
    if (!gamePath) {
      return { ok: false, error: 'RotMG path not configured and auto-detection failed.' };
    }

    const exePath = join(gamePath, 'RotMG Exalt.exe');
    if (!existsSync(exePath)) {
      return { ok: false, error: `RotMG Exalt.exe not found at: ${exePath}` };
    }

    const clientToken = getClientToken();
    if (!clientToken) {
      return { ok: false, error: 'Client token unavailable.' };
    }

    const verifyResult = await this.verifyDecaAccount(email, password, clientToken);
    if ('error' in verifyResult) {
      return { ok: false, error: verifyResult.error };
    }

    const { token, tokenTimestamp, tokenExpiration } = verifyResult;

    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const args = `data:{platform:Deca,guid:${b64(email)},token:${b64(token)},tokenTimestamp:${b64(tokenTimestamp)},tokenExpiration:${b64(tokenExpiration)},env:4,serverName:${serverName}}`;
    const windowExtras = this.buildCredentialLaunchWindowExtras(opts);
    const launchedAtIso = new Date().toISOString();

    try {
      const child = spawn(exePath, [args, ...windowExtras], {
        cwd: gamePath,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      const wr = opts?.windowRect;
      const launcherPid = typeof child.pid === 'number' ? child.pid : -1;
      if (launcherPid > 0) {
        registerCredentialLaunch({
          launcherPid,
          accountId: opts?.accountId ?? null,
          accountLabel: opts?.accountLabel ?? null,
          email,
        });
      }
      // Conversion-funnel signal: how often saved accounts actually launch.
      // Includes server but no email/IGN.
      this.eventTracker?.track('account_launch', {
        server: serverName,
        compact_window: !!opts?.compactWindow,
        has_window_rect: !!opts?.windowRect,
      });
      if (wr && process.platform === 'win32' && launcherPid > 0) {
        window.setTimeout(() => {
          void moveRotmgLaunchedWindowAfterSpawn(launcherPid, wr, { email, launchedAtIso }).then((pos) => {
            if (pos.ok) {
              Logger.log(
                'DevServer',
                `Positioned credential launch window via Win32 (launcher PID ${launcherPid}, ${wr.width}×${wr.height} @ ${wr.x},${wr.y})`,
              );
            } else {
              Logger.warn(
                'DevServer',
                `Post-launch window move failed (launcher PID ${launcherPid}). ${pos.debug ?? ''}`.slice(0, 2000),
              );
            }
          });
        }, 500);
      }
      const logSuffix = wr
        ? ` (${wr.width}×${wr.height} @ ${wr.x},${wr.y})`
        : opts?.compactWindow
          ? ' (640×360 compact)'
          : '';
      Logger.log('DevServer', `Launched RotMG with credentials${logSuffix} from: ${exePath}`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      Logger.error('DevServer', `Failed to launch RotMG: ${msg}`);
      return { ok: false, error: msg };
    }
  }

  /**
   * Save config to disk.
   */
  private saveConfig(): void {
    try {
      writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      Logger.warn('DevServer', `Failed to save config: ${(err as Error).message}`);
    }
  }

  private buildConfigMessage(): string {
    return JSON.stringify({
      type: 'config',
      rotmgPath: this.getRotmgPath() || '',
      rotmgPathSource: this.config.rotmgPath ? 'custom' : (this.detectedGamePath ? 'auto' : 'none'),
      rotmgExtractorGameDataPath: (this.config.rotmgExtractorGameDataPath || '').trim(),
      singleClientOnly: this.isSingleClientOnlyEnabled(),
      pluginConfigId: this.config.lastPluginConfigId || '',
      serverNames: this.serverNames,
      botApiUrl: BOT_API_URL,
    });
  }

  private broadcastConfig(): void {
    const configMsg = this.buildConfigMessage();
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(configMsg);
      }
    }
  }


  private broadcastInternalState(): void {
    const msg = JSON.stringify({
      type: 'internalState',
      connected: false,
    });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  private broadcastUnresolvedClasses(classes: string[]): void {
    const msg = JSON.stringify({ type: 'unresolvedClasses', classes });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  private broadcastGameClientState(): void {
    const msg = JSON.stringify({
      type: 'gameClient',
      connected: this.gameClientConnected,
    });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  private broadcastClientList(target?: WebSocket): void {
    const clients = Array.from(this.connectedClients.entries()).map(([clientId, c]) => {
      const pd = c.playerData;
      const serverIp = c.state?.conTargetAddress || '';
      return {
        clientId,
        name: pd?.name || '',
        classType: pd?.classType ?? null,
        skin: pd?.skin ?? null,
        tex1: pd?.tex1 ?? null,
        tex2: pd?.tex2 ?? null,
        hp: pd?.health ?? 0,
        maxHp: pd?.maxHealth ?? 1,
        guild: pd?.guildName || '',
        server: this.ipToServerName[serverIp] || serverIp || '--',
        connectedAt: undefined as number | undefined,
        fullData: undefined as unknown,
      };
    });
    for (const session of this.headlessFleet?.list() ?? []) {
      const client = this.headlessFleet?.get(session.accountId);
      const player = client?.getPlayer();
      const carried = player?.inventory ?? [];
      const totalVit = player?.vit ?? 0;
      const totalWis = player?.wis ?? 0;
      const fullData = player ? {
        name: player.name || session.alias,
        classType: player.class,
        class: player.className,
        characterId: session.characterId,
        skin: player.texture,
        tex1: player.clothingDye,
        tex2: player.accessoryDye,
        gameId: session.gameId,
        objectId: session.objectId,
        objectType: player.class,
        level: player.level,
        hp: player.hp,
        maxHp: player.maxHP,
        mana: player.mp,
        maxMana: player.maxMP,
        healthBonus: player.maxHPBoost,
        manaBonus: player.maxMPBoost,
        hpRegenPerSec: Math.round((2 * (1 + 0.12 * totalVit)) * 10) / 10,
        mpRegenPerSec: Math.round((totalWis / 10) * 10) / 10,
        attack: player.atk,
        attackBonus: player.atkBoost,
        exaltedAttack: player.exaltedAtt,
        defense: player.def,
        defenseBonus: player.defBoost,
        exaltedDefense: player.exaltedDef,
        speed: player.spd,
        speedBonus: player.spdBoost,
        exaltedSpeed: player.exaltedSpd,
        dexterity: player.dex,
        dexterityBonus: player.dexBoost,
        exaltedDexterity: player.exaltedDex,
        vitality: player.vit,
        vitalityBonus: player.vitBoost,
        exaltedVitality: player.exaltedVit,
        wisdom: player.wis,
        wisdomBonus: player.wisBoost,
        exaltedWisdom: player.exaltedWis,
        exaltedMaxHP: player.exaltedHP,
        exaltedMaxMP: player.exaltedMP,
        stars: player.stars,
        fame: player.currentFame,
        guild: player.guildName || '',
        pos: session.position,
        map: session.mapName,
        mapName: session.mapName,
        server: session.serverName,
        hasBackpack: player.hasBackpack,
        backpackTier: client?.hasPetBag() ? 16 : player.hasBackpack ? 8 : 0,
        inventory: carried.slice(0, 12),
        backpack: carried.slice(12, 20),
        conditionEffects: [],
      } : {
        name: session.alias,
        characterId: session.characterId,
        gameId: session.gameId,
        objectId: session.objectId,
        pos: session.position,
        map: session.mapName,
        server: session.serverName,
      };
      clients.push({
        clientId: session.accountId,
        name: session.playerName || session.alias,
        classType: player?.class ?? null,
        skin: player?.texture ?? null,
        tex1: player?.clothingDye ?? null,
        tex2: player?.accessoryDye ?? null,
        hp: player?.hp ?? 0,
        maxHp: player?.maxHP ?? 1,
        guild: player?.guildName ?? '',
        server: session.serverName,
        connectedAt: session.connectedAt,
        fullData,
      });
    }
    const msg = JSON.stringify({ type: 'clientList', clients });
    const recipients = target ? [target] : this.wss.clients;
    for (const ws of recipients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  private broadcastHeadlessSessions(sessions: HeadlessSessionSummary[] = this.headlessFleet?.list() ?? []): void {
    const activeAccountIds = new Set(sessions.map((session) => session.accountId));
    for (const accountId of this.headlessChatHistory.keys()) {
      if (!activeAccountIds.has(accountId)) this.headlessChatHistory.delete(accountId);
    }
    const msg = JSON.stringify({ type: 'headlessSessions', sessions });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
    this.broadcastClientList();
  }

  private broadcastHeadlessDamage(accountId: string, snapshot = this.headlessFleet?.damage(accountId)): void {
    if (!snapshot) return;
    const msg = JSON.stringify({ type: 'headlessDamageData', accountId, ...snapshot });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  private broadcastHeadlessChat(accountId: string, message: HeadlessChatMessage): void {
    const history = this.headlessChatHistory.get(accountId) ?? [];
    history.push(message);
    if (history.length > DevServer.HEADLESS_CHAT_HISTORY_LIMIT) {
      history.splice(0, history.length - DevServer.HEADLESS_CHAT_HISTORY_LIMIT);
    }
    this.headlessChatHistory.set(accountId, history);
    const payload = JSON.stringify({ type: 'chatMessage', accountId, message });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  }

  private captureHeadlessPacket(accountId: string, traffic: PacketTraffic): void {
    const preview = traffic.payload.subarray(0, DevServer.HEADLESS_PACKET_PAYLOAD_LIMIT);
    const packet: HeadlessPacketRecord = {
      id: ++this.headlessPacketSequence,
      accountId,
      timestamp: traffic.timestamp,
      direction: traffic.direction === 'outgoing' ? 'C->S' : 'S->C',
      packetId: traffic.id,
      name: traffic.type ? String(traffic.type) : `UNKNOWN_${traffic.id}`,
      size: traffic.size,
      payloadHex: preview.toString('hex'),
      payloadTruncated: traffic.payload.length > preview.length,
    };
    const history = this.headlessPacketHistory.get(accountId) ?? [];
    history.push(packet);
    if (history.length > DevServer.HEADLESS_PACKET_HISTORY_LIMIT) {
      history.splice(0, history.length - DevServer.HEADLESS_PACKET_HISTORY_LIMIT);
    }
    this.headlessPacketHistory.set(accountId, history);

    const payload = JSON.stringify({ type: 'headlessPacket', accountId, packet });
    for (const [client, selectedAccountId] of this.headlessPacketSubscriptions) {
      if (selectedAccountId === accountId && client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private sendHeadlessChat(accountId: string, channel: string, recipient: string, message: string): { ok: boolean; error?: string } {
    const client = this.headlessFleet?.get(accountId);
    if (!client || !client.isConnected() || !client.isInWorld()) {
      return { ok: false, error: 'The selected account is not connected in a world.' };
    }
    const body = message.trim();
    if (!body) return { ok: false, error: 'Enter a message.' };
    if (body.length > 512) return { ok: false, error: 'Messages are limited to 512 characters.' };

    let line: string;
    switch (channel) {
      case 'say': line = body; break;
      case 'yell': line = `/yell ${body}`; break;
      case 'party': line = `/party ${body}`; break;
      case 'guild': line = `/guild ${body}`; break;
      case 'tell': {
        const target = recipient.trim();
        if (!target) return { ok: false, error: 'Enter a recipient for a tell.' };
        if (target.length > 64 || /\s/.test(target)) return { ok: false, error: 'Enter a valid player name.' };
        line = `/tell ${target} ${body}`;
        break;
      }
      default: return { ok: false, error: 'Unsupported chat channel.' };
    }
    try {
      client.say(line);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: (error as Error).message || 'The message could not be sent.' };
    }
  }

  private getHeadlessObjectsPayload(accountId?: string | null) {
    const client = this.headlessFleet?.get(accountId);
    if (!client || !this.gameData) return null;
    const grouped = new Map<string, Map<number, ReturnType<typeof client.visibleObjects>>>();
    for (const object of client.visibleObjects()) {
      const category = this.gameData.getObjectCategory(object.type);
      if (category === 'Player') continue;
      let types = grouped.get(category);
      if (!types) grouped.set(category, types = new Map());
      let items = types.get(object.type);
      if (!items) types.set(object.type, items = []);
      items.push(object);
    }
    const makeGroups = (category: string) => Array.from(grouped.get(category) ?? [], ([objectType, entities]) => ({
      objectType,
      name: this.gameData?.getObject(objectType)?.id ?? `0x${objectType.toString(16)}`,
      entities: entities.map((entity) => ({ objectId: entity.objectId, x: entity.x, y: entity.y })),
    })).sort((a, b) => a.objectType - b.objectType);
    const labels: Record<string, string> = {
      VisualOnly: 'Visual Only', Pet: 'Pets', Projectile: 'Projectiles', Container: 'Containers', Enemy: 'Enemies', Other: 'Other',
    };
    const categories = Object.keys(labels).map((category) => ({ category: labels[category], groups: makeGroups(category) }))
      .filter((entry) => entry.groups.length > 0);
    return { portals: makeGroups('Portal'), beacons: makeGroups('Beacon'), categories };
  }

  private getHeadlessTilesPayload(accountId: string | null | undefined, radius: number) {
    const client = this.headlessFleet?.get(accountId);
    if (!client || !this.gameData) return null;
    const center = client.getPosition();
    const r = Math.max(1, Math.min(30, Math.trunc(radius)));
    const groups = new Map<number, Array<{ x: number; y: number }>>();
    for (const tile of client.visibleTiles()) {
      if (Math.abs(tile.x - center.x) > r || Math.abs(tile.y - center.y) > r) continue;
      let list = groups.get(tile.type);
      if (!list) groups.set(tile.type, list = []);
      list.push({ x: tile.x, y: tile.y });
    }
    return {
      center,
      radius: r,
      groups: Array.from(groups, ([tileType, tiles]) => ({ tileType, name: this.gameData?.getTileName(tileType) ?? `0x${tileType.toString(16)}`, tiles }))
        .sort((a, b) => a.tileType - b.tileType),
    };
  }

  private getHeadlessViewerPayload(
    accountId: string | null | undefined,
    radius: number,
    options: HeadlessViewerOptions,
    knownTileKeys?: Set<string>,
  ) {
    const client = this.headlessFleet?.get(accountId);
    if (!client || !this.gameData) return null;
    const center = client.getPosition();
    const player = client.getPlayer();
    const playerDef = player ? this.gameData.getObject(Number(player.class)) : undefined;
    const r = Math.max(6, Math.min(24, Math.trunc(radius)));
    const tiles = options.includeTiles ? [] as Array<{
      x: number;
      y: number;
      type: number;
      name: string;
      textureFile: string;
      textureIndex: number;
    }> : undefined;
    if (tiles) {
      if (knownTileKeys) {
        const retentionRadius = r + 3;
        for (const key of knownTileKeys) {
          const separator = key.indexOf(',');
          const x = Number(key.slice(0, separator));
          const y = Number(key.slice(separator + 1));
          if (Math.abs(x - center.x) > retentionRadius || Math.abs(y - center.y) > retentionRadius) {
            knownTileKeys.delete(key);
          }
        }
      }
      const minX = Math.ceil(center.x - r);
      const maxX = Math.floor(center.x + r);
      const minY = Math.ceil(center.y - r);
      const maxY = Math.floor(center.y + r);
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const key = `${x},${y}`;
          if (knownTileKeys?.has(key)) continue;
          const tile = client.getTile(x, y);
          if (!tile) continue;
          knownTileKeys?.add(key);
          const texture = this.gameData.getTileTexture(tile.type);
          tiles.push({
            x: tile.x,
            y: tile.y,
            type: tile.type,
            name: this.gameData.getTileName(tile.type) ?? `0x${tile.type.toString(16)}`,
            textureFile: texture?.file ?? '',
            textureIndex: texture?.index ?? -1,
          });
        }
      }
    }
    const objects = options.includeObjects
      ? client.visibleObjects()
        .filter((object) => Math.abs(object.x - center.x) <= r && Math.abs(object.y - center.y) <= r)
        .map((object) => {
          const def = this.gameData?.getObject(object.type);
          const category = def?.isLoot
            ? 'Container'
            : this.gameData?.getObjectCategory(object.type) ?? 'Other';
          const liveTextureType = Number(object.player?.texture ?? 0);
          const visualDef = category === 'Player' && liveTextureType > 0
            ? this.gameData?.getObject(liveTextureType) ?? def
            : def;
          const contents = category === 'Container'
            ? client.getWorldContainerSlots(object.objectId)
              .filter((slot) => slot.slotId >= 0 && slot.slotId < 8 && slot.objectType > 0)
              .map((slot) => {
                const itemDef = this.gameData?.getObject(slot.objectType);
                return {
                  slotIndex: slot.slotId,
                  objectType: slot.objectType,
                  name: itemDef?.displayId || itemDef?.id || `0x${slot.objectType.toString(16)}`,
                  tier: itemDef?.tierStr ?? '',
                  textureFile: itemDef?.textureFile ?? '',
                  textureIndex: itemDef?.textureIndex ?? -1,
                };
              })
            : [];
          return {
            objectId: object.objectId,
            type: object.type,
            category,
            name: object.player?.name || object.name || def?.displayId || def?.id || `0x${object.type.toString(16)}`,
            x: object.x,
            y: object.y,
            textureFile: visualDef?.textureFile ?? '',
            textureIndex: visualDef?.textureIndex ?? -1,
            classType: category === 'Player' ? object.type : 0,
            hp: Number(object.player?.hp ?? object.rawStats?.['1'] ?? 0),
            maxHp: Number(object.player?.maxHP ?? object.rawStats?.['0'] ?? def?.maxHp ?? 0),
            size: Number(object.player?.size ?? object.rawStats?.['2'] ?? def?.size ?? 100),
            isLoot: def?.isLoot === true,
            contents,
          };
        })
      : undefined;
    const projectiles = options.includeSelfProjectiles || options.includeOtherProjectiles
      ? client.getViewerProjectiles()
        .filter((projectile) => projectile.side === 'own'
          ? options.includeSelfProjectiles
          : options.includeOtherProjectiles)
        .map((projectile) => {
          const projectileDef = this.gameData?.getProjectile(projectile.containerType, projectile.bulletType);
          const containerDef = this.gameData?.getObject(projectile.containerType);
          const visualDef = projectileDef?.objectId
            ? this.gameData?.getObjectById(projectileDef.objectId)
            : undefined;
          const explicitSize = Number(projectileDef?.visualSize ?? -1);
          return {
            key: `${projectile.ownerId}:${projectile.bulletId}`,
            side: projectile.side,
            bulletId: projectile.bulletId,
            bulletType: projectile.bulletType,
            ownerId: projectile.ownerId,
            containerType: projectile.containerType,
            startX: projectile.startX,
            startY: projectile.startY,
            angle: projectile.angle,
            startTime: projectile.startTime,
            speed: projectile.definition.speed,
            lifetimeMs: projectile.definition.lifetimeMs,
            trajectoryLifetimeMs: projectile.definition.trajectoryLifetimeMs ?? projectile.definition.lifetimeMs,
            amplitude: projectile.definition.amplitude,
            frequency: projectile.definition.frequency,
            magnitude: projectile.definition.magnitude,
            wavy: projectile.definition.wavy,
            parametric: projectile.definition.parametric,
            boomerang: projectile.definition.boomerang,
            acceleration: projectile.definition.acceleration,
            accelerationDelay: projectile.definition.accelerationDelay,
            speedClamp: projectile.definition.speedClamp,
            textureFile: visualDef?.textureFile ?? '',
            textureIndex: visualDef?.textureIndex ?? -1,
            size: Number.isFinite(explicitSize) && explicitSize >= 0
              ? explicitSize
              : containerDef?.size ?? 100,
            angleCorrection: visualDef?.angleCorrection ?? 0,
            rotation: visualDef?.rotation ?? 0,
            faceDir: projectileDef?.faceDir ?? false,
            noRotation: projectileDef?.noRotation ?? false,
          };
        })
      : undefined;
    const playerTextureType = Number(player?.texture ?? 0);
    const playerVisualDef = playerTextureType > 0
      ? this.gameData.getObject(playerTextureType) ?? playerDef
      : playerDef;
    const tick = client.getTickInfo();
    const pathfindingPath = options.includePathfindingPath
      ? client.getNavigationPath()
      : undefined;
    const dodgeState = options.includeDodgePath ? client.getAutoDodgeState() : null;
    const dodgePath = options.includeDodgePath
      ? dodgeState?.overrideActive
        ? [{
            x: center.x + dodgeState.velocity.x * VIEWER_DODGE_PATH_HORIZON_MS,
            y: center.y + dodgeState.velocity.y * VIEWER_DODGE_PATH_HORIZON_MS,
          }]
        : []
      : undefined;
    return {
      mapName: client.getMapName(),
      center,
      radius: r,
      tiles,
      objects,
      projectiles,
      pathfindingPath,
      dodgePath,
      tickId: tick.tickId,
      tickTimeMs: tick.tickTimeMs,
      msSinceTick: tick.msSinceTick,
      gameTime: client.getGameTime(),
      sampledAt: Date.now(),
      player: {
        objectId: client.getObjectId(),
        name: player?.name || client.alias,
        classType: Number(player?.class ?? 0),
        skin: Number(player?.texture ?? 0),
        hp: Number(player?.hp ?? 0),
        maxHp: Number(player?.maxHP ?? 0),
        size: Number(player?.size ?? playerDef?.size ?? 100),
        x: center.x,
        y: center.y,
        textureFile: playerVisualDef?.textureFile ?? '',
        textureIndex: playerVisualDef?.textureIndex ?? -1,
      },
    };
  }

  private sendHeadlessViewer(
    ws: WebSocket,
    subscription: HeadlessViewerSubscription,
    forceTileReset = false,
  ): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) return;
    const client = this.headlessFleet?.get(subscription.accountId);
    const nextMapName = client?.getMapName() ?? '';
    const tilesReset = forceTileReset || subscription.mapName !== nextMapName;
    if (tilesReset || !subscription.includeTiles) subscription.tileKeys.clear();
    const payload = this.getHeadlessViewerPayload(
      subscription.accountId,
      subscription.radius,
      subscription,
      subscription.includeTiles ? subscription.tileKeys : undefined,
    );
    subscription.mapName = payload?.mapName ?? nextMapName;
    ws.send(JSON.stringify({
      type: 'viewerData',
      accountId: subscription.accountId,
      tilesReset,
      ...(payload ?? {
        mapName: '',
        center: { x: 0, y: 0 },
        radius: subscription.radius,
        tiles: subscription.includeTiles ? [] : undefined,
        objects: subscription.includeObjects ? [] : undefined,
        projectiles: subscription.includeSelfProjectiles || subscription.includeOtherProjectiles ? [] : undefined,
        pathfindingPath: subscription.includePathfindingPath ? [] : undefined,
        dodgePath: subscription.includeDodgePath ? [] : undefined,
        player: null,
        tickId: -1,
        tickTimeMs: 200,
        msSinceTick: -1,
        gameTime: 0,
        sampledAt: Date.now(),
      }),
    }));
  }

  private broadcastHeadlessViewerTick(accountId: string): void {
    for (const [ws, subscription] of this.headlessViewerSubscriptions) {
      if (subscription.accountId === accountId) this.sendHeadlessViewer(ws, subscription);
    }
  }

  private queueHeadlessViewerTick(accountId: string): void {
    this.pendingHeadlessViewerTicks.add(accountId);
    if (this.headlessViewerTickScheduled) return;
    this.headlessViewerTickScheduled = true;
    setImmediate(() => {
      this.headlessViewerTickScheduled = false;
      const accountIds = Array.from(this.pendingHeadlessViewerTicks);
      this.pendingHeadlessViewerTicks.clear();
      for (const pendingAccountId of accountIds) this.broadcastHeadlessViewerTick(pendingAccountId);
    });
  }

  private syncViewerOtherProjectileTracking(): void {
    const enabledAccounts = new Set<string>();
    for (const subscription of this.headlessViewerSubscriptions.values()) {
      if (subscription.includeOtherProjectiles) enabledAccounts.add(subscription.accountId);
    }
    for (const session of this.headlessFleet?.list() ?? []) {
      this.headlessFleet?.get(session.accountId)?.setViewerOtherProjectilesEnabled(enabledAccounts.has(session.accountId));
    }
  }

  private getHeadlessNearbyPlayers(accountId?: string | null) {
    const client = this.headlessFleet?.get(accountId);
    if (!client || !this.gameData) return null;
    const self = client.getPosition();
    return client.visibleObjects()
      .filter((object) => this.gameData?.getObjectCategory(object.type) === 'Player')
      .map((object) => ({
        objectId: object.objectId,
        objectType: object.type,
        className: this.gameData?.getObject(object.type)?.id ?? `0x${object.type.toString(16)}`,
        name: object.name || '?',
        x: object.x,
        y: object.y,
        dist: Math.hypot(object.x - self.x, object.y - self.y),
        hp: object.player?.hp ?? 0,
        maxHp: object.player?.maxHP ?? 0,
        mp: object.player?.mp ?? 0,
        maxMp: object.player?.maxMP ?? 0,
        level: object.player?.level ?? 0,
        fame: object.player?.currentFame ?? 0,
        eq: object.player?.inventory.slice(0, 4) ?? [-1, -1, -1, -1],
      })).sort((a, b) => a.dist - b.dist);
  }

  private getHeadlessNearbyPlayerDebug(accountId: string | null | undefined, objectId: number) {
    const client = this.headlessFleet?.get(accountId);
    const object = client?.getVisibleObject(objectId);
    const player = object?.player;
    if (!client || !object || !player || !this.gameData || this.gameData.getObjectCategory(object.type) !== 'Player') return null;
    const self = client.getPosition();
    return {
      identity: {
        name: player.name || object.name || '?',
        className: player.className || this.gameData.getObject(object.type)?.id || `0x${object.type.toString(16)}`,
        objectId: object.objectId,
        objectType: object.type,
        objectTypeHex: `0x${object.type.toString(16)}`,
        accountId: player.accountId,
        guildName: player.guildName,
        guildRank: player.guildRank,
        skin: player.texture,
        hasBackpack: player.hasBackpack,
        backpackTier: player.hasBackpack ? 8 : 0,
        hasBackpackExtender: false,
      },
      position: {
        x: object.x,
        y: object.y,
        dist: Math.hypot(object.x - self.x, object.y - self.y),
      },
      vitals: { hp: player.hp, maxHp: player.maxHP, mp: player.mp, maxMp: player.maxMP },
      stats: { atk: player.atk, def: player.def, spd: player.spd, dex: player.dex, vit: player.vit, wis: player.wis },
      boosts: {
        hpBonus: player.maxHPBoost,
        mpBonus: player.maxMPBoost,
        atkBonus: player.atkBoost,
        defBonus: player.defBoost,
        spdBonus: player.spdBoost,
        vitBonus: player.vitBoost,
        wisBonus: player.wisBoost,
        dexBonus: player.dexBoost,
      },
      misc: {
        level: player.level,
        fame: player.currentFame,
        stars: player.stars,
        credits: player.gold,
        seasonal: player.seasonal,
        accountLevel: player.accountLevel,
      },
      inventory: {
        equipped: player.inventory.slice(0, 4),
        inventory: player.inventory.slice(0, 12),
        backpack: player.inventory.slice(12, 20),
        quickSlots: [player.potionOneType, player.potionTwoType, player.potionThreeType],
        healthStackCount: player.hpPots,
        magicStackCount: player.mpPots,
      },
      effects: { effects1: player.condition, effects2: player.condition2 },
      rawStats: object.rawStats ?? {},
    };
  }

  start(port = 3000): void {
    this.httpServer.listen(port, () => {
      Logger.log('DevServer', `Dashboard available at http://localhost:${port}`);
      void this.applyExaltTuneOnProxyStartMaybe().finally(() => {
        syncExaltTuneWatchdogFromDisk();
      });
    });
  }

  /** Optional: apply saved idle priority + startup power scheme when dashboard/proxy listens. */
  private async applyExaltTuneOnProxyStartMaybe(): Promise<void> {
    try {
      const s = loadExaltTuneSettings();
      if (!s.autoApplyOnProxyStart) return;
      const check = await tuningSupported();
      if (!check.ok) return;
      await applyRolePrioritiesFromDisk();
      const g = String(s.startupPowerGuid ?? '').trim();
      if (g) await activatePowerPlan(g);
    } catch (e) {
      Logger.warn('DevServer', `exaltTune autoApply: ${(e as Error).message}`);
    }
  }

  stop(): void {
    this.headlessFleet?.disconnectAll('manager shutdown');
    stopExaltTuneWatchdog();
    this.playerDataIntervalStop?.();
    this.playerDataIntervalStop = null;
    this.runtimeScheduler.stop();
    try {
      if (loadExaltTuneSettings().restoreProcessBaselineOnExit) {
        void restoreProcessBaseline().catch(() => {});
      }
    } catch {
      /* ignore */
    }
    this.wss.close();
    this.httpServer.close();
  }

  /** TCP connect to each server:2050, return name -> ms. Failed/timeout omitted. */
  private pingAllServers(): Promise<Record<string, number>> {
    const timeoutMs = 3000;
    const port = 2050;
    const entries = Object.entries(this.servers);
    return Promise.all(
      entries.map(
        ([name, host]) =>
          new Promise<[string, number]>((resolve) => {
            const start = Date.now();
            const socket = new net.Socket();
            const done = (ms: number) => {
              try {
                socket.destroy();
              } catch {}
              resolve([name, ms]);
            };
            socket.setTimeout(timeoutMs, () => done(-1));
            socket.once('error', () => done(-1));
            socket.once('connect', () => done(Date.now() - start));
            socket.connect(port, host);
          }),
      ),
    ).then((results) => {
      const out: Record<string, number> = {};
      results.forEach(([name, ms]) => {
        if (ms >= 0) out[name] = ms;
      });
      return out;
    });
  }

  /** Base URL for forwarding /api/market/* to the bot API (no trailing slash). */
  private getMarketApiBase(): string {
    return BOT_API_URL.replace(/\/$/, '');
  }

  /** Bot API base URL for auth proxy (no trailing slash). */
  private getBotApiBase(): string {
    return BOT_API_URL.replace(/\/$/, '');
  }

  /** Proxy dashboard auth requests to bot-api (renderer uses same origin as DevServer). */
  private proxyRequestToBotApi(
    res: http.ServerResponse,
    backendPath: string,
    init: { method: string; body?: string | null; authorization?: string },
  ): void {
    const base = this.getBotApiBase();
    if (!base) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'botApiUrl not configured' }));
      return;
    }
    const headers: Record<string, string> = {};
    if (init.body != null && init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (init.authorization) {
      headers['Authorization'] = init.authorization;
    }
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    fetch(`${base}${backendPath}`, {
      method: init.method,
      headers,
      body: init.body == null || init.body === undefined ? undefined : init.body,
      signal: ac.signal,
    })
      .then(async (r) => {
        clearTimeout(to);
        const text = await r.text();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(text.length ? text : '{}');
      })
      .catch((err) => {
        clearTimeout(to);
        const msg = (err as Error).message || String(err);
        Logger.warn('DevServer', `Bot API proxy ${base}${backendPath} failed: ${msg}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: `Bot API unreachable: ${msg}` }));
      });
  }

  private handleMarketCatalogGet(res: http.ServerResponse): void {
    const base = this.getMarketApiBase();
    if (base) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 10000);
      fetch(`${base}/api/market/catalog`, { signal: ac.signal })
        .then((r) => {
          clearTimeout(to);
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        })
        .catch((e) => {
          clearTimeout(to);
          Logger.warn('DevServer', `Market catalog upstream failed (${base}): ${(e as Error).message}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(getMarketCatalogStub()));
        });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getMarketCatalogStub()));
  }

  private handleMarketCheckoutPost(body: string, res: http.ServerResponse): void {
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }
    const base = this.getMarketApiBase();
    if (base) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 15000);
      fetch(`${base}/api/market/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
        signal: ac.signal,
      })
        .then(async (r) => {
          clearTimeout(to);
          const text = await r.text();
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(text || '{}');
        })
        .catch((e) => {
          clearTimeout(to);
          Logger.warn('DevServer', `Market checkout upstream failed: ${(e as Error).message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Upstream unavailable' }));
        });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        stub: true,
        message: 'Checkout stub — market API forwarding is not configured.',
      }),
    );
  }

  private handleMarketScriptSubmitPost(body: string, res: http.ServerResponse): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      return;
    }
    const base = this.getMarketApiBase();
    if (base) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 15000);
      fetch(`${base}/api/market/script-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
        signal: ac.signal,
      })
        .then(async (r) => {
          clearTimeout(to);
          const text = await r.text();
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(text || '{}');
        })
        .catch((e) => {
          clearTimeout(to);
          Logger.warn('DevServer', `Market script-submit upstream failed: ${(e as Error).message}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Upstream unavailable' }));
        });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        stub: true,
        message:
          'Submission received (stub). File content is not uploaded yet — wire your API to accept multipart or storage.',
        received: {
          name: parsed.name,
          category: parsed.category,
          pricing: parsed.pricing,
          fileName: parsed.fileName,
          fileSize: parsed.fileSize,
        },
      }),
    );
  }

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.tryServeWikiTextureFile(req, res)) return;
    // API endpoints
    if (req.url === '/api/market/catalog' && req.method === 'GET') {
      this.handleMarketCatalogGet(res);
      return;
    }
    if (req.url === '/api/market/checkout' && req.method === 'POST') {
      let checkoutBody = '';
      req.on('data', (chunk) => {
        checkoutBody += chunk;
      });
      req.on('end', () => this.handleMarketCheckoutPost(checkoutBody, res));
      return;
    }
    if (req.url === '/api/market/script-submit' && req.method === 'POST') {
      let submitBody = '';
      req.on('data', (chunk) => {
        submitBody += chunk;
      });
      req.on('end', () => this.handleMarketScriptSubmitPost(submitBody, res));
      return;
    }

    // ── Bot API auth proxy (dashboard uses /api/auth/* on DevServer origin) ──
    if (req.url?.startsWith('/api/auth/') || req.url?.startsWith('/api/payments/')) {
      res.writeHead(410, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Hive backend auth and payments have been removed.' }));
      return;
    }

    if (req.url === '/api/recent' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.inspector.getRecent()));
      return;
    }

    if (req.url === '/api/damage/encounters' && req.method === 'GET') {
      const history = this.headlessFleet?.damage()?.history ?? [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(history));
      return;
    }

    // ── Packet Lab API ──────────────────────────────────────────────────────

    if (req.url === '/api/lab/definitions' && req.method === 'GET') {
      try {
        type LabPacket = {
          key: string;
          id: number | null;
          name: string;
          direction: string;
          fields: any[];
          status: 'working' | 'needsWork';
        };
        const defs = packetDefinitions as { packets: Record<string, { name: string; direction: string; fields: any[] }>; dataObjects?: Record<string, any> };
        const nameOnlyDefs: { packets?: Array<{ name: string; direction: string; id?: number }> } = packetLabNameOnly;
        const statusMap: Record<string, string> = packetStatus;
        const packets: LabPacket[] = Object.entries(defs.packets || {}).map(([idStr, def]) => ({
          key: `id:${idStr}`,
          id: parseInt(idStr, 10),
          name: def.name,
          direction: def.direction,
          fields: def.fields || [],
          status: statusMap[idStr] === 'needsWork' ? 'needsWork' : 'working',
        }));
        for (const p of nameOnlyDefs.packets || []) {
          packets.push({
            key: `name:${p.direction}:${p.name}`,
            id: typeof p.id === 'number' ? p.id : null,
            name: p.name,
            direction: p.direction,
            fields: [],
            status: 'needsWork',
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ packets, dataObjects: defs.dataObjects || {} }));
      } catch (err) {
        Logger.warn('DevServer', `Failed to load lab definitions: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load definitions' }));
      }
      return;
    }

    if (req.url === '/api/lab/unknowns' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.lab.getUnknowns()));
      return;
    }

    if (req.url?.startsWith('/api/lab/analyze/') && req.method === 'GET') {
      const id = parseInt(req.url.slice('/api/lab/analyze/'.length), 10);
      const result = this.lab.analyze(id);
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No data for packet id ${id}` }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
      return;
    }

    if (req.url === '/api/lab/probe' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        try {
          const { id, spec } = JSON.parse(body);
          const result = this.lab.probe(Number(id), String(spec ?? ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    if (req.url === '/api/ping-all' && req.method === 'GET') {
      this.pingAllServers()
        .then((results) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(results));
        })
        .catch((err) => {
          Logger.warn('DevServer', `ping-all failed: ${(err as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Ping failed' }));
        });
      return;
    }

    // ── Admin: Node process memory (Hive proxy) ───────────────────────
    if (req.url === '/api/admin/memory' && req.method === 'GET') {
      const mu = process.memoryUsage();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          rss: mu.rss,
          heapUsed: mu.heapUsed,
          heapTotal: mu.heapTotal,
          external: mu.external,
          arrayBuffers: (mu as { arrayBuffers?: number }).arrayBuffers,
        }),
      );
      return;
    }

    if (req.url === '/api/admin/window-tuning/settings' && req.method === 'GET') {
      try {
        const settings = loadExaltTuneSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            settings,
            settingsPath: tuneSettingsPath(),
          }),
        );
      } catch (err) {
        Logger.warn('DevServer', `window-tuning settings GET: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((err as Error).message || err) }));
      }
      return;
    }

    if (req.url?.startsWith('/api/admin/window-tuning/tune-status') && req.method === 'GET') {
      void (async () => {
        try {
          const settings = loadExaltTuneSettings();
          const sup = await tuningSupported();
          const reqUrl = new URL(req.url || '/api/admin/window-tuning/tune-status', 'http://127.0.0.1');
          const wantsThermalSample =
            reqUrl.searchParams.get('thermalSample') === '1' ||
            reqUrl.searchParams.get('thermalSample') === 'true';
          const thermalSample = wantsThermalSample ? await sampleWindowsThermalSignals() : undefined;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              supported: !!sup.ok,
              reason: sup.ok ? undefined : sup.reason,
              tuningPreset: settings.tuningPreset ?? null,
              watchdogEnabled: !!settings.watchdog.enabled,
              thermalEnabled: !!settings.thermal.enabled,
              thermalBackgroundDemotionActive: isThermalBackgroundDemotionActive(),
              thermalSample,
            }),
          );
        } catch (e) {
          Logger.warn('DevServer', `window-tuning tune-status GET: ${(e as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
        }
      })();
      return;
    }

    if (req.url === '/api/admin/window-tuning/settings' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as Partial<ExaltTuneSettings>;
          const next = saveExaltTuneSettings(parsed);
          syncExaltTuneWatchdogFromDisk();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, settings: next }));
        } catch (e) {
          Logger.warn('DevServer', `window-tuning settings POST: ${(e as Error).message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/supported' && req.method === 'GET') {
      tuningSupported()
        .then((payload) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reason: String((err as Error).message || err) }));
        });
      return;
    }

    if (req.url === '/api/admin/window-tuning/power-hints' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hints: SUGGESTED_REALM_POWER_HINTS }));
      return;
    }

    if (req.url === '/api/admin/window-tuning/exalt-processes' && req.method === 'GET') {
      enrichWindowTuningExaltPayload()
        .then((data) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...data }));
        })
        .catch((err) => {
          Logger.warn('DevServer', `exalt-processes: ${(err as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((err as Error).message || err) }));
        });
      return;
    }

    if (req.url === '/api/admin/window-tuning/power-plans' && req.method === 'GET') {
      listPowerPlans()
        .then((plans) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, plans }));
        })
        .catch((err) => {
          Logger.warn('DevServer', `power-plans: ${(err as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((err as Error).message || err) }));
        });
      return;
    }

    if (req.url === '/api/admin/window-tuning/power-plan' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { guid?: string };
          const guid = String(parsed.guid ?? '').trim();
          if (!guid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'guid required' }));
            return;
          }
          activatePowerPlan(guid)
            .then((result) => {
              res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            })
            .catch((err) => {
              Logger.warn('DevServer', `power-plan POST: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: String((err as Error).message || err) }));
            });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/exalt-priority' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { preset?: string };
          const p = String(parsed.preset || '') as PriorityPreset;
          const allowed = new Set<PriorityPreset>([
            'Idle',
            'BelowNormal',
            'Normal',
            'AboveNormal',
            'High',
          ]);
          if (!allowed.has(p)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'preset must be Idle|BelowNormal|Normal|AboveNormal|High',
              }),
            );
            return;
          }
          setAllExaltPriority(p)
            .then((result) => {
              res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            })
            .catch((err) => {
              Logger.warn('DevServer', `exalt-priority POST: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: String((err as Error).message || err) }));
            });
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/spread-cores' && req.method === 'POST') {
      spreadAffinityEven()
        .then((result) => {
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          Logger.warn('DevServer', `spread-cores POST: ${(err as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((err as Error).message || err) }));
        });
      return;
    }

    if (req.url === '/api/admin/window-tuning/client-roles/apply' && req.method === 'POST') {
      (async () => {
        try {
          const enriched = await enrichWindowTuningExaltPayload();
          const fg = enriched.foregroundPid;
          const parkedSet = new Set(loadExaltClientRoles().parkedPids);
          const out = await applyResolvedRolesMultiboxClusters(fg, parkedSet);
          res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(out));
        } catch (e) {
          Logger.warn(
            'DevServer',
            `window-tuning client-roles apply: ${(e as Error).message}`,
          );
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
        }
      })();
      return;
    }

    if (req.url === '/api/admin/window-tuning/multibox-action' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || '{}') as { pid?: number; action?: string };
            const pid = Math.floor(Number(parsed.pid));
            const action = String(parsed.action || '').trim().toLowerCase();
            if (!Number.isFinite(pid) || pid <= 0) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'pid required' }));
              return;
            }
            const rel = await getRelatedRealmProcessIds(pid);
            const seed = Math.min(...rel);

            if (action === 'park') {
              const cur = loadExaltClientRoles();
              const next = [...new Set([...cur.parkedPids, ...rel])];
              saveExaltClientRoles({ parkedPids: next });
              const r = await applyClientRoleRuleToSeedPid(seed, 'parked', 0);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: r.ok, error: r.error, pids: r.pids, action: 'park' }));
              return;
            }

            if (action === 'activate' || action === 'active') {
              unparkRealmPidCluster(rel);
              for (const tryPid of [...rel].sort((a, b) => b - a)) {
                await bringRealmPidMainWindowForeground(tryPid);
              }
              const r = await applyClientRoleRuleToSeedPid(seed, 'active', 0);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: r.ok, error: r.error, pids: r.pids, action: 'activate' }));
              return;
            }

            if (action === 'background') {
              unparkRealmPidCluster(rel);
              const r = await applyClientRoleRuleToSeedPid(seed, 'background', 0);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: r.ok, error: r.error, pids: r.pids, action: 'background' }));
              return;
            }

            if (action === 'trim') {
              const r = await emptyWorkingSetForPids(rel);
              res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ...r, action: 'trim' }));
              return;
            }

            if (action === 'resize' || action === 'restore') {
              const r = await resizeRestoreRealmPidCluster(pid);
              res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ...r, action: 'resize' }));
              return;
            }

            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'action must be park|activate|background|trim|resize',
              }),
            );
          } catch (e) {
            Logger.warn('DevServer', `multibox-action: ${(e as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
          }
        })();
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/tuning-preset' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void (async () => {
          try {
            const parsed = JSON.parse(body || '{}') as { preset?: string };
            /** Do not blindly `toLowerCase()` — `lowHeat` would become `lowheat` and fail the Set. */
            const raw = String(parsed.preset || '').trim();
            const low = raw.toLowerCase();
            const PRESET_KEYS: Record<string, TuningPresetName> = {
              safe: 'safe',
              balanced: 'balanced',
              multibox: 'multibox',
              aggressive: 'aggressive',
              lowheat: 'lowHeat',
              lowHeat: 'lowHeat',
            };
            const presetName = PRESET_KEYS[raw] ?? PRESET_KEYS[low];
            if (!presetName) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'preset must be safe|balanced|multibox|aggressive|lowHeat',
                }),
              );
              return;
            }
            applyTuningPresetToDisk(presetName);
            syncExaltTuneWatchdogFromDisk();
            const sup = await tuningSupported();
            if (!sup.ok) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, appliedLive: false, reason: sup.reason, slots: [] }));
              return;
            }
            const out = await applyEffectiveMultiboxPolicyFromDisk();
            res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: !!out.ok,
                appliedLive: !!out.ok,
                error: out.error,
                slots: out.slots || [],
              }),
            );
          } catch (e) {
            Logger.warn('DevServer', `tuning-preset: ${(e as Error).message}`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
          }
        })();
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/run-multibox-policy' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void (async () => {
          try {
            let parsed: { preset?: string } = {};
            if ((body || '').trim()) parsed = JSON.parse(body) as { preset?: string };
            const out = await applyMultiboxPresetAndLivePolicy(parsed);
            res.writeHead(out.ok ? 200 : 400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out));
          } catch (e) {
            Logger.warn('DevServer', `run-multibox-policy: ${(e as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
          }
        })();
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/restore-all' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        void (async () => {
          try {
            let bp = false;
            if ((body || '').trim()) {
              const p = JSON.parse(body) as { balancedPowerPlan?: boolean };
              bp = !!p.balancedPowerPlan;
            }
            const result = await restoreAllClientTuning({ activateBalancedPowerPlan: bp });
            res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            Logger.warn('DevServer', `restore-all: ${(e as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
          }
        })();
      });
      return;
    }

    if (req.url === '/api/admin/window-tuning/restore-process-baseline' && req.method === 'POST') {
      void (async () => {
        try {
          const result = await restoreProcessBaseline();
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          Logger.warn('DevServer', `restore-process-baseline: ${(e as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
        }
      })();
      return;
    }

    if (req.url === '/api/admin/window-tuning/recapture-process-baseline' && req.method === 'POST') {
      void (async () => {
        try {
          const result = await captureProcessBaselineOverwrite();
          res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          Logger.warn('DevServer', `recapture-process-baseline: ${(e as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String((e as Error).message || e) }));
        }
      })();
      return;
    }

    if (req.url === '/api/admin/window-tuning/kill-msedge' && req.method === 'POST') {
      void (async () => {
        try {
          const result = killMicrosoftEdgeProcessesBestEffort();
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          Logger.warn('DevServer', `kill-msedge: ${(e as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, ran: false, error: String((e as Error).message || e) }));
        }
      })();
      return;
    }

    // ── Dashboard data: Documents/Hive (configs, accounts) ─────────
    const hiveUserDir = getHiveDocumentsDir();
    const configsDir = this.getConfigsDir();
    const ensureHiveUserDir = () => this.ensureDir(hiveUserDir);
    const ensureConfigsDir = () => this.ensureDir(configsDir);

    if (req.url === '/api/configs' && req.method === 'GET') {
      try {
        ensureHiveUserDir();
        ensureConfigsDir();
        const files = readdirSync(configsDir).filter((f) => extname(f) === '.json');
        const configs: Array<{ id: string; name: string; updatedAt: number; createdAt: number }> = [];
        for (const f of files) {
          try {
            const raw = readFileSync(join(configsDir, f), 'utf8');
            const cfg = JSON.parse(raw) as { id?: string; name?: string; updatedAt?: number; createdAt?: number };
            const id = String(cfg.id || f.replace(/\.json$/i, ''));
            const name = String(cfg.name || id);
            const updatedAt = Number(cfg.updatedAt || 0) || 0;
            const createdAt = Number(cfg.createdAt || 0) || 0;
            configs.push({ id, name, updatedAt, createdAt });
          } catch {}
        }
        configs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.name.localeCompare(b.name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ configs }));
      } catch (err) {
        Logger.warn('DevServer', `configs list failed: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to list configs' }));
      }
      return;
    }

    if (req.url === '/api/configs/save' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { name?: string };
          const name = String(parsed.name || '').trim();
          if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Config name is required.' }));
            return;
          }
          ensureHiveUserDir();
          ensureConfigsDir();
          const snapshot = this.buildPluginConfigSnapshot(name);
          const filePath = join(configsDir, snapshot.id + '.json');
          if (existsSync(filePath)) {
            try {
              const oldRaw = readFileSync(filePath, 'utf8');
              const oldCfg = JSON.parse(oldRaw) as { createdAt?: number };
              if (Number(oldCfg.createdAt) > 0) snapshot.createdAt = Number(oldCfg.createdAt);
            } catch {}
            snapshot.updatedAt = Date.now();
          }
          writeFileSync(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
          this.config.lastPluginConfigId = snapshot.id;
          this.saveConfig();
          this.broadcastConfig();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            config: { id: snapshot.id, name: snapshot.name, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt },
          }));
        } catch (err) {
          Logger.warn('DevServer', `configs save failed: ${(err as Error).message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save config' }));
        }
      });
      return;
    }

    if (req.url === '/api/configs/load' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { id?: string };
          const rawId = String(parsed.id || '').trim();
          if (!rawId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Config id is required.' }));
            return;
          }
          const id = this.sanitizeConfigId(rawId);
          ensureHiveUserDir();
          ensureConfigsDir();
          const filePath = join(configsDir, id + '.json');
          if (!existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Config not found.' }));
            return;
          }
          const raw = readFileSync(filePath, 'utf8');
          const snapshot = JSON.parse(raw);
          const result = this.applyPluginConfigSnapshot(snapshot);
          if (result.ok) {
            this.config.lastPluginConfigId = id;
            this.saveConfig();
            this.broadcastConfig();
          }
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          Logger.warn('DevServer', `configs load failed: ${(err as Error).message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to load config' }));
        }
      });
      return;
    }

    if (req.url === '/api/proxies' && req.method === 'GET') {
      const proxies = this.readDashboardProxies();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ proxies }));
      return;
    }

    if (req.url === '/api/proxies' && req.method === 'PUT') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { proxies?: unknown[] };
          if (!Array.isArray(parsed.proxies)) throw new Error('proxies[] is required.');
          const existing = new Map(this.readDashboardProxies().map((proxy) => [proxy.id, proxy] as const));
          const now = Date.now();
          const proxies = parsed.proxies.map((raw, index) => {
            const normalized = this.normalizeDashboardProxyRecord(raw, index);
            const previous = existing.get(normalized.id);
            normalized.name ||= `${normalized.protocol.toUpperCase()} ${normalized.host}:${normalized.port}`;
            normalized.createdAt = previous?.createdAt || normalized.createdAt || now;
            normalized.updatedAt = now;
            const config = this.dashboardProxyToConfig(normalized);
            normalized.protocol = config.protocol;
            normalized.host = config.host;
            normalized.port = config.port;
            normalized.username ||= config.username || '';
            normalized.password ||= config.password || '';
            return normalized;
          });
          this.writeDashboardProxies(proxies);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, proxies }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (req.url === '/api/proxies/test' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}') as { ids?: unknown[]; all?: boolean };
          const ids = parsed.all
            ? undefined
            : new Set((Array.isArray(parsed.ids) ? parsed.ids : []).map((id) => String(id)));
          if (ids && ids.size === 0) throw new Error('Select at least one proxy to test.');
          const proxies = await this.testDashboardProxies(ids);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, proxies }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }

    if (req.url === '/api/accounts' && req.method === 'GET') {
      try {
        debugLog(`GET /api/accounts: reading accounts...`);
        const accounts = this.readDashboardAccounts();
        debugLog(`GET /api/accounts: returning ${accounts.length} account(s)`);
        const cachedOverviews = this.readAllDashboardAccountOverviewCaches();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accounts, cachedOverviews }));
      } catch (err) {
        debugLog(`GET /api/accounts: EXCEPTION: ${(err as Error).message}`);
        Logger.warn('DevServer', `accounts list failed: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to load accounts' }));
      }
      return;
    }

    if (req.url === '/api/accounts/save' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}') as { accounts?: unknown[] };
          if (!Array.isArray(parsed.accounts)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'accounts[] is required.' }));
            return;
          }
          const existingById = new Map(this.readDashboardAccounts().map((account) => [account.id, account] as const));
          const now = Date.now();
          const accounts = parsed.accounts.map((rawAccount, index) => {
            const normalized = this.normalizeDashboardAccountRecord(rawAccount, index);
            const existing = existingById.get(normalized.id);
            return {
              ...normalized,
              createdAt: existing?.createdAt || normalized.createdAt || now,
              updatedAt: now,
            };
          });
          this.writeDashboardAccounts(accounts);
          this.pruneDashboardAccountOverviewCaches(accounts);
          for (const account of accounts) {
            const existing = existingById.get(account.id);
            if (existing && String(existing.email || '').trim() !== String(account.email || '').trim()) {
              this.deleteDashboardAccountOverviewCache(account.id);
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, accounts }));
        } catch (err) {
          Logger.warn('DevServer', `accounts save failed: ${(err as Error).message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to save accounts' }));
        }
      });
      return;
    }

    if (req.url === '/api/accounts/overview' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}') as {
            accountId?: string;
            email?: string;
            password?: string;
            refresh?: boolean;
          };
          const accountId = String(parsed.accountId || '').trim();
          const email = String(parsed.email || '').trim();
          const password = String(parsed.password || '');
          const refresh = !!parsed.refresh;
          if (!email || !password) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Email and password are required.' }));
            return;
          }

          if (!refresh && accountId) {
            const cached = this.readDashboardAccountOverviewCache(accountId);
            if (cached && String(cached.email || '').trim() === email) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, overview: cached.overview, cached: true, updatedAt: cached.updatedAt }));
              return;
            }
          }

          const savedAccount = accountId
            ? this.readDashboardAccounts().find((account) => account.id === accountId)
            : undefined;
          const proxy = savedAccount ? this.resolveDashboardAccountProxy(savedAccount) : undefined;
          const remoteResult = await this.fetchDashboardAccountOverviewRemote(
            accountId || email,
            email,
            password,
            proxy,
          );
          if ('error' in remoteResult) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: remoteResult.error }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            overview: remoteResult.cache.overview,
            cached: false,
            updatedAt: remoteResult.cache.updatedAt,
          }));
        } catch (err) {
          Logger.warn('DevServer', `accounts overview failed: ${(err as Error).message}`);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: (err as Error).message || 'Failed to load account overview.' }));
        }
      });
      return;
    }

    if (req.url === '/api/hwid/refresh' && req.method === 'POST') {
      try {
        const removed = clearCachedHwid();
        const fresh = getClientToken({ skipFile: true });
        const preview = fresh ? `${fresh.slice(0, 8)}…${fresh.slice(-4)}` : '';
        Logger.log('DevServer', `HWID refresh requested; ${removed ? 'removed' : 'no'} hwid.txt; fresh=${preview}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, removed, hwidPreview: preview }));
      } catch (err) {
        Logger.warn('DevServer', `hwid refresh failed: ${(err as Error).message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to refresh HWID.' }));
      }
      return;
    }

    if (req.url === '/api/accounts/refresh-all' && req.method === 'POST') {
      Promise.resolve().then(async () => {
        try {
          const accounts = this.readDashboardAccounts();
          const results: Record<string, { ok: boolean; updatedAt?: number; overview?: DashboardAccountOverview; error?: string }> = {};
          for (const account of accounts) {
            const email = String(account.email || '').trim();
            const password = String(account.password || '');
            if (!email || !password) {
              results[account.id] = { ok: false, error: 'Missing credentials.' };
              continue;
            }
            let proxy: ProxyConfig | undefined;
            try {
              proxy = this.resolveDashboardAccountProxy(account);
            } catch (error) {
              results[account.id] = { ok: false, error: (error as Error).message };
              continue;
            }
            const remoteResult = await this.fetchDashboardAccountOverviewRemote(
              account.id,
              email,
              password,
              proxy,
            );
            if ('error' in remoteResult) {
              results[account.id] = { ok: false, error: remoteResult.error };
              continue;
            }
            results[account.id] = {
              ok: true,
              updatedAt: remoteResult.cache.updatedAt,
              overview: remoteResult.cache.overview,
            };
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, results }));
        } catch (err) {
          Logger.warn('DevServer', `accounts refresh-all failed: ${(err as Error).message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Failed to refresh all accounts.' }));
        }
      });
      return;
    }

    if (req.url === '/api/scripts' && req.method === 'GET') {
      const scripts = this.scriptHost?.list() ?? [];
      const dir = this.scriptHost?.getScriptsDir() ?? null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ scripts, dir }));
      return;
    }

    if (req.url === '/api/scripts/open-folder' && req.method === 'POST') {
      try {
        if (!this.scriptHost) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Script host not available.' }));
          return;
        }
        const dir = this.scriptHost.getScriptsDir();
        mkdirSync(dir, { recursive: true });
        // Windows: `cmd /c start "" "<dir>"` — `start` is a shell builtin
        // that hands the path to the registered handler (Explorer for
        // folders). The empty title `""` is required because `start`
        // treats the first quoted token as a window title. This is
        // strictly more reliable than `explorer.exe <dir>` which has
        // the singleton-exits-with-1 quirk and silent-fails on some
        // AV/UAC setups. macOS uses `open`, Linux `xdg-open`.
        let cmd: string;
        let args: string[];
        if (process.platform === 'win32') {
          cmd = process.env.ComSpec || 'cmd.exe';
          args = ['/c', 'start', '', dir];
        } else if (process.platform === 'darwin') {
          cmd = 'open';
          args = [dir];
        } else {
          cmd = 'xdg-open';
          args = [dir];
        }
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
        child.on('error', (err) => {
          // Spawn failures arrive here (e.g. cmd.exe not on PATH).
          // Already-sent response handles the success path; nothing to
          // do but log — the proxy must not crash from a click.
          try { (this.scriptHost as any)?.logLine?.('open-folder failed: ' + err.message, 'error'); }
          catch { /* swallow */ }
        });
        child.unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, dir }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message || 'Failed to open scripts folder.' }));
      }
      return;
    }

    if (req.url === '/api/scripts/start' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          if (!this.scriptHost) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Script host not available.' }));
            return;
          }
          const parsed = JSON.parse(body || '{}') as { id?: string; accountId?: string };
          const requestedAccountId = String(parsed.accountId ?? '').trim();
          const headlessClient = requestedAccountId
            ? this.headlessFleet?.get(requestedAccountId)
            : this.headlessFleet?.get();
          if (requestedAccountId && !headlessClient) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'The selected headless client is no longer connected.' }));
            return;
          }
          if (headlessClient && !headlessClient.isInWorld()) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'The selected headless client is not ready in a map yet.' }));
            return;
          }
          if (!headlessClient && this.connectedClients.size === 0) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Connect an account before starting scripts.' }));
            return;
          }
          const id = String(parsed.id ?? '').trim();
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'id is required.' }));
            return;
          }
          const boundAccountId = headlessClient
            ? (requestedAccountId || this.headlessFleet?.accountIdForClient(headlessClient))
            : undefined;
          const result = await this.scriptHost.start(id, boundAccountId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message || 'Invalid request' }));
        }
      });
      return;
    }

    if (req.url === '/api/scripts/stop' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          if (!this.scriptHost) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Script host not available.' }));
            return;
          }
          const parsed = JSON.parse(body || '{}') as { id?: string };
          const id = String(parsed.id ?? '').trim();
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'id is required.' }));
            return;
          }
          const result = this.scriptHost.stop(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (err as Error).message || 'Invalid request' }));
        }
      });
      return;
    }

    if (req.url === '/api/client/escape' && req.method === 'POST') {
      try {
        const result = this.sendEscapePacket();
        res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, message: (err as Error).message || 'Invalid request' }));
      }
      return;
    }

    // Static file serving
    let filePath = req.url === '/' ? '/index.html' : req.url!;
    const fullPath = join(this.publicDir, filePath);

    if (!existsSync(fullPath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheHeaders = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    };
    const acceptsGzip = (req.headers['accept-encoding'] as string || '').includes('gzip');
    const gzPath = fullPath + '.gz';
    if (acceptsGzip && existsSync(gzPath)) {
      const content = readFileSync(gzPath);
      res.writeHead(200, { ...cacheHeaders, 'Content-Encoding': 'gzip' });
      res.end(content);
    } else {
      const content = readFileSync(fullPath);
      res.writeHead(200, cacheHeaders);
      res.end(content);
    }
  }

  private resetTradeSession(): void {
    this.tradeSession.active = false;
    this.tradeSession.ourSlotCount = 12;
    this.tradeSession.partnerSlotCount = 12;
    this.tradeSession.ourOffer = [];
    this.tradeSession.partnerOffer = [];
    this.tradeSession.partnerOfferFromTradeChanged = [];
    this.tradeSession.partnerName = '';
  }

  private normalizeSlotCount(value: unknown, fallback: number): number {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const count = Math.trunc(parsed);
      if (count >= 1 && count <= 20) return count;
    }
    const fallbackParsed = Number(fallback);
    if (Number.isFinite(fallbackParsed)) {
      const fallbackCount = Math.trunc(fallbackParsed);
      if (fallbackCount >= 1 && fallbackCount <= 20) return fallbackCount;
    }
    return 12;
  }

  private toBoolArray(value: unknown, count: number): boolean[] {
    const normalizedCount = this.normalizeSlotCount(count, 12);
    const out = new Array<boolean>(normalizedCount).fill(false);
    if (!Array.isArray(value)) return out;
    const max = Math.min(value.length, normalizedCount);
    for (let i = 0; i < max; i++) out[i] = Boolean(value[i]);
    return out;
  }

  private extractTradeItemIncluded(items: unknown[]): boolean[] {
    const out: boolean[] = [];
    for (const item of items) {
      if (item && typeof item === 'object' && 'included' in item) {
        out.push(Boolean((item as Record<string, unknown>).included));
      } else {
        out.push(false);
      }
    }
    return out;
  }

  private parseOfferSlots(raw: string, count: number): boolean[] {
    const normalizedCount = this.normalizeSlotCount(count, 12);
    const out = new Array<boolean>(normalizedCount).fill(false);
    const trimmed = raw.trim();
    if (!trimmed) return out;
    if (trimmed === '*' || trimmed.toLowerCase() === 'all') {
      return new Array<boolean>(normalizedCount).fill(true);
    }

    const parts = trimmed.split(',').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return out;
    for (const part of parts) {
      if (!/^\d+$/.test(part)) {
        throw new Error(`Invalid slot value "${part}". Use comma-separated indexes like 0,2,5 or "all".`);
      }
      const idx = Number(part);
      if (!Number.isInteger(idx) || idx < 0 || idx >= normalizedCount) {
        throw new Error(`Slot index ${idx} is out of range (0-${normalizedCount - 1}).`);
      }
      out[idx] = true;
    }
    return out;
  }

  private observeTradePacket(pkt: CapturedPacket): void {
    const name = String(pkt.name ?? '').toUpperCase();
    const direction = String(pkt.direction ?? '');
    const fromServer = direction.startsWith('S');
    const fromClient = direction.startsWith('C');
    const data = (pkt.data && typeof pkt.data === 'object') ? pkt.data : {};

    if (name === 'TRADESTART' && fromServer) {
      const clientItems = Array.isArray(data.clientItems) ? data.clientItems : [];
      const partnerItems = Array.isArray(data.partnerItems) ? data.partnerItems : [];
      this.tradeSession.active = true;
      this.tradeSession.ourSlotCount = this.normalizeSlotCount(clientItems.length, this.tradeSession.ourSlotCount);
      this.tradeSession.partnerSlotCount = this.normalizeSlotCount(partnerItems.length, this.tradeSession.partnerSlotCount);
      this.tradeSession.ourOffer = this.toBoolArray(
        this.extractTradeItemIncluded(clientItems),
        this.tradeSession.ourSlotCount,
      );
      this.tradeSession.partnerOffer = this.toBoolArray(
        this.extractTradeItemIncluded(partnerItems),
        this.tradeSession.partnerSlotCount,
      );
      this.tradeSession.partnerOfferFromTradeChanged = this.tradeSession.partnerOffer.slice();
      this.tradeSession.partnerName = typeof data.partnerName === 'string' ? data.partnerName : '';
      return;
    }

    if (name === 'TRADECHANGED' && fromServer) {
      this.tradeSession.active = true;
      const next = this.toBoolArray(data.offer, this.tradeSession.partnerSlotCount);
      this.tradeSession.partnerOffer = next;
      this.tradeSession.partnerOfferFromTradeChanged = next.slice();
      return;
    }

    if (name === 'CHANGETRADE' && fromClient) {
      this.tradeSession.active = true;
      this.tradeSession.ourOffer = this.toBoolArray(data.offer, this.tradeSession.ourSlotCount);
      return;
    }

    if (name === 'TRADEACCEPTED' && fromServer) {
      this.tradeSession.active = true;
      this.tradeSession.ourOffer = this.toBoolArray(data.clientOffer, this.tradeSession.ourSlotCount);
      this.tradeSession.partnerOffer = this.toBoolArray(data.partnerOffer, this.tradeSession.partnerSlotCount);
      // partnerOfferFromTradeChanged unchanged — ACCEPTTRADE must echo last TRADECHANGED
      return;
    }

    if ((name === 'TRADEDONE' && fromServer) || (name === 'CANCELTRADE' && fromClient)) {
      this.resetTradeSession();
    }
  }

  private sendLabPacket(nameRaw: unknown, dataRaw: unknown): {
    ok: boolean;
    message: string;
    packetName?: string;
    data?: Record<string, unknown>;
  } {
    if (!this.proxy) return { ok: false, message: 'Proxy is not attached.' };
    if (!this.currentClient || typeof this.currentClient.sendToServer !== 'function') {
      return { ok: false, message: 'No active game client connection.' };
    }

    const packetName = String(nameRaw ?? '').trim().toUpperCase();
    const allowed = new Set([
      'REQUESTTRADE',
      'CANCELTRADE',
      'ACCEPTTRADE',
      'CHANGETRADE',
      'PARTYACTIONRESULT',
      'PARTYJOINREQUEST',
      'INVENTORYSWAP',
    ]);
    if (!allowed.has(packetName)) {
      return { ok: false, message: `Packet ${packetName} is not enabled for Packet Lab sending.` };
    }

    const data = (dataRaw && typeof dataRaw === 'object')
      ? (dataRaw as Record<string, unknown>)
      : {};

    try {
      const packet = this.proxy.packetFactory.createByName(packetName);

      if (packetName === 'REQUESTTRADE') {
        const targetName = String(data.name ?? '').trim();
        if (!targetName) {
          return { ok: false, message: 'REQUESTTRADE requires a player name.' };
        }
        packet.data.name = targetName;
      } else if (packetName === 'ACCEPTTRADE') {
        const ourCount = this.normalizeSlotCount(this.tradeSession.ourSlotCount, 12);
        const partnerCount = this.normalizeSlotCount(this.tradeSession.partnerSlotCount, 12);
        packet.data.clientOffer = this.toBoolArray(this.tradeSession.ourOffer, ourCount);
        const partnerLine =
          this.tradeSession.partnerOfferFromTradeChanged.length > 0
            ? this.tradeSession.partnerOfferFromTradeChanged
            : this.tradeSession.partnerOffer;
        packet.data.partnerOffer = this.toBoolArray(partnerLine, partnerCount);
      } else if (packetName === 'CHANGETRADE') {
        const ourCount = this.normalizeSlotCount(this.tradeSession.ourSlotCount, 12);
        let offer: boolean[];
        if (Array.isArray(data.offer)) {
          offer = this.toBoolArray(data.offer, ourCount);
        } else {
          const offerSlots = String(data.offerSlots ?? '').trim();
          offer = offerSlots
            ? this.parseOfferSlots(offerSlots, ourCount)
            : this.toBoolArray(this.tradeSession.ourOffer, ourCount);
        }
        packet.data.offer = offer;
        this.tradeSession.ourOffer = offer.slice();
        this.tradeSession.active = true;
      } else if (packetName === 'CANCELTRADE') {
        this.resetTradeSession();
      } else if (packetName === 'PARTYACTIONRESULT') {
        const pid = Number(data.playerId);
        const aid = Number(data.actionId);
        if (!Number.isFinite(pid) || pid < 0 || pid > 65535) {
          return { ok: false, message: 'PARTYACTIONRESULT requires playerId 0–65535 (e.g. 65535).' };
        }
        if (!Number.isFinite(aid) || aid < 0 || aid > 255) {
          return { ok: false, message: 'PARTYACTIONRESULT requires actionId 0–255.' };
        }
        (packet.data as { playerId: number; actionId: number }).playerId = Math.trunc(pid);
        (packet.data as { playerId: number; actionId: number }).actionId = Math.trunc(aid);
        packet.modified = true;
      } else if (packetName === 'PARTYJOINREQUEST') {
        const partyId = Math.trunc(Number(data.partyId));
        if (!Number.isFinite(partyId) || partyId < 1 || partyId > 4294967295) {
          return { ok: false, message: 'PARTYJOINREQUEST requires partyId 1–4294967295.' };
        }
        let unknownByte = Math.trunc(Number(data.unknownByte));
        if (!Number.isFinite(unknownByte) || data.unknownByte === undefined || data.unknownByte === '') {
          unknownByte = 1;
        }
        if (unknownByte < 0 || unknownByte > 255) {
          return { ok: false, message: 'PARTYJOINREQUEST trailing byte must be 0–255.' };
        }
        (packet.data as { partyId: number; unknownByte: number }).partyId = partyId >>> 0;
        (packet.data as { partyId: number; unknownByte: number }).unknownByte = unknownByte;
        packet.modified = true;
      } else if (packetName === 'INVENTORYSWAP') {
        const c = this.currentClient;
        const p = c.playerData;
        const o1oid = Math.trunc(Number(data.o1oid));
        const o1slot = Math.trunc(Number(data.o1slot));
        const o1type = Math.trunc(Number(data.o1type));
        const o2oid = Math.trunc(Number(data.o2oid));
        const o2slot = Math.trunc(Number(data.o2slot));
        const o2type = Math.trunc(Number(data.o2type));
        if (!Number.isFinite(o1oid) || !Number.isFinite(o1slot) || !Number.isFinite(o1type) ||
            !Number.isFinite(o2oid) || !Number.isFinite(o2slot) || !Number.isFinite(o2type)) {
          return { ok: false, message: 'INVENTORYSWAP requires o1oid, o1slot, o1type, o2oid, o2slot, o2type (all integers).' };
        }
        packet.data.time = Math.trunc(c.time);
        packet.data.position = { x: p?.pos?.x ?? 0, y: p?.pos?.y ?? 0 };
        packet.data.slotObject1 = { objectId: o1oid, slotId: o1slot, objectType: o1type };
        packet.data.slotObject2 = { objectId: o2oid, slotId: o2slot, objectType: o2type };
        // No tickId — matches live protocol wire format
        packet.modified = true;
      }

      this.currentClient.sendToServer(packet);
      return {
        ok: true,
        packetName,
        message: `${packetName} sent.`,
        data: packet.data as Record<string, unknown>,
      };
    } catch (err) {
      return {
        ok: false,
        packetName,
        message: (err as Error).message || `Failed to send ${packetName}.`,
      };
    }
  }

  private sendEscapePacket(): { ok: boolean; message: string; packetName?: string } {
    if (!this.proxy) return { ok: false, message: 'Proxy is not attached.' };
    if (!this.currentClient || typeof this.currentClient.sendToServer !== 'function') {
      return { ok: false, message: 'No active game client connection.' };
    }
    try {
      const packet = this.proxy.packetFactory.createByName('ESCAPE');
      packet.modified = true;
      this.currentClient.sendToServer(packet);
      return { ok: true, packetName: 'ESCAPE', message: 'ESCAPE sent.' };
    } catch (err) {
      return { ok: false, message: (err as Error).message || 'Failed to send ESCAPE.' };
    }
  }

  private handleWsConnection(ws: WebSocket): void {
    Logger.log('DevServer', 'Dashboard client connected');

    // Send current plugin state
    ws.send(JSON.stringify({
      type: 'plugins',
      data: this.pluginManager.getPlugins(),
    }));
    ws.send(JSON.stringify({ type: 'headlessSessions', sessions: this.headlessFleet?.list() ?? [] }));
    this.broadcastClientList(ws);

    // Send current game client state
    ws.send(JSON.stringify({
      type: 'gameClient',
      connected: this.gameClientConnected,
    }));

    // Send current internal state (DLL bridge removed)
    ws.send(JSON.stringify({
      type: 'internalState',
      connected: false,
    }));

    if (this.lastUnresolvedClasses !== null) {
      ws.send(JSON.stringify({ type: 'unresolvedClasses', classes: this.lastUnresolvedClasses }));
    }

    // Send recent packets
    const recent = this.inspector.getRecent(100);
    ws.send(JSON.stringify({
      type: 'history',
      data: recent,
    }));

    // Subscribe to real-time packets
    const unsub = this.inspector.subscribe((packet: CapturedPacket) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'packet', data: packet }));
      }
    });

    // Send current config (rotmg path, server names)
    ws.send(this.buildConfigMessage());

    // Send current Packet Lab state
    ws.send(JSON.stringify({ type: 'labUpdate', unknowns: this.lab.getUnknowns() }));

    // Send current gem/login status
    ws.send(JSON.stringify({
      type: 'gemStatus',
      loggedIn: this.botApiClient.loggedIn,
      gem_balance: 0,
      active: this.pluginManager.activePlans.size > 0,
      active_plans: Array.from(this.pluginManager.activePlans),
      next_deduction_at: null,
    }));

    // Handle incoming messages from dashboard
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const removedBackendMessages = new Set([
          'dashboardToken',
          'botApiLogin',
          'botApiLogout',
          'botApiStatus',
          'getBundles',
          'buyGems',
          'getOwnedScripts',
          'runMarketplaceScript',
          'stopMarketplaceScript',
          'trackEvent',
        ]);
        if (removedBackendMessages.has(String(msg.type || ''))) {
          if (ws.readyState === WebSocket.OPEN) {
            if (msg.type === 'botApiStatus') {
              ws.send(JSON.stringify({ type: 'gemStatus', loggedIn: false, gem_balance: 0, active: false, active_plans: [], next_deduction_at: null }));
            } else if (msg.type === 'getOwnedScripts') {
              ws.send(JSON.stringify({ type: 'ownedScripts', scripts: [] }));
            } else if (msg.type === 'getBundles') {
              ws.send(JSON.stringify({ type: 'bundles', bundles: [] }));
            } else {
              ws.send(JSON.stringify({ type: 'botApiError', error: 'Hive backend API has been removed.' }));
            }
          }
          return;
        }
        if (msg.type === 'togglePlugin') {
          const result = this.pluginManager.togglePlugin(msg.pluginId, msg.enabled);
          if (!result.ok && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pluginToggleError', pluginId: msg.pluginId, reason: result.reason, requiredPlan: result.requiredPlan ?? null }));
          }
          // Only emit on accepted toggles — denied attempts (gem-gated etc.)
          // are spam and would skew the "popularity" interpretation.
          if (result.ok) {
            this.eventTracker?.track('plugin_toggle', {
              plugin: String(msg.pluginId || ''),
              enabled: !!msg.enabled,
            });
          }
          this.broadcastPluginState();
          this.scheduleAutosave();
        } else if (msg.type === 'scriptPanelEvent') {
          const scriptId = String((msg as { scriptId?: unknown }).scriptId ?? '').trim();
          const widgetId = String((msg as { widgetId?: unknown }).widgetId ?? '').trim();
          const rawKind = String((msg as { kind?: unknown }).kind ?? '').trim();
          if (!scriptId || !this.scriptHost) return;
          if (rawKind !== 'click' && rawKind !== 'change' && rawKind !== 'submit' && rawKind !== 'select' && rawKind !== 'closed-by-user') return;
          if (rawKind !== 'closed-by-user' && !widgetId) return;
          const evt: ScriptPanelInboundEvent = {
            scriptId,
            widgetId,
            kind: rawKind,
            value: (msg as { value?: unknown }).value,
          };
          this.scriptHost.dispatchPanelEvent(evt);
        } else if (msg.type === 'requestScriptPanelSnapshots') {
          this.sendScriptPanelSnapshots(ws);
        } else if (msg.type === 'updateSetting') {
          const settingOk = this.pluginManager.updateSetting(msg.pluginId, msg.key, msg.value);
          if (!settingOk && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'settingUpdateError', pluginId: msg.pluginId, key: msg.key }));
          }
          this.broadcastPluginState();
          this.scheduleAutosave();
        } else if (msg.type === 'resetPluginSettings') {
          const changed = this.pluginManager.resetPluginSettings(String(msg.pluginId ?? ''));
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'pluginSettingsReset',
              pluginId: msg.pluginId,
              changedKeys: changed,
            }));
          }
          this.broadcastPluginState();
          this.scheduleAutosave();
        } else if (msg.type === 'trackEvent') {
          // Product analytics removed — ignore dashboard emits.
        } else if (msg.type === 'launchGame') {
          const result = this.launchGame();
          ws.send(JSON.stringify({ type: 'launchGameResult', ...result }));
        } else if (msg.type === 'launchGameWithCredentials') {
          const email = String(msg.email ?? '').trim();
          const password = String(msg.password ?? '');
          const serverName = String(msg.serverName ?? 'USWest').trim() || 'USWest';
          const rawRect = (msg as { windowRect?: unknown }).windowRect;
          let windowRect: { x: number; y: number; width: number; height: number } | undefined;
          if (rawRect && typeof rawRect === 'object') {
            const r = rawRect as Record<string, unknown>;
            const x = Number(r.x);
            const y = Number(r.y);
            const width = Number(r.width);
            const height = Number(r.height);
            if ([x, y, width, height].every((n) => Number.isFinite(n))) {
              windowRect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
            }
          }
          const compactWindow = !!(msg as { compactWindow?: boolean }).compactWindow && !windowRect;
          const rawAccountId = (msg as { accountId?: unknown }).accountId;
          const accountId =
            typeof rawAccountId === 'string' && rawAccountId.trim() !== '' ? rawAccountId.trim() : null;
          const rawLabel = (msg as { accountLabel?: unknown }).accountLabel;
          const accountLabel =
            typeof rawLabel === 'string' && rawLabel.trim() !== '' ? rawLabel.trim() : null;
          const rawProxy = (msg as { accountProxy?: unknown }).accountProxy;
          let accountProxy: DashboardAccountProxySelection | null = null;
          if (rawProxy && typeof rawProxy === 'object') {
            const value = rawProxy as Record<string, unknown>;
            accountProxy = {
              proxyId: String(value.proxyId || '').trim(),
              proxyProtocol: this.normalizeProxyProtocol(value.proxyProtocol),
              proxy: String(value.proxy || ''),
              proxyUsername: String(value.proxyUsername || ''),
              proxyPassword: String(value.proxyPassword || ''),
            };
          }
          this.launchGameWithCredentials(email, password, serverName, {
            compactWindow,
            windowRect,
            accountId,
            accountLabel,
            accountProxy,
          }).then(
            (result) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'launchGameResult', ...result }));
              }
            },
          );
        } else if (msg.type === 'probePacket') {
          const result = this.lab.probe(Number(msg.id), String(msg.spec ?? ''));
          ws.send(JSON.stringify({ type: 'probeResult', id: msg.id, result }));
        } else if (msg.type === 'sendLabPacket') {
          const result = this.sendLabPacket(msg.packetName, msg.data);
          ws.send(JSON.stringify({
            type: 'labPacketSendResult',
            requestId: msg.requestId ?? null,
            result,
          }));
        } else if (msg.type === 'requestObjects') {
          const headlessPayload = this.getHeadlessObjectsPayload(String(msg.accountId || '') || null);
          if (headlessPayload) {
            ws.send(JSON.stringify({ type: 'objectsData', ...headlessPayload, beaconTypes: this.gameData?.getBeaconTypes() ?? [] }));
            return;
          }
          if (this.worldState && this.gameData) {
            const payload = this.worldState.getObjectsForDashboard(this.gameData);
            const beaconTypes = this.gameData.getBeaconTypes();
            const objectsMsg = JSON.stringify({ type: 'objectsData', ...payload, beaconTypes });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(objectsMsg);
            }
          } else {
            const emptyMsg = JSON.stringify({ type: 'objectsData', portals: [], beacons: [], categories: [], beaconTypes: [] });
            if (ws.readyState === WebSocket.OPEN) ws.send(emptyMsg);
          }
        } else if (msg.type === 'requestHeadlessDamage') {
          const accountId = String(msg.accountId || '') || null;
          const snapshot = this.headlessFleet?.damage(accountId) ?? null;
          ws.send(JSON.stringify({
            type: 'headlessDamageData',
            accountId: accountId || this.headlessFleet?.list()[0]?.accountId || '',
            live: snapshot?.live ?? null,
            history: snapshot?.history ?? [],
          }));
        } else if (msg.type === 'subscribeHeadlessPackets') {
          const accountId = String(msg.accountId || '').trim();
          if (accountId && this.headlessFleet?.get(accountId)) {
            this.headlessPacketSubscriptions.set(ws, accountId);
          } else {
            this.headlessPacketSubscriptions.delete(ws);
          }
          ws.send(JSON.stringify({
            type: 'headlessPacketHistory',
            accountId,
            packets: accountId ? this.headlessPacketHistory.get(accountId) ?? [] : [],
          }));
        } else if (msg.type === 'unsubscribeHeadlessPackets') {
          this.headlessPacketSubscriptions.delete(ws);
        } else if (msg.type === 'clearHeadlessPackets') {
          const accountId = String(msg.accountId || '').trim();
          if (accountId) this.headlessPacketHistory.set(accountId, []);
          ws.send(JSON.stringify({ type: 'headlessPacketHistory', accountId, packets: [] }));
        } else if (msg.type === 'requestChatHistory') {
          const accountId = String(msg.accountId || '').trim();
          ws.send(JSON.stringify({
            type: 'chatHistory',
            accountId,
            messages: this.headlessChatHistory.get(accountId) ?? [],
          }));
        } else if (msg.type === 'sendChatMessage') {
          const accountId = String(msg.accountId || '').trim();
          const result = this.sendHeadlessChat(
            accountId,
            String(msg.channel || 'say').trim().toLowerCase(),
            String(msg.recipient || ''),
            String(msg.message || ''),
          );
          ws.send(JSON.stringify({
            type: 'chatSendResult',
            requestId: String(msg.requestId || ''),
            accountId,
            ...result,
          }));
        } else if (msg.type === 'requestViewer') {
          const requestedAccountId = String(msg.accountId || '').trim();
          const accountId = requestedAccountId && this.headlessFleet?.get(requestedAccountId)
            ? requestedAccountId
            : this.headlessFleet?.list()[0]?.accountId ?? '';
          const radiusRaw = Number(msg.radius ?? 15);
          const radius = Math.max(6, Math.min(24, Math.trunc(Number.isFinite(radiusRaw) ? radiusRaw : 15)));
          const previous = this.headlessViewerSubscriptions.get(ws);
          const subscription: HeadlessViewerSubscription = {
            accountId,
            radius,
            includeTiles: msg.includeTiles !== false,
            includeObjects: msg.includeObjects !== false,
            includeSelfProjectiles: msg.includeSelfProjectiles !== false,
            includeOtherProjectiles: msg.includeOtherProjectiles !== false,
            includePathfindingPath: msg.includePathfindingPath !== false,
            includeDodgePath: msg.includeDodgePath !== false,
            mapName: previous?.accountId === accountId ? previous.mapName : '',
            tileKeys: previous?.accountId === accountId ? previous.tileKeys : new Set<string>(),
          };
          const resetTiles = previous?.accountId !== accountId
            || previous?.radius !== radius
            || previous?.includeTiles !== subscription.includeTiles;
          if (msg.subscribe === true && accountId) {
            this.headlessViewerSubscriptions.set(ws, subscription);
          } else {
            this.headlessViewerSubscriptions.delete(ws);
          }
          this.syncViewerOtherProjectileTracking();
          this.sendHeadlessViewer(ws, subscription, resetTiles);
        } else if (msg.type === 'unsubscribeViewer') {
          this.headlessViewerSubscriptions.delete(ws);
          this.syncViewerOtherProjectileTracking();
        } else if (msg.type === 'disconnectHeadlessClient') {
          const accountId = String(msg.accountId || '').trim();
          const ok = !!accountId && !!this.headlessFleet?.disconnect(accountId, 'dashboard disconnect');
          ws.send(JSON.stringify({
            type: 'headlessDisconnectResult',
            accountId,
            ok,
            message: ok ? 'Client disconnected.' : 'Client is no longer connected.',
          }));
        } else if (msg.type === 'requestGameWikiCatalog') {
          if (msg.force === true) {
            this.gameWikiCatalogJson = null;
          }
          if (ws.readyState !== WebSocket.OPEN) return;
          if (!this.gameData) {
            ws.send(
              JSON.stringify({
                type: 'gameWikiCatalog',
                objectSummaries: [],
                objectDetails: {},
                tiles: [],
                objectCount: 0,
                tileCount: 0,
                reason: 'no_game_data',
              }),
            );
            return;
          }
          if (!this.gameWikiCatalogJson) {
            const { objectSummaries, objectDetails, tiles } = this.gameData.getGameWikiCatalog();
            this.gameWikiCatalogJson = JSON.stringify({
              type: 'gameWikiCatalog',
              objectSummaries,
              objectDetails,
              tiles,
              objectCount: objectSummaries.length,
              tileCount: tiles.length,
            });
          }
          ws.send(this.gameWikiCatalogJson);
        } else if (msg.type === 'requestObjectXml') {
          if (ws.readyState !== WebSocket.OPEN || !this.gameData) return;
          const t = Number(msg.objectType);
          ws.send(JSON.stringify({
            type: 'objectXmlResult',
            objectType: t,
            rawXml: Number.isFinite(t) ? (this.gameData.getRawObjectXml(t) ?? null) : null,
          }));
        } else if (msg.type === 'requestTileXml') {
          if (ws.readyState !== WebSocket.OPEN || !this.gameData) return;
          const t = Number(msg.tileType);
          ws.send(JSON.stringify({
            type: 'tileXmlResult',
            tileType: t,
            rawXml: Number.isFinite(t) ? (this.gameData.getRawTileXml(t) ?? null) : null,
          }));
        } else if (msg.type === 'requestTilemap') {
          const radiusRaw = Number(msg.radius ?? 12);
          const radius = Number.isFinite(radiusRaw) ? Math.max(1, Math.min(30, Math.trunc(radiusRaw))) : 12;
          const headlessPayload = this.getHeadlessTilesPayload(String(msg.accountId || '') || null, radius);
          if (headlessPayload) {
            ws.send(JSON.stringify({ type: 'tilesData', ...headlessPayload }));
            return;
          }
          const pos = this.getEffectivePlayerPos();
          if (this.worldState && this.gameData && pos) {
            let payload = this.worldState.getNearbyTilesForDashboard(
              this.gameData,
              pos,
              radius,
            );
            const packetPos = this.currentClient?.playerData?.pos ?? null;
            if (
              payload.groups.length === 0
              && packetPos
              && (Math.abs(packetPos.x - pos.x) > 0.01 || Math.abs(packetPos.y - pos.y) > 0.01)
            ) {
              payload = this.worldState.getNearbyTilesForDashboard(
                this.gameData,
                packetPos,
                radius,
              );
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tilesData', ...payload }));
            }
          } else if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'tilesData', center: { x: 0, y: 0 }, radius: 12, groups: [] }));
          }
        } else if (msg.type === 'requestNearbyPlayers') {
          const headlessPlayers = this.getHeadlessNearbyPlayers(String(msg.accountId || '') || null);
          if (headlessPlayers) {
            ws.send(JSON.stringify({ type: 'nearbyPlayersData', players: headlessPlayers }));
            return;
          }
          if (this.worldState && this.gameData && this.currentClient?.playerData) {
            const myPos = this.getEffectivePlayerPos();
            const payload = this.worldState.getNearbyPlayersForDashboard(
              this.gameData,
              myPos,
              this.currentClient.objectId,
            );
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'nearbyPlayersData', players: payload }));
            }
          } else {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'nearbyPlayersData', players: [] }));
            }
          }
        } else if (msg.type === 'requestAllPlayersRawStats') {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (this.worldState && this.gameData) {
            const all = this.worldState.getAllPlayersRawStatsForDashboard(this.gameData);
            const oid = this.currentClient?.objectId;
            const players =
              oid != null && Number.isFinite(Number(oid))
                ? all.filter((p) => p.objectId === oid)
                : [];
            ws.send(
              JSON.stringify({
                type: 'allPlayersRawStats',
                capturedAt: Date.now(),
                map: this.currentClient?.playerData?.mapName ?? null,
                gameId: this.currentClient?.state?.gameId ?? null,
                selfObjectId: this.currentClient?.objectId ?? null,
                players,
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                type: 'allPlayersRawStats',
                capturedAt: Date.now(),
                map: null,
                gameId: null,
                selfObjectId: null,
                players: [],
              }),
            );
          }
        } else if (msg.type === 'requestVaultData') {
          if (ws.readyState !== WebSocket.OPEN) return;
          const vaultState = this.currentClient ? getVaultStore(this.currentClient) : null;
          if (!vaultState) {
            ws.send(JSON.stringify({
              type: 'vaultData',
              error: 'Vault data not available — enter the vault first.',
              capturedAt: null,
            }));
          } else {
            ws.send(JSON.stringify({
              type: 'vaultData',
              capturedAt: vaultState.capturedAt,
              updatedAt: vaultState.updatedAt,
              revision: vaultState.revision,
              active: vaultState.active,
              map: this.currentClient?.playerData?.mapName ?? null,
              gameId: this.currentClient?.state?.gameId ?? null,
              lastVaultUpdate: vaultState.lastVaultUpdate,
              vault:          { objectId: vaultState.vault.objectId,          contents: vaultState.vault.contents,          chunks: vaultState.vault.chunks },
              material:       { objectId: vaultState.material.objectId,       contents: vaultState.material.contents,       chunks: vaultState.material.chunks },
              gift:           { objectId: vaultState.gift.objectId,           contents: vaultState.gift.contents,           chunks: vaultState.gift.chunks },
              potion:         { objectId: vaultState.potion.objectId,         contents: vaultState.potion.contents,         chunks: vaultState.potion.chunks },
              seasonalSpoils: { objectId: vaultState.seasonalSpoils.objectId, contents: vaultState.seasonalSpoils.contents, chunks: vaultState.seasonalSpoils.chunks },
              vaultUpgradeCost:    vaultState.vaultUpgradeCost,
              materialUpgradeCost: vaultState.materialUpgradeCost,
              seasonalSpoilUpgradeCost: vaultState.seasonalSpoilUpgradeCost,
              potionUpgradeCost:   vaultState.potionUpgradeCost,
              currentPotionMax:    vaultState.currentPotionMax,
              nextPotionMax:       vaultState.nextPotionMax,
              vaultChestEnchants:  vaultState.vaultChestEnchants,
              giftChestEnchants:   vaultState.giftChestEnchants,
              spoilsChestEnchants: vaultState.spoilsChestEnchants,
            }));
          }
        } else if (msg.type === 'requestNearbyPlayerDebug') {
          const oid = Number(msg.objectId);
          if (!Number.isFinite(oid)) return;
          const headlessDebug = this.getHeadlessNearbyPlayerDebug(String(msg.accountId || '') || null, oid);
          if (headlessDebug) {
            ws.send(JSON.stringify({ type: 'nearbyPlayerDebug', objectId: oid, debug: headlessDebug }));
            return;
          }
          if (this.worldState && this.gameData && this.currentClient?.playerData) {
            const myPos = this.currentClient.playerData.pos ?? null;
            const debug = this.worldState.getNearbyPlayerDebugForDashboard(this.gameData, myPos, oid);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'nearbyPlayerDebug', objectId: oid, debug }));
            }
          } else {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'nearbyPlayerDebug', objectId: oid, debug: null }));
            }
          }
        } else if (msg.type === 'updateRotmgPath') {
          const newPath = (msg.path || '').trim();
          if (newPath) {
            this.config.rotmgPath = newPath;
          } else {
            delete this.config.rotmgPath;
          }
          this.saveConfig();
          this.broadcastConfig();
        } else if (msg.type === 'updateRotmgExtractorGameDataPath') {
          const p = String(msg.path ?? '').trim();
          if (p) {
            this.config.rotmgExtractorGameDataPath = p;
          } else {
            delete this.config.rotmgExtractorGameDataPath;
          }
          this.wikiSpriteSheetCache = null;
          this.saveConfig();
          this.broadcastConfig();
        } else if (msg.type === 'updateSingleClientOnly') {
          this.config.singleClientOnly = msg.value !== false;
          this.broadcastConfig();
        } else if (msg.type === 'dashboardToken') {
          // Dashboard sends its access+refresh tokens so plugins use the same session
          const at = String(msg.access_token ?? '').trim();
          const rt = String(msg.refresh_token ?? '').trim() || null;
          const isAdmin = msg.is_admin === true;
          const developerMode = msg.developer_mode === true;
          if (at && at !== this.lastSeedToken) {
            this.lastSeedToken = at;
            this.botApiClient.loginWithTokens(at, rt);
            // Echo token to UI so it can make direct bot-api requests (e.g., script upload)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'botApiTokenGranted', access_token: at }));
            }
            // Apply admin mode before broadcasting plugin state
            const prevAdmin = this.pluginManager.adminMode;
            this.pluginManager.adminMode = isAdmin;
            if (!isAdmin && prevAdmin) this.pluginManager.disableAdminGatedPlugins();
            if (!isAdmin) this.pluginManager.enforceNonAdminSettingCaps();
            // Fetch plugins from API (in-memory only — never on disk)
            const apiBase = this.getBotApiBase();
            if (apiBase) {
              this.pluginManager.loadFromApi(apiBase, at).then(() => {
                this.broadcastPluginState();
              }).catch(() => {});
            }
            this.botApiClient.checkGems().then((status) => {
              this.pluginManager.loginGateActive = true;
              this.pluginManager.setActivePlans(status.active_subs?.map(s => s.plan_name) ?? []);
              this.recordPlanTierFromStatus(status);
              this.broadcastGemStatus(status);
              this.broadcastPluginState();
            }).catch(() => {
              // Gem check failed but still allow session — don't force logout
              this.pluginManager.loginGateActive = true;
              this.broadcastPluginState();
            });
            // Token seeded → kick off telemetry heartbeats and record the
            // sign-in event. `method: token_seed` distinguishes a dashboard-
            // brokered login (most common) from a direct desktop login.
            this.eventTracker?.track('client_sign_in', { method: 'token_seed' });
          }
        } else if (msg.type === 'botApiLogin') {
          const email = String(msg.email ?? '').trim();
          const password = String(msg.password ?? '');
          this.botApiClient.login(email, password).then(async (status) => {
            const tok = this.botApiClient.getAccessToken();
            if (tok) {
              // Send token to UI so it can make direct bot-api requests (e.g., script upload)
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'botApiTokenGranted', access_token: tok }));
              }
              // Fetch plugins from API (in-memory only)
              const apiBase = this.getBotApiBase();
              if (apiBase) {
                await this.pluginManager.loadFromApi(apiBase, tok).catch(() => {});
              }
            }
            this.pluginManager.loginGateActive = true;
            this.pluginManager.setActivePlans(status.active_subs?.map(s => s.plan_name) ?? []);
            this.recordPlanTierFromStatus(status);
            this.broadcastGemStatus(status);
            this.broadcastPluginState();
            this.eventTracker?.track('client_sign_in', { method: 'direct' });
          }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'botApiError', error: (err as Error).message }));
            }
          });
        } else if (msg.type === 'botApiLogout') {
          // Fire the sign-out event BEFORE stopping the emitter — once we
          // call stop(), the tracker's flush queue is paused and the event
          // would never reach the server.
          this.eventTracker?.track('client_sign_out');
          this.botApiClient.logout();
          this.lastSeedToken = null;
          this.pluginManager.loginGateActive = false;
          this.pluginManager.setActivePlans([]);
          this.pluginManager.adminMode = false;
          this.pluginManager.enforceNonAdminSettingCaps();
          this.pluginManager.disableAllPlugins();
          this.currentPlanTier = 'free';
          this.lastKnownPlanTier = null;
          this.botApiSessionStartedAt = null;
          this.eventTracker?.stop();
          this.broadcastGemStatus(null);
          this.broadcastPluginState();
        } else if (msg.type === 'botApiStatus') {
          if (!this.botApiClient.loggedIn) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'gemStatus', loggedIn: false, gem_balance: 0, active: false, active_plans: [], next_deduction_at: null }));
            }
          } else {
            this.botApiClient.checkGems().then((status) => {
              this.pluginManager.loginGateActive = true;
              this.pluginManager.setActivePlans(status.active_subs?.map(s => s.plan_name) ?? []);
              this.recordPlanTierFromStatus(status);
              this.broadcastGemStatus(status);
              this.broadcastPluginState();
            }).catch(() => {
              this.pluginManager.loginGateActive = false;
              this.pluginManager.setActivePlans([]);
              this.pluginManager.disableAllPlugins();
              this.broadcastPluginState();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'gemStatus', loggedIn: false, gem_balance: 0, active: false, active_plans: [], next_deduction_at: null }));
              }
            });
          }
        } else if (msg.type === 'getBundles') {
          this.botApiClient.getBundles().then((bundles) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'bundles', bundles }));
            }
          }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'botApiError', error: (err as Error).message }));
            }
          });
        } else if (msg.type === 'buyGems') {
          const bundleId = String(msg.bundle_id ?? '');
          this.botApiClient.createStripeCheckout(bundleId).then((resp) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'stripeCheckout', checkout_url: resp.checkout_url, payment_id: resp.payment_id }));
            }
          }).catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'botApiError', error: (err as Error).message }));
            }
          });
        } else if (msg.type === 'getOwnedScripts') {
          if (!this.botApiClient.loggedIn) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ownedScripts', scripts: [] }));
            }
          } else {
            this.botApiClient.getOwnedScripts().then((scripts) => {
              if (ws.readyState === WebSocket.OPEN) {
                // Annotate each with whether it's cached (no re-fetch needed)
                const annotated = scripts.map((s) => ({
                  ...s,
                  cached: this.scriptHost?.isMarketplaceCached(s.script_id) ?? false,
                  running: this.scriptHost?.isRunning(s.script_id) ?? false,
                }));
                ws.send(JSON.stringify({ type: 'ownedScripts', scripts: annotated }));
              }
            }).catch((err) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'botApiError', error: (err as Error).message }));
              }
            });
          }
        } else if (msg.type === 'runMarketplaceScript') {
          const scriptId = String(msg.scriptId ?? '');
          const scriptName = String(msg.scriptName ?? scriptId);
          if (!scriptId || !this.scriptHost || !this.botApiClient.loggedIn) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'marketplaceScriptResult', scriptId, ok: false, error: 'Not logged in or script host unavailable' }));
            }
          } else if (this.connectedClients.size === 0) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'marketplaceScriptResult', scriptId, ok: false, error: 'Connect an account before starting scripts.' }));
            }
          } else {
            const hwid = getClientToken();
            const userId = extractUserIdFromJwt(this.botApiClient.getAccessToken() ?? '') ?? '';
            // Use cached module if available — skip server round-trip
            const needsFetch = !this.scriptHost.isMarketplaceCached(scriptId);
            (needsFetch
              ? this.botApiClient.getScriptRuntime(scriptId, hwid)
              : Promise.resolve(null)
            ).then(async (payload) => {
              const result = await this.scriptHost!.startMarketplace(scriptId, scriptName, payload, userId, hwid);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'marketplaceScriptResult', scriptId, ...result }));
              }
            }).catch((err) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'marketplaceScriptResult', scriptId, ok: false, error: (err as Error).message }));
              }
            });
          }
        } else if (msg.type === 'stopMarketplaceScript') {
          const scriptId = String(msg.scriptId ?? '');
          if (!scriptId || !this.scriptHost) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'marketplaceScriptResult', scriptId, ok: false, error: 'Script host unavailable' }));
            }
          } else {
            const result = this.scriptHost.stop(scriptId);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'marketplaceScriptResult', scriptId, ...result, stopped: true }));
            }
          }
        }
      } catch {}
    });

    ws.on('close', () => {
      unsub();
      this.headlessPacketSubscriptions.delete(ws);
      this.headlessViewerSubscriptions.delete(ws);
      this.syncViewerOtherProjectileTracking();
      Logger.log('DevServer', 'Dashboard client disconnected');
    });
  }

  private broadcastGemStatus(status: GemStatusResponse | null): void {
    const msg = JSON.stringify({
      type: 'gemStatus',
      loggedIn: this.botApiClient.loggedIn,
      gem_balance: status?.gem_balance ?? 0,
      active: status?.active ?? false,
      active_plans: Array.from(this.pluginManager.activePlans),
      next_deduction_at: status?.next_deduction_at ?? null,
    });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  broadcastPluginState(): void {
    const pluginData = JSON.stringify({
      type: 'plugins',
      data: this.pluginManager.getPlugins(),
    });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(pluginData);
      }
    }
  }

  broadcastDllMessage(_msg: any): void {
    // DLL bridge removed — no-op
  }

  setScriptHost(host: ScriptHost): void {
    this.scriptHost = host;
  }

  /** Mirrors GET /api/scripts over WebSocket so `activity` updates without polling */
  broadcastScriptsState(): void {
    const scripts = this.scriptHost?.list() ?? [];
    const dir = this.scriptHost?.getScriptsDir() ?? null;
    const msg = JSON.stringify({ type: 'scriptsState', scripts, dir });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  broadcastScriptLog(
    id: string,
    line: string,
    level: 'info' | 'warn' | 'error' = 'info',
  ): void {
    const msg = JSON.stringify({ type: 'scriptLog', id, line, level });
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /** Outbound panel state / patches from `Hive.ui.panel.*`. */
  broadcastScriptPanelMessage(msg: ScriptPanelOutboundMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /** Replays current panel state to one dashboard socket (used on reconnect). */
  sendScriptPanelSnapshots(ws: WebSocket): void {
    if (!this.scriptHost) return;
    for (const scriptId of this.scriptHost.panelScriptIds()) {
      const snap = this.scriptHost.getPanelSnapshot(scriptId);
      if (!snap) continue;
      const msg: ScriptPanelOutboundMessage = {
        type: 'scriptPanelState',
        scriptId,
        def: snap.def,
        isOpen: snap.isOpen,
      };
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }
  }
}
