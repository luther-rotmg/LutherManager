import {
  Hive,
  Position,
  Self,
  StatusEffect,
  Walking,
  World,
  chat,
  character,
  connection,
  inventory,
  type InventoryContainer,
  type Stats,
} from '@hive/sdk';
import { ClientEvent, type Client } from 'headless-client';
import type { BridgeDeps } from '../BridgeDeps.js';
import { Logger } from '../../../util/Logger.js';
import { installHeadlessChatBridge } from './HeadlessChatBridge.js';
import { installHeadlessCombatBridge } from './HeadlessCombatBridge.js';
import { installHeadlessEventsBridge } from './HeadlessEventsBridge.js';
import { installHeadlessLootBridge } from './HeadlessLootBridge.js';
import { installHeadlessSocialBridge } from './HeadlessSocialBridge.js';
import { installHeadlessWorldBridge } from './HeadlessWorldBridge.js';
import { resolveTeleportBeacon } from '../walking/TeleportBeacon.js';
import { buildSlotEnchantments } from '../loot/model.js';

function active(deps: BridgeDeps): Client {
  const client = deps.getHeadlessClient?.();
  if (!client) throw new Error('No headless account is connected to Hive.');
  return client;
}

function optional(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

const STORAGE_CONTAINERS = new Set<InventoryContainer>([
  'vault',
  'materialVault',
  'giftChest',
  'potionVault',
  'spoilsChest',
]);

/** SDK storage slots use one flattened logical index across physical chests. */
function sdkContainerSlots(client: Client, container: InventoryContainer) {
  const slots = client.getContainerSlots(container);
  if (!STORAGE_CONTAINERS.has(container)) return slots;
  return slots.map((slot, slotId) => ({
    objectId: slot.objectId,
    slotId,
    objectType: slot.objectType,
  }));
}

type HeadlessStatMode = 'total' | 'base' | 'withGear';

function headlessStats(deps: BridgeDeps, mode: HeadlessStatMode): Stats {
  const player = optional(deps)?.getPlayer();
  if (!player) {
    return { maxHP: 0, maxMP: 0, attack: 0, defense: 0, speed: 0, dexterity: 0, vitality: 0, wisdom: 0 };
  }

  const total: Stats = {
    maxHP: player.maxHP ?? 0,
    maxMP: player.maxMP ?? 0,
    attack: player.atk ?? 0,
    defense: player.def ?? 0,
    speed: player.spd ?? 0,
    dexterity: player.dex ?? 0,
    vitality: player.vit ?? 0,
    wisdom: player.wis ?? 0,
  };
  if (mode === 'total') return total;

  const excluded: Stats = mode === 'base'
    ? {
        maxHP: player.maxHPBoost ?? 0,
        maxMP: player.maxMPBoost ?? 0,
        attack: player.atkBoost ?? 0,
        defense: player.defBoost ?? 0,
        speed: player.spdBoost ?? 0,
        dexterity: player.dexBoost ?? 0,
        vitality: player.vitBoost ?? 0,
        wisdom: player.wisBoost ?? 0,
      }
    : {
        maxHP: player.exaltedHP ?? 0,
        maxMP: player.exaltedMP ?? 0,
        attack: player.exaltedAtt ?? 0,
        defense: player.exaltedDef ?? 0,
        speed: player.exaltedSpd ?? 0,
        dexterity: player.exaltedDex ?? 0,
        vitality: player.exaltedVit ?? 0,
        wisdom: player.exaltedWis ?? 0,
      };

  return {
    maxHP: total.maxHP - excluded.maxHP,
    maxMP: total.maxMP - excluded.maxMP,
    attack: total.attack - excluded.attack,
    defense: total.defense - excluded.defense,
    speed: total.speed - excluded.speed,
    dexterity: total.dexterity - excluded.dexterity,
    vitality: total.vitality - excluded.vitality,
    wisdom: total.wisdom - excluded.wisdom,
  };
}

function headlessGearBonus(combined: number | undefined, exalted: number | undefined): number {
  return (combined ?? 0) - (exalted ?? 0);
}

type ConditionWord = 'condition' | 'condition2';

const EFFECT_MASKS: Record<StatusEffect, ReadonlyArray<readonly [ConditionWord, number]>> = {
  [StatusEffect.CURSED]: [['condition2', 0x40]],
  [StatusEffect.SLOWED]: [['condition', 0x8]],
  [StatusEffect.STUNNED]: [['condition', 0x40]],
  [StatusEffect.BLIND]: [['condition', 0x80]],
  [StatusEffect.HALLUCINATING]: [['condition', 0x100]],
  [StatusEffect.DRUNK]: [['condition', 0x200]],
  [StatusEffect.CONFUSED]: [['condition', 0x400]],
  [StatusEffect.STASIS]: [['condition', 0x200000]],
  [StatusEffect.INVISIBLE]: [['condition', 0x1000]],
  [StatusEffect.ARMORED]: [['condition', 0x2000000]],
  [StatusEffect.INVINCIBLE]: [['condition', 0x800000]],
  [StatusEffect.SPEEDY]: [['condition', 0x4000], ['condition', 0x10000000]],
  [StatusEffect.HEALING]: [['condition', 0x20000]],
  [StatusEffect.DAMAGING]: [['condition', 0x40000]],
  [StatusEffect.BERSERK]: [['condition', 0x80000]],
  [StatusEffect.PETRIFIED]: [['condition2', 0x8]],
  [StatusEffect.SICK]: [['condition', 0x10]],
  [StatusEffect.BLEEDING]: [['condition', 0x8000]],
  [StatusEffect.QUIET]: [['condition', 0x2]],
  [StatusEffect.EXPOSED]: [['condition2', 0x20000]],
  [StatusEffect.HEXED]: [['condition', 0x8000000]],
};

function hasEffect(deps: BridgeDeps, effect: StatusEffect): boolean {
  const player = optional(deps)?.getPlayer();
  return !!player && (EFFECT_MASKS[effect] ?? []).some(([word, mask]) => ((player[word] ?? 0) & mask) !== 0);
}

function itemMatches(deps: BridgeDeps, objectType: number, query: number | string): boolean {
  if (typeof query === 'number') return objectType === Math.trunc(query);
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  const itemName = deps.gameData.buildSdkItem(objectType)?.name.toLowerCase() ?? '';
  const objectName = deps.gameData.getObject(objectType)?.id.toLowerCase() ?? '';
  return itemName.includes(normalized) || objectName.includes(normalized);
}

interface FollowState {
  query: string;
  objectId: number;
  lastX?: number;
  lastY?: number;
  onTick: () => void;
  onMapChange: () => void;
}

const follows = new WeakMap<Client, FollowState>();

function stopFollowing(client: Client): void {
  const state = follows.get(client);
  if (!state) return;
  client.off(ClientEvent.Tick, state.onTick);
  client.off(ClientEvent.MapChange, state.onMapChange);
  follows.delete(client);
}

function findPlayer(client: Client, deps: BridgeDeps, query: string, objectId?: number) {
  const players = client.visibleObjects().filter(
    (object) => object.objectId !== client.getObjectId() && deps.gameData.getObjectCategory(object.type) === 'Player',
  );
  const current = objectId === undefined ? undefined : players.find((object) => object.objectId === objectId);
  return current
    ?? players.find((object) => (object.player?.name || object.name || '').trim().toLowerCase() === query)
    ?? players.find((object) => (object.player?.name || object.name || '').toLowerCase().includes(query));
}

export function installHeadlessBridge(deps: BridgeDeps): void {
  if (!deps.getHeadlessClient) return;

  Self.getObjectId = () => optional(deps)?.getObjectId() ?? -1;
  Self.getX = () => optional(deps)?.getPosition().x ?? 0;
  Self.getY = () => optional(deps)?.getPosition().y ?? 0;
  Self.getPosition = () => {
    const pos = optional(deps)?.getPosition() ?? { x: 0, y: 0 };
    return new Position(pos.x, pos.y);
  };
  Self.distanceTo = (position: Position) => optional(deps)?.distanceTo(position) ?? 0;
  Self.canEquip = (objectType: number) => {
    const playerClass = optional(deps)?.getPlayer()?.class;
    const itemSlotType = deps.gameData.getObject(objectType)?.slotType;
    if (!playerClass || !Number.isFinite(itemSlotType)) return false;
    return deps.gameData.getObject(playerClass)?.slotTypes?.slice(0, 4).includes(itemSlotType!) ?? false;
  };
  Self.getName = () => optional(deps)?.getPlayer()?.name ?? '';
  Self.getClass = () => optional(deps)?.getPlayer()?.className ?? '';
  Self.getHP = () => optional(deps)?.getPlayer()?.hp ?? 0;
  Self.getMaxHP = () => optional(deps)?.getPlayer()?.maxHP ?? 0;
  Self.getHPPercent = () => {
    const player = optional(deps)?.getPlayer();
    return player?.maxHP ? player.hp / player.maxHP : 0;
  };
  Self.getMP = () => optional(deps)?.getPlayer()?.mp ?? 0;
  Self.getMaxMP = () => optional(deps)?.getPlayer()?.maxMP ?? 0;
  Self.getMPPercent = () => {
    const player = optional(deps)?.getPlayer();
    return player?.maxMP ? player.mp / player.maxMP : 0;
  };
  Self.getLevel = () => optional(deps)?.getPlayer()?.level ?? 0;
  Self.getStats = () => headlessStats(deps, 'total');
  Self.getBaseStats = () => headlessStats(deps, 'base');
  Self.getStatsWithGear = () => headlessStats(deps, 'withGear');
  Self.getBaseMaxHP = () => headlessStats(deps, 'base').maxHP;
  Self.getMaxHPWithGear = () => headlessStats(deps, 'withGear').maxHP;
  Self.getBaseMaxMP = () => headlessStats(deps, 'base').maxMP;
  Self.getMaxMPWithGear = () => headlessStats(deps, 'withGear').maxMP;
  Self.getBaseAtk = () => headlessStats(deps, 'base').attack;
  Self.getAtkWithGear = () => headlessStats(deps, 'withGear').attack;
  Self.getBaseDef = () => headlessStats(deps, 'base').defense;
  Self.getDefWithGear = () => headlessStats(deps, 'withGear').defense;
  Self.getBaseSpd = () => headlessStats(deps, 'base').speed;
  Self.getSpdWithGear = () => headlessStats(deps, 'withGear').speed;
  Self.getBaseDex = () => headlessStats(deps, 'base').dexterity;
  Self.getDexWithGear = () => headlessStats(deps, 'withGear').dexterity;
  Self.getBaseVit = () => headlessStats(deps, 'base').vitality;
  Self.getVitWithGear = () => headlessStats(deps, 'withGear').vitality;
  Self.getBaseWis = () => headlessStats(deps, 'base').wisdom;
  Self.getWisWithGear = () => headlessStats(deps, 'withGear').wisdom;
  Self.getAtk = () => optional(deps)?.getPlayer()?.atk ?? 0;
  Self.getDef = () => optional(deps)?.getPlayer()?.def ?? 0;
  Self.getSpd = () => optional(deps)?.getPlayer()?.spd ?? 0;
  Self.getDex = () => optional(deps)?.getPlayer()?.dex ?? 0;
  Self.getVit = () => optional(deps)?.getPlayer()?.vit ?? 0;
  Self.getWis = () => optional(deps)?.getPlayer()?.wis ?? 0;
  Self.getExaltedMaxHP = () => optional(deps)?.getPlayer()?.exaltedHP ?? 0;
  Self.getExaltedMaxMP = () => optional(deps)?.getPlayer()?.exaltedMP ?? 0;
  Self.getExaltedAtk = () => optional(deps)?.getPlayer()?.exaltedAtt ?? 0;
  Self.getExaltedDef = () => optional(deps)?.getPlayer()?.exaltedDef ?? 0;
  Self.getExaltedSpd = () => optional(deps)?.getPlayer()?.exaltedSpd ?? 0;
  Self.getExaltedDex = () => optional(deps)?.getPlayer()?.exaltedDex ?? 0;
  Self.getExaltedVit = () => optional(deps)?.getPlayer()?.exaltedVit ?? 0;
  Self.getExaltedWis = () => optional(deps)?.getPlayer()?.exaltedWis ?? 0;
  Self.getGearMaxHP = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.maxHPBoost, player?.exaltedHP);
  };
  Self.getGearMaxMP = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.maxMPBoost, player?.exaltedMP);
  };
  Self.getGearAtk = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.atkBoost, player?.exaltedAtt);
  };
  Self.getGearDef = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.defBoost, player?.exaltedDef);
  };
  Self.getGearSpd = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.spdBoost, player?.exaltedSpd);
  };
  Self.getGearDex = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.dexBoost, player?.exaltedDex);
  };
  Self.getGearVit = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.vitBoost, player?.exaltedVit);
  };
  Self.getGearWis = () => {
    const player = optional(deps)?.getPlayer();
    return headlessGearBonus(player?.wisBoost, player?.exaltedWis);
  };
  Self.getExaltedBonuses = () => ({
    maxHP: Self.getExaltedMaxHP(), maxMP: Self.getExaltedMaxMP(), attack: Self.getExaltedAtk(), defense: Self.getExaltedDef(),
    speed: Self.getExaltedSpd(), dexterity: Self.getExaltedDex(), vitality: Self.getExaltedVit(), wisdom: Self.getExaltedWis(),
  });
  Self.getGearBonuses = () => ({
    maxHP: Self.getGearMaxHP(), maxMP: Self.getGearMaxMP(), attack: Self.getGearAtk(), defense: Self.getGearDef(),
    speed: Self.getGearSpd(), dexterity: Self.getGearDex(), vitality: Self.getGearVit(), wisdom: Self.getGearWis(),
  });
  Self.getWeapon = () => {
    const type = optional(deps)?.getInventory()?.[0] ?? -1;
    return type < 0 ? null : deps.gameData.buildSdkItem(type);
  };
  Self.getAbility = () => {
    const type = optional(deps)?.getInventory()?.[1] ?? -1;
    return type < 0 ? null : deps.gameData.buildSdkItem(type);
  };
  Self.getArmor = () => {
    const type = optional(deps)?.getInventory()?.[2] ?? -1;
    return type < 0 ? null : deps.gameData.buildSdkItem(type);
  };
  Self.getRing = () => {
    const type = optional(deps)?.getInventory()?.[3] ?? -1;
    return type < 0 ? null : deps.gameData.buildSdkItem(type);
  };
  Self.getAccountFame = () => optional(deps)?.getPlayer()?.accountFame ?? 0;
  Self.getCharacterFame = () => optional(deps)?.getPlayer()?.currentFame ?? 0;
  Self.hasEffect = (effect: StatusEffect) => hasEffect(deps, effect);
  Self.getEffects = () => Object.values(StatusEffect).filter((effect) => hasEffect(deps, effect));
  Self.isInvisible = () => hasEffect(deps, StatusEffect.INVISIBLE);
  Self.getPowerLevel = () => optional(deps)?.getPlayer()?.powerLevel ?? 0;
  Self.getStars = () => optional(deps)?.getPlayer()?.stars ?? 0;
  Self.isSeasonal = () => optional(deps)?.isSeasonal();
  Self.pet.getObjectId = () => optional(deps)?.getPetObjectId() ?? -1;
  Self.pet.getInstanceId = () => optional(deps)?.getPetInstanceId() ?? -1;
  Self.pet.getBagContainerId = () => optional(deps)?.getPetBagContainerId() ?? -1;
  Self.pet.hasBag = () => optional(deps)?.hasPetBag() ?? false;

  World.isNexus = () => optional(deps)?.isInNexus() ?? false;
  World.isVault = () => optional(deps)?.isInVault() ?? false;
  World.isPetYard = () => optional(deps)?.isInPetYard() ?? false;
  World.isRealm = () => {
    const client = optional(deps);
    return !!client && client.isInWorld() && !client.isInNexus() && !client.isInVault() && !client.isInPetYard();
  };
  World.isDungeon = () => false;
  World.getName = () => optional(deps)?.getMapName() ?? 'Unknown';
  World.getServerHost = () => optional(deps)?.getServerHost() ?? '';
  World.getRealmPortals = () => optional(deps)?.realmPortals() ?? [];
  World.getVisibleObjects = () => optional(deps)?.visibleObjects() ?? [];
  World.getVisibleTiles = () => optional(deps)?.visibleTiles() ?? [];
  World.getTile = (x: number, y: number) => optional(deps)?.getTile(x, y);
  World.getObject = (objectId: number) => optional(deps)?.getVisibleObject(objectId);
  World.getNearestObject = () => optional(deps)?.getNearestVisibleObject();
  Hive.world.isNexus = World.isNexus;
  Hive.world.isVault = World.isVault;
  Hive.world.isPetYard = World.isPetYard;
  Hive.world.isRealm = World.isRealm;
  Hive.world.isDungeon = World.isDungeon;
  Hive.world.getName = World.getName;
  Hive.world.getServerHost = World.getServerHost;
  Hive.world.getRealmPortals = World.getRealmPortals;
  Hive.world.getVisibleObjects = World.getVisibleObjects;
  Hive.world.getVisibleTiles = World.getVisibleTiles;
  Hive.world.getTile = World.getTile;
  Hive.world.getObject = World.getObject;
  Hive.world.getNearestObject = World.getNearestObject;

  Walking.walkTo = (x: number, y: number) => {
    const client = active(deps);
    stopFollowing(client);
    return client.moveTo({ x, y });
  };
  Walking.pathfindingWalkTo = (x: number, y: number, arriveThreshold?: number) => {
    const client = active(deps);
    stopFollowing(client);
    return client.pathfindingWalkTo({ x, y }, arriveThreshold);
  };
  Walking.walkToPosition = (position: Position) => {
    const client = active(deps);
    stopFollowing(client);
    return client.moveTo(position);
  };
  Walking.walkToEnemy = () => {
    const client = active(deps);
    stopFollowing(client);
    const enemy = client.visibleObjects()
      .filter((object) => deps.gameData.isCombatEnemy(object.type))
      .sort((a, b) => client.distanceTo(a) - client.distanceTo(b))[0];
    return enemy ? client.moveToObject(enemy.objectId, 1.3) : false;
  };
  Walking.pathfindingWalkToEnemy = () => {
    const client = active(deps);
    stopFollowing(client);
    const enemy = client.visibleObjects()
      .filter((object) => deps.gameData.isCombatEnemy(object.type))
      .sort((a, b) => client.distanceTo(a) - client.distanceTo(b))[0];
    return enemy ? client.pathfindingWalkTo({ x: enemy.x, y: enemy.y }, 1.3) : false;
  };
  Walking.walkToPortal = (name: string) => {
    const client = active(deps);
    stopFollowing(client);
    const portal = client.getRealmPortal(name) ?? client.visibleObjects().find((object) => object.name?.toLowerCase() === name.toLowerCase());
    return portal ? client.moveToObject(portal.objectId) : false;
  };
  Walking.walkToNearestPortal = () => {
    const client = active(deps);
    stopFollowing(client);
    const portal = client.realmPortals().sort((a, b) => client.distanceTo(a) - client.distanceTo(b))[0];
    return portal ? client.moveToObject(portal.objectId) : false;
  };
  Walking.followPlayer = (name: string) => {
    const client = active(deps);
    const query = name.trim().toLowerCase();
    if (!query) return false;
    const player = findPlayer(client, deps, query);
    if (!player) return false;

    stopFollowing(client);
    const state: FollowState = {
      query,
      objectId: player.objectId,
      onTick: () => {
        const target = findPlayer(client, deps, state.query, state.objectId);
        if (!target) {
          client.stopMoving();
          state.lastX = undefined;
          state.lastY = undefined;
          return;
        }
        state.objectId = target.objectId;
        const targetMoved = state.lastX === undefined || state.lastY === undefined
          || Math.hypot(target.x - state.lastX, target.y - state.lastY) >= 0.1;
        if (client.distanceTo(target) > 1.5 && (targetMoved || !client.isMoving())) {
          client.moveToObject(target.objectId, 1.5);
        } else if (client.distanceTo(target) <= 1.5 && client.isMoving()) {
          client.stopMoving();
        }
        state.lastX = target.x;
        state.lastY = target.y;
      },
      onMapChange: () => stopFollowing(client),
    };
    follows.set(client, state);
    client.on(ClientEvent.Tick, state.onTick);
    client.on(ClientEvent.MapChange, state.onMapChange);
    state.onTick();
    return true;
  };
  Walking.enterPortal = (objectId: number) => {
    const client = active(deps);
    stopFollowing(client);
    return client.enterPortal(objectId);
  };
  Walking.enterVault = () => {
    const client = active(deps);
    stopFollowing(client);
    client.enterVault();
  };
  Walking.enterPetYard = () => {
    const client = active(deps);
    stopFollowing(client);
    client.enterPetYard();
  };
  Walking.enterGuildHall = () => {
    const client = active(deps);
    stopFollowing(client);
    client.enterGuildHall();
  };
  Walking.enterDailyQuestRoom = () => {
    const client = active(deps);
    stopFollowing(client);
    client.enterDailyQuestRoom();
  };
  Walking.nexus = () => {
    const client = active(deps);
    stopFollowing(client);
    client.escape();
  };
  Walking.stopMoving = () => {
    const client = active(deps);
    stopFollowing(client);
    client.stopMoving();
  };
  Walking.isMoving = () => optional(deps)?.isMoving() ?? false;
  Walking.hasReached = (position: Position, tolerance = 0.5) => (optional(deps)?.distanceTo(position) ?? Infinity) <= tolerance;
  Walking.enableAutoDodge = (options = {}) => active(deps).enableAutoDodge(options);
  Walking.disableAutoDodge = () => active(deps).disableAutoDodge();
  Walking.isAutoDodgeEnabled = () => optional(deps)?.isAutoDodgeEnabled() ?? false;
  Walking.getAutoDodgeState = () => optional(deps)?.getAutoDodgeState() ?? null;
  Walking.getDodgePosition = () => {
    const target = optional(deps)?.getAutoDodgeState()?.target;
    return target ? new Position(target.x, target.y) : null;
  };
  Walking.dodge = () => active(deps).enableAutoDodge();
  Walking.dodgeFrom = () => active(deps).enableAutoDodge();
  Walking.canTeleport = () => optional(deps)?.canTeleport() ?? false;
  Walking.teleportToPlayer = (name: string) => {
    const client = active(deps);
    if (!client.canTeleport()) {
      Logger.warn('Walking', 'teleportToPlayer: teleport not allowed in this map');
      return false;
    }
    const query = name.trim().toLowerCase();
    if (!query) return false;
    const player = findPlayer(client, deps, query);
    if (!player) {
      Logger.warn('Walking', `teleportToPlayer: player "${name}" is not visible`);
      return false;
    }
    return client.teleportTo(player.objectId);
  };
  Walking.teleportBeacon = (destination: string) => {
    const client = active(deps);
    if (!client.canTeleport()) {
      Logger.warn('Walking', 'teleportBeacon: teleport not allowed in this map');
      return false;
    }
    const beacon = resolveTeleportBeacon(
      destination,
      client.visibleObjects(),
      deps.gameData,
      client.getServerPosition() ?? client.getPosition(),
    );
    if (!beacon) {
      Logger.warn('Walking', `teleportBeacon: no live teleport beacon matches "${destination}"`);
      return false;
    }
    return client.teleportTo(beacon.objectId);
  };
  Walking.teleportToBeacon = (objectId: number) => {
    const client = active(deps);
    if (!client.canTeleport()) {
      Logger.warn('Walking', 'teleportToBeacon: teleport not allowed in this map');
      return false;
    }
    const id = Math.trunc(objectId);
    const beacon = client.getVisibleObject(id);
    if (!beacon || !deps.gameData.isTeleportBeacon(beacon.type)) {
      Logger.warn('Walking', `teleportToBeacon: object ${objectId} is not a live teleport beacon`);
      return false;
    }
    return client.teleportTo(id);
  };

  chat.say = (message: string) => active(deps).say(message);
  chat.send = (message: string) => active(deps).say(message);

  inventory.getAll = () => {
    const values = optional(deps)?.getInventory() ?? [];
    return Array.from({ length: 28 }, (_, index) => values[index] ?? -1);
  };
  inventory.getSlot = (index: number) => {
    const objectType = optional(deps)?.getInventory()?.[index] ?? -1;
    return objectType < 0 ? null : { objectType, slotIndex: index };
  };
  inventory.getEnchantments = (slotIndex: number) => {
    const player = optional(deps)?.getPlayer();
    if (!player || !Number.isInteger(slotIndex) || slotIndex < 0) return null;
    return buildSlotEnchantments(player.enchantmentsRaw, slotIndex, deps);
  };
  inventory.findItem = (query: number | string) => {
    const client = optional(deps);
    if (!client) return null;
    const slot = client.getInventorySlots().find((candidate) => candidate.objectType >= 0 && itemMatches(deps, candidate.objectType, query));
    return slot ? { objectType: slot.objectType, slotIndex: slot.slotId } : null;
  };
  inventory.findItems = (query: number | string) => {
    return (optional(deps)?.getInventorySlots() ?? [])
      .filter((slot) => slot.objectType >= 0 && itemMatches(deps, slot.objectType, query))
      .map((slot) => ({ objectType: slot.objectType, slotIndex: slot.slotId }));
  };
  inventory.useItem = (slotIndex: number) => {
    const client = active(deps);
    const slot = client.getInventorySlot(Math.trunc(slotIndex));
    if (slot) client.useItem(slot);
  };
  inventory.swapSlots = (from: number, to: number) => { active(deps).swapInventorySlots(from, to); };
  inventory.isFull = () => !optional(deps)?.hasInventorySpace();
  inventory.emptySlotCount = () => (optional(deps)?.getInventorySlots() ?? []).filter((slot) => slot.slotId >= 4 && slot.objectType < 0).length;
  inventory.getBackpack = () => optional(deps)?.hasPetBag() ? 3 : optional(deps)?.hasBackpack() ? 2 : 1;
  inventory.getContainerSlots = (container: InventoryContainer) => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, container) : [];
  };
  inventory.getContainerObjectId = (container: InventoryContainer) => optional(deps)?.getContainerObjectId(container) ?? -1;
  inventory.swapContainers = (from, to) => active(deps).swapContainerItems(from, to);
  inventory.getFirstFilledSlot = (container: InventoryContainer) => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, container).find((slot) => slot.objectType >= 0) ?? null : null;
  };
  inventory.getFirstEmptySlot = (container: InventoryContainer) => {
    const client = optional(deps);
    return client
      ? sdkContainerSlots(client, container).find(
          (slot) => slot.objectType < 0 && (container !== 'inventory' || slot.slotId >= 4),
        ) ?? null
      : null;
  };
  inventory.getContainerItemCount = (container: InventoryContainer) => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, container).filter((slot) => slot.objectType >= 0).length : 0;
  };
  inventory.hasSpace = () => optional(deps)?.hasInventorySpace() ?? false;
  inventory.swapInventoryWithPetBag = (inventorySlot, petBagSlot, petBagItemType) => active(deps).swapInventoryWithPetBag(inventorySlot, petBagSlot, petBagItemType);
  inventory.swapInventoryWithVault = (inventorySlot, vaultSlot) => active(deps).swapInventoryWithVault(inventorySlot, vaultSlot);
  inventory.swapInventoryWithPotionVault = (inventorySlot, potionSlot) => active(deps).swapInventoryWithPotionVault(inventorySlot, potionSlot);
  inventory.withdraw = (target, side) => {
    const client = active(deps);
    const vaultSlots = sdkContainerSlots(client, 'vault');
    let source;
    let destination;
    if (side === 'container') {
      const direct = vaultSlots.find((slot) => slot.slotId === Math.trunc(target) && slot.objectType >= 0);
      source = direct ?? vaultSlots.find((slot) => slot.objectType === Math.trunc(target));
      destination = client.getEmptyInventorySlot();
    } else {
      source = vaultSlots.find((slot) => slot.objectType >= 0) ?? null;
      const candidate = client.getContainerSlot('inventory', Math.trunc(target));
      destination = candidate?.objectType === -1 ? candidate : null;
    }
    return !!source && !!destination && client.swapContainerItems(
      { container: 'vault', slotId: source.slotId },
      { container: 'inventory', slotId: destination.slotId },
    );
  };
  inventory.deposit = (target, side) => {
    const client = active(deps);
    const vaultSlots = sdkContainerSlots(client, 'vault');
    let source;
    let destination;
    if (side === 'inventory') {
      const direct = client.getInventorySlot(Math.trunc(target));
      source = direct ?? client.getInventorySlots().find(
        (slot) => slot.slotId >= 4 && slot.objectType === Math.trunc(target),
      ) ?? null;
      destination = vaultSlots.find((slot) => slot.objectType < 0) ?? null;
    } else {
      source = client.getInventorySlot();
      const candidate = vaultSlots.find((slot) => slot.slotId === Math.trunc(target));
      destination = candidate?.objectType === -1 ? candidate : null;
    }
    return !!source && !!destination && client.swapContainerItems(
      { container: 'inventory', slotId: source.slotId },
      { container: 'vault', slotId: destination.slotId },
    );
  };
  inventory.getVault = () => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, 'vault').map((slot) => slot.objectType) : [];
  };
  inventory.getPotions = () => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, 'potionVault').map((slot) => slot.objectType) : [];
  };
  inventory.getMaterials = () => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, 'materialVault').map((slot) => slot.objectType) : [];
  };
  inventory.getGifts = () => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, 'giftChest').map((slot) => slot.objectType) : [];
  };
  inventory.getSeasonalSpoils = () => {
    const client = optional(deps);
    return client ? sdkContainerSlots(client, 'spoilsChest').map((slot) => slot.objectType) : [];
  };
  inventory.getEntireVault = () => {
    const client = active(deps);
    const snapshot = client.getVaultContent();
    if (!snapshot) throw new Error('inventory.getEntireVault: vault not entered yet (no VAULT_CONTENT received)');
    const containers = (key: string) => {
      let startSlot = 0;
      return snapshot.sections.filter((candidate) => candidate.key === key).map((section) => {
        const result = {
          objectId: section.objectId,
          startSlot,
          slotCount: section.contents.length,
          enchantments: section.enchantments ?? '',
        };
        startSlot += section.contents.length;
        return result;
      });
    };
    const containerGroups = {
      vault: containers('vault'),
      material: containers('material'),
      gift: containers('gift'),
      potion: containers('potion'),
      seasonalSpoils: containers('spoils'),
    };
    return {
      capturedAt: Date.parse(snapshot.capturedAt || snapshot.at) || Date.now(),
      updatedAt: Date.parse(snapshot.updatedAt || snapshot.at) || Date.now(),
      revision: snapshot.revision,
      active: snapshot.active,
      complete: snapshot.lastVaultPacket,
      objectIds: {
        vault: containerGroups.vault.find((entry) => entry.objectId > 0)?.objectId ?? -1,
        material: containerGroups.material.find((entry) => entry.objectId > 0)?.objectId ?? -1,
        gift: containerGroups.gift.find((entry) => entry.objectId > 0)?.objectId ?? -1,
        potion: containerGroups.potion.find((entry) => entry.objectId > 0)?.objectId ?? -1,
        seasonalSpoils: containerGroups.seasonalSpoils.find((entry) => entry.objectId > 0)?.objectId ?? -1,
      },
      containers: containerGroups,
      vault: sdkContainerSlots(client, 'vault').map((slot) => slot.objectType),
      material: sdkContainerSlots(client, 'materialVault').map((slot) => slot.objectType),
      gift: sdkContainerSlots(client, 'giftChest').map((slot) => slot.objectType),
      potion: sdkContainerSlots(client, 'potionVault').map((slot) => slot.objectType),
      seasonalSpoils: sdkContainerSlots(client, 'spoilsChest').map((slot) => slot.objectType),
      upgradeCosts: {
        vault: snapshot.vaultUpgradeCost,
        material: snapshot.materialUpgradeCost,
        potion: snapshot.potionUpgradeCost,
        seasonalSpoils: snapshot.seasonalSpoilUpgradeCost,
      },
      potionCapacity: { current: snapshot.currentPotionMax, next: snapshot.nextPotionMax },
      enchantments: {
        vault: snapshot.vaultChestEnchants,
        gift: snapshot.giftChestEnchants,
        seasonalSpoils: snapshot.spoilsChestEnchants,
      },
    };
  };
  inventory.getVaultSnapshot = () => inventory.getEntireVault();

  connection.isConnected = () => optional(deps)?.isConnected() ?? false;
  connection.isInWorld = () => optional(deps)?.isInWorld() ?? false;
  connection.getLifecycleState = () => String(optional(deps)?.getLifecycleState() ?? 'disconnected');
  connection.getServerHost = () => optional(deps)?.getServerHost() ?? '';
  connection.isStalled = () => optional(deps)?.isStalled() ?? false;
  connection.stall = (milliseconds?: number) => active(deps).stall(milliseconds);
  connection.resume = () => active(deps).resumeSocket();
  connection.reconnect = (host?: string) => host ? active(deps).connectToServer(host) : active(deps).connect();
  connection.stop = () => active(deps).stop('stopped by Hive script');
  connection.getTickInfo = () => active(deps).getTickInfo();
  connection.getStallInfo = () => active(deps).getStallInfo();
  connection.getKnownServers = () => optional(deps)?.knownServers() ?? [];
  connection.getReconnectTickets = () => optional(deps)?.getReconnectTickets() ?? [];

  character.create = (classType: number, seasonal?: boolean) => active(deps).createCharacter(classType, seasonal);
  character.delete = (characterId: number) => active(deps).deleteCharacter(characterId);
  character.convertSeasonal = () => active(deps).sendSeasonalConversion();
  character.isSeasonal = () => optional(deps)?.isSeasonal();
  character.getCurrentId = () => optional(deps)?.getCharacterId() ?? -1;
  character.getAll = async () => {
    const client = active(deps);
    const currentId = client.getCharacterId();
    return (await client.listCharacters()).map((entry) => {
      const classType = entry.classType ?? 0;
      const classDef = deps.gameData.getObject(classType);
      return {
        id: entry.charId,
        classType,
        className: classDef?.displayId || classDef?.id || `0x${classType.toString(16)}`,
        level: entry.level ?? 0,
        experience: entry.exp ?? 0,
        fame: entry.currentFame ?? 0,
        seasonal: entry.seasonal ?? false,
        equipment: [...(entry.equipment ?? [])],
        isCurrent: entry.charId === currentId,
      };
    });
  };
  character.switchTo = (characterId: number) => active(deps).switchCharacter(characterId);

  installHeadlessWorldBridge(deps);
  installHeadlessCombatBridge(deps);
  installHeadlessChatBridge(deps);
  installHeadlessSocialBridge(deps);
  installHeadlessEventsBridge(deps);
  installHeadlessLootBridge(deps);

}
