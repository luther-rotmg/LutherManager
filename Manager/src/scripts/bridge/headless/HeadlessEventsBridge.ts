import {
  events,
  type CharacterFameThresholdEvent,
  type ChatEvent,
  type ConnectionEvent,
  type DamageTakenEvent,
  type EnemySpawnedEvent,
  type GuildNearbyEvent,
  type GuildNearbyMatchMode,
  type GuildNearbyOptions,
  type ItemPickedUpEvent,
  type LevelUpEvent,
  type MapChangedEvent,
  type PlayerDiedEvent,
  type PlayerJoinPartyEvent,
  type PlayerJoinPartyMatchMode,
  type PlayerNearbyEvent,
  type PlayerNearbyOptions,
  type PortalOpenedEvent,
  type ShotFiredEvent,
} from '@hive/sdk';
import { ClientEvent, type Client, type TrackedObject } from 'headless-client';
import type { BridgeDeps } from '../BridgeDeps.js';
import { subscribeHeadlessChat } from './HeadlessChatBridge.js';
import { getHeadlessEnemyRows, getHeadlessPlayerRows, headlessObjectName } from './HeadlessWorldBridge.js';
import { subscribeHeadlessPartyJoin } from './HeadlessSocialBridge.js';

type Unsubscribe = () => void;

function active(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

function bound<T extends (...args: any[]) => any>(deps: BridgeDeps, handler: T): T {
  const session = deps.getScriptSession?.() ?? deps.scriptSession;
  if (!session.scriptId || !deps.runInScriptSession) return handler;
  return ((...args: Parameters<T>) => deps.runInScriptSession!(
    { scriptId: session.scriptId!, accountId: session.accountId },
    () => handler(...args),
  )) as T;
}

function onClient<E extends ClientEvent>(client: Client, event: E, listener: (...args: any[]) => void): Unsubscribe {
  client.on(event, listener as never);
  return () => client.off(event, listener as never);
}

function distance(client: Client, row: TrackedObject): number {
  const position = client.getPosition();
  return Math.hypot(row.x - position.x, row.y - position.y);
}

function playerName(row: TrackedObject): string {
  return row.player?.name || row.name || '';
}

export function installHeadlessEventsBridge(deps: BridgeDeps): void {
  events.onPlayerDied = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const callback = bound(deps, (packet: { killedBy?: string }) => handler({
      playerName: client.getPlayer()?.name ?? client.alias,
      isLocal: true,
      killedBy: packet.killedBy,
    } satisfies PlayerDiedEvent));
    return onClient(client, ClientEvent.Death, callback);
  };
  events.onEnemySpawned = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    let known = new Set(getHeadlessEnemyRows(deps, client).map((row) => row.objectId));
    const callback = bound(deps, () => {
      const rows = getHeadlessEnemyRows(deps, client);
      const next = new Set(rows.map((row) => row.objectId));
      for (const row of rows) {
        if (known.has(row.objectId)) continue;
        handler({ objectType: row.type, objectId: row.objectId, name: headlessObjectName(deps, row), position: { x: row.x, y: row.y } } satisfies EnemySpawnedEvent);
      }
      known = next;
    });
    return onClient(client, ClientEvent.Tick, callback);
  };
  events.onEnemySpawnedOfType = (objectType, handler) => events.onEnemySpawned((event) => {
    if (event.objectType === objectType) handler(event);
  });
  events.onMapChanged = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const callback = bound(deps, (mapName: string) => {
      const dimensions = client.getMapDimensions();
      handler({ mapName, ...dimensions } satisfies MapChangedEvent);
    });
    return onClient(client, ClientEvent.MapChange, callback);
  };
  events.onConnected = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const callback = bound(deps, () => handler({ serverAddress: client.getServerHost() } satisfies ConnectionEvent));
    return onClient(client, ClientEvent.Ready, callback);
  };
  events.onDisconnected = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const callback = bound(deps, () => handler({ serverAddress: client.getServerHost() } satisfies ConnectionEvent));
    return onClient(client, ClientEvent.Disconnect, callback);
  };
  events.onShotFired = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const callback = bound(deps, (event: ShotFiredEvent) => handler(event));
    return onClient(client, ClientEvent.ShotFired, callback);
  };
  events.onDamageTaken = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const callback = bound(deps, (event: DamageTakenEvent) => handler(event));
    return onClient(client, ClientEvent.DamageTaken, callback);
  };
  events.onLevelUp = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    let previous = client.getPlayer()?.level;
    const callback = bound(deps, () => {
      const level = client.getPlayer()?.level;
      if (level !== undefined && previous !== undefined && level > previous) handler({ newLevel: level } satisfies LevelUpEvent);
      previous = level;
    });
    return onClient(client, ClientEvent.Tick, callback);
  };
  events.onItemPickedUp = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    let previous = client.getInventory()?.slice();
    const callback = bound(deps, () => {
      const inventory = client.getInventory()?.slice();
      if (inventory && previous) {
        for (let index = 0; index < inventory.length; index++) {
          const item = inventory[index] ?? -1;
          if (item > 0 && item !== (previous[index] ?? -1)) {
            handler({ slotIndex: index, objectType: item, itemName: deps.gameData.buildSdkItem(item)?.name } satisfies ItemPickedUpEvent);
          }
        }
      }
      previous = inventory;
    });
    return onClient(client, ClientEvent.Tick, callback);
  };
  events.onPortalOpened = (handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const portals = () => client.visibleObjects().filter((row) => deps.gameData.getObjectCategory(row.type) === 'Portal');
    let known = new Set(portals().map((row) => row.objectId));
    const callback = bound(deps, () => {
      const rows = portals();
      const next = new Set(rows.map((row) => row.objectId));
      for (const row of rows) {
        if (!known.has(row.objectId)) handler({ portalName: headlessObjectName(deps, row), objectId: row.objectId, position: { x: row.x, y: row.y } } satisfies PortalOpenedEvent);
      }
      known = next;
    });
    return onClient(client, ClientEvent.Tick, callback);
  };
  events.onCharacterFameAtLeast = (threshold, handler) => {
    const client = active(deps);
    if (!client) return () => {};
    const target = Math.max(0, Number(threshold) || 0);
    let previous = client.getPlayer()?.currentFame ?? 0;
    const callback = bound(deps, () => {
      const fame = client.getPlayer()?.currentFame ?? 0;
      if (previous < target && fame >= target) handler({ fame, threshold: target } satisfies CharacterFameThresholdEvent);
      previous = fame;
    });
    return onClient(client, ClientEvent.Tick, callback);
  };
  events.onChat = (needle: string, handler: (event: ChatEvent) => void) => {
    const client = active(deps);
    if (!client) return () => {};
    const query = needle.trim().toLowerCase();
    const callback = bound(deps, (event: ChatEvent) => { if (event.message.toLowerCase().includes(query)) handler(event); });
    return subscribeHeadlessChat(deps, client, callback);
  };
  events.onPlayerNearby = (names: string | readonly string[], handler: (event: PlayerNearbyEvent) => void, options?: PlayerNearbyOptions) => {
    const client = active(deps);
    if (!client) return () => {};
    const watched = new Set((Array.isArray(names) ? names : [names]).map((name) => String(name).trim().toLowerCase()).filter(Boolean));
    const radius = Math.max(0, Number(options?.radius ?? 12));
    let previous: Set<number> | undefined;
    const callback = bound(deps, () => {
      const inRange = getHeadlessPlayerRows(deps, client)
        .filter((row) => row.objectId !== client.getObjectId() && watched.has(playerName(row).trim().toLowerCase()))
        .map((row) => ({ name: playerName(row), objectId: row.objectId, x: row.x, y: row.y, distance: distance(client, row) }))
        .filter((row) => row.distance <= radius);
      const next = new Set(inRange.map((row) => row.objectId));
      if (previous) {
        const entered = inRange.filter((row) => !previous!.has(row.objectId));
        if (entered.length) handler({ entered, inRange, radius } satisfies PlayerNearbyEvent);
      }
      previous = next;
    });
    return onClient(client, ClientEvent.Tick, callback);
  };
  events.onGuildNearby = ((guildName: string, matchOrHandler: GuildNearbyMatchMode | ((event: GuildNearbyEvent) => void), handlerOrOptions?: ((event: GuildNearbyEvent) => void) | GuildNearbyOptions, maybeOptions?: GuildNearbyOptions) => {
    const client = active(deps);
    if (!client) return () => {};
    const match = typeof matchOrHandler === 'string' ? matchOrHandler : 'equals';
    const handler = (typeof matchOrHandler === 'function' ? matchOrHandler : handlerOrOptions) as (event: GuildNearbyEvent) => void;
    const options = (typeof matchOrHandler === 'function' ? handlerOrOptions : maybeOptions) as GuildNearbyOptions | undefined;
    const query = guildName.trim().toLowerCase();
    const radius = Math.max(0, Number(options?.radius ?? 12));
    let previous: Set<number> | undefined;
    const callback = bound(deps, () => {
      const inRange = getHeadlessPlayerRows(deps, client).filter((row) => row.objectId !== client.getObjectId()).map((row) => {
        const guild = row.player?.guildName?.trim() ?? '';
        return { name: playerName(row), guildName: guild, objectId: row.objectId, x: row.x, y: row.y, distance: distance(client, row) };
      }).filter((row) => row.distance <= radius && (match === 'contains' ? row.guildName.toLowerCase().includes(query) : row.guildName.toLowerCase() === query));
      const next = new Set(inRange.map((row) => row.objectId));
      if (previous) {
        const entered = inRange.filter((row) => !previous!.has(row.objectId));
        if (entered.length) handler({ entered, inRange, radius } satisfies GuildNearbyEvent);
      }
      previous = next;
    });
    return onClient(client, ClientEvent.Tick, callback);
  }) as typeof events.onGuildNearby;
  events.onPlayerJoinParty = ((playerNameQuery: string, matchOrHandler: PlayerJoinPartyMatchMode | ((event: PlayerJoinPartyEvent) => void), handlerMaybe?: (event: PlayerJoinPartyEvent) => void) => {
    const client = active(deps);
    if (!client) return () => {};
    const match = typeof matchOrHandler === 'string' ? matchOrHandler : 'equals';
    const handler = (typeof matchOrHandler === 'function' ? matchOrHandler : handlerMaybe)!;
    const query = playerNameQuery.trim().toLowerCase();
    const callback = bound(deps, (member: { playerName: string; playerId: number; classId: number }) => {
      const name = member.playerName.trim().toLowerCase();
      if (match === 'contains' ? name.includes(query) : name === query) handler({ ...member });
    });
    return subscribeHeadlessPartyJoin(client, callback);
  }) as typeof events.onPlayerJoinParty;
}
