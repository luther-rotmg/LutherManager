import { loot } from '@luthermanager/sdk';
import type { LootBag, LootItem, PickupOptions } from '@luthermanager/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { Packet } from '../../../packets/Packet.js';
import { StatType } from '../../../constants/StatType.js';
import { Logger } from '../../../util/Logger.js';
import { buildLootBag, LOOT_RARITY_RANK } from './model.js';

// ─── Item classification sets (mirrors auto-loot) ────────────────────────────

const HP_POTION_IDS = new Set<number>([2594, 2736]);
const MP_POTION_IDS = new Set<number>([2595, 2781]);
const LIFE_MANA_POTION_IDS = new Set<number>([
  2793, 2794, 5471, 5472, 9070, 9071,
]);
const STAT_POTION_IDS = new Set<number>([
  2591, 2592, 2593, 2612, 2613, 2636,
  5465, 5466, 5467, 5468, 5469, 5470,
  5094,
  9064, 9065, 9066, 9067, 9068, 9069,
]);

const WEAPON_SLOT_TYPES = new Set<number>([1, 2, 3, 8, 17, 24]);
const ABILITY_SLOT_TYPES = new Set<number>([4, 5, 11, 12, 13, 15, 16, 18, 19, 20, 21, 22, 23, 25, 27, 28, 29, 30, 31]);
const ARMOR_SLOT_TYPES = new Set<number>([6, 7, 14]);
const RING_SLOT_TYPES = new Set<number>([9]);
// Slot types excluded from UT looting (tomes / orbs excluded from generic UT loot)
const EXCLUDED_UT_SLOT_TYPES = new Set<number>([10, 26]);

function isGearSlotType(slotType: number): boolean {
  return WEAPON_SLOT_TYPES.has(slotType)
    || ABILITY_SLOT_TYPES.has(slotType)
    || ARMOR_SLOT_TYPES.has(slotType)
    || RING_SLOT_TYPES.has(slotType);
}

function isMultitoolUtTier(normalizedTier: string, slotType: number): boolean {
  if (normalizedTier === 'ST') return false;
  if (normalizedTier === 'UT') return true;
  if (normalizedTier !== '') return false;
  return isGearSlotType(slotType);
}

type GearCategory = 'weapon' | 'ability' | 'armor' | 'ring';

function getGearCategory(slotType: number): GearCategory | null {
  if (WEAPON_SLOT_TYPES.has(slotType)) return 'weapon';
  if (ABILITY_SLOT_TYPES.has(slotType)) return 'ability';
  if (ARMOR_SLOT_TYPES.has(slotType)) return 'armor';
  if (RING_SLOT_TYPES.has(slotType)) return 'ring';
  return null;
}

// ─── ItemInfo catalog ────────────────────────────────────────────────────────

interface ItemInfo {
  slotType: number;
  tier: number | null;
  isUT: boolean;
  isST: boolean;
  name: string;
  quickslotAllowed: boolean;
}

let catalog: Map<number, ItemInfo> = new Map();

function buildCatalog(deps: BridgeDeps): void {
  catalog = new Map();
  for (const obj of deps.gameData.getAllObjects()) {
    const slotTypeRaw = Number(obj.slotType ?? -1);
    if (!Number.isFinite(slotTypeRaw) || slotTypeRaw < 0) continue;
    const slotType = Math.trunc(slotTypeRaw);
    const normalizedTier = String(obj.tierStr ?? '').trim().toUpperCase();
    const isST = normalizedTier === 'ST';
    const isUT = isMultitoolUtTier(normalizedTier, slotType);
    const tier = (isUT || isST || !/^-?\d+$/.test(normalizedTier)) ? null : Number(normalizedTier);
    const name = String(obj.id || '').trim() || `0x${obj.type.toString(16)}`;
    catalog.set(obj.type, { slotType, tier, isUT, isST, name, quickslotAllowed: obj.quickslotAllowed === true });
  }
}

// ─── Rarity ranking ──────────────────────────────────────────────────────────

const RARITY_RANK = LOOT_RARITY_RANK;

// ─── Active bag tracking ─────────────────────────────────────────────────────

type AnyHandler = (e: any) => void;
interface LegacyLootState {
  activeBags: Map<number, LootBag>;
  listeners: Map<string, AnyHandler[]>;
}

const legacyStates = new WeakMap<ClientConnection, LegacyLootState>();

function stateFor(client: ClientConnection): LegacyLootState {
  const current = legacyStates.get(client);
  if (current) return current;
  const state = { activeBags: new Map<number, LootBag>(), listeners: new Map<string, AnyHandler[]>() };
  legacyStates.set(client, state);
  return state;
}

function register(client: ClientConnection | undefined, key: string, handler: AnyHandler): () => void {
  if (!client) return () => {};
  const { listeners } = stateFor(client);
  if (!listeners.has(key)) listeners.set(key, []);
  listeners.get(key)!.push(handler);
  return () => {
    const arr = listeners.get(key) ?? [];
    listeners.set(key, arr.filter((h) => h !== handler));
  };
}

function fireSafe(client: ClientConnection, key: string, event: any): void {
  for (const h of stateFor(client).listeners.get(key) ?? []) {
    try {
      h(event);
    } catch (err) {
      Logger.warn('BridgeLoot', `listener error: ${(err as Error).message}`);
    }
  }
}

function buildBagFromObj(obj: any, deps: BridgeDeps): LootBag | null {
  const objectType = Number(obj.objectType);
  const status = obj.status;
  if (!status) return null;

  const objectId = Number(status.objectId);
  const pos = status.position
    ? { x: Number(status.position.x), y: Number(status.position.y) }
    : { x: 0, y: 0 };

  const stats: Record<string, number | string> = {};
  if (status.data && Array.isArray(status.data)) {
    for (const s of status.data) {
      if (s && s.id != null) stats[String(s.id)] = s.value;
    }
  }
  return buildLootBag({ objectId, objectType, x: pos.x, y: pos.y, stats }, Date.now(), deps);
}

function onUpdate(client: ClientConnection, packet: Packet, deps: BridgeDeps): void {
  if (!packet.isDefined) return;
  const { activeBags } = stateFor(client);
  if (packet.data.newObjs) {
    for (const obj of packet.data.newObjs as any[]) {
      const bag = buildBagFromObj(obj, deps);
      if (!bag) continue;
      activeBags.set(bag.objectId, bag);
      fireSafe(client, 'bagDropped', { bag });
    }
  }
  if (packet.data.drops) {
    for (const id of packet.data.drops as number[]) {
      const bag = activeBags.get(Number(id));
      if (!bag) continue;
      activeBags.delete(Number(id));
      fireSafe(client, 'bagRemoved', { bag });
    }
  }
}

function currentLegacyBags(deps: BridgeDeps): LootBag[] {
  const client = deps.clientRef.current;
  if (!client) return [];
  const state = stateFor(client);
  const worldState = deps.getWorldStateForClient?.(client) ?? deps.worldState;
  const result: LootBag[] = [];
  for (const [objectId, cached] of state.activeBags) {
    const entity = worldState.getEntity(objectId);
    const refreshed = entity
      ? buildLootBag({
          objectId,
          objectType: cached.bagType,
          x: entity.pos.x,
          y: entity.pos.y,
          stats: { ...(entity.stats ?? {}) },
        }, cached.droppedAt, deps)
      : cached;
    if (!refreshed) continue;
    state.activeBags.set(objectId, refreshed);
    result.push(refreshed);
  }
  return result;
}

// ─── Packet helpers ───────────────────────────────────────────────────────────

const QUICKSLOT_PACKET_BASE = 1000000;
const QUICK_SLOT_COUNT = 3;

function getCurrentBagSlotItem(
  deps: BridgeDeps,
  client: ClientConnection,
  bagObjectId: number,
  slotIndex: number,
): number {
  const worldState = deps.getWorldStateForClient?.(client) ?? deps.worldState;
  const entity = worldState.getEntity(bagObjectId);
  if (!entity) return -1;
  const raw = entity.stats?.[String(StatType.Inventory0 + slotIndex)];
  const itemId = Number(raw);
  return Number.isFinite(itemId) ? Math.trunc(itemId) : -1;
}

function findFreeSlot(
  client: ClientConnection,
  useBackpack = true,
  exclude?: Set<number>,
): { packetSlotId: number; currentObjectType: number } | null {
  // Main inventory slots 4–11 (0–3 are gear slots)
  for (let slot = 4; slot <= 11; slot++) {
    if (exclude?.has(slot)) continue;
    const objectType = Number(client.playerData.inventory[slot] ?? -1);
    if (objectType === -1) return { packetSlotId: slot, currentObjectType: -1 };
  }
  if (useBackpack && client.playerData.hasBackpack) {
    for (let slot = 0; slot < 16; slot++) {
      const packetSlotId = 12 + slot;
      if (exclude?.has(packetSlotId)) continue;
      const objectType = Number(client.playerData.backpack[slot] ?? -1);
      if (objectType === -1) return { packetSlotId: packetSlotId, currentObjectType: -1 };
    }
  }
  return null;
}

function findQuickslotForItem(
  client: ClientConnection,
  itemId: number,
  exclude?: Set<number>,
): { packetSlotId: number; currentObjectType: number } | null {
  const info = catalog.get(itemId);
  if (!info?.quickslotAllowed) return null;
  // Check if already in a quick slot
  for (let slot = 0; slot < QUICK_SLOT_COUNT; slot++) {
    const packetSlotId = QUICKSLOT_PACKET_BASE + slot;
    if (exclude?.has(packetSlotId)) continue;
    const objectType = Number(client.playerData.quickSlots[slot] ?? -1);
    if (objectType === itemId) return { packetSlotId, currentObjectType: objectType };
  }
  // Find empty quick slot
  for (let slot = 0; slot < QUICK_SLOT_COUNT; slot++) {
    const packetSlotId = QUICKSLOT_PACKET_BASE + slot;
    if (exclude?.has(packetSlotId)) continue;
    const objectType = Number(client.playerData.quickSlots[slot] ?? -1);
    if (objectType === -1) return { packetSlotId, currentObjectType: -1 };
  }
  return null;
}

function sendInventorySwap(
  c: ClientConnection,
  deps: BridgeDeps,
  bagObjectId: number,
  bagSlot: number,
  itemId: number,
  dest: { packetSlotId: number; currentObjectType: number },
): void {
  const pkt = deps.proxy.packetFactory.createByName('INVENTORYSWAP');
  pkt.data.time = Math.trunc(c.time);
  pkt.data.position = {
    x: Number(c.playerData.pos?.x ?? 0),
    y: Number(c.playerData.pos?.y ?? 0),
  };
  pkt.data.slotObject1 = { objectId: bagObjectId, slotId: bagSlot, objectType: itemId };
  pkt.data.slotObject2 = { objectId: c.objectId, slotId: dest.packetSlotId, objectType: dest.currentObjectType };
  pkt.modified = true;
  c.sendToServer(pkt);
}

// ─── shouldPickup logic ───────────────────────────────────────────────────────

function runShouldPickup(objectType: number, opts: PickupOptions, deps: BridgeDeps): boolean {
  if (!Number.isFinite(objectType) || objectType <= 0) return false;

  const blacklistSet = opts.blacklist ? new Set(opts.blacklist) : null;
  const whitelistSet = opts.whitelist ? new Set(opts.whitelist) : null;

  if (blacklistSet?.has(objectType)) return false;
  if (whitelistSet?.has(objectType)) return true;

  if (HP_POTION_IDS.has(objectType)) return opts.includeHpPotions ?? false;
  if (MP_POTION_IDS.has(objectType)) return opts.includeMpPotions ?? false;
  if (LIFE_MANA_POTION_IDS.has(objectType)) return opts.includeLifeManaPotions ?? true;
  if (STAT_POTION_IDS.has(objectType)) return opts.includeStatPotions ?? true;

  const info = catalog.get(objectType);
  if (!info) {
    // Item not in gear catalog — try raw game data (catches recently-added items missing from catalog)
    const rawObj = deps.gameData.getObject(objectType);
    if (rawObj && (opts.includeUTs ?? true)) {
      const st = Math.trunc(Number(rawObj.slotType ?? -1));
      const tier = String(rawObj.tierStr ?? '').trim().toUpperCase();
      if (isMultitoolUtTier(tier, st) && !EXCLUDED_UT_SLOT_TYPES.has(st)) return true;
    }
    return false;
  }

  if (opts.includeMarks && info.name.includes('Mark of ')) return true;
  if (opts.includeEggs && info.name.endsWith(' Egg')) return true;

  if (info.isUT) {
    if (!(opts.includeUTs ?? true)) return false;
    return !EXCLUDED_UT_SLOT_TYPES.has(info.slotType);
  }

  if (info.isST) return opts.includeSTs ?? false;

  const category = getGearCategory(info.slotType);
  if (!category) return false;

  let minTier: number;
  switch (category) {
    case 'weapon': minTier = opts.minWeaponTier ?? 0; break;
    case 'ability': minTier = opts.minAbilityTier ?? 0; break;
    case 'armor': minTier = opts.minArmorTier ?? 0; break;
    case 'ring': minTier = opts.minRingTier ?? 0; break;
  }

  return info.tier != null && info.tier >= minTier;
}

// ─── install ──────────────────────────────────────────────────────────────────

let hookInstalled = false;

export function install(deps: BridgeDeps): void {
  if (!hookInstalled) {
    hookInstalled = true;
    buildCatalog(deps);

    deps.proxy.hookPacket('UPDATE', (client, packet) => {
      try {
        onUpdate(client, packet, deps);
      } catch (err) {
        Logger.warn('BridgeLoot', `UPDATE hook error: ${(err as Error).message}`);
      }
    });

    deps.proxy.hookPacket('MAPINFO', (client) => {
      stateFor(client).activeBags.clear();
    });
  }

  // ─── Bag queries ────────────────────────────────────────────────────────────
  loot.getBags = () => currentLegacyBags(deps);

  loot.getNearbyBags = (radius = 5) => {
    const pd = deps.clientRef.current?.playerData;
    if (!pd) return currentLegacyBags(deps);
    const { x: px, y: py } = pd.pos;
    return currentLegacyBags(deps).filter(
      (b) => Math.sqrt((b.position.x - px) * (b.position.x - px) + (b.position.y - py) * (b.position.y - py)) <= radius,
    );
  };

  loot.getBagsByRarity = (rarity) =>
    currentLegacyBags(deps).filter((b) => b.rarity === rarity);

  loot.getBagsContaining = (objectType) =>
    currentLegacyBags(deps).filter((b) => b.items.some((i) => i.objectType === objectType));

  // ─── Events ─────────────────────────────────────────────────────────────────
  loot.onBagDropped = (handler) => register(deps.clientRef.current, 'bagDropped', handler);

  loot.onRareBagDropped = (minRarity, handler) =>
    loot.onBagDropped((e) => {
      if (RARITY_RANK[e.bag.rarity] >= RARITY_RANK[minRarity]) handler(e);
    });

  loot.onItemDropped = (objectType, handler) =>
    loot.onBagDropped((e) => {
      const match = e.bag.items.find((i: LootItem) => i.objectType === objectType);
      if (match) handler({ bag: e.bag, item: match });
    });

  loot.onBagRemoved = (handler) => register(deps.clientRef.current, 'bagRemoved', handler);

  // ─── Pickup ──────────────────────────────────────────────────────────────────

  loot.pickup = (bag, slotIndex, opts) => {
    const c = deps.clientRef.current;
    if (!c?.connected || !c.objectId) return false;

    const itemId = getCurrentBagSlotItem(deps, c, bag.objectId, slotIndex);
    if (itemId <= 0) return false;

    const useBackpack = opts?.useBackpack ?? true;
    const destination = findQuickslotForItem(c, itemId) ?? findFreeSlot(c, useBackpack);
    if (!destination) return false;

    try {
      sendInventorySwap(c, deps, bag.objectId, slotIndex, itemId, destination);
      return true;
    } catch (err) {
      Logger.warn('BridgeLoot', `pickup failed: ${(err as Error).message}`);
      return false;
    }
  };

  loot.pickupToSlot = (bag, slotIndex, inventorySlotIndex) => {
    const c = deps.clientRef.current;
    if (!c?.connected || !c.objectId || !Number.isInteger(inventorySlotIndex) || inventorySlotIndex < 0) return false;
    const itemId = getCurrentBagSlotItem(deps, c, bag.objectId, slotIndex);
    if (itemId <= 0) return false;
    const currentObjectType = inventorySlotIndex < 12
      ? Number(c.playerData.inventory[inventorySlotIndex] ?? -1)
      : Number(c.playerData.backpack[inventorySlotIndex - 12] ?? -1);
    try {
      sendInventorySwap(c, deps, bag.objectId, slotIndex, itemId, {
        packetSlotId: inventorySlotIndex,
        currentObjectType,
      });
      return true;
    } catch (err) {
      Logger.warn('BridgeLoot', `pickupToSlot failed: ${(err as Error).message}`);
      return false;
    }
  };

  loot.pickupId = (bagObjectId, opts) => {
    const c = deps.clientRef.current;
    if (!c?.connected || !c.objectId) return -1;

    // Look up bag — check activeBags first, fall back to worldState entity
    const bag = stateFor(c).activeBags.get(bagObjectId);
    const worldState = deps.getWorldStateForClient?.(c) ?? deps.worldState;
    const entity = worldState.getEntity(bagObjectId);
    if (!entity) return -1;

    // Use most up-to-date position from worldState
    const bx = Number(entity.pos?.x ?? (bag?.position.x ?? 0));
    const by = Number(entity.pos?.y ?? (bag?.position.y ?? 0));
    const px = Number(c.playerData.pos?.x ?? 0);
    const py = Number(c.playerData.pos?.y ?? 0);
    const maxDist = opts?.maxDistance ?? 1.0;
    if (Math.sqrt((bx - px) * (bx - px) + (by - py) * (by - py)) > maxDist) return -1;

    const useBackpack = opts?.useBackpack ?? true;
    const claimedSlots = new Set<number>();
    let sent = 0;

    for (let slot = 0; slot < 8; slot++) {
      const itemId = getCurrentBagSlotItem(deps, c, bagObjectId, slot);
      if (itemId <= 0) continue;

      const destination = findQuickslotForItem(c, itemId, claimedSlots)
        ?? findFreeSlot(c, useBackpack, claimedSlots);
      if (!destination) continue; // inventory full for this item

      claimedSlots.add(destination.packetSlotId);
      try {
        sendInventorySwap(c, deps, bagObjectId, slot, itemId, destination);
        sent++;
      } catch (err) {
        Logger.warn('BridgeLoot', `pickupId slot ${slot} failed: ${(err as Error).message}`);
      }
    }

    return sent;
  };

  loot.useFromBag = (bag, slotIndex) => {
    const c = deps.clientRef.current;
    if (!c?.connected) return false;

    const itemId = getCurrentBagSlotItem(deps, c, bag.objectId, slotIndex);
    if (itemId <= 0) return false;

    try {
      const pkt = deps.proxy.packetFactory.createByName('USEITEM');
      pkt.data.time = Math.trunc(c.time);
      pkt.data.slotObject = {
        objectId: bag.objectId,
        slotId: slotIndex,
        objectType: itemId,
      };
      pkt.data.itemUsePos = { x: 0, y: 0 };
      pkt.data.useType = 0;
      pkt.data.unknownInt = 0;
      pkt.modified = true;
      c.sendToServer(pkt);
      return true;
    } catch (err) {
      Logger.warn('BridgeLoot', `useFromBag failed: ${(err as Error).message}`);
      return false;
    }
  };

  // ─── Item classification + filter ────────────────────────────────────────────

  loot.shouldPickup = (objectType, opts = {}) => runShouldPickup(objectType, opts, deps);
  loot.getItemInfo = (objectType) => deps.gameData.buildSdkItem(objectType);

  loot.isUT = (objectType) => {
    const info = catalog.get(objectType);
    if (info) return info.isUT;
    const raw = deps.gameData.getObject(objectType);
    if (!raw) return false;
    const st = Math.trunc(Number(raw.slotType ?? -1));
    return isMultitoolUtTier(String(raw.tierStr ?? '').trim().toUpperCase(), st);
  };

  loot.isST = (objectType) => {
    const info = catalog.get(objectType);
    if (info) return info.isST;
    const raw = deps.gameData.getObject(objectType);
    return raw ? String(raw.tierStr ?? '').trim().toUpperCase() === 'ST' : false;
  };

  loot.isStatPot = (objectType) => STAT_POTION_IDS.has(objectType);
  loot.isHpPot = (objectType) => HP_POTION_IDS.has(objectType);
  loot.isMpPot = (objectType) => MP_POTION_IDS.has(objectType);
  loot.isLifeManaPot = (objectType) => LIFE_MANA_POTION_IDS.has(objectType);
}
