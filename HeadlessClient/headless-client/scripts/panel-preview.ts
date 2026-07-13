import { Client } from '../src/client';
import { PluginManager } from '../src/plugin-manager';
import { startWebPanel } from '../src/web-panel';

const startedAt = Date.now();
let target: { x: number; y: number; threshold: number } | undefined = { x: 52, y: 41, threshold: 0.5 };
let pos = { x: 43.2, y: 36.8 };

const objects = [
  { objectId: 201, type: 0x0712, x: 48, y: 39, name: 'Medusa' },
  { objectId: 202, type: 0x0721, x: 38, y: 31, name: 'Ent Ancient' },
  { objectId: 203, type: 0x0704, x: 45, y: 43, name: 'Cube God' },
  { objectId: 301, type: 0x0700, x: 47, y: 34, name: 'Realm Portal' },
  { objectId: 401, type: 0x0504, x: 40, y: 40, name: 'Health Potion' },
  ...Array.from({ length: 42 }, (_, index) => ({
    objectId: 500 + index,
    type: 0x0900 + (index % 5),
    x: 30 + ((index * 7) % 29),
    y: 25 + ((index * 11) % 30),
    name: index % 7 === 0 ? `Scenery ${index}` : undefined,
  })),
];

const fake = {
  alias: 'preview-client',
  getLifecycleState: () => 'inWorld',
  getMapName: () => 'Realm of the Mad God',
  getServerHost: () => 'useast4.example.test',
  isInVault: () => false,
  getPosition: () => ({ ...pos, x: pos.x + 0.18 }),
  getServerPosition: () => ({ ...pos }),
  getTickInfo: () => ({ tickId: 4821, tickCount: 930, tickTimeMs: 200, msSinceTick: Date.now() % 200 }),
  getInventory: () => [2592, 2593, 2594, 2595, 2600, 2601, -1, -1, 2701, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
  getLastInvResult: () => ({
    ok: true, code: 0, at: new Date().toISOString(),
    from: { objectId: 100, slotId: 4, itemType: 2600 },
    to: { objectId: 100, slotId: 5, itemType: 2601 },
  }),
  getVaultContent: () => undefined,
  getReconnectTickets: () => [],
  getPlayer: () => ({ hasBackpack: true }),
  debugInfo: () => ({
    alias: 'preview-client', lifecycle: 'inWorld', host: 'useast4.example.test:2050', mapName: 'Realm of the Mad God',
    gameId: 1, connected: true, objectId: 100, petObjectId: 101, inVault: false, inQueue: false,
    stalled: false, stalledQueuedPackets: 0, stalledDroppedPackets: 0, movementTarget: target,
    movementDistance: target ? Math.hypot(target.x - pos.x, target.y - pos.y) : undefined,
    positionDrift: 0.18, tickId: 4821, tickCount: 930, tickTimeMs: 200,
    lastActivityAt: new Date().toISOString(), activityAgeMs: 42, connectAgeMs: Date.now() - startedAt,
    reconnectAttempts: 0, visibleObjects: objects.length, realmPortals: 1, class: 'Wizard', level: 20,
    hp: '685/770', mp: '252/252', hasBackpack: true,
    socket: { destroyed: false, connecting: false, localAddress: '127.0.0.1', localPort: 52140,
      remoteAddress: '203.0.113.10', remotePort: 2050, bytesRead: 1843200, bytesWritten: 382400 },
  }),
  visibleObjects: () => objects,
  realmPortals: () => [{ objectId: 301, type: 0x0700, x: 47, y: 34, name: 'Realm Portal', players: 26, maxPlayers: 85, openedAt: '12m' }],
  moveTo: (next: { x: number; y: number }) => { target = { ...next, threshold: 0.5 }; pos = { ...next }; },
  say: () => undefined,
  enterVault: () => undefined,
  escape: () => undefined,
  stallSocket: () => undefined,
  resumeSocket: () => undefined,
  isStalled: () => false,
} as unknown as Client;

const clients = new Map<string, Client>([[fake.alias, fake]]);
const panel = startWebPanel({ clients, getServers: () => [], plugins: new PluginManager() });
console.log('Preview data is synthetic; no account login or game connection is made.');

const close = (): void => { panel.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
