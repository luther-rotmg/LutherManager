import { EventEmitter } from 'events';
import {
  Client,
  ClientEvent,
  PacketType,
  getCharAndServers,
  login,
  proxyConfigToUrl,
  resolveClassType,
  type Account,
  type PacketTraffic,
  type ProxyConfig,
  type TextPacket,
  type TrackedObject,
  type TrackedTile,
} from 'headless-client';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import { HeadlessDamageTracker, type HeadlessDamageSnapshot } from './HeadlessDamageTracker.js';

export interface FleetAccount {
  id: string;
  email: string;
  password: string;
  label?: string;
  serverName?: string;
  proxy?: ProxyConfig;
}

export interface HeadlessSessionSummary {
  accountId: string;
  alias: string;
  email: string;
  serverName: string;
  lifecycle: string;
  connected: boolean;
  inWorld: boolean;
  mapName: string;
  objectId: number;
  playerName: string;
  position: { x: number; y: number };
  connectedAt: number;
  characterId: number;
  gameId: number;
  proxy: string;
}

export type HeadlessChatChannel = 'say' | 'tell' | 'party' | 'guild' | 'global' | 'system';

export interface HeadlessChatMessage {
  id: string;
  accountId: string;
  sender: string;
  recipient: string;
  message: string;
  channel: HeadlessChatChannel;
  timestamp: number;
  stars: number;
  isLocal: boolean;
  isSupporter: boolean;
  starBackground: number;
}

export interface HeadlessFleetEvents {
  changed: [sessions: HeadlessSessionSummary[]];
  damage: [accountId: string, snapshot: HeadlessDamageSnapshot];
  chat: [accountId: string, message: HeadlessChatMessage];
  packet: [accountId: string, traffic: PacketTraffic];
}

interface FleetEntry {
  account: FleetAccount;
  client: Client;
  serverName: string;
  stopping: boolean;
  connectedAt: number;
  damage: HeadlessDamageTracker;
}

export class HeadlessFleet extends EventEmitter {
  private readonly entries = new Map<string, FleetEntry>();
  private readonly pending = new Map<string, Promise<Client>>();
  private changedTimer: NodeJS.Timeout | undefined;
  private chatSequence = 0;

  constructor(private readonly gameData: GameDataLoader) {
    super();
  }

  override on<E extends keyof HeadlessFleetEvents>(event: E, listener: (...args: HeadlessFleetEvents[E]) => void): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  get size(): number {
    return this.entries.size;
  }

  get(accountId?: string | null): Client | undefined {
    if (accountId) return this.entries.get(String(accountId))?.client;
    return this.entries.values().next().value?.client;
  }

  accountIdForClient(client: Client): string | undefined {
    for (const [accountId, entry] of this.entries) {
      if (entry.client === client) return accountId;
    }
    return undefined;
  }

  list(): HeadlessSessionSummary[] {
    return Array.from(this.entries, ([accountId, entry]) => {
      const player = entry.client.getPlayer();
      return {
        accountId,
        alias: entry.client.alias,
        email: entry.account.email,
        serverName: entry.serverName,
        lifecycle: String(entry.client.getLifecycleState()),
        connected: entry.client.isConnected(),
        inWorld: entry.client.isInWorld(),
        mapName: entry.client.getMapName(),
        objectId: entry.client.getObjectId(),
        playerName: player?.name ?? '',
        position: entry.client.getPosition(),
        connectedAt: entry.connectedAt,
        characterId: entry.client.getCharacterId(),
        gameId: entry.client.getGameId(),
        proxy: entry.account.proxy ? proxyConfigToUrl(entry.account.proxy, false) : '',
      };
    });
  }

  async connect(account: FleetAccount): Promise<Client> {
    const accountId = String(account.id || '').trim();
    if (!accountId) throw new Error('Account id is required.');
    const existing = this.entries.get(accountId)?.client;
    if (existing) return existing;
    const inFlight = this.pending.get(accountId);
    if (inFlight) return inFlight;

    const task = this.createClient(account).finally(() => this.pending.delete(accountId));
    this.pending.set(accountId, task);
    return task;
  }

  disconnect(accountId: string, reason = 'manager disconnect'): boolean {
    const entry = this.entries.get(String(accountId));
    if (!entry) return false;
    entry.stopping = true;
    this.entries.delete(String(accountId));
    entry.client.stop(reason);
    this.emitChanged();
    return true;
  }

  disconnectAll(reason = 'manager shutdown'): void {
    for (const accountId of Array.from(this.entries.keys())) this.disconnect(accountId, reason);
  }

  visibleObjects(accountId?: string | null): TrackedObject[] {
    return this.get(accountId)?.visibleObjects() ?? [];
  }

  visibleTiles(accountId?: string | null): TrackedTile[] {
    return this.get(accountId)?.visibleTiles() ?? [];
  }

  damage(accountId?: string | null): HeadlessDamageSnapshot | null {
    const entry = accountId ? this.entries.get(String(accountId)) : this.entries.values().next().value;
    return entry?.damage.snapshot() ?? null;
  }

  private async createClient(account: FleetAccount): Promise<Client> {
    const authAccount: Account = {
      guid: account.email,
      password: account.password,
      alias: account.label || account.email,
    };
    const requestOptions = account.proxy ? { proxy: account.proxy } : undefined;
    const { accessToken, clientToken } = await login(authAccount, requestOptions);
    const { char, servers } = await getCharAndServers(accessToken, requestOptions);
    const preferred = servers.find((server) => server.name.toLowerCase() === String(account.serverName || '').toLowerCase());
    const server = preferred ?? servers[0];
    if (!server) throw new Error('No game servers were returned for this account.');

    const client = new Client({
      alias: account.label || account.email,
      accessToken,
      clientToken,
      charId: char.charId,
      needsNewChar: char.needsNewChar,
      host: server.address,
      proxy: account.proxy,
      servers,
      combatData: this.gameData,
      createClassType: resolveClassType(),
      refreshCredentials: () => login(authAccount, requestOptions),
    });
    const damage = new HeadlessDamageTracker(client, this.gameData);
    const entry: FleetEntry = { account, client, serverName: server.name, stopping: false, connectedAt: Date.now(), damage };
    this.entries.set(account.id, entry);
    damage.on('changed', (snapshot: HeadlessDamageSnapshot) => this.emit('damage', account.id, snapshot));
    client.on(ClientEvent.PacketTraffic, (traffic) => this.emit('packet', account.id, traffic));
    client.onPacket<TextPacket>(PacketType.TEXT, (packet) => {
      const message = String(packet.cleanText || packet.text || '').trim();
      if (!message) return;
      const sender = String(packet.name || 'System');
      const self = client.getPlayer()?.name ?? '';
      const chat: HeadlessChatMessage = {
        id: `${Date.now()}-${++this.chatSequence}`,
        accountId: account.id,
        sender,
        recipient: String(packet.recipient || ''),
        message,
        channel: this.classifyChat(packet, client),
        timestamp: Date.now(),
        stars: Number(packet.numStars || 0),
        isLocal: !!self && sender.toLowerCase() === self.toLowerCase(),
        isSupporter: !!packet.isSupporter,
        starBackground: Number(packet.starBackground || 0),
      };
      this.emit('chat', account.id, chat);
    }, { priority: 20_000 });

    const changed = () => this.scheduleChanged();
    client.on(ClientEvent.Connected, changed);
    client.on(ClientEvent.Ready, changed);
    client.on(ClientEvent.MapChange, changed);
    client.on(ClientEvent.Tick, changed);
    client.on(ClientEvent.Disconnect, () => {
      if (!entry.stopping) changed();
    });
    client.connect();
    this.emitChanged();
    return client;
  }

  private classifyChat(packet: TextPacket, client: Client): HeadlessChatChannel {
    const text = String(packet.text ?? '');
    const name = String(packet.name ?? '');
    const recipient = String(packet.recipient ?? '');
    const self = client.getPlayer()?.name ?? '';
    if (recipient && self && recipient.toLowerCase() === self.toLowerCase() && name.toLowerCase() !== self.toLowerCase()) return 'tell';
    if (text.startsWith('Party>') || name.toLowerCase().includes('party')) return 'party';
    if (text.startsWith('Guild>') || name.toLowerCase().includes('guild')) return 'guild';
    if (text.startsWith('Tell>') || text.startsWith('[Tell]')) return 'tell';
    if (/\[.*global.*\]/i.test(text)) return 'global';
    if (packet.numStars === 65535 || packet.objectId <= 0 || name === '*' || name === '#') return 'system';
    return 'say';
  }

  private emitChanged(): void {
    this.emit('changed', this.list());
  }

  private scheduleChanged(): void {
    if (this.changedTimer) return;
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined;
      this.emitChanged();
    }, 250);
    this.changedTimer.unref();
  }
}
