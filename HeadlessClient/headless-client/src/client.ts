import * as net from 'net';
import { EventEmitter } from 'events';
import {
  Packet,
  DeathPacket,
  PacketIO,
  PacketType,
  HelloPacket,
  LoadPacket,
  CreatePacket,
  MovePacket,
  MoveRecord,
  PongPacket,
  UpdateAckPacket,
  GotoAckPacket,
  ShootAckPacket,
  MapInfoPacket,
  UpdatePacket,
  NewTickPacket,
  PingPacket,
  FailurePacket,
  ReconnectPacket,
  ServerPlayerShootPacket,
  PlayerShootPacket,
  EnemyShootPacket,
  AoePacket,
  AoeAckPacket,
  GroundDamagePacket,
  DamagePacket,
  CreateSuccessPacket,
  QueueInfoPacket,
  ChangeAllyShootPacket,
  VaultContentPacket,
  EscapePacket,
  InvResultPacket,
  StatData,
  ObjectData,
  ObjectStatusData,
  StatType,
  RawPacket,
  RawOutgoingPacket,
  PlayerData,
  Classes,
  FailureCode,
  ProtocolError,
  processObject,
  processObjectStatus,
  parsePlayerClass,
  hexdump,
  PortalType,
  GotoPacket,
  SlotObjectData,
  ConvertSeasonalCharacterPacket,
  inventorySlotIndex,
  ConditionEffectBits,
  ConditionEffectBits2,
} from 'realmlib';
import { deleteCharacter as deleteCharacterRequest } from './account-service';
import {
  AutoCombatController,
  type AutoAbilityOptions,
  type AutoAimMode,
  type AutoAimOptions,
  type AutoCombatState,
} from './auto-combat';
import {
  AutoNexusMonitor,
  calculateAutoNexusDamage,
  isAutoNexusSafeMap,
  type AutoNexusConfig,
  type AutoNexusState,
  type AutoNexusTrigger,
  type AutoNexusTriggerSource,
} from './auto-nexus';
import { ClientLifecycle, ClientLifecycleState } from './client-lifecycle';
import { CommandSender, type SlotRef } from './command-sender';
import { CombatTracker } from './combat-tracker';
import { BUILD_VERSION, GAME_ID, GAME_PORT, HELLO_TOKEN } from './constants';
import { config } from './config';
import { ClientEvent } from './events';
import { ExplorativePathfinder } from './explorative-pathfinder';
import { MovementController } from './movement-controller';
import { RealmPortal, ClientOptions, ClientServer, TrackedObject, TrackedTile } from './models';
import { PortalTracker } from './portal-tracker';
import { connectThroughProxy, proxyConfigToUrl } from './proxy';
import { TimerBag, TimerHandle } from './timer-bag';
export type { SlotRef } from './command-sender';
export { Classes as ClassType } from 'realmlib';

/** Known storage object types. Runtime object ids still come from map state. */
export const VAULT_CHEST_OBJECT_TYPE = 1284;
export const POTION_VAULT_OBJECT_TYPE = 1859;
export const MAIN_INVENTORY_SLOT_IDS = [4, 5, 6, 7, 8, 9, 10, 11] as const;
export const BACKPACK_SLOT_IDS = [12, 13, 14, 15, 16, 17, 18, 19] as const;

enum AoeEffectId {
  Quiet = 2,
  Weak = 3,
  Slowed = 4,
  Sick = 5,
  Dazed = 6,
  Stunned = 7,
  Blind = 8,
  Hallucinating = 9,
  Drunk = 10,
  Confused = 11,
  StunImmune = 12,
  Invisible = 13,
  Paralyzed = 14,
  Speedy = 15,
  Bleeding = 16,
  Stasis = 22,
  StasisImmune = 23,
  ArmorBroken = 27,
  Hexed = 28,
  NinjaSpeedy = 29,
  Unstable = 30,
  Darkness = 31,
  Petrified = 35,
  PetrifiedImmune = 36,
  Curse = 38,
  Silenced = 48,
}

/** Effects ProdMafia applies locally from AOE before the authoritative NEWTICK. */
const LOCALLY_APPLIED_AOE_EFFECTS = new Set<number>(Object.values(AoeEffectId).filter(
  (value): value is number => typeof value === 'number',
));

export interface PacketTraffic {
  direction: 'incoming' | 'outgoing';
  id: number;
  type?: PacketType;
  size: number;
  payload: Buffer;
  timestamp: number;
}

export interface ClientShotFiredEvent {
  bulletId: number;
  weaponType: number;
  attackIndex: number;
  angle: number;
}

export interface ClientDamageTakenEvent {
  amount: number;
  source: AutoNexusTriggerSource;
  hp: number | null;
  maxHp: number | null;
  ownerId?: number;
  bulletId?: number;
}

export type ItemContainer =
  | 'inventory'
  | 'petBag'
  | 'vault'
  | 'materialVault'
  | 'giftChest'
  | 'potionVault'
  | 'spoilsChest';

/** A slot in a logical item container. Omit itemType when client state can infer it. */
export interface ContainerSlotRef {
  container: ItemContainer;
  slotId: number;
  itemType?: number;
}

/**
 * Typed payloads for each {@link ClientEvent}, so `client.on(event, listener)`
 * infers the listener arguments instead of falling back to EventEmitter's `any[]`.
 */
export interface ClientEventMap {
  [ClientEvent.PacketTraffic]: [traffic: PacketTraffic];
  [ClientEvent.Connected]: [];
  [ClientEvent.Ready]: [objectId: number];
  [ClientEvent.MapChange]: [mapName: string];
  [ClientEvent.EnterVault]: [];
  [ClientEvent.EnterPetYard]: [];
  [ClientEvent.EnterNexus]: [];
  [ClientEvent.VaultContents]: [packet: VaultContentPacket];
  [ClientEvent.InventoryResult]: [packet: InvResultPacket];
  [ClientEvent.RealmPortal]: [portal: RealmPortal];
  [ClientEvent.Tick]: [player: PlayerData | undefined];
  [ClientEvent.Death]: [packet: DeathPacket];
  [ClientEvent.Failure]: [packet: FailurePacket];
  [ClientEvent.Disconnect]: [];
  [ClientEvent.ReachedTarget]: [target: { x: number; y: number }];
  [ClientEvent.AutoNexus]: [trigger: AutoNexusTrigger];
  [ClientEvent.ShotFired]: [event: ClientShotFiredEvent];
  [ClientEvent.DamageTaken]: [event: ClientDamageTakenEvent];
}

/** Context passed to packet hooks so one plugin can stop later hooks. */
export interface PacketContext {
  readonly type: PacketType;
  readonly packet: Packet;
  readonly cancelled: boolean;
  cancel(reason?: string): void;
  cancelReason?: string;
}

interface MutablePacketContext extends PacketContext {
  cancelled: boolean;
  cancelReason?: string;
}

interface PacketHandlerEntry {
  handler: (packet: Packet, ctx: PacketContext) => void;
  priority: number;
  order: number;
}

/**
 * A headless client for one account. Logs in, runs the keep-alive loop, and
 * acts as the event surface plugins hook into: it re-emits incoming packets by
 * PacketType and emits higher-level game events ('ready', 'enterVault', …).
 */
export class Client extends EventEmitter {
  private socket!: net.Socket;
  private io!: PacketIO;
  private readonly lifecycle = new ClientLifecycle();
  private readonly timers = new TimerBag();
  private readonly movement = new MovementController();
  private readonly pathfinder: ExplorativePathfinder;
  private readonly portalTracker = new PortalTracker();
  private readonly autoNexus: AutoNexusMonitor;
  private readonly combat: CombatTracker | undefined;
  private readonly autoCombat: AutoCombatController | undefined;
  private readonly commands = new CommandSender(() => ({
    io: this.io,
    time: this.time(),
    // Gameplay commands must originate where the server last placed us. Local
    // dead reckoning can be ahead when movement stalls or crosses a map portal.
    pos: this.serverPos ?? this.pos,
    objectId: this.objectId,
    player: this.player,
    nextBulletId: () => this.nextBulletId++ % 128,
    weapon: (weaponType: number) => {
      const def = this.opts.combatData?.getObject(weaponType);
      return {
        rateOfFire: def?.rateOfFire ?? 1,
        numProjectiles: def?.numProjectiles ?? 1,
        arcGap: def?.arcGap ?? 11.25,
        subattacks: def?.subattacks,
      };
    },
    ability: (abilityType: number) => {
      const def = this.opts.combatData?.getObject(abilityType);
      return {
        usable: def?.usable ?? true,
        mpCost: def?.mpCost ?? 0,
        cooldownMs: Math.max(550, def?.cooldownMs ?? 0),
        activateEffects: def?.activateEffects ?? [],
      };
    },
    trackShot: (shot: PlayerShootPacket, projectileId: number) => {
      this.combat?.trackPlayerShoot(
        this.objectId,
        shot,
        shot.time,
        projectileId,
        this.player?.projSpeedMult,
        this.player?.projLifeMult,
      );
      this.emit(ClientEvent.ShotFired, {
        bulletId: shot.bulletId,
        weaponType: shot.containerType,
        attackIndex: shot.attackIndex,
        angle: shot.angle,
      });
    },
  }));

  /** Packet types any plugin has hooked; bridged onto each fresh io. */
  private readonly subscribedPacketTypes = new Set<PacketType>();
  private readonly bridgedPacketTypes = new Set<PacketType>();
  private readonly packetHandlers = new Map<PacketType, PacketHandlerEntry[]>();
  private packetHandlerOrder = 0;

  // Current server / map state
  private host: string;
  private port = GAME_PORT;
  /** Last confirmed regional Nexus endpoint, retained while realm reconnects change host/port. */
  private nexusHost: string;
  private nexusPort = GAME_PORT;
  private gameId = GAME_ID.NEXUS;
  private key: number[] = [];
  private keyTime = -1;
  private readonly reconnectTickets = new Map<number, ReconnectTicket>();
  private nextReconnectTicketId = 1;

  // Current player state
  private objectId = -1;
  /** Map-scoped active-pet object id (PET_OBJECT_ID); retained for older plugins. */
  private petObjectId = -1;
  /** Active pet instance/container id (PET_INSTANCEID_STAT), used for pet-bag INVSWAPs. */
  private petInstanceId = -1;
  private seasonal: boolean | undefined;
  private pos = { x: 0, y: 0 };
  private posKnown = false;
  /** Latest authoritative self-position the server reported via NewTick. Drives movement so we never outrun the server. */
  private serverPos: { x: number; y: number } | undefined;
  /** Gameplay-clock epoch. It intentionally survives every socket/map reconnect. */
  private connectStart = Date.now();
  private lastFrameTime = 0;
  private lastGroundDamageAt = 0;
  private tickCount = 0;
  /** Tick id from the most recent NewTick, and the server-reported ms between the last two ticks. */
  private lastTickId = -1;
  private lastTickTime = 0;
  private readonly seenUnknown = new Set<number>();
  private player: PlayerData | undefined;
  private inQueue = false;
  private mapName = 'Unknown';
  private mapWidth = 0;
  private mapHeight = 0;
  private lastInvResult: InvResultSnapshot | undefined;
  private lastVaultContent: VaultContentSnapshot | undefined;
  /** Latest slot contents learned from successful INVRESULTs, keyed by container object id. */
  private readonly containerSlotItems = new Map<number, Map<number, number>>();
  private nextBulletId = 1;
  private stalled = false;
  private stalledAt = 0;
  private stallResumeTimer: TimerHandle | undefined;
  private stallUntil: number | undefined;
  /** Outgoing packets captured while stalled, flushed in order on resume (mimics a TCP send buffer). */
  private readonly stallQueue: Packet[] = [];
  private stallQueueDropped = 0;
  private stallRawSend: ((packet: Packet) => void) | undefined;

  // Navigation / vault state
  private wantVault = false;
  private readonly objects = new Map<number, TrackedObject>();
  private readonly tiles = new Map<string, TrackedTile>();
  private readonly recentObjectTypes = new Map<number, number>();
  private readonly predictedPlayerDamage = new Map<string, number>();
  private vaultPortalId: number | undefined;
  private enteringVault = false;
  private inVault = false;
  private dumped = false;
  private lastUsePortalTick = -100;
  private usePortalAttempts = 0;
  private reconnectTimer: TimerHandle | undefined;

  // Navigation to a non-vault portal (pet yard, guild hall, daily quest room).
  // The vault has its own bespoke path above (VAULT_CONTENT / inVault); this
  // generic one just walks to a portal of a given type and uses it.
  private pendingPortal: PendingPortalNav | undefined;

  // Reconnect / liveness supervision
  /** Current access token; refreshed from opts.refreshCredentials on each (re)connect. */
  private accessToken: string;
  /** Current client (user) token; refreshed alongside the access token. */
  private clientToken: string;
  /** Consecutive unexpected-drop reconnect attempts; drives the backoff ramp, reset once in-world. */
  private reconnectAttempts = 0;
  /** Latched on a fatal, non-recoverable failure so we stop auto-reconnecting until a manual connect. */
  private giveUp = false;
  private watchdogTimer: TimerHandle | undefined;
  private combatTimer: TimerHandle | undefined;
  /** Wall-clock of the last byte/packet received from the server; drives the liveness watchdog. */
  private lastActivityAt = 0;
  /** Wall-clock at which the current connect attempt began; drives the handshake timeout. */
  private connectStartedAt = 0;

  /** Creates a client bound to one authenticated account and starting server. */
  constructor(private readonly opts: ClientOptions) {
    super();
    this.setMaxListeners(config.maxEventListeners);
    this.host = opts.host;
    this.nexusHost = opts.host;
    this.accessToken = opts.accessToken;
    this.clientToken = opts.clientToken;
    this.wantVault = opts.autoEnterVault ?? config.autoEnterVault;
    this.pathfinder = new ExplorativePathfinder(opts.combatData);
    this.autoNexus = new AutoNexusMonitor((trigger) => {
      console.warn(
        `${this.tag} autonexus at ${trigger.hp}/${trigger.maxHp} HP ` +
          `(${trigger.thresholdPercent}% threshold, ${trigger.source})`,
      );
      this.emit(ClientEvent.AutoNexus, trigger);
      this.nexusImmediately('autonexus');
    });
    this.combat = opts.combatData
      ? new CombatTracker(
          opts.combatData,
          (packet) => this.io.send(packet),
          (hit) => this.applyPredictedDamage(
            hit.damage,
            !!hit.projectile.armorPiercing,
            'projectile',
            { ownerId: hit.ownerId, bulletId: hit.bulletId },
          ),
        )
      : undefined;
    this.autoCombat = opts.combatData ? new AutoCombatController(opts.combatData) : undefined;
  }

  //#region typed event surface

  // Typed overloads for the client's game events (see ClientEventMap). A string
  // fallback overload keeps the generic EventEmitter API (used by PluginManager)
  // working. Runtime behavior is unchanged — these only sharpen the types.

  on<E extends keyof ClientEventMap>(event: E, listener: (...args: ClientEventMap[E]) => void): this;
  on(event: string | symbol, listener: (...args: never[]) => void): this;
  on(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<E extends keyof ClientEventMap>(event: E, listener: (...args: ClientEventMap[E]) => void): this;
  once(event: string | symbol, listener: (...args: never[]) => void): this;
  once(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof ClientEventMap>(event: E, listener: (...args: ClientEventMap[E]) => void): this;
  off(event: string | symbol, listener: (...args: never[]) => void): this;
  off(event: string | symbol, listener: (...args: never[]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof ClientEventMap>(event: E, ...args: ClientEventMap[E]): boolean;
  emit(event: string | symbol, ...args: never[]): boolean;
  emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  //#endregion

  //#region plugin-facing surface

  /**
   * Hooks an incoming packet type. Higher priority handlers run first and can
   * cancel later packet hooks through PacketContext.
   */
  onPacket<T extends Packet>(
    type: PacketType,
    handler: (packet: T, ctx: PacketContext) => void,
    options: { priority?: number } = {},
  ): this {
    if (!this.subscribedPacketTypes.has(type)) {
      this.subscribedPacketTypes.add(type);
      // Bridge io -> this for the type if already connected; otherwise
      // registerHandlers() will bridge it on (re)connect.
      this.bridgePacket(type);
    }
    const handlers = this.packetHandlers.get(type) ?? [];
    handlers.push({
      handler: handler as (packet: Packet, ctx: PacketContext) => void,
      priority: options.priority ?? 0,
      order: this.packetHandlerOrder++,
    });
    handlers.sort((a, b) => b.priority - a.priority || a.order - b.order);
    this.packetHandlers.set(type, handlers);
    return this;
  }

  /** Removes a packet hook registered with onPacket. */
  offPacket<T extends Packet>(type: PacketType, handler: (packet: T, ctx: PacketContext) => void): this {
    const handlers = this.packetHandlers.get(type);
    if (!handlers) {
      return this;
    }
    const remaining = handlers.filter((entry) => entry.handler !== handler);
    if (remaining.length === 0) {
      this.packetHandlers.delete(type);
      this.subscribedPacketTypes.delete(type);
    } else {
      this.packetHandlers.set(type, remaining);
    }
    return this;
  }

  /** Sends a packet to the server. */
  send(packet: Packet): void {
    this.commands.send(packet);
  }

  /** Sends a chat message as this player (PLAYERTEXT). */
  say(message: string): void {
    this.commands.say(message);
  }

  /** Walks directly toward a position without pathfinding. */
  moveTo(target: { x: number; y: number }, arriveThreshold = config.arriveThreshold): boolean {
    if (!validMoveTarget(target, arriveThreshold)) {
      return false;
    }
    this.pathfinder.clearTarget();
    this.movement.setTarget(target, arriveThreshold);
    return true;
  }

  /** Optimistically pathfinds toward a position using streamed map knowledge. */
  pathfindingWalkTo(target: { x: number; y: number }, arriveThreshold = config.arriveThreshold): boolean {
    if (!this.pathfinder.setTarget(target, arriveThreshold)) {
      return false;
    }
    this.movement.clear();
    return true;
  }

  stopMoving(): void {
    this.pathfinder.clearTarget();
    this.movement.clear();
  }

  isMoving(): boolean {
    return this.pathfinder.hasTarget() || this.movement.hasTarget();
  }

  getNavigationPath(): Array<{ x: number; y: number }> {
    return this.pathfinder.getRemainingPath();
  }

  /** Short account label used in logs and console commands. */
  get alias(): string {
    return this.opts.alias;
  }

  /** Latest parsed player stats, if the player has appeared in an update. */
  getPlayer(): PlayerData | undefined {
    return this.player;
  }

  /** Updates autonexus settings for this account. Autonexus defaults to off. */
  configureAutoNexus(options: Partial<AutoNexusConfig>): AutoNexusState {
    this.autoNexus.configure(options);
    return this.autoNexus.getState();
  }

  /** Enables or disables autonexus without changing its threshold. */
  setAutoNexusEnabled(enabled: boolean): AutoNexusState {
    this.autoNexus.setEnabled(enabled);
    return this.autoNexus.getState();
  }

  /** Sets the autonexus threshold as a percentage from 1 through 100. */
  setAutoNexusThreshold(thresholdPercent: number): AutoNexusState {
    this.autoNexus.setThreshold(thresholdPercent);
    return this.autoNexus.getState();
  }

  /** Current autonexus configuration and predicted-health state. */
  getAutoNexusState(): AutoNexusState {
    return this.autoNexus.getState();
  }

  /** Current estimated (dead-reckoned) player position. */
  getPosition(): { x: number; y: number } {
    return { x: this.pos.x, y: this.pos.y };
  }

  /** Latest position the server reported for us (authoritative), if any. */
  getServerPosition(): { x: number; y: number } | undefined {
    return this.serverPos ? { ...this.serverPos } : undefined;
  }

  /** Latest game-tick info: server tick id, local tick counter, server tick interval, and ms since the last tick. */
  getTickInfo(): { tickId: number; tickCount: number; tickTimeMs: number; msSinceTick: number } {
    return {
      tickId: this.lastTickId,
      tickCount: this.tickCount,
      tickTimeMs: this.lastTickTime,
      msSinceTick: this.lastFrameTime > 0 ? this.time() - this.lastFrameTime : -1,
    };
  }

  /** A snapshot of the client's current state, for the `debug` console command. */
  debugInfo(): Record<string, unknown> {
    const player = this.player;
    const now = Date.now();
    const target = this.pathfinder.getTarget() ?? this.movement.getTarget();
    const waypoint = this.movement.getTarget();
    return {
      alias: this.opts.alias,
      lifecycle: this.lifecycle.current,
      host: `${this.host}:${this.port}`,
      nexusEndpoint: `${this.nexusHost}:${this.nexusPort}`,
      mapName: this.mapName,
      gameId: this.gameId,
      connected: !!this.socket && !this.socket.destroyed,
      objectId: this.objectId,
      petObjectId: this.petObjectId,
      petInstanceId: this.petInstanceId,
      inVault: this.inVault,
      inQueue: this.inQueue,
      stalled: this.stalled,
      stalledQueuedPackets: this.stallQueue.length,
      stalledDroppedPackets: this.stallQueueDropped,
      movementTarget: target,
      movementDistance: target ? Math.hypot(target.x - this.pos.x, target.y - this.pos.y) : undefined,
      movementWaypoint: waypoint,
      navigationWaypoints: this.pathfinder.getRemainingPath().length,
      localPos: `(${this.pos.x.toFixed(2)}, ${this.pos.y.toFixed(2)})`,
      serverPos: this.serverPos ? `(${this.serverPos.x.toFixed(2)}, ${this.serverPos.y.toFixed(2)})` : 'unknown',
      positionDrift: this.serverPos ? Math.hypot(this.pos.x - this.serverPos.x, this.pos.y - this.serverPos.y) : undefined,
      tickId: this.lastTickId,
      tickCount: this.tickCount,
      tickTimeMs: this.lastTickTime,
      lastActivityAt: this.lastActivityAt > 0 ? new Date(this.lastActivityAt).toISOString() : undefined,
      activityAgeMs: this.lastActivityAt > 0 ? now - this.lastActivityAt : undefined,
      autoNexus: this.autoNexus.getState(),
      connectAgeMs: this.connectStartedAt > 0 ? now - this.connectStartedAt : undefined,
      reconnectAttempts: this.reconnectAttempts,
      socket: this.socket
        ? {
            destroyed: this.socket.destroyed,
            connecting: this.socket.connecting,
            localAddress: this.socket.localAddress,
            localPort: this.socket.localPort,
            remoteAddress: this.socket.remoteAddress,
            remotePort: this.socket.remotePort,
            bytesRead: this.socket.bytesRead,
            bytesWritten: this.socket.bytesWritten,
          }
        : undefined,
      visibleObjects: this.objects.size,
      realmPortals: this.portalTracker.all().length,
      class: player ? parsePlayerClass(player.class) : 'unknown',
      level: player?.level,
      hp: player ? `${player.hp}/${player.maxHP}` : 'unknown',
      mp: player ? `${player.mp}/${player.maxMP}` : 'unknown',
      hasBackpack: player?.hasBackpack ?? false,
      inventory: player ? `[${player.inventory.join(', ')}]` : 'unknown',
    };
  }

  /** Current in-world object id, or -1 before CreateSuccess. */
  getObjectId(): number {
    return this.objectId;
  }

  /** Character id selected during login. */
  getCharacterId(): number {
    return this.opts.charId;
  }

  /** Current protocol game id (Nexus is -2). */
  getGameId(): number {
    return this.gameId;
  }

  /**
   * Object id of the player's active pet, or -1 if the server hasn't reported
   * one yet. Note this is map-scoped: it changes after each reconnect (e.g.
   * entering the vault), so always read it fresh rather than caching it.
   */
  getPetObjectId(): number {
    return this.petObjectId;
  }

  /** Active-pet instance/container id reported by PET_INSTANCEID_STAT. */
  getPetInstanceId(): number {
    return this.petInstanceId;
  }

  /** Container id used by pet-bag INVSWAPs; prefers PET_INSTANCEID, with the older object-id fallback. */
  getPetBagContainerId(): number {
    return this.petInstanceId !== -1 ? this.petInstanceId : this.petObjectId;
  }

  /** Whether the last MapInfo identified the current map as a vault. */
  isInVault(): boolean {
    return this.inVault;
  }

  /** Whether the current map is the Nexus. */
  isInNexus(): boolean {
    return this.mapName === 'Nexus';
  }

  /** Whether the current map is a Pet Yard. */
  isInPetYard(): boolean {
    return /pet\s*yard/i.test(this.mapName);
  }

  /** Seasonal state reported by the player status, or undefined until observed. */
  isSeasonal(): boolean | undefined {
    return this.seasonal;
  }

  /** Whether the socket is currently open. */
  isConnected(): boolean {
    return !!this.socket && !this.socket.destroyed;
  }

  /** Whether CreateSuccess has placed the character in-world. */
  isInWorld(): boolean {
    return this.objectId !== -1 && this.lifecycle.current === ClientLifecycleState.InWorld;
  }

  /** Whether a usable pet-bag container id has been observed. */
  hasPetBag(): boolean {
    return this.getPetBagContainerId() !== -1;
  }

  /** Current map name from the latest MapInfo packet, or Unknown before entry. */
  getMapName(): string {
    return this.mapName;
  }

  /** Dimensions reported by the latest MAPINFO packet. */
  getMapDimensions(): { width: number; height: number } {
    return { width: this.mapWidth, height: this.mapHeight };
  }

  /** The realm portals currently tracked in the nexus. */
  realmPortals(): RealmPortal[] {
    return this.portalTracker.all();
  }

  /** Visible non-player objects currently tracked from UPDATE/NEWTICK state. */
  visibleObjects(): TrackedObject[] {
    return [...this.objects.values()];
  }

  /** Tiles observed on the current map. */
  visibleTiles(): TrackedTile[] {
    return Array.from(this.tiles.values());
  }

  /** Returns one observed tile by integer map coordinate. */
  getTile(x: number, y: number): TrackedTile | undefined {
    return this.tiles.get(`${Math.trunc(x)},${Math.trunc(y)}`);
  }

  /** One currently visible non-player object by object id. */
  getVisibleObject(objectId: number): TrackedObject | undefined {
    const object = this.objects.get(objectId);
    return object ? { ...object } : undefined;
  }

  /** Visible objects matching a predicate, or all objects when omitted. */
  findVisibleObjects(predicate: (object: TrackedObject) => boolean = () => true): TrackedObject[] {
    return this.visibleObjects().filter(predicate);
  }

  /** Nearest visible object matching an optional predicate. */
  getNearestVisibleObject(predicate: (object: TrackedObject) => boolean = () => true): TrackedObject | undefined {
    const position = this.serverPos ?? this.pos;
    return this.findVisibleObjects(predicate).sort(
      (a, b) => distance(position, a) - distance(position, b),
    )[0];
  }

  /** Distance from the player to a world position or tracked object. */
  distanceTo(target: { x: number; y: number }): number {
    return distance(this.serverPos ?? this.pos, target);
  }

  /** Moves to a visible object by id; returns false when it is not visible. */
  moveToObject(objectId: number, arriveThreshold = config.arriveThreshold): boolean {
    const object = this.objects.get(objectId);
    if (!object) return false;
    return this.moveTo({ x: object.x, y: object.y }, arriveThreshold);
  }

  /** Realm portal by name (case-insensitive), if currently visible. */
  getRealmPortal(name: string): RealmPortal | undefined {
    return this.realmPortals().find((portal) => portal.name.toLowerCase() === name.toLowerCase());
  }

  /** Hostname/address of the server this client is currently connected to. */
  getServerHost(): string {
    return this.host;
  }

  /** Server list returned by /char/list when this client was created. */
  knownServers(): ClientServer[] {
    return [...(this.opts.servers ?? [])];
  }

  /** Reconnect tickets captured from server-issued Reconnect packets. */
  getReconnectTickets(): ReconnectTicketSummary[] {
    return [...this.reconnectTickets.values()].map(({ key, ...ticket }) => ({
      ...ticket,
      keyLength: key.length,
    }));
  }

  /** Whether the client has a server-issued reconnect ticket for this game id. */
  hasReconnectTicket(gameId: number, host?: string): boolean {
    return this.findReconnectTicket(gameId, host) !== undefined;
  }

  /** First known server whose address differs from the current host. */
  differentServer(): ClientServer | undefined {
    return this.knownServers().find((server) => server.address !== this.host);
  }

  /** Current lifecycle state for diagnostics and orchestration. */
  getLifecycleState(): ClientLifecycleState {
    return this.lifecycle.current;
  }

  /** Sends USE_PORTAL for a visible portal object id. */
  usePortal(objectId: number): void {
    this.commands.usePortal(objectId);
  }

  /** Walks into range of a visible portal, then sends USE_PORTAL on arrival. */
  enterPortal(objectId: number, arriveThreshold = config.arriveThreshold): boolean {
    const portal = this.objects.get(objectId) ?? this.portalTracker.all().find((p) => p.objectId === objectId);
    if (!portal) {
      console.warn(`${this.tag} cannot enter portal ${objectId} - not visible`);
      return false;
    }

    const target = { x: portal.x, y: portal.y };
    const current = this.serverPos ?? this.pos;
    if (distance(current, target) <= arriveThreshold) {
      console.log(`${this.tag} entering portal ${objectId} at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`);
      this.usePortal(objectId);
      return true;
    }

    const onReached = (reached: { x: number; y: number }): void => {
      if (distance(reached, target) > arriveThreshold) {
        return;
      }
      this.off(ClientEvent.MapChange, cancel);
      console.log(`${this.tag} reached portal ${objectId} - sending UsePortal`);
      this.usePortal(objectId);
    };
    const cancel = (): void => {
      this.off(ClientEvent.ReachedTarget, onReached);
    };

    this.off(ClientEvent.ReachedTarget, onReached);
    this.once(ClientEvent.ReachedTarget, onReached);
    this.once(ClientEvent.MapChange, cancel);
    this.moveTo(target, arriveThreshold);
    console.log(`${this.tag} walking to portal ${objectId} at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`);
    return true;
  }

  /** Sends INVSWAP between two player inventory/backpack slots. */
  swapInventorySlots(fromSlotId: number, toSlotId: number): boolean {
    return this.commands.swapInventorySlots(fromSlotId, toSlotId);
  }

  /**
   * Swaps the consumable item in inventory slot `fromSlotId` into a
   * consumable-belt slot (`1000000`, `1000001`, or `1000003`). Returns false
   * if not in-world, the destination isn't a valid consumable slot, or the
   * source slot is empty. See `CONSUMABLE_SLOT_IDS`.
   */
  swapToConsumable(fromSlotId: number, consumableSlotId: number): boolean {
    return this.commands.swapToConsumable(fromSlotId, consumableSlotId);
  }

  /** Last server INVRESULT parsed by the core client, if any. */
  getLastInvResult(): InvResultSnapshot | undefined {
    return this.lastInvResult;
  }

  /** Last parsed vault storage snapshot, if a VAULT_CONTENT packet has arrived. */
  getVaultContent(): VaultContentSnapshot | undefined {
    return this.lastVaultContent
      ? {
          ...this.lastVaultContent,
          sections: this.lastVaultContent.sections.map((section) => ({
            ...section,
            contents: [...section.contents],
          })),
        }
      : undefined;
  }

  /**
   * Sends a raw INVSWAP between two arbitrary container slots. Unlike
   * {@link swapInventorySlots}, the source and destination can belong to any
   * container — the player, a pet's bag, a vault chest — identified by its
   * object id. Each {@link SlotRef}'s `itemType` is the id of the item already
   * in that slot (or -1 for empty, sent as the 0xffffffff sentinel). Returns
   * false if the client is not yet in-world.
   */
  invSwap(from: SlotRef, to: SlotRef): boolean {
    return this.commands.invSwap(from, to);
  }

  /** Walks into range of any non-player container involved, then sends INVSWAP. */
  invSwapNear(from: SlotRef, to: SlotRef, arriveThreshold = Math.max(config.arriveThreshold, 1)): boolean {
    const targetObjectId = [from.objectId, to.objectId].find((objectId) => objectId !== this.objectId);
    if (targetObjectId === undefined) {
      return this.invSwap(from, to);
    }
    // PET_INSTANCEID is the pet-bag container id, but movement follows the
    // visible PET_OBJECT_ID entity when the two ids differ.
    const targetObject = this.objects.get(targetObjectId)
      ?? (targetObjectId === this.petInstanceId ? this.objects.get(this.petObjectId) : undefined);
    if (!targetObject) {
      console.warn(`${this.tag} cannot INVSWAP with object ${targetObjectId} - not visible`);
      return false;
    }

    const target = { x: targetObject.x, y: targetObject.y };
    const current = this.serverPos ?? this.pos;
    if (distance(current, target) <= arriveThreshold) {
      console.log(
        `${this.tag} INVSWAP in range of object ${targetObjectId} at ` +
          `(${target.x.toFixed(1)}, ${target.y.toFixed(1)})`,
      );
      return this.invSwap(from, to);
    }

    const onReached = (reached: { x: number; y: number }): void => {
      if (distance(reached, target) > arriveThreshold) {
        return;
      }
      this.off(ClientEvent.MapChange, cancel);
      console.log(`${this.tag} reached object ${targetObjectId} - sending INVSWAP`);
      this.invSwap(from, to);
    };
    const cancel = (): void => {
      this.off(ClientEvent.ReachedTarget, onReached);
    };

    this.once(ClientEvent.ReachedTarget, onReached);
    this.once(ClientEvent.MapChange, cancel);
    this.moveTo(target, arriveThreshold);
    console.log(
      `${this.tag} walking to object ${targetObjectId} before INVSWAP at ` +
        `(${target.x.toFixed(1)}, ${target.y.toFixed(1)})`,
    );
    return true;
  }

  /** Resolves a logical container to the object id required by INVSWAP. */
  getContainerObjectId(container: ItemContainer): number {
    switch (container) {
      case 'inventory':
        return this.objectId;
      case 'petBag':
        return this.getPetBagContainerId();
      case 'vault':
        return this.storageObjectId('vault', VAULT_CHEST_OBJECT_TYPE);
      case 'materialVault':
        return this.storageSectionObjectId('material');
      case 'giftChest':
        return this.storageSectionObjectId('gift');
      case 'potionVault':
        return this.storageObjectId('potion', POTION_VAULT_OBJECT_TYPE);
      case 'spoilsChest':
        return this.storageSectionObjectId('spoils');
    }
  }

  /**
   * Swaps any two supported logical-container slots. Item types are inferred
   * for inventory/vault/potion slots. Pet-bag item types must be supplied when
   * the slot is occupied because the server does not expose pet-bag contents
   * through the player's inventory stats.
   */
  swapContainerItems(from: ContainerSlotRef, to: ContainerSlotRef): boolean {
    let fromSlot = this.resolveContainerSlot(from);
    let toSlot = this.resolveContainerSlot(to);
    let fromContainer = from.container;
    let toContainer = to.container;
    if (!fromSlot || !toSlot) {
      return false;
    }
    if (fromSlot.itemType === -1 && toSlot.itemType !== -1) {
      [fromSlot, toSlot] = [toSlot, fromSlot];
      [fromContainer, toContainer] = [toContainer, fromContainer];
    }
    if (fromSlot.itemType === -1 && toSlot.itemType === -1) {
      console.warn(`${this.tag} cannot INVSWAP two empty slots`);
      return false;
    }
    console.log(
      `${this.tag} INVSWAP request ` +
        `${fromContainer}(obj ${fromSlot.objectId} slot ${fromSlot.slotId} type ${fromSlot.itemType}) -> ` +
        `${toContainer}(obj ${toSlot.objectId} slot ${toSlot.slotId} type ${toSlot.itemType})`,
    );
    return this.invSwapNear(fromSlot, toSlot);
  }

  /** Sends an INVSWAP using protocol-native slot objects. */
  swapSlots(from: SlotObjectData, to: SlotObjectData): boolean {
    let source = from;
    let destination = to;
    if (source.objectType === -1 && destination.objectType !== -1) {
      [source, destination] = [destination, source];
    }
    if (source.objectType === -1 && destination.objectType === -1) {
      console.warn(`${this.tag} cannot INVSWAP two empty slots`);
      return false;
    }
    return this.invSwapNear(slotRef(source), slotRef(destination));
  }

  /** Swaps a player inventory slot with a pet-bag slot (empty pet slot by default). */
  swapInventoryWithPetBag(inventorySlot: SlotObjectData, petBagSlot: SlotObjectData): boolean;
  swapInventoryWithPetBag(inventorySlot: number, petBagSlot: number, petBagItemType?: number): boolean;
  swapInventoryWithPetBag(
    inventorySlot: number | SlotObjectData,
    petBagSlot: number | SlotObjectData,
    petBagItemType = -1,
  ): boolean {
    if (isSlotObject(inventorySlot) && isSlotObject(petBagSlot)) {
      return this.swapSlots(inventorySlot, petBagSlot);
    }
    if (typeof inventorySlot !== 'number' || typeof petBagSlot !== 'number') return false;
    return this.swapContainerItems(
      { container: 'inventory', slotId: inventorySlot },
      { container: 'petBag', slotId: petBagSlot, itemType: petBagItemType },
    );
  }

  /** Swaps a player inventory slot with a main-vault slot. */
  swapInventoryWithVault(inventorySlot: SlotObjectData, vaultSlot: SlotObjectData): boolean;
  swapInventoryWithVault(inventorySlot: number, vaultSlot: number): boolean;
  swapInventoryWithVault(inventorySlot: number | SlotObjectData, vaultSlot: number | SlotObjectData): boolean {
    if (isSlotObject(inventorySlot) && isSlotObject(vaultSlot)) return this.swapSlots(inventorySlot, vaultSlot);
    if (typeof inventorySlot !== 'number' || typeof vaultSlot !== 'number') return false;
    return this.swapContainerItems(
      { container: 'inventory', slotId: inventorySlot },
      { container: 'vault', slotId: vaultSlot },
    );
  }

  /** Swaps a player inventory slot with a potion-vault slot. */
  swapInventoryWithPotionVault(inventorySlot: SlotObjectData, potionSlot: SlotObjectData): boolean;
  swapInventoryWithPotionVault(inventorySlot: number, potionSlot: number): boolean;
  swapInventoryWithPotionVault(
    inventorySlot: number | SlotObjectData,
    potionSlot: number | SlotObjectData,
  ): boolean {
    if (isSlotObject(inventorySlot) && isSlotObject(potionSlot)) return this.swapSlots(inventorySlot, potionSlot);
    if (typeof inventorySlot !== 'number' || typeof potionSlot !== 'number') return false;
    return this.swapContainerItems(
      { container: 'inventory', slotId: inventorySlot },
      { container: 'potionVault', slotId: potionSlot },
    );
  }

  /** Swaps a pet-bag slot with a main-vault slot. */
  swapPetBagWithVault(petBagSlot: SlotObjectData, vaultSlot: SlotObjectData): Promise<boolean>;
  swapPetBagWithVault(petBagSlot: number, petBagItemType: number, vaultSlot: number): boolean;
  swapPetBagWithVault(
    petBagSlot: number | SlotObjectData,
    petBagItemTypeOrVault: number | SlotObjectData,
    vaultSlot?: number,
  ): boolean | Promise<boolean> {
    if (isSlotObject(petBagSlot) && isSlotObject(petBagItemTypeOrVault)) {
      return this.transferBetweenContainers(petBagSlot, petBagItemTypeOrVault);
    }
    if (typeof petBagSlot !== 'number' || typeof petBagItemTypeOrVault !== 'number' || vaultSlot === undefined) {
      return false;
    }
    return this.swapContainerItems(
      { container: 'petBag', slotId: petBagSlot, itemType: petBagItemTypeOrVault },
      { container: 'vault', slotId: vaultSlot },
    );
  }

  /** Swaps a pet-bag slot with a potion-vault slot. */
  swapPetBagWithPotionVault(petBagSlot: SlotObjectData, potionSlot: SlotObjectData): Promise<boolean>;
  swapPetBagWithPotionVault(petBagSlot: number, petBagItemType: number, potionSlot: number): boolean;
  swapPetBagWithPotionVault(
    petBagSlot: number | SlotObjectData,
    petBagItemTypeOrPotion: number | SlotObjectData,
    potionSlot?: number,
  ): boolean | Promise<boolean> {
    if (isSlotObject(petBagSlot) && isSlotObject(petBagItemTypeOrPotion)) {
      return this.transferBetweenContainers(petBagSlot, petBagItemTypeOrPotion);
    }
    if (typeof petBagSlot !== 'number' || typeof petBagItemTypeOrPotion !== 'number' || potionSlot === undefined) {
      return false;
    }
    return this.swapContainerItems(
      { container: 'petBag', slotId: petBagSlot, itemType: petBagItemTypeOrPotion },
      { container: 'potionVault', slotId: potionSlot },
    );
  }

  /**
   * Diagnostic direct main-vault/potion-vault INVSWAP. Current live servers
   * reject non-player-to-non-player swaps; production flows must route both
   * items through empty player inventory slots.
   */
  swapVaultWithPotionVault(vaultSlot: SlotObjectData, potionSlot: SlotObjectData): Promise<boolean>;
  swapVaultWithPotionVault(vaultSlot: number, potionSlot: number): boolean;
  swapVaultWithPotionVault(
    vaultSlot: number | SlotObjectData,
    potionSlot: number | SlotObjectData,
  ): boolean | Promise<boolean> {
    if (isSlotObject(vaultSlot) && isSlotObject(potionSlot)) {
      return this.transferBetweenContainers(vaultSlot, potionSlot);
    }
    if (typeof vaultSlot !== 'number' || typeof potionSlot !== 'number') return false;
    return this.swapContainerItems(
      { container: 'vault', slotId: vaultSlot },
      { container: 'potionVault', slotId: potionSlot },
    );
  }

  /**
   * Reliably moves/exchanges two non-player container slots through player
   * inventory. Empty destinations require one empty buffer; occupied
   * destinations require two. Every leg waits for a matching INVRESULT.
   */
  async transferBetweenContainers(from: SlotObjectData, to: SlotObjectData, timeoutMs = 6000): Promise<boolean> {
    let source = from;
    let destination = to;
    if (source.objectType === -1 && destination.objectType !== -1) {
      [source, destination] = [destination, source];
    }
    if (source.objectType === -1) return false;
    if (source.objectId === this.objectId || destination.objectId === this.objectId || source.objectId === destination.objectId) {
      return this.sendSlotSwapAndWait(source, destination, timeoutMs);
    }

    const buffers = this.getInventorySlots().filter(
      (slot) => slot.slotId >= 4 && slot.objectType === -1,
    );
    const needed = destination.objectType === -1 ? 1 : 2;
    if (buffers.length < needed) {
      console.warn(`${this.tag} transfer needs ${needed} empty player inventory buffer slot(s)`);
      return false;
    }
    const firstBuffer = buffers[0];
    if (!await this.sendSlotSwapAndWait(source, firstBuffer, timeoutMs)) return false;

    const moveCurrent = async (
      fromObjectId: number,
      fromSlotId: number,
      toObjectId: number,
      toSlotId: number,
    ): Promise<boolean> => {
      const currentFrom = this.slotByObjectAndIndex(fromObjectId, fromSlotId);
      const currentTo = this.slotByObjectAndIndex(toObjectId, toSlotId);
      return !!currentFrom && currentFrom.objectType !== -1 && !!currentTo &&
        this.sendSlotSwapAndWait(currentFrom, currentTo, timeoutMs);
    };

    if (destination.objectType === -1) {
      const bufferedSource = this.slotByObjectAndIndex(this.objectId, firstBuffer.slotId);
      const currentDestination = this.slotByObjectAndIndex(destination.objectId, destination.slotId);
      const completed = !!bufferedSource && !!currentDestination &&
        await this.sendSlotSwapAndWait(bufferedSource, currentDestination, timeoutMs);
      if (!completed) {
        await moveCurrent(this.objectId, firstBuffer.slotId, source.objectId, source.slotId);
      }
      return completed;
    }

    const secondBuffer = buffers[1];
    const currentDestination = this.slotByObjectAndIndex(destination.objectId, destination.slotId);
    if (!currentDestination || !await this.sendSlotSwapAndWait(currentDestination, secondBuffer, timeoutMs)) {
      await moveCurrent(this.objectId, firstBuffer.slotId, source.objectId, source.slotId);
      return false;
    }
    const bufferedDestination = this.slotByObjectAndIndex(this.objectId, secondBuffer.slotId);
    const emptySource = this.slotByObjectAndIndex(source.objectId, source.slotId);
    if (!bufferedDestination || !emptySource || !await this.sendSlotSwapAndWait(bufferedDestination, emptySource, timeoutMs)) {
      await moveCurrent(this.objectId, secondBuffer.slotId, destination.objectId, destination.slotId);
      await moveCurrent(this.objectId, firstBuffer.slotId, source.objectId, source.slotId);
      return false;
    }
    const bufferedSource = this.slotByObjectAndIndex(this.objectId, firstBuffer.slotId);
    const emptyDestination = this.slotByObjectAndIndex(destination.objectId, destination.slotId);
    const completed = !!bufferedSource && !!emptyDestination &&
      await this.sendSlotSwapAndWait(bufferedSource, emptyDestination, timeoutMs);
    if (!completed) {
      await moveCurrent(source.objectId, source.slotId, this.objectId, secondBuffer.slotId);
      await moveCurrent(this.objectId, secondBuffer.slotId, destination.objectId, destination.slotId);
      await moveCurrent(this.objectId, firstBuffer.slotId, source.objectId, source.slotId);
    }
    return completed;
  }

  /** Current player inventory snapshot (20 slots: 0-3 equip, 4-11 inventory, 12-19 backpack), or undefined. */
  getInventory(): number[] | undefined {
    return this.player ? [...this.player.inventory] : undefined;
  }

  /** All currently known slots for a logical container, including empty slots. */
  getContainerSlots(container: ItemContainer): SlotObjectData[] {
    const objectId = this.getContainerObjectId(container);
    if (objectId === -1) return [];
    if (container === 'inventory') {
      return (this.player?.inventory ?? []).map((itemType, slotId) => SlotObjectData.from(objectId, slotId, itemType));
    }
    const key = storageSectionKey(container);
    if (key) {
      const contents = this.lastVaultContent?.sections.find((section) => section.key === key)?.contents ?? [];
      return contents.map((itemType, slotId) => SlotObjectData.from(objectId, slotId, itemType));
    }
    // Some builds publish pet-bag inventory stats on the visible pet object
    // while INVSWAP expects PET_INSTANCEID. Preserve the authoritative slot
    // values but rewrite their object id to the container id used on the wire.
    const direct = this.containerSlotItems.get(objectId);
    const petObjectSlots = container === 'petBag' ? this.containerSlotItems.get(this.petObjectId) : undefined;
    const known = direct || petObjectSlots
      ? new Map([...(petObjectSlots?.entries() ?? []), ...(direct?.entries() ?? [])])
      : undefined;
    return known
      ? [...known.entries()]
          .sort(([a], [b]) => a - b)
          .map(([slotId, itemType]) => SlotObjectData.from(objectId, slotId, itemType))
      : [];
  }

  getInventorySlots(): SlotObjectData[] { return this.getContainerSlots('inventory'); }
  getVaultSlots(): SlotObjectData[] { return this.getContainerSlots('vault'); }
  getPetBagSlots(): SlotObjectData[] { return this.getContainerSlots('petBag'); }
  getPotionVaultSlots(): SlotObjectData[] { return this.getContainerSlots('potionVault'); }

  /** A known slot in a logical container, including an empty slot. */
  getContainerSlot(container: ItemContainer, slotIndex: number): SlotObjectData | null {
    if (!Number.isInteger(slotIndex) || slotIndex < 0) return null;
    return this.getContainerSlots(container).find((slot) => slot.slotId === slotIndex) ?? null;
  }

  /** First known non-empty slot in a container. */
  getFirstFilledSlot(container: ItemContainer): SlotObjectData | null {
    return this.getContainerSlots(container).find((slot) => slot.objectType !== -1) ?? null;
  }

  /** First known empty slot in a container. */
  getFirstEmptySlot(container: ItemContainer): SlotObjectData | null {
    return this.getContainerSlots(container).find((slot) => slot.objectType === -1) ?? null;
  }

  /**
   * A non-empty player slot. With no index, searches main inventory then the
   * backpack (equipment is excluded from automatic selection).
   */
  getInventorySlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('inventory', slotIndex);
      return slot && slot.objectType !== -1 ? slot : null;
    }
    const slots = [...MAIN_INVENTORY_SLOT_IDS, ...BACKPACK_SLOT_IDS];
    return slots.map((slot) => this.getContainerSlot('inventory', slot)).find((slot) => !!slot && slot.objectType !== -1) ?? null;
  }

  /** A non-empty main-vault slot, or the first non-empty slot when omitted. */
  getVaultSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('vault', slotIndex);
      return slot && slot.objectType !== -1 ? slot : null;
    }
    return this.getFirstFilledSlot('vault');
  }

  /** First known empty pet-bag slot (or the requested slot if it is empty). */
  getPetBagSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('petBag', slotIndex);
      return slot?.objectType === -1 ? slot : null;
    }
    return this.getFirstEmptySlot('petBag');
  }

  /** First empty potion-vault slot (or the requested slot if it is empty). */
  getPotionVaultSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('potionVault', slotIndex);
      return slot?.objectType === -1 ? slot : null;
    }
    return this.getFirstEmptySlot('potionVault');
  }

  /** First non-empty potion-vault slot, useful when withdrawing. */
  getPotionVaultItemSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('potionVault', slotIndex);
      return slot && slot.objectType !== -1 ? slot : null;
    }
    return this.getFirstFilledSlot('potionVault');
  }

  /** First non-empty Gift Chest slot. */
  getGiftChestSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('giftChest', slotIndex);
      return slot && slot.objectType !== -1 ? slot : null;
    }
    return this.getFirstFilledSlot('giftChest');
  }

  /** First non-empty material-vault slot. */
  getMaterialVaultSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('materialVault', slotIndex);
      return slot && slot.objectType !== -1 ? slot : null;
    }
    return this.getFirstFilledSlot('materialVault');
  }

  /** First non-empty Spoils Chest slot. */
  getSpoilsChestSlot(slotIndex?: number): SlotObjectData | null {
    if (slotIndex !== undefined) {
      const slot = this.getContainerSlot('spoilsChest', slotIndex);
      return slot && slot.objectType !== -1 ? slot : null;
    }
    return this.getFirstFilledSlot('spoilsChest');
  }

  /** First empty carried-inventory slot (main inventory, then backpack). */
  getEmptyInventorySlot(): SlotObjectData | null {
    const slots = [...MAIN_INVENTORY_SLOT_IDS, ...BACKPACK_SLOT_IDS];
    return slots.map((slot) => this.getContainerSlot('inventory', slot)).find((slot) => slot?.objectType === -1) ?? null;
  }

  /** First carried-inventory slot holding the requested item type. */
  findInventoryItem(itemType: number): SlotObjectData | null {
    return this.getContainerSlots('inventory').find(
      (slot) => slot.slotId >= 4 && slot.objectType === itemType,
    ) ?? null;
  }

  /** Number of non-empty known slots in a logical container. */
  getContainerItemCount(container: ItemContainer): number {
    return this.getContainerSlots(container).filter((slot) => slot.objectType !== -1).length;
  }

  /** Whether the carried inventory has at least one known empty slot. */
  hasInventorySpace(): boolean {
    return this.getEmptyInventorySlot() !== null;
  }

  private sendSlotSwapAndWait(from: SlotObjectData, to: SlotObjectData, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: TimerHandle | undefined;
      const finish = (result: boolean): void => {
        this.off(ClientEvent.InventoryResult, onResult);
        this.off(ClientEvent.MapChange, onMapChange);
        this.timers.clear(timer);
        resolve(result);
      };
      const onResult = (packet: InvResultPacket): void => {
        if (
          packet.isUseItemAck() ||
          packet.fromSlot.objectId !== from.objectId || packet.fromSlot.slotId !== from.slotId ||
          packet.toSlot.objectId !== to.objectId || packet.toSlot.slotId !== to.slotId
        ) {
          return;
        }
        finish(packet.success);
      };
      const onMapChange = (): void => finish(false);
      this.on(ClientEvent.InventoryResult, onResult);
      this.once(ClientEvent.MapChange, onMapChange);
      timer = this.timers.setTimeout(() => finish(false), Math.max(1, timeoutMs));
      if (!this.swapSlots(from, to)) finish(false);
    });
  }

  private slotByObjectAndIndex(objectId: number, slotId: number): SlotObjectData | null {
    const itemType = objectId === this.objectId
      ? this.player?.inventory?.[slotId]
      : this.containerSlotItems.get(objectId)?.get(slotId);
    return itemType === undefined ? null : SlotObjectData.from(objectId, slotId, itemType);
  }

  private resolveContainerSlot(ref: ContainerSlotRef): SlotRef | undefined {
    if (!Number.isInteger(ref.slotId) || ref.slotId < 0) {
      console.warn(`${this.tag} cannot INVSWAP ${ref.container}: invalid slot ${ref.slotId}`);
      return undefined;
    }
    const objectId = this.getContainerObjectId(ref.container);
    if (objectId === -1) {
      console.warn(`${this.tag} cannot INVSWAP ${ref.container}: container id is not known`);
      return undefined;
    }
    const itemType = ref.itemType ?? this.containerItemType(ref.container, ref.slotId);
    if (itemType === undefined) {
      console.warn(
        `${this.tag} cannot INVSWAP ${ref.container} slot ${ref.slotId}: item type is not known; ` +
          `pass itemType explicitly`,
      );
      return undefined;
    }
    return { objectId, slotId: ref.slotId, itemType };
  }

  private containerItemType(container: ItemContainer, slotId: number): number | undefined {
    if (container === 'inventory') {
      return this.player?.inventory?.[slotId];
    }
    if (container === 'petBag') {
      return this.containerSlotItems.get(this.getPetBagContainerId())?.get(slotId);
    }
    const key = storageSectionKey(container);
    if (!key) {
      return undefined;
    }
    return this.lastVaultContent?.sections.find((section) => section.key === key)?.contents[slotId];
  }

  private storageObjectId(sectionKey: 'vault' | 'potion', objectType: number): number {
    const packetObjectId = this.lastVaultContent?.sections.find((section) => section.key === sectionKey)?.objectId;
    if (packetObjectId !== undefined && packetObjectId !== -1) {
      return packetObjectId;
    }
    return this.visibleObjects().find((object) => object.type === objectType)?.objectId ?? -1;
  }

  /** Whether the player has a backpack (slots 12-19 usable). */
  hasBackpack(): boolean {
    return this.player?.hasBackpack ?? false;
  }

  /** Aims at a world position and sends a PLAYERSHOOT packet with the equipped weapon. */
  shootAt(target: { x: number; y: number }, weaponSlot = 0): boolean {
    return this.commands.shootAt(target, weaponSlot);
  }

  /** Uses the equipped ability at a world position. */
  useAbilityAt(target: { x: number; y: number }): boolean {
    return this.commands.useAbilityAt(target);
  }

  /** Uses the equipped ability at the player's current position. */
  useAbility(): boolean {
    return this.commands.useAbilityAt(this.serverPos ?? this.pos);
  }

  aimAt(objectId: number): boolean {
    return this.autoCombat?.aimAt(objectId) ?? false;
  }

  aimAtPosition(x: number, y: number): boolean {
    return this.autoCombat?.aimAtPosition(x, y) ?? false;
  }

  stopAiming(): void {
    this.autoCombat?.stopAiming();
  }

  enableAutoAim(options?: AutoAimOptions): boolean {
    return this.autoCombat?.enableAutoAim(options) ?? false;
  }

  configureAutoAim(options: AutoAimMode | AutoAimOptions): boolean {
    return this.autoCombat?.configureAutoAim(options) ?? false;
  }

  enableAutoAbility(options?: AutoAbilityOptions): boolean {
    return this.autoCombat?.enableAutoAbility(options) ?? false;
  }

  configureAutoAbility(options: AutoAbilityOptions): boolean {
    return this.autoCombat?.configureAutoAbility(options) ?? false;
  }

  disableAutoAbility(): void {
    this.autoCombat?.disableAutoAbility();
  }

  getAutoCombatState(): AutoCombatState | undefined {
    return this.autoCombat?.getState();
  }

  enableProjectileNoclip(): boolean {
    return this.setProjectileNoclip(true);
  }

  disableProjectileNoclip(): void {
    this.combat?.setProjectileNoclip(false);
  }

  setProjectileNoclip(enabled: boolean): boolean {
    if (!this.combat) {
      return false;
    }
    this.combat.setProjectileNoclip(enabled);
    return true;
  }

  isProjectileNoclipEnabled(): boolean {
    return this.combat?.isProjectileNoclipEnabled() ?? false;
  }

  accuracy(): number {
    return this.combat?.accuracy() ?? 0;
  }

  recentAccuracy(minutes: number): number {
    return this.combat?.recentAccuracy(minutes) ?? 0;
  }

  resetAccuracy(): void {
    this.combat?.resetAccuracy();
  }

  //#endregion

  /** Records both active-pet identifiers from a player stat list, if present. */
  private capturePetObjectId(stats: StatData[]): void {
    for (const stat of stats) {
      if (stat.statType === StatType.PET_INSTANCEID_STAT) {
        this.petInstanceId = stat.statValue;
      } else if (stat.statType === StatType.PET_OBJECT_ID) {
        this.petObjectId = stat.statValue;
      } else if (stat.statType === StatType.SEASONAL_CHARACTER_STAT) {
        this.seasonal = stat.statValue !== 0;
      }
    }
  }

  private storageSectionObjectId(sectionKey: 'material' | 'gift' | 'spoils'): number {
    return this.lastVaultContent?.sections.find((section) => section.key === sectionKey)?.objectId ?? -1;
  }

  /** Records inventory-shaped stats for any visible container object. */
  private captureContainerSlots(objectId: number, stats: StatData[]): void {
    for (const stat of stats) {
      const slotId = inventorySlotIndex(stat.statType);
      if (slotId === null) continue;
      const slots = this.containerSlotItems.get(objectId) ?? new Map<number, number>();
      slots.set(slotId, stat.statValue);
      this.containerSlotItems.set(objectId, slots);
    }
  }

  /** Bridges an io packet emission onto this client's emitter (for the current io). */
  private bridgePacket(type: PacketType): void {
    if (!this.io || this.bridgedPacketTypes.has(type)) {
      return;
    }
    this.bridgedPacketTypes.add(type);
    this.io.on(type, (packet: Packet) => this.dispatchPacket(type, packet));
  }

  /** Runs plugin packet hooks in priority order until one cancels the packet. */
  private dispatchPacket(type: PacketType, packet: Packet): void {
    const handlers = this.packetHandlers.get(type) ?? [];
    const ctx: MutablePacketContext = {
      type,
      packet,
      cancelled: false,
      cancel: () => undefined,
    };
    ctx.cancel = (reason?: string): void => {
      ctx.cancelled = true;
      ctx.cancelReason = reason;
    };
    for (const entry of handlers) {
      try {
        entry.handler(packet, ctx);
      } catch (error) {
        console.error(`${this.tag} packet hook for ${type} failed:`, error instanceof Error ? error.message : error);
      }
      if (ctx.cancelled) {
        return;
      }
    }
  }

  /**
   * Requests that the client walk to the vault portal and enter the vault.
   * Takes effect once in the nexus; safe to call before or after connecting.
   */
  enterVault(): void {
    if (this.inVault) {
      return;
    }
    this.wantVault = true;
    this.findVaultPortal(); // act now if the nexus objects are already known
  }

  /**
   * Walks to the pet yard portal and enters it. Takes effect once in the
   * nexus; safe to call before or after connecting.
   */
  enterPetYard(): void {
    this.navToPortalType(PortalType.PetYard, 'Pet Yard', /pet\s*yard/i);
  }

  /** Walks to the guild hall portal and enters it (from the nexus). */
  enterGuildHall(): void {
    this.navToPortalType(PortalType.GuildHall, 'Guild Hall', /guild\s*hall/i);
  }

  /** Walks to the daily quest room portal and enters it (from the nexus). */
  enterDailyQuestRoom(): void {
    this.navToPortalType(PortalType.DailyQuestRoom, 'Daily Quest Room', /quest/i);
  }

  /**
   * Whether the character has a potion belt equipped — i.e. a third consumable
   * slot (`1000002`, see `CONSUMABLE_SLOT_IDS`). Reads the POTION_BELT stat.
   */
  hasPotionBelt(): boolean {
    return this.player?.potionBelt ?? false;
  }

  /** Starts navigating to the first visible portal of `type`. */
  private navToPortalType(type: PortalType, label: string, arrived: RegExp): void {
    if (arrived.test(this.mapName)) {
      return; // already there
    }
    if (this.pendingPortal?.type !== type) {
      this.pendingPortal = { type, label, arrived, attempts: 0, lastTick: -100 };
    }
    this.findPendingPortal(); // act now if the nexus objects are already known
  }

  /**
   * Sends a CREATE packet to create a new character with the given options
   * (falling back to the client's configured create settings, then Wizard).
   * Only valid in a character-select map (nexus); the server replies with
   * CreateSuccess + NewCharacterInformation, or a Failure if creation is not
   * allowed (e.g. the account is at its character cap).
   */
  createCharacter(classType: number, seasonal?: boolean): void;
  createCharacter(overrides?: {
    classType?: number;
    skin?: number;
    seasonal?: boolean;
    challenger?: boolean;
  }): void;
  createCharacter(
    classTypeOrOptions: number | {
      classType?: number;
      skin?: number;
      seasonal?: boolean;
      challenger?: boolean;
    } = {},
    seasonal?: boolean,
  ): void {
    const overrides = typeof classTypeOrOptions === 'number'
      ? { classType: classTypeOrOptions, seasonal: seasonal ?? false }
      : classTypeOrOptions;
    const create = new CreatePacket();
    create.classType = overrides.classType ?? this.opts.createClassType ?? Classes.Wizard;
    create.skinType = overrides.skin ?? this.opts.createSkin ?? 0;
    create.isSeasonal = overrides.seasonal ?? this.opts.createSeasonal ?? false;
    create.isChallenger = overrides.challenger ?? this.opts.createChallenger ?? false;
    create.unknownByte = 1;
    console.log(
      `${this.tag} creating character (class ${create.classType}, skin ${create.skinType}` +
        `${create.isSeasonal ? ', seasonal' : ''}${create.isChallenger ? ', challenger' : ''})`,
    );
    this.io.send(create);
  }

  /** Sends the empty-body packet which converts the current seasonal character. */
  sendSeasonalConversion(): void {
    console.log(`${this.tag} sending seasonal conversion`);
    this.send(new ConvertSeasonalCharacterPacket());
  }

  /**
   * Permanently deletes a character on this client's account via the AppEngine
   * `/char/delete` endpoint (HTTP, independent of the game socket). Irreversible.
   */
  async deleteCharacter(charId: number): Promise<void> {
    console.log(`${this.tag} deleting character ${charId}`);
    await deleteCharacterRequest(this.accessToken, charId);
    console.log(`${this.tag} deleted character ${charId}`);
  }

  /**
   * Stalls the connection to faithfully simulate a network lagout, so the
   * server's disconnect timeout can actually be probed.
   *
   * Two things happen together:
   *  - Reading is paused via `socket.pause()`. We stop draining the OS receive
   *    buffer, so the kernel stops ACKing application data and eventually
   *    advertises a zero window — to the server we look like a frozen/silent
   *    peer, not a healthy connection that merely isn't moving. (An earlier
   *    version kept reading "to preserve RC4 sync", but that kept TCP alive at
   *    the OS level and the server never noticed; pause/resume preserves byte
   *    order, so RC4 stays in sync regardless.)
   *  - Outgoing packets are not sent but *queued* in order, mimicking the
   *    client's TCP send buffer holding traffic until the link recovers.
   *
   * The connection is NOT closed by us — if it drops, the server did it.
   * Returns false if already stalled or not connected.
   */
  stall(ms?: number): boolean {
    if (this.stalled || !this.socket || this.socket.destroyed) {
      return false;
    }
    if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0)) {
      console.warn(`${this.tag} stall duration must be a positive number of milliseconds`);
      return false;
    }
    this.stalled = true;
    this.stalledAt = this.time();
    this.stallUntil = ms === undefined ? undefined : Date.now() + ms;
    this.stallQueue.length = 0;
    this.stallQueueDropped = 0;
    this.socket.pause(); // stop reading: the OS stops ACKing once its recv buffer fills
    if (ms !== undefined) {
      this.stallResumeTimer = this.timers.setTimeout(() => this.unstall(), ms);
    }
    console.log(
      `${this.tag} ⏸ socket stalled (frozen) — paused reads, queueing outgoing` +
        (ms === undefined ? ' until unstall()' : ` for ${ms}ms`),
    );
    return true;
  }

  /**
   * Resumes a stalled socket and flushes the queued outgoing packets in order,
   * so the server receives the acks it was owed during the stall. Returns the
   * stall duration in ms, or -1 if not stalled.
   */
  unstall(): number {
    if (!this.stalled || !this.socket) {
      return -1;
    }
    this.timers.clear(this.stallResumeTimer);
    this.stallResumeTimer = undefined;
    this.stallUntil = undefined;
    const heldMs = this.time() - this.stalledAt;
    const queued = this.stallQueue.length;
    const droppedQueued = this.stallQueueDropped;
    const acks = this.stallQueue.filter((p) => p.type === PacketType.UPDATEACK).length;
    const moves = this.stallQueue.filter((p) => p.type === PacketType.MOVE).length;
    const dropped = this.socket.destroyed;
    this.stalled = false;
    if (!dropped && this.stallRawSend) {
      for (const packet of this.stallQueue) {
        this.stallRawSend(packet);
      }
    }
    this.stallQueue.length = 0;
    if (dropped) {
      // The server closed us during the stall; nothing was flushed.
      console.log(
        `${this.tag} ▶ resume after ${heldMs}ms — server had already dropped us; ` +
          `discarded ${queued} unsent packet(s), dropped ${droppedQueued} while capped`,
      );
      return heldMs;
    }
    // Resume reading: the buffered incoming bytes flood in (in order, so RC4
    // stays in sync) and the handlers fire, sending a burst of catch-up Moves
    // with stale tick ids — the same recovery a real client attempts after a lag.
    this.socket.resume();
    console.log(
      `${this.tag} ▶ socket resumed after ${heldMs}ms — flushed ${queued} queued outgoing packet(s): ` +
        `${acks} UpdateAck, ${moves} Move, ${queued - acks - moves} other` +
        (droppedQueued ? `; dropped ${droppedQueued} while capped` : ''),
    );
    return heldMs;
  }

  /** @deprecated Use {@link stall}. */
  stallSocket(): boolean {
    return this.stall();
  }

  /** @deprecated Use {@link unstall}. */
  resumeSocket(): number {
    return this.unstall();
  }

  /**
   * Wraps the current io's send so that, while {@link stalled}, every outgoing
   * packet is queued instead of sent (and flushed in order on resume). Installed
   * once per connect (io is recreated on each connect).
   */
  private installStallGate(): void {
    const io = this.io;
    const rawSend = io.send.bind(io);
    this.stallRawSend = rawSend;
    io.send = (packet: Packet): void => {
      if (this.stalled) {
        if (this.stallQueue.length < config.stalledPacketQueueCap) {
          this.stallQueue.push(packet);
        } else {
          this.stallQueueDropped++;
          if (this.stallQueueDropped === 1 || this.stallQueueDropped % 1000 === 0) {
            console.warn(
              `${this.tag} stalled packet queue full (${config.stalledPacketQueueCap}); ` +
                `dropped ${this.stallQueueDropped} packet(s) while stalled`,
            );
          }
        }
        return;
      }
      rawSend(packet);
    };
  }

  /** Whether the socket is currently stalled. */
  isStalled(): boolean {
    return this.stalled;
  }

  /** Current socket-stall diagnostics for plugins and control surfaces. */
  getStallInfo(): { stalled: boolean; elapsedMs: number; remainingMs?: number; queuedPackets: number; droppedPackets: number } {
    const remainingMs = this.stallUntil === undefined ? undefined : Math.max(0, this.stallUntil - Date.now());
    return {
      stalled: this.stalled,
      elapsedMs: this.stalled ? Math.max(0, this.time() - this.stalledAt) : 0,
      remainingMs,
      queuedPackets: this.stallQueue.length,
      droppedPackets: this.stallQueueDropped,
    };
  }

  /**
   * Sends an ESCAPE packet to return to the nexus. The server replies with a
   * Reconnect, which is followed automatically.
   */
  escape(): void {
    if (!this.io) {
      console.log(`${this.tag} escape ignored — not connected`);
      return;
    }
    console.log(`${this.tag} escaping to the nexus`);
    this.io.send(new EscapePacket());
    this.wantVault = false; // don't immediately walk back into the vault
    this.clearNavState();
    this.gameId = GAME_ID.NEXUS;
    this.key = [];
    this.keyTime = -1;
  }

  /** Drops the current socket and begins a fresh Nexus connection immediately. */
  nexusImmediately(reason = 'emergency nexus'): boolean {
    if (!this.socket || this.socket.destroyed) {
      console.log(`${this.tag} ${reason} ignored - not connected`);
      return false;
    }
    console.warn(`${this.tag} ${reason}: reconnecting directly to the nexus`);
    this.wantVault = false;
    this.resetForNexus();
    this.connect();
    return true;
  }

  /** Disconnects and connects to the given game server (its nexus). */
  connectToServer(host: string): void {
    console.log(`${this.tag} connecting to server ${host}`);
    this.nexusHost = host;
    this.nexusPort = GAME_PORT;
    this.resetForNexus();
    this.connect();
  }

  /**
   * Disconnects and reconnects to a specific Hello game id on the current or
   * supplied server. Useful for controlled map-id probing plugins.
   */
  connectToGameId(gameId: number, host = this.host): GameIdConnectMode {
    const ticket = this.findReconnectTicket(gameId, host);
    if (ticket) {
      this.connectToReconnectTicket(ticket.id);
      return 'ticket';
    }

    console.log(`${this.tag} connecting to gameId ${gameId} on ${host} without reconnect key`);
    this.clearMapState();
    this.clearNavState();
    this.host = host;
    this.port = GAME_PORT; // don't inherit a custom port from an earlier reconnect
    this.gameId = gameId;
    this.key = [];
    this.keyTime = -1;
    this.inVault = false;
    this.enteringVault = false;
    this.connect();
    return 'unkeyed';
  }

  /** Connects using a previously captured server-issued reconnect ticket. */
  connectToReconnectTicket(ticketId: number): boolean {
    const ticket = this.reconnectTickets.get(ticketId);
    if (!ticket) {
      console.warn(`${this.tag} reconnect ticket ${ticketId} not found`);
      return false;
    }
    console.log(
      `${this.tag} connecting with reconnect ticket #${ticket.id} ` +
        `${ticket.name || 'unnamed'} gameId ${ticket.gameId} on ${ticket.host}:${ticket.port}`,
    );
    this.clearMapState();
    this.clearNavState();
    this.host = ticket.host;
    this.port = ticket.port;
    this.gameId = ticket.gameId;
    this.key = [...ticket.key];
    this.keyTime = ticket.keyTime;
    this.inVault = false;
    this.enteringVault = /vault/i.test(ticket.name);
    ticket.usedAt = new Date().toISOString();
    this.connect();
    return true;
  }

  /** Stops network activity and clears client-owned timers. Plugins should be unloaded separately. */
  stop(reason = 'stopped'): void {
    this.lifecycle.transition(ClientLifecycleState.Stopped);
    this.giveUp = true; // don't let an in-flight close schedule a reconnect
    this.stopWatchdog();
    this.timers.clear(this.combatTimer);
    this.combatTimer = undefined;
    this.timers.clear(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAttempts = 0;
    this.timers.clear(this.stallResumeTimer);
    this.stallResumeTimer = undefined;
    this.stallUntil = undefined;
    this.stalled = false;
    this.stallQueue.length = 0;
    this.stallQueueDropped = 0;
    this.destroySocket();
    console.log(`${this.tag} stopped (${reason})`);
  }

  /** Log prefix for this client. */
  private get tag(): string {
    return `[${this.opts.alias}]`;
  }

  /** Milliseconds since this client instance started, matching Flash getTimer(). */
  private time(): number {
    return Date.now() - this.connectStart;
  }

  /** Names a FailurePacket error code via realmlib's failure models. */
  private describeFailure(p: FailurePacket): string {
    // In-game failures are ProtocolError codes; pre-entry ones are FailureCode.
    const name = this.objectId !== -1 ? ProtocolError[p.errorId] : FailureCode[p.errorId];
    return name ?? `code ${p.errorId}`;
  }

  /** The display name of an object, from its NAME stat, if any. */
  private objectName(obj: ObjectData): string | undefined {
    return obj.status.stats.find((s) => s.statType === StatType.NAME_STAT)?.stringStatValue || undefined;
  }

  /** Records or refreshes a realm portal from its object status. */
  private trackRealmPortal(status: ObjectStatusData): void {
    const tracked = this.portalTracker.trackRealmPortal(status);
    if (!tracked) {
      return;
    }
    const { portal, isNew } = tracked;
    if (isNew) {
      console.log(
        `${this.tag} realm portal: ${portal.name} (${portal.players}/${portal.maxPlayers}) ` +
          `opened ${portal.openedAt || '?'} connect ${portal.connectId ?? '?'}:${portal.connectValueTwo ?? '?'}`,
      );
    }
    this.emit(ClientEvent.RealmPortal, portal);
  }

  /** Clears state tied to the current map; call on any map change. */
  private clearMapState(): void {
    this.objectId = -1;
    this.petObjectId = -1;
    this.petInstanceId = -1;
    this.seasonal = undefined;
    this.containerSlotItems.clear();
    this.posKnown = false;
    this.serverPos = undefined;
    this.player = undefined;
    this.lastFrameTime = 0;
    this.lastGroundDamageAt = 0;
    this.objects.clear();
    this.tiles.clear();
    this.pathfinder.resetMap();
    this.recentObjectTypes.clear();
    this.predictedPlayerDamage.clear();
    this.nextBulletId = 1;
    this.commands.resetMap();
    this.autoNexus.reset();
    this.autoNexus.setSafeMap(true);
    this.combat?.clear();
    this.autoCombat?.clearMap();
    this.portalTracker.clear();
  }

  /** Clears vault navigation progress (target, portal id, retry counters). */
  private clearNavState(): void {
    this.movement.clear();
    this.pathfinder.clearTarget();
    this.vaultPortalId = undefined;
    this.usePortalAttempts = 0;
    this.lastUsePortalTick = -100;
    // Keep the pending-portal *intent* across a reconnect, but re-find the
    // portal id and reset the retry counter for the new map.
    if (this.pendingPortal) {
      this.pendingPortal.portalId = undefined;
      this.pendingPortal.attempts = 0;
      this.pendingPortal.lastTick = -100;
    }
  }

  /** Resets to a fresh nexus connection (used after a rate-limit cooldown). */
  private resetForNexus(): void {
    this.clearMapState();
    this.clearNavState();
    this.host = this.nexusHost;
    this.port = this.nexusPort;
    this.gameId = GAME_ID.NEXUS;
    this.key = [];
    this.keyTime = -1;
    this.inVault = false;
    this.enteringVault = false;
  }

  /** Stores a Reconnect packet as a reusable, server-issued connection ticket. */
  private rememberReconnectTicket(p: ReconnectPacket): ReconnectTicket {
    const host = p.host || this.host;
    const port = p.port !== -1 && p.port !== 0 ? p.port : this.port;
    const existing = [...this.reconnectTickets.values()].find(
      (ticket) =>
        ticket.host === host &&
        ticket.port === port &&
        ticket.gameId === p.gameId &&
        ticket.keyTime === p.keyTime &&
        sameNumberArray(ticket.key, p.key),
    );
    if (existing) {
      existing.capturedAt = new Date().toISOString();
      existing.name = p.name || existing.name;
      return existing;
    }

    const ticket: ReconnectTicket = {
      id: this.nextReconnectTicketId++,
      name: p.name,
      host,
      port,
      gameId: p.gameId,
      keyTime: p.keyTime,
      key: [...p.key],
      capturedAt: new Date().toISOString(),
    };
    this.reconnectTickets.set(ticket.id, ticket);
    while (this.reconnectTickets.size > 80) {
      const oldest = this.reconnectTickets.keys().next().value;
      if (oldest === undefined) break;
      this.reconnectTickets.delete(oldest);
    }
    console.log(
      `${this.tag} captured reconnect ticket #${ticket.id}: ` +
        `${ticket.name || 'unnamed'} gameId ${ticket.gameId} keyTime ${ticket.keyTime} keyLen ${ticket.key.length}`,
    );
    return ticket;
  }

  private findReconnectTicket(gameId: number, host?: string): ReconnectTicket | undefined {
    const normalizedHost = host || this.host;
    const tickets = [...this.reconnectTickets.values()]
      .filter((ticket) => ticket.gameId === gameId && (!normalizedHost || ticket.host === normalizedHost))
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
    return tickets[0];
  }

  /** Reconnects to the nexus after `ms`, e.g. once a rate-limit has cooled down. */
  private scheduleReconnect(ms: number): void {
    if (this.reconnectTimer) {
      return; // already pending; don't stack reconnects on repeated failures
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.resetForNexus();
      this.connect();
    }, ms);
  }

  /** Once in the nexus, locate the vault portal by name and start navigating to it. */
  private findVaultPortal(): void {
    if (!this.wantVault || this.vaultPortalId !== undefined || this.inVault || this.enteringVault) {
      return;
    }
    const found = this.portalTracker.findVaultPortal(this.objects);
    if (found) {
      this.vaultPortalId = found.id;
      this.moveTo({ x: found.object.x, y: found.object.y }, config.arriveThreshold);
      console.log(
        `${this.tag} found vault portal "${found.object.name}" (id ${found.id}, type ${found.object.type}) ` +
          `at (${found.object.x.toFixed(1)}, ${found.object.y.toFixed(1)}) → navigating`,
      );
    }
  }

  /** Walks toward the pending portal once it is visible (mirrors findVaultPortal). */
  private findPendingPortal(): void {
    const nav = this.pendingPortal;
    if (!nav || nav.portalId !== undefined) {
      return;
    }
    const found = this.portalTracker.findPortalByType(this.objects, nav.type);
    if (found) {
      nav.portalId = found.id;
      this.moveTo({ x: found.object.x, y: found.object.y }, config.arriveThreshold);
      console.log(
        `${this.tag} found ${nav.label} portal "${found.object.name}" (id ${found.id}, type ${found.object.type}) ` +
          `at (${found.object.x.toFixed(1)}, ${found.object.y.toFixed(1)}) → navigating`,
      );
    }
  }

  /** With DUMP_OBJECTS=1, log the named objects in view once (portal discovery aid). */
  private maybeDumpObjects(): void {
    if (this.dumped || !process.env.DUMP_OBJECTS || this.objects.size < 10) {
      return;
    }
    //this.dumped = true;
    console.log(`${this.tag} --- named objects in view (${this.objects.size} total) ---`);
    for (const [id, o] of this.objects) {
      if (o.name) {
        console.log(`${this.tag}   id ${id} type ${o.type} "${o.name}" @ (${o.x.toFixed(1)}, ${o.y.toFixed(1)})`);
      }
    }
  }

  /** Opens the TCP socket, builds PacketIO, and starts the Hello handshake. */
  connect(): void {
    if (this.reconnectTimer) {
      this.timers.clear(this.reconnectTimer); // a (re)connect cancels any pending scheduled one
      this.reconnectTimer = undefined;
    }
    this.giveUp = false; // a fresh connect attempt clears the fatal-failure latch
    const generation = this.lifecycle.nextGeneration();
    this.lifecycle.transition(ClientLifecycleState.Connecting);
    this.stopWatchdog();
    this.timers.clear(this.combatTimer);
    this.combatTimer = undefined;
    this.combat?.clear();
    this.destroySocket();
    this.timers.clear(this.stallResumeTimer);
    this.stallResumeTimer = undefined;
    this.stallUntil = undefined;
    this.stalled = false;
    this.stallQueue.length = 0;
    this.connectStartedAt = Date.now();
    this.lastActivityAt = 0;
    void this.openSocket(generation);
  }

  private initializeSocket(socket: net.Socket, generation: number): void {
    this.socket = socket;
    this.socket.setKeepAlive(true, 30_000); // surface dead peers at the OS level
    this.io = new PacketIO({ socket: this.socket });
    this.bridgedPacketTypes.clear();
    this.installStallGate();
    this.io.setMaxListeners(config.maxEventListeners);
    this.io.on('error', (err: Error) => console.error(`${this.tag} io error:`, err.message));
    this.setupPacketTraffic();
    this.registerHandlers();
    this.setupDebug();
    if (this.combat) {
      this.combatTimer = this.timers.setInterval(() => this.updateCombat(this.time()), 16);
    }

    this.socket.on('close', () => {
      if (!this.lifecycle.isCurrent(generation)) {
        return;
      }
      const state = this.lifecycle.current;
      const unexpected =
        state !== ClientLifecycleState.Stopped && state !== ClientLifecycleState.Reconnecting;
      if (unexpected) {
        this.lifecycle.transition(ClientLifecycleState.Disconnected);
      }
      this.stopWatchdog();
      this.timers.clear(this.combatTimer);
      this.combatTimer = undefined;
      if (this.stalled) {
        this.unstall();
      }
      console.log(`${this.tag} socket closed`);
      this.emit(ClientEvent.Disconnect);
      if (unexpected) {
        this.scheduleBackoffReconnect();
      }
    });
    this.socket.on('error', (err) => {
      if (this.lifecycle.isCurrent(generation)) {
        console.error(`${this.tag} socket error:`, err.message);
      }
    });
  }

  private async openSocket(generation: number): Promise<void> {
    try {
      if (this.opts.proxy) {
        console.log(
          `${this.tag} connecting to ${this.host}:${this.port} via ${proxyConfigToUrl(this.opts.proxy, false)}`,
        );
        const socket = await connectThroughProxy(this.opts.proxy, this.host, this.port);
        if (!this.lifecycle.isCurrent(generation)) {
          socket.destroy();
          return;
        }
        this.initializeSocket(socket, generation);
        this.startWatchdog(generation);
        await this.handleSocketConnected(generation);
        return;
      }

      const socket = new net.Socket();
      this.initializeSocket(socket, generation);
      socket.once('connect', () => {
        // Refresh credentials before Hello so a long-lived process never sends an
        // expired access token on reconnect, then send Hello.
        void this.handleSocketConnected(generation);
      });
      this.startWatchdog(generation);
      console.log(`${this.tag} connecting to ${this.host}:${this.port}`);
      socket.connect(this.port, this.host);
    } catch (error) {
      if (!this.lifecycle.isCurrent(generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${this.tag} connection failed: ${message}`);
      this.lifecycle.transition(ClientLifecycleState.Disconnected);
      this.emit(ClientEvent.Disconnect);
      this.scheduleBackoffReconnect();
    }
  }

  /** Refreshes credentials (if a provider is configured) then sends Hello. */
  private async handleSocketConnected(generation: number): Promise<void> {
    if (!this.lifecycle.isCurrent(generation)) {
      return;
    }
    try {
      await this.ensureCredentials();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${this.tag} credential refresh failed on connect: ${message} — will retry`);
      if (this.lifecycle.isCurrent(generation)) {
        this.destroySocket(); // triggers the close handler → backoff reconnect
      }
      return;
    }
    if (!this.lifecycle.isCurrent(generation) || !this.socket || this.socket.destroyed) {
      return; // stopped, reconnected, or watchdog-killed while awaiting the refresh
    }
    this.lifecycle.transition(ClientLifecycleState.Connected);
    // Note: lastActivityAt stays 0 until the server actually sends a packet, so
    // the handshake timeout bounds "connected but server never replied to Hello".
    console.log(`${this.tag} socket connected → sending Hello (gameId ${this.gameId})`);
    this.sendHello();
    this.emit(ClientEvent.Connected);
  }

  /** Pulls fresh credentials from the account layer, if a provider was supplied. */
  private async ensureCredentials(): Promise<void> {
    if (!this.opts.refreshCredentials) {
      return;
    }
    const creds = await this.opts.refreshCredentials();
    this.accessToken = creds.accessToken;
    this.clientToken = creds.clientToken;
  }

  /** Starts the connection watchdog (handshake timeout + in-world liveness). */
  private startWatchdog(generation: number): void {
    this.stopWatchdog();
    if (config.watchdogIntervalMs <= 0) {
      return;
    }
    this.watchdogTimer = this.timers.setInterval(
      () => this.checkLiveness(generation),
      config.watchdogIntervalMs,
    );
  }

  /** Stops the connection watchdog, if running. */
  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      this.timers.clear(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Force-reconnects a wedged connection: a handshake that never completes, or
   * an in-world connection that has gone silent (TCP still open but no packets).
   * Destroying the socket fires the close handler, which schedules the reconnect.
   */
  private checkLiveness(generation: number): void {
    if (!this.lifecycle.isCurrent(generation) || this.stalled) {
      return; // stale generation, or an intentional stall probe is in progress
    }
    const state = this.lifecycle.current;
    if (
      state === ClientLifecycleState.Idle ||
      state === ClientLifecycleState.Stopped ||
      state === ClientLifecycleState.Reconnecting ||
      state === ClientLifecycleState.Disconnected
    ) {
      return; // nothing to supervise between connections
    }
    const now = Date.now();
    // Before the server sends its first packet, bound the handshake (covers both
    // "TCP never connected" and "connected but no reply to Hello").
    if (this.lastActivityAt === 0) {
      if (config.connectTimeoutMs > 0 && now - this.connectStartedAt > config.connectTimeoutMs) {
        console.warn(
          `${this.tag} ⌛ no server response within ${config.connectTimeoutMs}ms of connecting — forcing reconnect`,
        );
        this.destroySocket();
      }
      return;
    }
    // Once traffic has started — handshake, login queue, or in-world — require it
    // to keep flowing. Periodic packets (QueueInfo, NewTick) keep this fed, so a
    // legitimately long queue is safe; a silent-but-open socket is not.
    if (config.livenessTimeoutMs > 0 && now - this.lastActivityAt > config.livenessTimeoutMs) {
      console.warn(
        `${this.tag} 💤 no server traffic for ${now - this.lastActivityAt}ms — connection is dead, forcing reconnect`,
      );
      this.destroySocket();
    }
  }

  /** Schedules a reconnect after an unexpected drop, with exponential backoff + jitter. */
  private scheduleBackoffReconnect(): void {
    if (this.giveUp) {
      return;
    }
    const delay = backoffDelay(this.reconnectAttempts, config.reconnectBaseMs, config.reconnectMaxMs);
    this.reconnectAttempts++;
    console.log(`${this.tag} reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);
    this.scheduleReconnect(delay);
  }

  /**
   * Reports unknown packet ids once and, when DEBUG_PACKETS is set, logs raw
   * packet traffic for protocol debugging.
   */
  private setupDebug(): void {
    this.io.on('unknownPacket', ({ id, size }: { id: number; size: number }) => {
      if (this.seenUnknown.has(id)) {
        return;
      }
      this.seenUnknown.add(id);
      console.log(`${this.tag} ⚠️ unknown packet id ${id} (${size}b) — not in packet map`);
    });

    const mode = process.env.DEBUG_PACKETS;
    if (!mode) {
      return;
    }
    this.io.on('rawPacket', (raw: RawPacket) => {
      if (mode === 'unknown' && raw.type) {
        return;
      }
      const label = raw.type ?? `UNKNOWN(${raw.id})`;
      console.log(`${this.tag} « ${label} [id ${raw.id}, ${raw.payload.length}b]`);
      if (mode === 'hex' || (mode === 'unknown' && !raw.type)) {
        console.log(hexdump(raw.payload));
      }
    });
    if (mode !== 'unknown') {
      this.io.on('sentPacket', (sent: { id: number; type: string; size: number }) => {
        console.log(`${this.tag} » ${sent.type} [id ${sent.id}, ${sent.size}b]`);
      });
    }
  }

  /** Sends the Hello packet for the current host, game id, and reconnect key. */
  private sendHello(): void {
    const hello = new HelloPacket();
    hello.gameId = this.gameId;
    hello.buildVersion = BUILD_VERSION;
    hello.accessToken = this.accessToken;
    hello.keyTime = this.keyTime;
    hello.key = this.key;
    hello.gameNet = 'rotmg';
    hello.playPlatform = 'rotmg';
    hello.platformToken = '';
    hello.userToken = this.clientToken;
    hello.clientToken = HELLO_TOKEN;
    this.io.send(hello);
  }

  /** Registers core packet handlers on the current PacketIO instance. */
  private registerHandlers(): void {
    // Any inbound packet is a sign of life; feeds the liveness watchdog.
    this.io.on('rawPacket', () => {
      this.lastActivityAt = Date.now();
    });
    this.io.on(PacketType.MAPINFO, (p: MapInfoPacket)                     => this.handleMapInfo(p));
    this.io.on(PacketType.CREATE_SUCCESS, (p: CreateSuccessPacket)        => this.handleCreateSuccess(p));
    this.io.on(PacketType.UPDATE, (p: UpdatePacket)                       => this.handleUpdate(p));
    this.io.on(PacketType.NEWTICK, (p: NewTickPacket)                     => this.handleNewTick(p));
    this.io.on(PacketType.PING, (p: PingPacket)                           => this.handlePing(p));
    this.io.on(PacketType.SERVERPLAYERSHOOT, (p: ServerPlayerShootPacket) => this.handleServerPlayerShoot(p));
    this.io.on(PacketType.ENEMYSHOOT, (p: EnemyShootPacket)               => this.handleEnemyShoot(p));
    this.io.on(PacketType.AOE, (p: AoePacket)                             => this.handleAoe(p));
    this.io.on(PacketType.DAMAGE, (p: DamagePacket)                       => this.handleDamage(p));
    this.io.on(PacketType.GOTO, (p: GotoPacket)                           => this.handleGoto(p));
    this.io.on(PacketType.VAULT_CONTENT,  (p: VaultContentPacket)         => this.handleVaultContent(p));
    this.io.on(PacketType.INVRESULT, (p: InvResultPacket)                 => this.handleInvResult(p));
    this.io.on(PacketType.QUEUE_INFORMATION, (p: QueueInfoPacket)         => this.handleQueueInformation(p));
    this.io.on(PacketType.RECONNECT, (p: ReconnectPacket)                 => this.handleReconnect(p));
    this.io.on(PacketType.FAILURE, (p: FailurePacket)                     => this.handleFailure(p));
    this.io.on(PacketType.DEATH, (p: DeathPacket)                         => this.handleDeath(p));

    // Re-attach plugin packet hooks: bridge every subscribed type onto this io.
    for (const type of this.subscribedPacketTypes) {
      this.bridgePacket(type);
    }
  }

  /** Handles map metadata, then creates or loads the configured character. */
  private handleMapInfo(p: MapInfoPacket): void {
    console.log(`${this.tag} ✓ MapInfo accepted: "${p.name}" (${p.width}x${p.height})`);
    this.mapName = p.name;
    this.mapWidth = p.width;
    this.mapHeight = p.height;
    this.pathfinder.setMapBounds(p.width, p.height);
    this.enteringVault = false;
    this.inVault = /vault/i.test(p.name);
    this.autoNexus.reset();
    this.autoNexus.setSafeMap(isAutoNexusSafeMap(p.name));
    if (p.name.trim().toLowerCase() === 'nexus') {
      this.nexusHost = this.host;
      this.nexusPort = this.port;
    }
    // Reached a pending non-vault portal destination? Clear the intent.
    if (this.pendingPortal?.arrived.test(p.name)) {
      console.log(`${this.tag} arrived at ${this.pendingPortal.label}`);
      this.pendingPortal = undefined;
    }
    if (this.inQueue) {
      console.log(`${this.tag} cleared queue — entering`);
      this.inQueue = false;
    }
    this.emit(ClientEvent.MapChange, p.name);
    if (this.inVault) {
      console.log(`${this.tag} entered Vault`);
      this.emit(ClientEvent.EnterVault);
    } else if (this.isInPetYard()) {
      console.log(`${this.tag} entered Pet Yard`);
      this.emit(ClientEvent.EnterPetYard);
    } else if (p.name === 'Nexus') {
      console.log(`${this.tag} entered Nexus`);
      this.emit(ClientEvent.EnterNexus);
    }
    if (this.opts.needsNewChar) {
      this.createCharacter();
    } else {
      const load = new LoadPacket();
      load.charId = this.opts.charId;
      load.isFromArena = false;
      console.log(`${this.tag} loading character ${this.opts.charId}`);
      this.io.send(load);
    }
  }

  /** Records the assigned player object id and initializes ally-shot visibility. */
  private handleCreateSuccess(p: CreateSuccessPacket): void {
    this.lifecycle.transition(ClientLifecycleState.InWorld);
    this.reconnectAttempts = 0; // a successful entry resets the backoff ramp
    this.objectId = p.objectId;
    this.lastFrameTime = this.time();
    console.log(`${this.tag} ✓✓ IN-WORLD as objectId ${p.objectId}`);
    const show = new ChangeAllyShootPacket();
    // ProdMafia and Exalt send 0 for the normal "show ally shots" preference.
    show.toggle = 0;
    this.io.send(show);
    this.emit(ClientEvent.Ready, p.objectId);
  }

  /** Acknowledges object updates and refreshes tracked entities and portals. */
  private handleUpdate(p: UpdatePacket): void {
    this.io.send(new UpdateAckPacket());
    if (!this.posKnown && p.pos) {
      this.pos = { x: p.pos.x, y: p.pos.y };
      this.posKnown = true;
    }
    for (const tile of p.tiles) {
      this.tiles.set(`${tile.x},${tile.y}`, { x: tile.x, y: tile.y, type: tile.type });
      this.pathfinder.observeTile(tile.x, tile.y, tile.type);
    }
    for (const obj of p.newObjects) {
      if (obj.status.objectId === this.objectId) {
        this.pos = { x: obj.status.pos.x, y: obj.status.pos.y };
        this.posKnown = true;
        this.player = processObject(obj);
        this.reconcilePlayerHealth(this.player, true);
        this.capturePetObjectId(obj.status.stats);
        this.captureContainerSlots(obj.status.objectId, obj.status.stats);
      } else {
        this.captureContainerSlots(obj.status.objectId, obj.status.stats);
        this.objects.set(obj.status.objectId, {
          objectId: obj.status.objectId,
          type: obj.objectType,
          x: obj.status.pos.x,
          y: obj.status.pos.y,
          name: this.objectName(obj),
          player: processObject(obj),
          rawStats: this.rawStats(obj.status.stats),
        });
        this.pathfinder.upsertObject(
          obj.status.objectId,
          obj.objectType,
          obj.status.pos.x,
          obj.status.pos.y,
        );
        this.recentObjectTypes.set(obj.status.objectId, obj.objectType);
        if (obj.objectType === PortalType.RealmPortal) {
          this.trackRealmPortal(obj.status);
        }
      }
    }
    for (const id of p.drops) {
      this.objects.delete(id);
      this.pathfinder.removeObject(id);
      this.portalTracker.delete(id);
    }
    this.maybeDumpObjects();
    this.findVaultPortal();
    this.findPendingPortal();
  }

  /** Drives each game tick: movement, status updates, portal use, and events. */
  private handleNewTick(p: NewTickPacket): void {
    const now = this.time();
    const dt = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0;
    this.lastFrameTime = now;
    this.lastTickId = p.tickId;
    this.lastTickTime = p.tickTime;
    this.tickCount++;
    this.updateTarget(dt);
    this.sendMove(p, now);
    this.updateStatuses(p);
    this.updateCombat(now);
    this.tryUseVaultPortal();
    this.tryUsePendingPortal();
    //this.logAlive(p);
    this.emit(ClientEvent.Tick, this.player);
  }

  /** Advances locally simulated projectiles against the latest world snapshot. */
  private updateCombat(now: number): void {
    this.combat?.update(now, {
      playerId: this.objectId,
      playerPos: this.serverPos ?? this.pos,
      mapWidth: this.mapWidth,
      mapHeight: this.mapHeight,
      entities: this.objects.values(),
      tiles: this.tiles.values(),
    });
    this.updateGroundDamage(now);
    this.autoCombat?.update(now, {
      inWorld: this.isInWorld(),
      safeMap: this.isInNexus() || this.isInVault() || this.isInPetYard()
        || /guild\s*hall|daily\s*quest|quest\s*room/i.test(this.mapName),
      player: this.player,
      playerPos: this.serverPos ?? this.pos,
      objects: this.objects.values(),
    }, {
      shootAt: (target, weaponSlot) => this.commands.shootAt(target, weaponSlot),
      useAbilityAt: (target) => this.commands.useAbilityAt(target),
    });
  }

  /** Mirrors the current client's 500 ms damaging-ground prediction and acknowledgement. */
  private updateGroundDamage(now: number): void {
    const data = this.opts.combatData;
    if (!data?.getTileDamage || !this.posKnown || now - this.lastGroundDamageAt <= 500) return;

    const playerPos = this.serverPos ?? this.pos;
    const tileX = Math.floor(playerPos.x);
    const tileY = Math.floor(playerPos.y);
    const tile = this.tiles.get(`${tileX},${tileY}`);
    if (!tile) return;
    const damage = data.getTileDamage(tile.type) ?? 0;
    if (damage <= 0) return;

    for (const object of this.objects.values()) {
      if (
        Math.floor(object.x) === tileX &&
        Math.floor(object.y) === tileY &&
        data.getObject(object.type)?.protectFromGroundDamage
      ) {
        return;
      }
    }

    const condition = (this.player?.condition ?? 0) >>> 0;
    if (
      (condition & ConditionEffectBits.INVINCIBLE) !== 0 ||
      (condition & ConditionEffectBits.INVULNERABLE) !== 0
    ) {
      return;
    }

    this.lastGroundDamageAt = now;
    if (this.recordDamageTaken(damage, 'ground')) return;

    const ground = new GroundDamagePacket();
    ground.time = Math.trunc(now);
    ground.position.x = playerPos.x;
    ground.position.y = playerPos.y;
    this.io.send(ground);
  }

  /** Advances the local position toward a requested movement target. */
  private updateTarget(dt: number): void {
    if (!this.pathfinder.hasTarget()) {
      if (!this.movement.hasTarget()) {
        return;
      }
      const direct = this.movement.update(
        {
          localPos: this.pos,
          serverPos: this.serverPos,
          playerSpeed: this.player?.spd ?? 0,
          playerSpeedBoost: this.player?.spdBoost ?? 0,
        },
        dt,
      );
      this.pos = direct.pos;
      if (direct.stalled && this.serverPos) {
        console.warn(
          `${this.tag} direct movement stalled - server stuck ${direct.stalled.distance.toFixed(1)} tiles from target ` +
            `at (${this.serverPos.x.toFixed(2)},${this.serverPos.y.toFixed(2)})`,
        );
      }
      if (direct.reached) {
        console.log(`${this.tag} reached move target`);
        this.emit(ClientEvent.ReachedTarget, direct.reached);
      }
      return;
    }
    const authoritativePos = this.serverPos ?? this.pos;
    const navigation = this.pathfinder.next(authoritativePos);
    if (navigation.reached) {
      this.movement.clear();
      console.log(`${this.tag} reached move target`);
      this.emit(ClientEvent.ReachedTarget, navigation.reached);
      return;
    }
    if (!navigation.waypoint || navigation.waypointThreshold === undefined) {
      this.movement.clear();
      if (navigation.noPath && navigation.replanned) {
        const target = this.pathfinder.getTarget();
        console.warn(
          `${this.tag} no path to (${target?.x.toFixed(2)},${target?.y.toFixed(2)}) with current map knowledge`,
        );
      }
      return;
    }
    const activeWaypoint = this.movement.getTarget();
    if (!activeWaypoint
      || activeWaypoint.x !== navigation.waypoint.x
      || activeWaypoint.y !== navigation.waypoint.y
      || activeWaypoint.threshold !== navigation.waypointThreshold) {
      this.movement.setTarget(navigation.waypoint, navigation.waypointThreshold);
    }
    const update = this.movement.update(
      {
        localPos: this.pos,
        serverPos: this.serverPos,
        playerSpeed: this.player?.spd ?? 0,
        playerSpeedBoost: this.player?.spdBoost ?? 0,
      },
      dt,
    );
    this.pos = update.pos;
    if (update.stalled && this.serverPos) {
      this.pathfinder.reportStall(this.serverPos);
      this.movement.clear();
      console.warn(
        `${this.tag} movement stalled ${update.stalled.distance.toFixed(1)} tiles from waypoint at ` +
          `(${this.serverPos.x.toFixed(2)},${this.serverPos.y.toFixed(2)}); marking the next tile blocked and replanning`,
      );
    }
  }

  /** Sends the MOVE packet required every tick to keep the client alive. */
  private sendMove(p: NewTickPacket, now: number): void {
    const move = new MovePacket();
    move.tickId = p.tickId;
    move.time = p.serverRealTimeMS;
    const record = new MoveRecord();
    record.time = now;
    record.x = this.pos.x;
    record.y = this.pos.y;
    move.records = [record]; // must send >= 1 record or the server drops us
    this.io.send(move);
  }

  /** Applies per-object status deltas from the tick to player and portal state. */
  private updateStatuses(p: NewTickPacket): void {
    let selfUpdated = false;
    for (const status of p.statuses) {
      if (status.objectId === this.objectId) {
        this.serverPos = { x: status.pos.x, y: status.pos.y };
        this.player = processObjectStatus(status, this.player);
        selfUpdated = true;
        this.capturePetObjectId(status.stats);
        this.captureContainerSlots(status.objectId, status.stats);
      } else {
        this.captureContainerSlots(status.objectId, status.stats);
        const tracked = this.objects.get(status.objectId);
        if (tracked) {
          tracked.x = status.pos.x;
          tracked.y = status.pos.y;
          this.pathfinder.upsertObject(status.objectId, tracked.type, tracked.x, tracked.y);
          tracked.player = processObjectStatus(status, tracked.player);
          Object.assign(tracked.rawStats ??= {}, this.rawStats(status.stats));
        }
        if (this.portalTracker.has(status.objectId)) {
          this.trackRealmPortal(status);
        }
      }
    }
    if (selfUpdated && this.player) {
      this.reconcilePlayerHealth(this.player);
    }
  }

  /** Emits any authoritative HP loss not already covered by local damage prediction. */
  private reconcilePlayerHealth(player: PlayerData, full = false): void {
    if (!full) {
      const state = this.autoNexus.getState();
      if (state.syncedHp !== null && state.predictedHp !== null) {
        const serverDrop = Math.max(0, state.syncedHp - player.hp);
        const predictedDamage = Math.max(0, state.syncedHp - state.predictedHp);
        const unreportedDamage = Math.max(0, serverDrop - predictedDamage);
        if (unreportedDamage > 0) this.recordDamageTaken(unreportedDamage, 'server');
      }
    }
    this.autoNexus.reconcileServerHp(player.hp, player.maxHP, full);
  }

  /** Re-emits raw traffic from each fresh PacketIO for fleet diagnostics. */
  private setupPacketTraffic(): void {
    this.io.on('rawPacket', (raw: RawPacket) => {
      this.emit(ClientEvent.PacketTraffic, {
        direction: 'incoming',
        id: raw.id,
        type: raw.type,
        size: raw.payload.length + 5,
        payload: raw.payload,
        timestamp: Date.now(),
      });
    });
    this.io.on('sentRawPacket', (raw: RawOutgoingPacket) => {
      this.emit(ClientEvent.PacketTraffic, {
        direction: 'outgoing',
        id: raw.id,
        type: raw.type,
        size: raw.size,
        payload: raw.payload,
        timestamp: Date.now(),
      });
    });
  }

  private rawStats(stats: Array<{ statType: number; statValue: number; stringStatValue: string }>): Record<string, number | string> {
    const result: Record<string, number | string> = {};
    for (const stat of stats) {
      result[String(stat.statType)] = stat.stringStatValue !== '' ? stat.stringStatValue : stat.statValue;
    }
    return result;
  }

  /** Sends USE_PORTAL once the vault target has been reached. */
  private tryUseVaultPortal(): void {
    if (
      this.vaultPortalId === undefined ||
      this.pathfinder.hasTarget() ||
      this.inVault ||
      this.enteringVault ||
      this.usePortalAttempts >= 5 ||
      this.tickCount - this.lastUsePortalTick < 4
    ) {
      return;
    }
    const sp = this.serverPos;
    console.log(
      `${this.tag} → UsePortal(${this.vaultPortalId}) (attempt ${this.usePortalAttempts + 1}) ` +
        `local (${this.pos.x.toFixed(2)},${this.pos.y.toFixed(2)}) ` +
        `server ${sp ? `(${sp.x.toFixed(2)},${sp.y.toFixed(2)})` : '?'}`,
    );
    this.usePortal(this.vaultPortalId);
    this.lastUsePortalTick = this.tickCount;
    this.usePortalAttempts++;
  }

  /** Sends USE_PORTAL once the pending-portal target has been reached (mirrors tryUseVaultPortal). */
  private tryUsePendingPortal(): void {
    const nav = this.pendingPortal;
    if (
      !nav ||
      nav.portalId === undefined ||
      this.pathfinder.hasTarget() ||
      nav.attempts >= 5 ||
      this.tickCount - nav.lastTick < 4
    ) {
      return;
    }
    console.log(`${this.tag} → UsePortal(${nav.portalId}) ${nav.label} (attempt ${nav.attempts + 1})`);
    this.usePortal(nav.portalId);
    nav.lastTick = this.tickCount;
    nav.attempts++;
  }

  /** Emits a periodic compact heartbeat with basic character state. */
  private logAlive(p: NewTickPacket): void {
    // tickCount is advanced once per tick in handleNewTick — do not increment here.
    if (this.tickCount % 30 !== 0) {
      return;
    }
    const stats = this.player
      ? `${parsePlayerClass(this.player.class)} lvl ${this.player.level} hp ${this.player.hp}/${this.player.maxHP}`
      : '';
    console.log(`${this.tag} alive — tick ${p.tickId}, pos (${this.pos.x.toFixed(1)}, ${this.pos.y.toFixed(1)}) ${stats}`);
  }

  /** Replies to server ping with the expected serial and current client time. */
  private handlePing(p: PingPacket): void {
    const pong = new PongPacket();
    pong.serial = p.serial;
    pong.time = this.time();
    this.io.send(pong);
  }

  /** Charges server-confirmed local damage that was not already predicted by projectile collision. */
  private handleDamage(p: DamagePacket): void {
    if (p.targetId !== this.objectId || p.damageAmount <= 0) return;
    const now = Date.now();
    for (const [key, at] of this.predictedPlayerDamage) {
      if (now - at > 5000) this.predictedPlayerDamage.delete(key);
    }
    const key = `${p.objectId}:${p.bulletId}`;
    if (this.predictedPlayerDamage.has(key)) {
      this.predictedPlayerDamage.delete(key);
      return;
    }
    this.recordDamageTaken(p.damageAmount, 'server', {
      ownerId: p.objectId,
      bulletId: p.bulletId,
    });
  }

  /** Acknowledges our own server-authoritative projectile events. */
  private handleServerPlayerShoot(p: ServerPlayerShootPacket): void {
    if (p.ownerId !== this.objectId) {
      return;
    }
    const ack = new ShootAckPacket();
    ack.time = this.lastFrameTime;
    ack.ackCount = 1;
    this.io.send(ack);
    this.combat?.trackOwnShoot(p, this.time());
  }

  /** Acknowledges enemy projectile events so the server does not drop us. */
  private handleEnemyShoot(p: EnemyShootPacket): void {
    const ack = new ShootAckPacket();
    ack.time = this.lastFrameTime;
    ack.ackCount = 1;
    this.io.send(ack);
    const ownerType = this.objects.get(p.ownerId)?.type ?? this.recentObjectTypes.get(p.ownerId);
    this.combat?.trackEnemyShoot(p, ownerType, this.time());
  }

  /** Processes and acknowledges an area attack using the current local frame state. */
  private handleAoe(p: AoePacket): void {
    const ackTime = this.time();
    const ack = new AoeAckPacket();
    ack.time = ackTime;

    if (!this.player) {
      this.io.send(ack);
      return;
    }

    ack.position.x = this.pos.x;
    ack.position.y = this.pos.y;
    if ((this.player.condition & ConditionEffectBits.INVINCIBLE) !== 0) {
      this.io.send(ack);
      return;
    }

    if (Math.hypot(this.pos.x - p.pos.x, this.pos.y - p.pos.y) < p.radius) {
      if (this.applyPredictedDamage(p.damage, p.armorPiercing, 'aoe')) {
        return;
      }
      this.applyAoeCondition(p.effect);
    }
    this.io.send(ack);
  }

  /** Mirrors the local condition mutation performed by ProdMafia's GameObject.damage. */
  private applyAoeCondition(effect: number): void {
    const player = this.player;
    const effectId = Math.trunc(effect);
    if (!player || !LOCALLY_APPLIED_AOE_EFFECTS.has(effectId)) return;

    if (effectId === AoeEffectId.Quiet) player.mp = 0;
    const condition = player.condition >>> 0;
    const condition2 = player.condition2 >>> 0;
    const immune =
      (effectId === AoeEffectId.Slowed && (condition2 & ConditionEffectBits2.SLOWED_IMMUNE) !== 0)
      || (effectId === AoeEffectId.Dazed && (condition2 & ConditionEffectBits2.DAZED_IMMUNE) !== 0)
      || (effectId === AoeEffectId.Stunned && (condition & ConditionEffectBits.STUN_IMMUNE) !== 0)
      || (effectId === AoeEffectId.Paralyzed && (condition2 & ConditionEffectBits2.PARALYZED_IMMUNE) !== 0)
      || (effectId === AoeEffectId.Stasis && (condition & ConditionEffectBits.STASIS_IMMUNE) !== 0)
      || (effectId === AoeEffectId.ArmorBroken && (condition & ConditionEffectBits.ARMOR_BROKEN_IMMUNE) !== 0)
      || (effectId === AoeEffectId.Petrified && (condition2 & ConditionEffectBits2.PETRIFIED_IMMUNE) !== 0)
      || (effectId === AoeEffectId.Curse && (condition2 & ConditionEffectBits2.CURSE_IMMUNE) !== 0);
    if (immune) return;

    if (effectId < 32) {
      player.condition = (condition | (1 << (effectId - 1))) >>> 0;
    } else {
      player.condition2 = (condition2 | (1 << (effectId - 32))) >>> 0;
    }
  }

  /** Applies ProdMafia's local player-damage formula before hit acknowledgements. */
  private applyPredictedDamage(
    baseDamage: number,
    armorPiercing: boolean,
    source: Exclude<AutoNexusTriggerSource, 'server'>,
    projectile?: { ownerId: number; bulletId: number },
  ): boolean {
    const player = this.player;
    if (!player) return false;
    const condition = player.condition >>> 0;
    const condition2 = player.condition2 >>> 0;
    const damage = calculateAutoNexusDamage({
      baseDamage,
      defense: player.def,
      armorPiercing,
      armorBroken: (condition & ConditionEffectBits.ARMOR_BROKEN) !== 0,
      armored: (condition & ConditionEffectBits.ARMORED) !== 0,
      invincible: (condition & ConditionEffectBits.INVINCIBLE) !== 0,
      invulnerable: (condition & ConditionEffectBits.INVULNERABLE) !== 0,
      exposed: (condition2 & ConditionEffectBits2.EXPOSED) !== 0,
      petrified: (condition2 & ConditionEffectBits2.PETRIFIED) !== 0,
      cursed: (condition2 & ConditionEffectBits2.CURSE) !== 0,
    });
    return this.recordDamageTaken(damage, source, projectile);
  }

  private recordDamageTaken(
    amount: number,
    source: AutoNexusTriggerSource,
    projectile?: { ownerId: number; bulletId: number },
  ): boolean {
    const damage = Math.max(0, Math.trunc(Number(amount) || 0));
    if (damage <= 0) return false;
    if (source === 'projectile' && projectile) {
      this.predictedPlayerDamage.set(`${projectile.ownerId}:${projectile.bulletId}`, Date.now());
    }

    const state = this.autoNexus.getState();
    const currentHp = state.predictedHp ?? this.player?.hp ?? null;
    const maxHp = state.maxHp ?? this.player?.maxHP ?? null;
    this.emit(ClientEvent.DamageTaken, {
      amount: damage,
      source,
      hp: currentHp === null ? null : Math.max(0, currentHp - damage),
      maxHp,
      ...projectile,
    });
    return this.autoNexus.applyDamage(damage, source);
  }

  /** Acknowledges server position corrections. */
  private handleGoto(_p: GotoPacket): void {
    const ack = new GotoAckPacket();
    ack.time = this.lastFrameTime;
    this.io.send(ack);
  }

  /** Logs parsed vault storage sections and emits them for plugins. */
  private handleVaultContent(p: VaultContentPacket): void {
    this.inVault = true;
    this.lastVaultContent = {
      lastVaultPacket: p.lastVaultPacket,
      vaultUpgradeCost: p.vaultUpgradeCost,
      materialUpgradeCost: p.materialUpgradeCost,
      potionUpgradeCost: p.potionUpgradeCost,
      currentPotionMax: p.currentPotionMax,
      nextPotionMax: p.nextPotionMax,
      at: new Date().toISOString(),
      sections: [
        { key: 'vault', label: 'Vault', objectId: p.chestObjectId, contents: [...p.vaultContents] },
        { key: 'material', label: 'Materials', objectId: p.materialObjectId, contents: [...p.materialContents] },
        { key: 'gift', label: 'Gift Chest', objectId: p.giftObjectId, contents: [...p.giftContents] },
        { key: 'potion', label: 'Potion Storage', objectId: p.potionObjectId, contents: [...p.potionContents] },
        { key: 'spoils', label: 'Spoils Chest', objectId: p.spoilsObjectId, contents: [...p.spoilsContents] },
      ],
    };
    for (const section of this.lastVaultContent.sections) {
      this.containerSlotItems.set(
        section.objectId,
        new Map(section.contents.map((itemType, slotId) => [slotId, itemType])),
      );
    }
    const line = (label: string, slots: number[]): string => {
      const items = slots.filter((id) => id !== -1);
      const list = items.length ? ` → [${items.join(', ')}]` : '';
      return `${this.tag}    ${label}: ${slots.length} slots, ${items.length} items${list}`;
    };
    console.log(`${this.tag} 🏛  VAULT_CONTENT received:`);
    console.log(line('vault   ', p.vaultContents));
    console.log(line('material', p.materialContents));
    console.log(line('gift    ', p.giftContents));
    console.log(line('potion  ', p.potionContents));
    console.log(line('spoils  ', p.spoilsContents));
    this.emit(ClientEvent.VaultContents, p);
  }

  /** Logs and stores server confirmation/rejection of the last INVSWAP. */
  private handleInvResult(p: InvResultPacket): void {
    this.lastInvResult = {
      ok: p.success,
      code: p.ackType,
      flags: p.flags,
      from: {
        objectId: p.fromSlot.objectId,
        slotId: p.fromSlot.slotId,
        itemType: p.fromSlot.objectType,
      },
      to: {
        objectId: p.toSlot.objectId,
        slotId: p.toSlot.slotId,
        itemType: p.toSlot.objectType,
      },
      at: new Date().toISOString(),
    };
    if (p.success && !p.isUseItemAck()) {
      this.applyInvResultSlot(p.fromSlot.objectId, p.fromSlot.slotId, p.fromSlot.objectType);
      this.applyInvResultSlot(p.toSlot.objectId, p.toSlot.slotId, p.toSlot.objectType);
    }
    const origin = p.isUseItemAck() ? 'USEITEM' : 'INVSWAP';
    console.log(
      `${this.tag} INVRESULT ok=${p.success} ackType=${p.ackType} origin=${origin} flags=0x${p.flags.toString(16)} ` +
        `from(obj ${p.fromSlot.objectId} slot ${p.fromSlot.slotId} type ${p.fromSlot.objectType}) ` +
      `to(obj ${p.toSlot.objectId} slot ${p.toSlot.slotId} type ${p.toSlot.objectType})`,
    );
    this.emit(ClientEvent.InventoryResult, p);
  }

  /** Applies the server-authoritative post-swap item value to local container state. */
  private applyInvResultSlot(objectId: number, slotId: number, itemType: number): void {
    const slots = this.containerSlotItems.get(objectId) ?? new Map<number, number>();
    slots.set(slotId, itemType);
    this.containerSlotItems.set(objectId, slots);
    if (objectId === this.objectId && this.player) {
      this.player.inventory[slotId] = itemType;
    }
    const section = this.lastVaultContent?.sections.find((candidate) => candidate.objectId === objectId);
    if (section) {
      section.contents[slotId] = itemType;
    }
  }

  /** Tracks queue state while waiting for full maps. */
  private handleQueueInformation(p: QueueInfoPacket): void {
    this.inQueue = true;
    console.log(`${this.tag} in queue — position ${p.currentPosition}/${p.maxPosition}`);
  }

  /** Follows a server reconnect, preserving its destination game id and key. */
  private handleReconnect(p: ReconnectPacket): void {
    const ticket = this.rememberReconnectTicket(p);
    console.log(`${this.tag} reconnecting → ${ticket.host} (gameId ${ticket.gameId})`);
    this.reconnectAttempts = 0; // a server-directed reconnect is normal, not a failure
    this.clearMapState();
    this.clearNavState();
    this.enteringVault = /vault/i.test(ticket.name);
    this.host = ticket.host;
    this.port = ticket.port;
    this.gameId = ticket.gameId;
    this.key = [...ticket.key];
    this.keyTime = ticket.keyTime;
    this.lifecycle.transition(ClientLifecycleState.Reconnecting);
    this.destroySocket();
    // Track the timer so a concurrent connect()/connectToServer() can cancel it
    // (connect() clears reconnectTimer) instead of racing into a second socket.
    if (this.reconnectTimer) {
      this.timers.clear(this.reconnectTimer);
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 1000);
  }

  /** Destroys the active socket, if there is one, without touching state. */
  private destroySocket(): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  /**
   * Logs server failure packets, emits them for consumers, and drives recovery
   * based on the failure class: back off long on rate-limits, re-authenticate on
   * auth failures, give up on fatal/version errors, and let the socket close
   * drive the normal backoff reconnect for transient ones.
   */
  private handleFailure(p: FailurePacket): void {
    const failureClass = classifyFailure(p.errorDescription);
    console.error(
      `${this.tag} ❌ FAILURE ${p.errorId} (${this.describeFailure(p)}) [${failureClass}]: ${p.errorDescription}`,
    );
    this.emit(ClientEvent.Failure, p);
    switch (failureClass) {
      case 'rate-limited': {
        const mins = Math.round(config.rateLimitReconnectMs / 60000);
        console.error(`${this.tag} ⛔ rate-limited/banned — reconnecting in ${mins} min`);
        // A long fixed cooldown that overrides any short backoff a preceding
        // close may have scheduled; it is not part of the backoff ramp.
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
          this.timers.clear(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        this.scheduleReconnect(config.rateLimitReconnectMs);
        break;
      }
      case 'auth':
        // Stale/invalid token. The following socket close triggers the backoff
        // reconnect, and ensureCredentials() re-authenticates before Hello.
        console.error(`${this.tag} 🔑 auth failure — will re-authenticate on reconnect`);
        break;
      case 'fatal':
        console.error(`${this.tag} 🛑 fatal failure — not auto-reconnecting until a manual connect`);
        this.giveUp = true;
        if (this.reconnectTimer) {
          this.timers.clear(this.reconnectTimer);
          this.reconnectTimer = undefined;
        }
        break;
      case 'transient':
        // Let the socket close drive the normal backoff reconnect.
        break;
    }
  }

  /** Emits a death event for plugins and operators. */
  private handleDeath(p: DeathPacket): void {
    console.log(`${this.tag} 💀 died`);
    this.emit(ClientEvent.Death, p);
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function validMoveTarget(target: { x: number; y: number }, threshold: number): boolean {
  return Number.isFinite(target.x)
    && Number.isFinite(target.y)
    && Number.isFinite(threshold)
    && threshold >= 0;
}

function sameNumberArray(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isSlotObject(value: number | SlotObjectData): value is SlotObjectData {
  return typeof value === 'object' && value !== null &&
    Number.isInteger(value.objectId) && Number.isInteger(value.slotId) && Number.isInteger(value.objectType);
}

function slotRef(slot: SlotObjectData): SlotRef {
  return { objectId: slot.objectId, slotId: slot.slotId, itemType: slot.objectType };
}

function storageSectionKey(container: ItemContainer): 'vault' | 'material' | 'gift' | 'potion' | 'spoils' | undefined {
  switch (container) {
    case 'vault': return 'vault';
    case 'materialVault': return 'material';
    case 'giftChest': return 'gift';
    case 'potionVault': return 'potion';
    case 'spoilsChest': return 'spoils';
    default: return undefined;
  }
}

/** How a server FailurePacket should drive reconnection. */
export type FailureClass = 'rate-limited' | 'auth' | 'fatal' | 'transient';

/**
 * Classifies a FailurePacket description so the client can distinguish
 * "back off for minutes" from "re-authenticate" from "give up" from "just
 * reconnect". Pure and exported for testing.
 */
export function classifyFailure(description: string): FailureClass {
  const text = (description ?? '').toLowerCase();
  if (/banned|abuse|too many|rate limit|try again later/.test(text)) {
    return 'rate-limited';
  }
  if (/token|not verified|credential|invalid account|nonce|unauthorized/.test(text)) {
    return 'auth';
  }
  if (/update|version|out of date|outdated|unsupported client|please upgrade/.test(text)) {
    return 'fatal';
  }
  return 'transient';
}

/**
 * Exponential backoff with full jitter for reconnect scheduling. `attempt` is
 * the count of prior consecutive attempts (0 for the first). Pure and exported
 * for testing.
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, attempt), maxMs);
  // Full jitter: a random point in [base, exponential] keeps a sane floor while
  // de-synchronizing many clients reconnecting at once.
  return baseMs + Math.random() * Math.max(0, exponential - baseMs);
}

type GameIdConnectMode = 'ticket' | 'unkeyed';

/** In-progress navigation to a non-vault portal (pet yard / guild hall / …). */
interface PendingPortalNav {
  /** The portal object type to walk to. */
  type: PortalType;
  /** Human label for logging. */
  label: string;
  /** Map-name pattern that means we've arrived (clears the intent). */
  arrived: RegExp;
  /** The matched portal's object id, once found in the nexus. */
  portalId?: number;
  /** UsePortal attempts made so far (capped). */
  attempts: number;
  /** Tick of the last UsePortal attempt (throttles retries). */
  lastTick: number;
}

interface ReconnectTicket {
  id: number;
  name: string;
  host: string;
  port: number;
  gameId: number;
  keyTime: number;
  key: number[];
  capturedAt: string;
  usedAt?: string;
}

interface ReconnectTicketSummary {
  id: number;
  name: string;
  host: string;
  port: number;
  gameId: number;
  keyTime: number;
  keyLength: number;
  capturedAt: string;
  usedAt?: string;
}

interface InvResultSnapshot {
  ok: boolean;
  code: number;
  flags: number;
  from: { objectId: number; slotId: number; itemType: number };
  to: { objectId: number; slotId: number; itemType: number };
  at: string;
}

interface VaultContentSnapshot {
  lastVaultPacket: boolean;
  vaultUpgradeCost: number;
  materialUpgradeCost: number;
  potionUpgradeCost: number;
  currentPotionMax: number;
  nextPotionMax: number;
  at: string;
  sections: VaultSectionSnapshot[];
}

interface VaultSectionSnapshot {
  key: string;
  label: string;
  objectId: number;
  contents: number[];
}
