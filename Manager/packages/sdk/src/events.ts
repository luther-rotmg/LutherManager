import type {
  Unsubscribe,
  PlayerDiedEvent,
  EnemySpawnedEvent,
  MapChangedEvent,
  LevelUpEvent,
  ItemPickedUpEvent,
  PortalOpenedEvent,
  ConnectionEvent,
  ShotFiredEvent,
  DamageTakenEvent,
  CharacterFameThresholdEvent,
  PlayerNearbyEvent,
  PlayerNearbyOptions,
  GuildNearbyEvent,
  GuildNearbyOptions,
  GuildNearbyMatchMode,
  PlayerJoinPartyEvent,
  PlayerJoinPartyMatchMode,
} from './types/events';
import type { ChatHandler } from './types/chat';

const noopUnsub: Unsubscribe = () => {};

type OnGuildNearbyFn = {
  (guildName: string, handler: (e: GuildNearbyEvent) => void, options?: GuildNearbyOptions): Unsubscribe;
  (
    guildName: string,
    match: GuildNearbyMatchMode,
    handler: (e: GuildNearbyEvent) => void,
    options?: GuildNearbyOptions,
  ): Unsubscribe;
};

function onGuildNearbyStub(
  guildName: string,
  _matchOrHandler: GuildNearbyMatchMode | ((e: GuildNearbyEvent) => void),
  _handlerOrOptions?: ((e: GuildNearbyEvent) => void) | GuildNearbyOptions,
  _maybeOptions?: GuildNearbyOptions,
): Unsubscribe {
  void guildName;
  return noopUnsub;
}

type OnPlayerJoinPartyFn = {
  (playerName: string, handler: (e: PlayerJoinPartyEvent) => void): Unsubscribe;
  (
    playerName: string,
    match: PlayerJoinPartyMatchMode,
    handler: (e: PlayerJoinPartyEvent) => void,
  ): Unsubscribe;
};

function onPlayerJoinPartyStub(
  _playerName: string,
  _matchOrHandler: PlayerJoinPartyMatchMode | ((e: PlayerJoinPartyEvent) => void),
  _handler?: (e: PlayerJoinPartyEvent) => void,
): Unsubscribe {
  return noopUnsub;
}

/**
 * Game lifecycle and world events for scripts (`Hive.events`).
 *
 * In the **Hive** desktop client, `ScriptHost.installBridge()` replaces these
 * implementations so subscriptions receive real packets (see client `scripts/bridge/events`).
 * Outside the client, each method is a no-op stub that returns a dummy unsubscribe.
 */
export const events = {
  /** Fires on server `DEATH` (local character). */
  onPlayerDied(handler: (e: PlayerDiedEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires for each new `Enemy`-category object in server `UPDATE` (`newObjs`). */
  onEnemySpawned(handler: (e: EnemySpawnedEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Convenience filter over `onEnemySpawned`. */
  onEnemySpawnedOfType(objectType: number, handler: (e: EnemySpawnedEvent) => void): Unsubscribe {
    void objectType;
    void handler;
    return noopUnsub;
  },

  /** Fires on server `MAPINFO` after map name / dimensions are applied. */
  onMapChanged(handler: (e: MapChangedEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires on server `CREATESUCCESS` (character in game; includes `serverAddress`). */
  onConnected(handler: (e: ConnectionEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires when the proxy session ends (`clientDisconnected`). */
  onDisconnected(handler: (e: ConnectionEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires for each local PLAYERSHOOT packet sent by the selected account. */
  onShotFired(handler: (e: ShotFiredEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires for each locally predicted or server-confirmed hit on the selected account. */
  onDamageTaken(handler: (e: DamageTakenEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires when the local player’s level stat increases (observed on `NEWTICK`). */
  onLevelUp(handler: (e: LevelUpEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /**
   * Fires when a main-inventory slot (0–11) goes from empty to occupied (`UPDATE` / `NEWTICK`).
   * Backpack-only changes are not reported here.
   */
  onItemPickedUp(handler: (e: ItemPickedUpEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /** Fires for each new `Portal`-category object in server `UPDATE` (`newObjs`). */
  onPortalOpened(handler: (e: PortalOpenedEvent) => void): Unsubscribe {
    void handler;
    return noopUnsub;
  },

  /**
   * Fires once when local **character fame** (stat **57**) goes from **below** `threshold`
   * to **at or above** it (observed after `UPDATE` / `NEWTICK` applies `PlayerData`).
   */
  onCharacterFameAtLeast(threshold: number, handler: (e: CharacterFameThresholdEvent) => void): Unsubscribe {
    void threshold;
    void handler;
    return noopUnsub;
  },

  /**
   * Fires when any incoming chat line’s text **contains** `needle` (case-insensitive).
   * Payload is the same `ChatEvent` as `Hive.chat.onMessage` (`ChatHandler`).
   * Wired in the client via `Hive.chat` after the TEXT hook is installed.
   */
  onChat(needle: string, handler: ChatHandler): Unsubscribe {
    void needle;
    void handler;
    return noopUnsub;
  },

  /**
   * When any **tracked** player whose display name is in `names` comes within `radius` of you
   * (and on each **enter** after a baseline `NEWTICK`). Pass one string, an array, or an array built
   * from variables, e.g. `onPlayerNearby(['a', myFriend], handler)`.
   */
  onPlayerNearby(
    names: string | readonly string[],
    handler: (e: PlayerNearbyEvent) => void,
    options?: PlayerNearbyOptions,
  ): Unsubscribe {
    void names;
    void handler;
    void options;
    return noopUnsub;
  },

  /**
   * When a **non-local** player whose guild tag matches `guildName` is within `radius`
   * (default **12**), using **equals** (case-insensitive full tag) unless you pass **`'contains'`**
   * as the second argument for substring matching. Baseline `NEWTICK` does not fire; then fires
   * on each **enter**. Pass `guildName` from a variable as needed.
   */
  onGuildNearby: onGuildNearbyStub as OnGuildNearbyFn,

  /**
   * When a **non-local** player joins your party and their display name **equals** `playerName`
   * (case-insensitive), or **contains** it if you pass **`'contains'`** as the second argument.
   */
  onPlayerJoinParty: onPlayerJoinPartyStub as OnPlayerJoinPartyFn,
};

export type {
  PlayerDiedEvent,
  EnemySpawnedEvent,
  MapChangedEvent,
  LevelUpEvent,
  ItemPickedUpEvent,
  PortalOpenedEvent,
  ConnectionEvent,
  ShotFiredEvent,
  DamageTakenEvent,
  CharacterFameThresholdEvent,
  PlayerNearbyEvent,
  PlayerNearbyOptions,
  PlayerNearbyPlayer,
  GuildNearbyEvent,
  GuildNearbyOptions,
  GuildNearbyPlayer,
  GuildNearbyMatchMode,
  PlayerJoinPartyEvent,
  PlayerJoinPartyMatchMode,
} from './types/events';
