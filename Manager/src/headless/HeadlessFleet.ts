import { EventEmitter } from 'events';
import {
  Client,
  ClientEvent,
  getCharAndServers,
  login,
  resolveClassType,
  type Account,
  type TrackedObject,
  type TrackedTile,
} from 'headless-client';

export interface FleetAccount {
  id: string;
  email: string;
  password: string;
  label?: string;
  serverName?: string;
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
}

export interface HeadlessFleetEvents {
  changed: [sessions: HeadlessSessionSummary[]];
}

interface FleetEntry {
  account: FleetAccount;
  client: Client;
  serverName: string;
  stopping: boolean;
  connectedAt: number;
}

export class HeadlessFleet extends EventEmitter {
  private readonly entries = new Map<string, FleetEntry>();
  private readonly pending = new Map<string, Promise<Client>>();
  private changedTimer: NodeJS.Timeout | undefined;

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

  private async createClient(account: FleetAccount): Promise<Client> {
    const authAccount: Account = {
      guid: account.email,
      password: account.password,
      alias: account.label || account.email,
    };
    const { accessToken, clientToken } = await login(authAccount);
    const { char, servers } = await getCharAndServers(accessToken);
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
      servers,
      createClassType: resolveClassType(),
      refreshCredentials: () => login(authAccount),
    });
    const entry: FleetEntry = { account, client, serverName: server.name, stopping: false, connectedAt: Date.now() };
    this.entries.set(account.id, entry);

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
