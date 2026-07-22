import {
  Enemies,
  Objects,
  Players,
  Position,
  Tiles,
  type Container,
  type Enemy,
  type GameObject,
  type MapTile,
  type ObjectCategory,
  type PlayerEntity,
  type PlayerNameMatchMode,
  type Portal,
  type Stats,
} from '@luthermanager/sdk';
import {
  PacketType,
  type Client,
  type QuestObjectIdPacket,
  type TrackedObject,
  type TrackedTile,
} from 'headless-client';
import { StatType } from '../../../constants/StatType.js';
import type { BridgeDeps } from '../BridgeDeps.js';
import { buildContainerItems, lootRarityForType } from '../loot/model.js';

const questIds = new WeakMap<Client, number>();
const questHooks = new WeakSet<Client>();

function active(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

function rawNumber(object: TrackedObject | undefined, stat: number, fallback = 0): number {
  const value = object?.rawStats?.[String(stat)];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rawString(object: TrackedObject, stat: number, fallback = ''): string {
  const value = object.rawStats?.[String(stat)];
  return value == null ? fallback : String(value);
}

function objectName(object: TrackedObject, deps: BridgeDeps): string {
  const def = deps.gameData.getObject(object.type);
  return object.name || rawString(object, StatType.NameStat) || def?.displayId || def?.id || `0x${object.type.toString(16)}`;
}

function baseObject(object: TrackedObject, deps: BridgeDeps): GameObject {
  return {
    objectId: object.objectId,
    objectType: object.type,
    name: objectName(object, deps),
    position: new Position(object.x, object.y),
  };
}

function statsFor(object: TrackedObject): Stats {
  const player = object.player;
  return {
    maxHP: player?.maxHP ?? rawNumber(object, StatType.MaxHP),
    maxMP: player?.maxMP ?? rawNumber(object, StatType.MaxMP),
    attack: player?.atk ?? rawNumber(object, StatType.Attack),
    defense: player?.def ?? rawNumber(object, StatType.Defense),
    speed: player?.spd ?? rawNumber(object, StatType.Speed),
    dexterity: player?.dex ?? rawNumber(object, StatType.Dexterity),
    vitality: player?.vit ?? rawNumber(object, StatType.Vitality),
    wisdom: player?.wis ?? rawNumber(object, StatType.Wisdom),
  };
}

function playerEntity(object: TrackedObject, deps: BridgeDeps): PlayerEntity {
  const player = object.player;
  const def = deps.gameData.getObject(object.type);
  return {
    ...baseObject(object, deps),
    hp: player?.hp ?? rawNumber(object, StatType.HP),
    maxHp: player?.maxHP ?? rawNumber(object, StatType.MaxHP),
    mp: player?.mp ?? rawNumber(object, StatType.MP),
    maxMp: player?.maxMP ?? rawNumber(object, StatType.MaxMP),
    stats: statsFor(object),
    className: player?.className || def?.displayId || def?.id || String(object.type),
  };
}

function enemyEntity(object: TrackedObject, deps: BridgeDeps): Enemy {
  const def = deps.gameData.getObject(object.type);
  const hp = rawNumber(object, StatType.HP, def?.maxHp ?? 0);
  const maxHp = rawNumber(object, StatType.MaxHP, def?.maxHp ?? hp);
  return {
    ...baseObject(object, deps),
    hp,
    maxHp,
    defense: rawNumber(object, StatType.Defense),
    stats: statsFor(object),
    phase: 0,
    isEnraged: false,
    isBoss: deps.gameData.isBoss(object.type, 5000),
  };
}

function portalEntity(object: TrackedObject, client: Client, deps: BridgeDeps): Portal & GameObject {
  const realm = client.realmPortals().find((candidate) => candidate.objectId === object.objectId);
  return {
    objectId: object.objectId,
    objectType: object.type,
    name: objectName(object, deps),
    position: new Position(object.x, object.y),
    isOpen: true,
    playerCount: realm?.players ?? 0,
    enter: () => client.enterPortal(object.objectId),
  };
}

function containerEntity(object: TrackedObject, client: Client, deps: BridgeDeps): Container {
  const def = deps.gameData.getObject(object.type);
  const stats = { ...(object.rawStats ?? {}) };
  for (const slot of client.getWorldContainerSlots(object.objectId)) {
    if (slot.slotId >= 0 && slot.slotId < 8) {
      stats[String(StatType.Inventory0 + slot.slotId)] = slot.objectType;
    }
  }
  const ownerName = stats[String(StatType.NameStat)];
  const ownerAccountId = stats[String(StatType.OwnerAccountId)];
  const base = baseObject(object, deps);
  return {
    ...base,
    name: def?.displayId || def?.id || base.name,
    isLoot: def?.isLoot === true,
    items: buildContainerItems(stats, deps),
    ...(def?.isLoot ? { rarity: lootRarityForType(object.type, deps) } : {}),
    ...(typeof ownerName === 'string' && ownerName ? { ownerName } : {}),
    ...(typeof ownerAccountId === 'string' && ownerAccountId ? { ownerAccountId } : {}),
  };
}

function sdkObject(object: TrackedObject, client: Client, deps: BridgeDeps): GameObject {
  switch (deps.gameData.getObjectCategory(object.type)) {
    case 'Player': return playerEntity(object, deps);
    case 'Enemy': return enemyEntity(object, deps);
    case 'Portal': return portalEntity(object, client, deps);
    case 'Container': return containerEntity(object, client, deps);
    default: return baseObject(object, deps);
  }
}

function visible(deps: BridgeDeps): { client: Client; rows: TrackedObject[] } | undefined {
  const client = active(deps);
  return client ? { client, rows: client.visibleObjects() } : undefined;
}

function distance(position: { x: number; y: number }, object: TrackedObject): number {
  return Math.sqrt((object.x - position.x) * (object.x - position.x) + (object.y - position.y) * (object.y - position.y));
}

function nearest(rows: TrackedObject[], position: { x: number; y: number }): TrackedObject | undefined {
  let best: TrackedObject | undefined;
  let bestDistance = Infinity;
  for (const row of rows) {
    const current = distance(position, row);
    if (current < bestDistance) {
      best = row;
      bestDistance = current;
    }
  }
  return best;
}

function tileSafe(tile: TrackedTile, deps: BridgeDeps): boolean {
  return !deps.gameData.tileIsBlockingWalk(tile.type)
    && (deps.gameData.getTileDamage(tile.type) ?? 0) <= 0
    && !deps.gameData.getTileHasConditionEffect(tile.type);
}

function tileMatches(tile: TrackedTile, filter: string | undefined, deps: BridgeDeps): boolean {
  const normalized = filter?.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!normalized) return true;
  switch (normalized) {
    case 'damaging': return (deps.gameData.getTileDamage(tile.type) ?? 0) > 0;
    case 'condition':
    case 'conditioneffect': return deps.gameData.getTileHasConditionEffect(tile.type);
    case 'slowing': return deps.gameData.getTileSpeed(tile.type) < 1;
    case 'speedy':
    case 'faster': return deps.gameData.getTileSpeed(tile.type) > 1;
    case 'speedmodified': return deps.gameData.getTileSpeed(tile.type) !== 1;
    case 'blocking':
    case 'nowalk': return deps.gameData.tileIsBlockingWalk(tile.type);
    case 'sink': return deps.gameData.tileIsSink(tile.type);
    case 'push':
    case 'pushes': return deps.gameData.getTileHasPush(tile.type);
    case 'slide':
    case 'sliding': return (deps.gameData.getTileSlideAmount(tile.type) ?? 0) > 0;
    case 'safe': return tileSafe(tile, deps);
    default: return deps.gameData.getTileName(tile.type).toLowerCase().includes(filter!.trim().toLowerCase());
  }
}

function mapTile(tile: TrackedTile, occupied: Set<string>, deps: BridgeDeps): MapTile {
  const damage = deps.gameData.getTileDamage(tile.type) ?? 0;
  return {
    type: tile.type,
    name: deps.gameData.getTileName(tile.type),
    position: new Position(tile.x + 0.5, tile.y + 0.5),
    isBlocking: deps.gameData.tileIsBlockingWalk(tile.type),
    isOccupied: occupied.has(`${tile.x},${tile.y}`),
    isSafe: tileSafe(tile, deps),
    speedMultiplier: deps.gameData.getTileSpeed(tile.type),
    damaging: damage > 0,
    damagePerTick: damage,
    hasConditionEffect: deps.gameData.getTileHasConditionEffect(tile.type),
  };
}

function occupiedTiles(client: Client): Set<string> {
  return new Set(client.visibleObjects().map((object) => `${Math.floor(object.x)},${Math.floor(object.y)}`));
}

function ensureQuestHook(client: Client): void {
  if (questHooks.has(client)) return;
  questHooks.add(client);
  client.onPacket<QuestObjectIdPacket>(PacketType.QUESTOBJID, (packet) => {
    questIds.set(client, Number(packet.objectId) || -1);
  });
}

function players(deps: BridgeDeps): { client: Client; rows: TrackedObject[] } | undefined {
  const state = visible(deps);
  if (!state) return undefined;
  return { ...state, rows: state.rows.filter((row) => deps.gameData.getObjectCategory(row.type) === 'Player') };
}

function combatEnemies(deps: BridgeDeps): { client: Client; rows: TrackedObject[] } | undefined {
  const state = visible(deps);
  if (!state) return undefined;
  return { ...state, rows: state.rows.filter((row) => deps.gameData.isCombatEnemy(row.type)) };
}

function findPlayer(rows: TrackedObject[], name: string, mode: PlayerNameMatchMode = 'equals'): TrackedObject | undefined {
  const query = name.trim().toLowerCase();
  if (!query) return undefined;
  return rows.find((row) => {
    const candidate = (row.player?.name || row.name || '').trim().toLowerCase();
    return mode === 'contains' ? candidate.includes(query) : candidate === query;
  });
}

export function installHeadlessWorldBridge(deps: BridgeDeps): void {
  Tiles.getAll = (filter?: string) => {
    const client = active(deps);
    if (!client) return [];
    const occupied = occupiedTiles(client);
    return client.visibleTiles().filter((tile) => tileMatches(tile, filter, deps)).map((tile) => mapTile(tile, occupied, deps));
  };
  Tiles.getNearby = ((radiusOrFilter?: number | string, filter?: string) => {
    const client = active(deps);
    if (!client) return [];
    const radius = typeof radiusOrFilter === 'number' ? Math.max(0, radiusOrFilter) : 5;
    const selectedFilter = typeof radiusOrFilter === 'string' ? radiusOrFilter : filter;
    const position = client.getPosition();
    const occupied = occupiedTiles(client);
    return client.visibleTiles()
      .filter((tile) => Math.sqrt((tile.x + 0.5 - position.x) * (tile.x + 0.5 - position.x) + (tile.y + 0.5 - position.y) * (tile.y + 0.5 - position.y)) <= radius)
      .filter((tile) => tileMatches(tile, selectedFilter, deps))
      .map((tile) => mapTile(tile, occupied, deps));
  }) as typeof Tiles.getNearby;
  Tiles.getByType = (type) => Tiles.getAll().filter((tile) => tile.type === type);
  Tiles.getAt = (x, y) => {
    const client = active(deps);
    const tile = client?.getTile(Math.floor(x), Math.floor(y));
    return client && tile ? mapTile(tile, occupiedTiles(client), deps) : null;
  };
  Tiles.isBlocking = (x, y) => Tiles.getAt(x, y)?.isBlocking ?? false;
  Tiles.isSafe = (x, y) => Tiles.getAt(x, y)?.isSafe ?? false;

  Objects.getAll = () => {
    const state = visible(deps);
    return state ? state.rows.map((row) => sdkObject(row, state.client, deps)) : [];
  };
  Objects.getById = (objectId) => Objects.getAll().find((object) => object.objectId === objectId) ?? null;
  Objects.getByType = (objectType) => Objects.getAll().filter((object) => object.objectType === objectType);
  Objects.count = () => active(deps)?.visibleObjects().length ?? 0;
  Objects.exists = (objectId) => !!active(deps)?.getVisibleObject(objectId);
  Objects.getByCategory = (category) => {
    const state = visible(deps);
    return state ? state.rows.filter((row) => deps.gameData.getObjectCategory(row.type) === category).map((row) => sdkObject(row, state.client, deps)) : [];
  };
  Objects.getEnemies = () => Enemies.getAll();
  Objects.getPlayers = () => Players.getAll();
  Objects.getPortals = () => Objects.getByCategory('Portal') as unknown as Portal[];
  Objects.getContainers = () => Objects.getByCategory('Container') as Container[];
  Objects.getPets = () => Objects.getByCategory('Pet');
  Objects.getBeacons = () => Objects.getByCategory('Beacon');
  Objects.getQuestTargetId = () => {
    const client = active(deps);
    if (!client) return -1;
    ensureQuestHook(client);
    return questIds.get(client) ?? -1;
  };
  Objects.getQuestObject = () => Objects.getById(Objects.getQuestTargetId());
  Objects.getQuestTargetType = () => Objects.getQuestObject()?.objectType ?? -1;
  Objects.getQuestId = Objects.getQuestTargetId;
  Objects.getQuestType = Objects.getQuestTargetType;
  Objects.getNearest = () => {
    const state = visible(deps);
    if (!state) return null;
    const row = nearest(state.rows.filter((candidate) => candidate.objectId !== state.client.getObjectId()), state.client.getPosition());
    return row ? sdkObject(row, state.client, deps) : null;
  };
  Objects.getNearestTo = (position) => {
    const state = visible(deps);
    if (!state) return null;
    const row = nearest(state.rows, position);
    return row ? sdkObject(row, state.client, deps) : null;
  };
  Objects.getNearestOfType = (objectType) => {
    const state = visible(deps);
    if (!state) return null;
    const row = nearest(state.rows.filter((candidate) => candidate.type === objectType), state.client.getPosition());
    return row ? sdkObject(row, state.client, deps) : null;
  };
  Objects.getNearestOfCategory = (category) => {
    const state = visible(deps);
    if (!state) return null;
    const row = nearest(state.rows.filter((candidate) => deps.gameData.getObjectCategory(candidate.type) === category), state.client.getPosition());
    return row ? sdkObject(row, state.client, deps) : null;
  };
  Objects.getWithinRadius = (radius) => {
    const client = active(deps);
    return client ? Objects.getWithinRadiusFrom(new Position(client.getPosition().x, client.getPosition().y), radius) : [];
  };
  Objects.getWithinRadiusFrom = (position, radius) => Objects.getAll().filter((object) => object.position.distanceTo(position) <= Math.max(0, radius));
  Objects.getWithinBounds = (minX, minY, maxX, maxY) => Objects.getAll().filter((object) => object.position.x >= minX && object.position.x <= maxX && object.position.y >= minY && object.position.y <= maxY);
  Objects.sortByDistance = () => {
    const position = active(deps)?.getPosition() ?? { x: 0, y: 0 };
    return Objects.getAll().sort((a, b) => a.position.distanceTo(new Position(position.x, position.y)) - b.position.distanceTo(new Position(position.x, position.y)));
  };
  Objects.sortByDistanceFrom = (position) => Objects.getAll().sort((a, b) => a.position.distanceTo(position) - b.position.distanceTo(position));
  Objects.findByName = (name) => Objects.findAllByName(name)[0] ?? null;
  Objects.findAllByName = (name) => {
    const query = name.trim().toLowerCase();
    return query ? Objects.getAll().filter((object) => object.name.toLowerCase().includes(query)) : [];
  };
  Objects.findPortal = (name) => Objects.getPortals().find((portal) => portal.name.toLowerCase().includes(name.trim().toLowerCase())) ?? null;
  Objects.getNearestPortal = () => Objects.getNearestOfCategory('Portal') as Portal | null;
  Objects.getOpenPortals = () => Objects.getPortals().filter((portal) => portal.isOpen);
  Objects.getNearestContainer = () => Objects.getNearestOfCategory('Container') as Container | null;
  Objects.findContainer = (name) => Objects.getContainers().find((container) => container.name.toLowerCase().includes(name.trim().toLowerCase())) ?? null;
  Objects.getCategory = (objectType) => deps.gameData.getObject(objectType) ? deps.gameData.getObjectCategory(objectType) : null;
  Objects.getTypeName = (objectType) => deps.gameData.getObject(objectType)?.displayId || deps.gameData.getObject(objectType)?.id || '';
  Objects.isEnemy = (objectType) => deps.gameData.getObjectCategory(objectType) === 'Enemy';
  Objects.isCombatEnemy = (objectType) => deps.gameData.isCombatEnemy(objectType);
  Objects.isPortal = (objectType) => deps.gameData.getObjectCategory(objectType) === 'Portal';
  Objects.isContainer = (objectType) => deps.gameData.getObjectCategory(objectType) === 'Container';
  Objects.isBoss = (objectType) => deps.gameData.isBoss(objectType, 5000);
  Objects.hasType = (objectType) => !!active(deps)?.visibleObjects().some((object) => object.type === objectType);

  Players.getAll = () => {
    const state = players(deps);
    return state ? state.rows.map((row) => playerEntity(row, deps)) : [];
  };
  Players.getNearest = () => {
    const state = players(deps);
    if (!state) return null;
    const row = nearest(state.rows.filter((candidate) => candidate.objectId !== state.client.getObjectId()), state.client.getPosition());
    return row ? playerEntity(row, deps) : null;
  };
  Players.find = (name) => {
    const state = players(deps);
    const row = state && (findPlayer(state.rows, name, 'equals') ?? findPlayer(state.rows, name, 'contains'));
    return row ? playerEntity(row, deps) : null;
  };
  Players.getHP = (name) => Players.find(name)?.hp ?? 0;
  Players.getMaxHP = (name) => Players.find(name)?.maxHp ?? 0;
  Players.getHPPercent = (name) => {
    const player = Players.find(name);
    return player?.maxHp ? player.hp / player.maxHp : 0;
  };
  Players.getMP = (name) => Players.find(name)?.mp ?? 0;
  Players.getAccountFame = (name) => {
    const state = players(deps);
    const row = state && (findPlayer(state.rows, name, 'equals') ?? findPlayer(state.rows, name, 'contains'));
    return row?.player?.accountFame ?? rawNumber(row!, StatType.CurrentFame, 0);
  };
  Players.getCharacterFame = (name) => {
    const state = players(deps);
    const row = state && (findPlayer(state.rows, name, 'equals') ?? findPlayer(state.rows, name, 'contains'));
    return row?.player?.currentFame ?? rawNumber(row!, StatType.CharacterAliveFame, 0);
  };
  Players.count = () => players(deps)?.rows.length ?? 0;
  Players.getPlayerGuild = (name, match: PlayerNameMatchMode = 'equals') => {
    const state = players(deps);
    const row = state && findPlayer(state.rows, name, match);
    return row?.player?.guildName || (row ? rawString(row, StatType.GuildName) : '');
  };
  Players.getNearbyGuilds = () => [...new Set((players(deps)?.rows ?? []).map((row) => row.player?.guildName || rawString(row, StatType.GuildName)).filter(Boolean))].sort((a, b) => a.localeCompare(b));

  Enemies.getAll = () => {
    const state = combatEnemies(deps);
    return state ? state.rows.map((row) => enemyEntity(row, deps)) : [];
  };
  Enemies.getNearest = () => {
    const state = combatEnemies(deps);
    if (!state) return null;
    const row = nearest(state.rows, state.client.getPosition());
    return row ? enemyEntity(row, deps) : null;
  };
  Enemies.getNearestTo = (position) => {
    const state = combatEnemies(deps);
    if (!state) return null;
    const row = nearest(state.rows, position);
    return row ? enemyEntity(row, deps) : null;
  };
  Enemies.getBoss = () => Enemies.getAll().filter((enemy) => enemy.isBoss).sort((a, b) => a.position.distanceTo(new Position(active(deps)?.getPosition().x ?? 0, active(deps)?.getPosition().y ?? 0)) - b.position.distanceTo(new Position(active(deps)?.getPosition().x ?? 0, active(deps)?.getPosition().y ?? 0)))[0] ?? null;
  Enemies.find = (name) => {
    const query = name.trim().toLowerCase();
    return query ? Enemies.getAll().find((enemy) => enemy.name.toLowerCase().includes(query)) ?? null : null;
  };
  Enemies.count = () => Enemies.getAll().length;
  Enemies.getById = (objectId) => Enemies.getAll().find((enemy) => enemy.objectId === objectId) ?? null;
  Enemies.getByType = (objectType) => Enemies.getAll().filter((enemy) => enemy.objectType === objectType);
}

export function getHeadlessPlayerRows(deps: BridgeDeps, client: Client): TrackedObject[] {
  return client.visibleObjects().filter((row) => deps.gameData.getObjectCategory(row.type) === 'Player');
}

export function getHeadlessEnemyRows(deps: BridgeDeps, client: Client): TrackedObject[] {
  return client.visibleObjects().filter((row) => deps.gameData.isCombatEnemy(row.type));
}

export function headlessObjectName(deps: BridgeDeps, object: TrackedObject): string {
  return objectName(object, deps);
}
