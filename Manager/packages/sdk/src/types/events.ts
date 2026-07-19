export type { Unsubscribe } from './chat';

export interface PlayerDiedEvent {
  playerName: string;
  isLocal: boolean;
  killedBy?: string;
}

export interface EnemySpawnedEvent {
  objectType: number;
  objectId: number;
  name: string;
  position: { x: number; y: number };
}

export interface MapChangedEvent {
  mapName: string;
  width: number;
  height: number;
}

export interface LevelUpEvent {
  newLevel: number;
}

export interface ItemPickedUpEvent {
  slotIndex: number;
  objectType: number;
  itemName?: string;
}

export interface PortalOpenedEvent {
  portalName: string;
  objectId: number;
  position: { x: number; y: number };
}

export interface ConnectionEvent {
  serverAddress?: string;
}

/** One local PLAYERSHOOT packet sent by the bound account. */
export interface ShotFiredEvent {
  bulletId: number;
  weaponType: number;
  attackIndex: number;
  angle: number;
}

/** Local damage predicted before acknowledgement or confirmed by the server. */
export interface DamageTakenEvent {
  amount: number;
  source: 'server' | 'projectile' | 'aoe' | 'ground' | 'condition';
  hp: number | null;
  maxHp: number | null;
  ownerId?: number;
  bulletId?: number;
}

/** Local player character fame (stat 57) crossed upward to at or above `threshold`. */
export interface CharacterFameThresholdEvent {
  fame: number;
  threshold: number;
}

export interface PlayerNearbyPlayer {
  name: string;
  objectId: number;
  x: number;
  y: number;
  distance: number;
}

/** A watched player (by display name) entered or is within the radius of the local player. */
export interface PlayerNearbyEvent {
  /** Names that crossed into `radius` since the last `NEWTICK` sample (not fired on the first baseline tick). */
  entered: PlayerNearbyPlayer[];
  /** All watched names currently within `radius`. */
  inRange: PlayerNearbyPlayer[];
  radius: number;
}

export interface PlayerNearbyOptions {
  /** Euclidean distance in world units (default **12**). */
  radius?: number;
}

export type GuildNearbyMatchMode = 'equals' | 'contains';

export interface GuildNearbyPlayer {
  name: string;
  /** Guild tag from player stat **62** (trimmed). */
  guildName: string;
  objectId: number;
  x: number;
  y: number;
  distance: number;
}

/** A player whose guild matches the watch entered within `radius` of you. */
export interface GuildNearbyEvent {
  /** Players that crossed into `radius` since the last `NEWTICK` sample (not fired on the first baseline tick). */
  entered: GuildNearbyPlayer[];
  /** All matching players currently within `radius`. */
  inRange: GuildNearbyPlayer[];
  radius: number;
}

export interface GuildNearbyOptions {
  /** Euclidean distance in world units (default **12**). */
  radius?: number;
}

export type PlayerJoinPartyMatchMode = 'equals' | 'contains';

/** A player matched by name joined your party (`PARTYMEMBERADDED`). */
export interface PlayerJoinPartyEvent {
  playerName: string;
  /** Roster member id — pass to `Luther.party.kick`. */
  playerId: number;
  classId: number;
}
