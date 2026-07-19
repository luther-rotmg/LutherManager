import {
  inventory,
  INVENTORY_BACKPACK_SLOT_COUNT,
  INVENTORY_MAIN_SLOT_COUNT,
  INVENTORY_TOTAL_SLOT_COUNT,
} from '@luthermanager/sdk';
import type {
  InventoryItem,
  InventoryBackpackTier,
  InventoryContainer,
  InventoryStorageSide,
  ContainerSlot,
} from '@luthermanager/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { PlayerData } from '../../../state/PlayerData.js';
import { depositToVault, sendInventorySwap, withdrawFromVault } from './vaultTransfer.js';
import {
  getChestSlots,
  getVaultStore,
  installVaultStoreHooks,
  resolveChestSlot,
  type ChestDb,
} from './VaultStore.js';
import { warnUnimplemented } from '../stubWarn.js';
import { buildSlotEnchantments } from '../loot/model.js';
import { GameId } from '../../../constants/GameId.js';
import { installStorageApi } from './storage.js';

type StorageContainer = Exclude<InventoryContainer, 'inventory' | 'petBag'>;

function playerData(deps: BridgeDeps): PlayerData | null {
  return deps.clientRef.current?.playerData ?? null;
}

/** SDK codes for `inventory.getBackpack()` — aligned with wire stat 130 + legacy HasBackpack (75). */
function backpackTierFromPlayerData(pd: PlayerData | null): InventoryBackpackTier {
  if (!pd) return 1;
  if (pd.backpackTier >= 16) return 3;
  if (pd.backpackTier !== 0 || pd.legacyHasBackpackStat75) return 2;
  return 1;
}

/** Normalized type id for a cell, or -1 if empty / invalid. */
function cellTypeId(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) return -1;
  return Math.trunc(raw);
}

function typeIdAtSlot(p: PlayerData, slotIndex: number): number {
  if (slotIndex < 0 || slotIndex >= INVENTORY_TOTAL_SLOT_COUNT) return -1;
  if (slotIndex < INVENTORY_MAIN_SLOT_COUNT) {
    return cellTypeId(p.inventory[slotIndex]);
  }
  return cellTypeId(p.backpack[slotIndex - INVENTORY_MAIN_SLOT_COUNT]);
}

function itemNameForType(deps: BridgeDeps, objectType: number): string | undefined {
  const item = deps.gameData.buildSdkItem(objectType);
  return item?.name;
}

function inventoryItemAt(
  deps: BridgeDeps,
  slotIndex: number,
  objectType: number,
): InventoryItem {
  return {
    objectType,
    slotIndex,
    itemName: itemNameForType(deps, objectType),
  };
}

function slotMatchesQuery(
  deps: BridgeDeps,
  objectType: number,
  query: number | string,
): boolean {
  if (typeof query === 'number' && Number.isFinite(query)) {
    return objectType === Math.trunc(query);
  }
  const q = String(query).trim().toLowerCase();
  if (!q) return false;
  const name = itemNameForType(deps, objectType)?.toLowerCase() ?? '';
  if (name.includes(q)) return true;
  const def = deps.gameData.getObject(objectType);
  const id = def?.id?.toLowerCase() ?? '';
  return id.includes(q);
}

function inventorySlotLimit(pd: PlayerData): number {
  const tier = backpackTierFromPlayerData(pd);
  return tier >= 3 ? INVENTORY_TOTAL_SLOT_COUNT : tier >= 2 ? 20 : INVENTORY_MAIN_SLOT_COUNT;
}

function storageChest(client: NonNullable<BridgeDeps['clientRef']['current']>, container: StorageContainer) {
  const state = getVaultStore(client);
  if (!state) return null;
  switch (container) {
    case 'vault': return state.vault;
    case 'materialVault': return state.material;
    case 'giftChest': return state.gift;
    case 'potionVault': return state.potion;
    case 'spoilsChest': return state.seasonalSpoils;
  }
}

function proxyContainerObjectId(deps: BridgeDeps, container: InventoryContainer): number {
  const client = deps.clientRef.current;
  if (!client) return -1;
  if (container === 'inventory') return client.playerData.ownerObjectId || client.objectId || -1;
  if (container === 'petBag') return -1;
  return storageChest(client, container)?.objectId ?? -1;
}

function proxyContainerSlots(deps: BridgeDeps, container: InventoryContainer): ContainerSlot[] {
  const client = deps.clientRef.current;
  if (!client) return [];
  const objectId = proxyContainerObjectId(deps, container);
  if (container === 'inventory') {
    const limit = inventorySlotLimit(client.playerData);
    return Array.from({ length: limit }, (_, slotId) => ({
      objectId,
      slotId,
      objectType: typeIdAtSlot(client.playerData, slotId),
    }));
  }
  if (container === 'petBag') return [];
  const chest = storageChest(client, container);
  return chest
    ? getChestSlots(chest).map((slot) => ({
        objectId: slot.objectId,
        slotId: slot.logicalSlotId,
        objectType: slot.objectType,
      }))
    : [];
}

function proxySwapContainers(
  deps: BridgeDeps,
  from: { container: InventoryContainer; slotId: number; itemType?: number },
  to: { container: InventoryContainer; slotId: number; itemType?: number },
): boolean {
  const client = deps.clientRef.current;
  if (!client?.connected) return false;
  const state = getVaultStore(client);
  const touchesStorage = from.container !== 'inventory' || to.container !== 'inventory';
  if (from.container === 'petBag' || to.container === 'petBag') return false;
  if (touchesStorage && (
    (client.state?.gameId ?? -999) !== GameId.Vault ||
    !state?.active ||
    !state.lastVaultUpdate
  )) return false;

  const resolve = (ref: typeof from) => {
    const slotId = Math.trunc(ref.slotId);
    if (ref.container === 'inventory') {
      const slot = proxyContainerSlots(deps, ref.container).find((candidate) => candidate.slotId === slotId);
      if (!slot) return null;
      return { ...slot, objectType: ref.itemType === undefined ? slot.objectType : Math.trunc(ref.itemType) };
    }
    if (ref.container === 'petBag') return null;
    const chest = storageChest(client, ref.container);
    const slot = chest ? resolveChestSlot(chest, slotId) : null;
    if (!slot) return null;
    return {
      objectId: slot.objectId,
      slotId: slot.slotId,
      objectType: ref.itemType === undefined ? slot.objectType : Math.trunc(ref.itemType),
    };
  };
  let source = resolve(from);
  let destination = resolve(to);
  if (!source || !destination || source.objectId <= 0 || destination.objectId <= 0) return false;
  if (source.objectType < 0 && destination.objectType >= 0) [source, destination] = [destination, source];
  if (source.objectType < 0 && destination.objectType < 0) return false;
  return sendInventorySwap(deps, client, source, destination);
}

export function install(deps: BridgeDeps): void {
  installVaultStoreHooks(deps);
  installStorageApi(deps);

  inventory.withdraw = (target: number, side: InventoryStorageSide) =>
    withdrawFromVault(deps, target, side);
  inventory.deposit = (target: number, side: InventoryStorageSide) =>
    depositToVault(deps, target, side);

  function requireVaultState(name: string) {
    const c = deps.clientRef.current;
    if (!c) throw new Error(`inventory.${name}: not connected`);
    const state = getVaultStore(c);
    if (!state) throw new Error(`inventory.${name}: vault not entered yet (no VAULTCONTENT received)`);
    return state;
  }

  inventory.getVault = () => requireVaultState('getVault').vault.contents.slice();

  inventory.getEntireVault = () => {
    const state = requireVaultState('getEntireVault');
    const containers = (chest: ChestDb) => {
      let startSlot = 0;
      return chest.chunks.map((chunk) => {
        const result = {
          objectId: chunk.objectId,
          startSlot,
          slotCount: chunk.contents.length,
          enchantments: chunk.enchantments,
        };
        startSlot += chunk.contents.length;
        return result;
      });
    };
    return {
      capturedAt: state.capturedAt,
      updatedAt: state.updatedAt,
      revision: state.revision,
      active: state.active,
      complete: state.lastVaultUpdate,
      objectIds: {
        vault: state.vault.objectId,
        material: state.material.objectId,
        gift: state.gift.objectId,
        potion: state.potion.objectId,
        seasonalSpoils: state.seasonalSpoils.objectId,
      },
      containers: {
        vault: containers(state.vault),
        material: containers(state.material),
        gift: containers(state.gift),
        potion: containers(state.potion),
        seasonalSpoils: containers(state.seasonalSpoils),
      },
      vault: state.vault.contents.slice(),
      material: state.material.contents.slice(),
      gift: state.gift.contents.slice(),
      potion: state.potion.contents.slice(),
      seasonalSpoils: state.seasonalSpoils.contents.slice(),
      upgradeCosts: {
        vault: state.vaultUpgradeCost,
        material: state.materialUpgradeCost,
        potion: state.potionUpgradeCost,
        seasonalSpoils: state.seasonalSpoilUpgradeCost,
      },
      potionCapacity: { current: state.currentPotionMax, next: state.nextPotionMax },
      enchantments: {
        vault: state.vaultChestEnchants,
        gift: state.giftChestEnchants,
        seasonalSpoils: state.spoilsChestEnchants,
      },
    };
  };
  inventory.getVaultSnapshot = () => inventory.getEntireVault();

  inventory.getMaterials = () => requireVaultState('getMaterials').material.contents.slice();
  inventory.getPotions   = () => requireVaultState('getPotions').potion.contents.slice();
  inventory.getGifts     = () => requireVaultState('getGifts').gift.contents.slice();
  inventory.getSeasonalSpoils = () => requireVaultState('getSeasonalSpoils').seasonalSpoils.contents.slice();

  inventory.getContainerSlots = (container: InventoryContainer) => proxyContainerSlots(deps, container);
  inventory.getContainerObjectId = (container: InventoryContainer) => proxyContainerObjectId(deps, container);
  inventory.swapContainers = (from, to) => proxySwapContainers(deps, from, to);
  inventory.getFirstFilledSlot = (container: InventoryContainer) =>
    proxyContainerSlots(deps, container).find((slot) => slot.objectType >= 0) ?? null;
  inventory.getFirstEmptySlot = (container: InventoryContainer) =>
    proxyContainerSlots(deps, container).find(
      (slot) => slot.objectType < 0 && (container !== 'inventory' || slot.slotId >= 4),
    ) ?? null;
  inventory.getContainerItemCount = (container: InventoryContainer) =>
    proxyContainerSlots(deps, container).filter((slot) => slot.objectType >= 0).length;
  inventory.hasSpace = () => proxyContainerSlots(deps, 'inventory').some((slot) => slot.slotId >= 4 && slot.objectType < 0);
  inventory.swapInventoryWithPetBag = () => false;
  inventory.swapInventoryWithVault = (inventorySlot, vaultSlot) => proxySwapContainers(
    deps,
    { container: 'inventory', slotId: inventorySlot },
    { container: 'vault', slotId: vaultSlot },
  );
  inventory.swapInventoryWithPotionVault = (inventorySlot, potionSlot) => proxySwapContainers(
    deps,
    { container: 'inventory', slotId: inventorySlot },
    { container: 'potionVault', slotId: potionSlot },
  );

  inventory.getSlot = (index: number) => {
    const p = playerData(deps);
    if (!p || index < 0 || index >= INVENTORY_TOTAL_SLOT_COUNT) return null;
    const objectType = typeIdAtSlot(p, index);
    if (objectType < 0) return null;
    return inventoryItemAt(deps, index, objectType);
  };
  inventory.getEnchantments = (slotIndex: number) => {
    const raw = playerData(deps)?.enchantmentsRaw;
    return buildSlotEnchantments(raw, slotIndex, deps);
  };

  inventory.getAll = () => {
    const p = playerData(deps);
    const out: number[] = new Array(INVENTORY_TOTAL_SLOT_COUNT).fill(-1);
    if (!p) return out;
    for (let i = 0; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
      out[i] = cellTypeId(p.inventory[i]);
    }
    for (let i = 0; i < INVENTORY_BACKPACK_SLOT_COUNT; i++) {
      out[INVENTORY_MAIN_SLOT_COUNT + i] = cellTypeId(p.backpack[i]);
    }
    return out;
  };

  inventory.findItem = (query: number | string) => {
    const p = playerData(deps);
    if (!p) return null;
    for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
      const objectType = typeIdAtSlot(p, slot);
      if (objectType < 0) continue;
      if (slotMatchesQuery(deps, objectType, query)) {
        return inventoryItemAt(deps, slot, objectType);
      }
    }
    return null;
  };

  inventory.findItems = (query: number | string) => {
    const p = playerData(deps);
    if (!p) return [];
    const matches: InventoryItem[] = [];
    for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
      const objectType = typeIdAtSlot(p, slot);
      if (objectType < 0) continue;
      if (slotMatchesQuery(deps, objectType, query)) {
        matches.push(inventoryItemAt(deps, slot, objectType));
      }
    }
    return matches;
  };

  inventory.useItem = (_slotIndex: number) => {
    warnUnimplemented('inventory.useItem');
  };

  inventory.swapSlots = (_slotA: number, _slotB: number) => {
    warnUnimplemented('inventory.swapSlots');
  };

  /** Bag slots only: indices 4–11 (8 slots), per RotMG layout. */
  inventory.isFull = () => {
    const p = playerData(deps);
    if (!p) return false;
    for (let i = 4; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
      if (typeIdAtSlot(p, i) < 0) return false;
    }
    return true;
  };

  inventory.emptySlotCount = () => {
    const p = playerData(deps);
    if (!p) return 8;
    let n = 0;
    for (let i = 4; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
      if (typeIdAtSlot(p, i) < 0) n++;
    }
    return n;
  };

  inventory.getBackpack = () => backpackTierFromPlayerData(playerData(deps));
}
