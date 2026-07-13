// ── Crash tracer ──────────────────────────────────────────────────────────────
import { appendFileSync as _crashAppend } from 'fs';
import { join as _crashJoin } from 'path';
import { tmpdir as _crashTmpdir } from 'os';
const _CRASH_LOG_PATH = _crashJoin(_crashTmpdir(), 'hive-proxy.log');
function _logCrash(tag: string, err: unknown): void {
  const ts = new Date().toISOString().slice(11, 23);
  const e = err instanceof Error ? err : new Error(String(err));
  const line = `[${ts}] [CRASH] ${tag}: ${e.message}\n${e.stack ?? ''}\n`;
  try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
  try { console.error(line); } catch {}
}
process.on('uncaughtException', (err) => _logCrash('uncaughtException', err));
process.on('unhandledRejection', (reason) => _logCrash('unhandledRejection', reason));
process.on('exit', (code) => {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] [EXIT] process.on('exit') code=${code}\n`;
  try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK', 'SIGABRT'] as const) {
  try {
    process.on(sig as NodeJS.Signals, () => {
      const ts = new Date().toISOString().slice(11, 23);
      const line = `[${ts}] [EXIT] received signal ${sig}\n`;
      try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
    });
  } catch {}
}
if (process.send) {
  process.on('disconnect', () => {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] [EXIT] IPC channel disconnected from parent\n`;
    try { _crashAppend(_CRASH_LOG_PATH, line); } catch {}
  });
}
// ──────────────────────────────────────────────────────────────────────────────

import { AntiHook } from './security/AntiHook.js';
AntiHook.captureBaseline();

import { resolve, dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { Proxy } from './proxy/Proxy.js';
import { PacketFactory } from './packets/PacketFactory.js';
import { ReconnectHandler } from './proxy/ReconnectHandler.js';
import { attachCoreCommands } from './core/CoreCommands.js';
import { StateManager } from './state/StateManager.js';
import { PartyRosterState } from './state/PartyRosterState.js';
import { ScriptHost } from './scripts/ScriptHost.js';
import type { BridgeClientRef } from './scripts/bridge/BridgeDeps.js';
import { GameWorldState } from './state/GameWorldState.js';
import { ProjectileTracker } from './state/ProjectileTracker.js';
import { GameDataLoader } from './game-data/GameDataLoader.js';
import { PluginManager } from './plugins/PluginManager.js';
import { PacketInspector } from './dev/server/PacketInspector.js';
import { DevServer } from './dev/server/DevServer.js';
import { Logger } from './util/Logger.js';
import { ensureRotmgMetadataXml } from './util/ensureRotmgMetadataXml.js';
import { ensureSdkDeployed } from './util/ensureSdkDeployed.js';
import { HeadlessFleet } from './headless/HeadlessFleet.js';
import { AntiTamper } from './security/AntiTamper.js';
import { getBakedPacketDefinitions, getBakedServers, getBakedStatTypes } from './config/BakedData.js';
import {
  getClientConfigWritePath,
  getUserClientConfigPath,
} from './util/clientConfigStore.js';

const IS_PROD = process.env.HIVE_PROD === '1';
const ROOT = process.env.HIVE_ROOT
  ? resolve(process.env.HIVE_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_ROOT = process.env.HIVE_APP_ROOT
  ? resolve(process.env.HIVE_APP_ROOT)
  : ROOT;

const DATA_CONFIG_PATH = resolve(ROOT, 'data', 'config.json');

async function main() {
  const devMode = process.argv.includes('--dev') || true;

  Logger.log('Main', 'Hive Manager starting...');

  AntiTamper.initialize(ROOT, IS_PROD);

  const configWritePath = getClientConfigWritePath(ROOT);
  const userOverlayPath = getUserClientConfigPath();
  Logger.log(
    'Main',
    `config write: ${configWritePath}${userOverlayPath ? ` (overlay merges on ${userOverlayPath})` : ''}; bundled defaults: ${DATA_CONFIG_PATH}`,
  );

  const bakedPacketDefinitions = getBakedPacketDefinitions();
  const bakedStatTypes = getBakedStatTypes();
  const defsPath = resolve(ROOT, 'data', 'packet-definitions.json');
  const statTypesPath = resolve(ROOT, 'data', 'stat-types.json');
  const packetFactory = new PacketFactory(
    bakedPacketDefinitions ?? defsPath,
    bakedStatTypes ?? statTypesPath,
  );

  const proxy = new Proxy(packetFactory);
  const dataDir = resolve(ROOT, 'data');

  const objectsPath = resolve(ROOT, 'data', 'objects.xml');
  const tilesPath = resolve(ROOT, 'data', 'tiles.xml');
  const gameData = new GameDataLoader();
  try {
    gameData.load(objectsPath);
  } catch (err) {
    Logger.warn('Main', `Failed to load objects.xml: ${(err as Error).message}`);
  }
  gameData.loadTiles(tilesPath);

  const stateManager = new StateManager();
  stateManager.attach(proxy);

  const worldState = new GameWorldState();
  worldState.attach(proxy);

  const projectileTracker = new ProjectileTracker(gameData, worldState);
  projectileTracker.attach(proxy);

  const partyRoster = new PartyRosterState();
  partyRoster.attach(proxy);

  const reconnectHandler = new ReconnectHandler();
  reconnectHandler.attach(proxy);

  attachCoreCommands(proxy, dataDir, getBakedServers());

  if (Logger.isPacketDebugEnabled()) {
    proxy.on('serverPacket', (_client: any, packet: any) => {
      if (!['NEWTICK', 'PING', 'UNKNOWN_11'].includes(packet.name) && !packet.name.startsWith('UNKNOWN_')) {
        Logger.log('Debug', `S->C: ${packet.name} (id=${packet.id}, size=${packet.rawBytes.length}, defined=${packet.isDefined})`);
      }
      if (packet.name.startsWith('UNKNOWN_')) {
        Logger.log('Debug', `S->C: ${packet.name} (size=${packet.rawBytes.length})`);
      }
    });
    proxy.on('clientPacket', (_client: any, packet: any) => {
      if (!['MOVE'].includes(packet.name)) {
        Logger.log('Debug', `C->S: ${packet.name} (id=${packet.id}, size=${packet.rawBytes.length}, defined=${packet.isDefined})`);
      }
    });
  }

  // Plugins removed — stub keeps DevServer APIs compiling.
  const pluginManager = new PluginManager(proxy);
  const headlessFleet = new HeadlessFleet();

  let devServer: DevServer | undefined;
  let scriptHost: ScriptHost | undefined;
  if (devMode) {
    const inspector = new PacketInspector();
    inspector.attach(proxy);

    const bridgeClientRef: BridgeClientRef = { current: undefined };
    const publicDir = resolve(ROOT, 'src', 'dev', 'public');
    devServer = new DevServer(inspector, pluginManager, publicDir, worldState, gameData, headlessFleet);
    devServer.setBridgeClientRef(bridgeClientRef);
    devServer.attachProxy(proxy);

    const scriptSession = { scriptId: undefined as string | undefined };
    scriptHost = new ScriptHost(scriptSession);
    scriptHost.onLog((id, line, level) => {
      devServer?.broadcastScriptLog(id, line, level);
    });
    devServer.setScriptHost(scriptHost);
    scriptHost.installBridge({
      getHeadlessClient: () => headlessFleet.get(),
      stateManager,
      clientRef: bridgeClientRef,
      worldState,
      getWorldStateForClient: () => worldState,
      partyRoster,
      gameData,
      proxy,
      scriptSession,
      emitScriptLog: (scriptId, line, level) => {
        devServer?.broadcastScriptLog(scriptId, line, level);
      },
      emitScriptPanelMessage: (msg) => {
        devServer?.broadcastScriptPanelMessage(msg);
      },
    });
    ensureSdkDeployed();
    scriptHost.setScriptsStateNotify(() => {
      devServer?.broadcastScriptsState();
    });
    devServer.start(4440);
  }

  const [metadataResult] = await Promise.all([
    ensureRotmgMetadataXml(dataDir, {
      log(level, message) {
        if (level === 'error') Logger.error('Metadata', message);
        else if (level === 'warn') Logger.warn('Metadata', message);
        else Logger.log('Metadata', message);
      },
    }),
    Promise.resolve(),
  ]);
  if (!metadataResult.ok) {
    Logger.warn(
      'Main',
      `Missing metadata XML (${metadataResult.failed.join(', ')}). Set ROTMG_XML_BASE or run: npm run download-game-xml`,
    );
  }

  // MITM TCP listener (:2050) removed — headless clients will feed the SDK directly.
  Logger.log('Main', 'MITM game proxy disabled (no :2050 listener)');
  if (devMode) {
    Logger.log('Main', 'Dev dashboard: http://localhost:4440');
  }

  AntiTamper.startMonitoring(30_000);

  const shutdown = async () => {
    Logger.log('Main', 'Shutting down...');
    AntiTamper.stopMonitoring();
    scriptHost?.stopAll();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  Logger.error('Main', 'Fatal error', err);
  process.exit(1);
});
