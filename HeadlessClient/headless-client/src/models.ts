import type { PlayerData } from 'realmlib';

/** A realm portal in the nexus, parsed from its NAME stat. */
export interface RealmPortal {
  objectId: number;
  /** The realm name, e.g. "Horizon". */
  name: string;
  /** Players currently in the realm. */
  players: number;
  /** Maximum players the realm holds. */
  maxPlayers: number;
  /** Server timestamp at which the realm opened. */
  openedAt: number;
  /** CONNECT_STAT primary value, when present on the portal status. */
  connectId?: number;
  /** CONNECT_STAT secondary value, when present on the portal status. */
  connectValueTwo?: number;
  x: number;
  y: number;
}

/** A visible object tracked from UPDATE/NEWTICK state. */
export interface TrackedObject {
  objectId: number;
  type: number;
  x: number;
  y: number;
  name?: string;
  /** Parsed status snapshot when the object is a player-class entity. */
  player?: PlayerData;
  /** Latest wire stats keyed by numeric stat id. */
  rawStats?: Record<string, number | string>;
}

/** A map tile learned from UPDATE packets. */
export interface TrackedTile {
  x: number;
  y: number;
  type: number;
}

/** Game server metadata from /char/list. */
export interface ClientServer {
  name: string;
  address: string;
}

/** Configuration for each Client. */
export interface ClientOptions {
  alias: string;
  /** Initial access token used for the first Hello. */
  accessToken: string;
  /** Initial client (user) token used for the first Hello. */
  clientToken: string;
  charId: number;
  needsNewChar: boolean;
  host: string;
  /** Full server list known when the client was created. */
  servers?: ClientServer[];
  /** Walk into the vault automatically once in the nexus. */
  autoEnterVault?: boolean;
  /**
   * Settings used when `needsNewChar` is true (or `createCharacter()` is
   * called). `createClassType` is a resolved numeric object type; defaults to
   * Wizard when omitted.
   */
  createClassType?: number;
  createSkin?: number;
  createSeasonal?: boolean;
  createChallenger?: boolean;
  /**
   * Supplies fresh credentials before every (re)connect so a long-running
   * client never sends an expired access token. Typically backed by the
   * cache-aware `login()`; omit to keep using the initial tokens (not
   * recommended for 24/7 operation).
   */
  refreshCredentials?: () => Promise<{ accessToken: string; clientToken: string }>;
}
