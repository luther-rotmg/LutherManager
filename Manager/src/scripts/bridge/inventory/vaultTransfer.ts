import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import { GameId } from '../../../constants/GameId.js';
import type { PlayerData } from '../../../state/PlayerData.js';
import { Logger } from '../../../util/Logger.js';
import type { BridgeDeps } from '../BridgeDeps.js';
import { INVENTORY_MAIN_SLOT_COUNT, INVENTORY_TOTAL_SLOT_COUNT } from '@hive/sdk';
import { getVaultStore } from './VaultStore.js';

/** RotMG vault map id. */
export const GAME_ID_VAULT = GameId.Vault;

export type InventoryStorageSide = 'container' | 'inventory';

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

function setSlot(p: PlayerData, slotIndex: number, typeId: number): void {
  const t = typeId < 0 ? -1 : Math.trunc(typeId);
  if (slotIndex < INVENTORY_MAIN_SLOT_COUNT) {
    p.inventory[slotIndex] = t;
  } else {
    p.backpack[slotIndex - INVENTORY_MAIN_SLOT_COUNT] = t;
  }
}

/** Bag slots only — indices 4–11 main, 12–27 backpack. Slots 0–3 are equipment and must not be used. */
function firstEmptyInventorySlot(p: PlayerData): number | null {
  for (let i = 4; i < INVENTORY_TOTAL_SLOT_COUNT; i++) {
    if (typeIdAtSlot(p, i) < 0) return i;
  }
  return null;
}

/** Bag slots only — indices 4–11 main, 12–27 backpack. Slots 0–3 are equipment and must not be used. */
function firstNonEmptyInventorySlot(p: PlayerData): number | null {
  for (let i = 4; i < INVENTORY_TOTAL_SLOT_COUNT; i++) {
    if (typeIdAtSlot(p, i) >= 0) return i;
  }
  return null;
}

/** Empty = -1 only (0 is a valid item type id). */
function firstEmptyVaultSlot(vault: number[]): number | null {
  for (let i = 0; i < vault.length; i++) {
    if (vault[i] === -1 || vault[i] === undefined) return i;
  }
  return null;
}

function getVaultSlots(deps: BridgeDeps, _p: PlayerData): number[] | null {
  const c = deps.clientRef.current;
  if (!c) return null;
  const state = getVaultStore(c);
  if (!state || state.vault.contents.length === 0) return null;
  return state.vault.contents.slice();
}

function setVaultSlot(deps: BridgeDeps, _p: PlayerData, slotIndex: number, typeId: number): void {
  const c = deps.clientRef.current;
  if (!c) return;
  const state = getVaultStore(c);
  if (!state) return;
  const contents = state.vault.contents;
  while (contents.length <= slotIndex) contents.push(-1);
  contents[slotIndex] = typeId < 0 ? -1 : Math.trunc(typeId);
}

/**
 * Resolve vault source: `target` is a vault slot index if that cell is occupied,
 * otherwise treated as an object type id (first matching cell).
 */
function resolveVaultSourceSlot(
  vaultContent: number[],
  target: number,
): { slot: number; itemType: number } | null {
  const t = Math.trunc(target);
  if (vaultContent.length === 0) return null;
  if (t >= 0 && t < vaultContent.length) {
    const at = Math.trunc(vaultContent[t]) | 0;
    if (at >= 0) return { slot: t, itemType: at };
  }
  for (let i = 0; i < vaultContent.length; i++) {
    const at = Math.trunc(vaultContent[i] ?? -1) | 0;
    if (at >= 0 && at === t) return { slot: i, itemType: at };
  }
  return null;
}

/** Find first occupied vault cell. */
function firstOccupiedVaultSlot(vaultContent: number[]): { slot: number; itemType: number } | null {
  for (let i = 0; i < vaultContent.length; i++) {
    const at = Math.trunc(vaultContent[i] ?? -1) | 0;
    if (at >= 0) return { slot: i, itemType: at };
  }
  return null;
}

/** Resolve inventory source: slot if occupied, else first slot matching object type. */
/** Resolve inventory source: bag slots only (4–27). Slot index if occupied, else first bag slot matching object type. */
function resolveInventorySourceSlot(
  p: PlayerData,
  target: number,
): { slot: number; itemType: number } | null {
  const t = Math.trunc(target);
  // Direct slot — must be a bag slot (4+)
  if (t >= 4 && t < INVENTORY_TOTAL_SLOT_COUNT) {
    const at = typeIdAtSlot(p, t);
    if (at >= 0) return { slot: t, itemType: at };
  }
  // Type scan — bag slots only
  for (let i = 4; i < INVENTORY_TOTAL_SLOT_COUNT; i++) {
    const at = typeIdAtSlot(p, i);
    if (at >= 0 && at === t) return { slot: i, itemType: at };
  }
  return null;
}

function sendInventorySwap(
  deps: BridgeDeps,
  c: ClientConnection,
  o1: { objectId: number; slotId: number; objectType: number },
  o2: { objectId: number; slotId: number; objectType: number },
): boolean {
  try {
    const pkt = deps.proxy.packetFactory.createByName('INVENTORYSWAP');
    const p = c.playerData;
    pkt.data.time = Math.trunc(c.time);
    pkt.data.position = { x: p.pos.x, y: p.pos.y };
    pkt.data.slotObject1 = { objectId: o1.objectId, slotId: o1.slotId, objectType: o1.objectType };
    pkt.data.slotObject2 = { objectId: o2.objectId, slotId: o2.slotId, objectType: o2.objectType };
    // No tickId — live protocol wire format is time+pos+slot1+slot2 only (41 bytes).
    pkt.modified = true;
    c.sendToServer(pkt);
    return true;
  } catch (err) {
    Logger.warn('InventoryVault', `INVENTORYSWAP: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Move one stack from vault storage into inventory (vault → bag).
 *
 * - `side === 'container'`: target is vault slot index or object type id (first match).
 * - `side === 'inventory'`: target is destination inventory slot; first occupied vault slot is used.
 */
export function withdrawFromVault(
  deps: BridgeDeps,
  target: number,
  side: InventoryStorageSide,
): boolean {
  const c = deps.clientRef.current;
  if (!c?.connected) {
    Logger.warn('InventoryVault', 'withdraw: no connection');
    return false;
  }
  if ((c.state?.gameId ?? -999) !== GAME_ID_VAULT) {
    Logger.warn('InventoryVault', 'withdraw: must be in vault');
    return false;
  }
  const p = c.playerData;
  const vaultStore = getVaultStore(c);
  const vaultOid = vaultStore?.vault.objectId ?? -1;
  if (vaultOid <= 0) {
    Logger.warn('InventoryVault', 'withdraw: vault chest objectId unknown (wait for VAULTCONTENT)');
    return false;
  }
  const playerOid = p.ownerObjectId || c.objectId;
  if (playerOid <= 0) {
    Logger.warn('InventoryVault', 'withdraw: player objectId unknown');
    return false;
  }
  const vault = getVaultSlots(deps, p);
  if (!vault || vault.length === 0) {
    Logger.warn('InventoryVault', 'withdraw: vault contents unavailable (wait for VAULTCONTENT)');
    return false;
  }

  let vSlot: number;
  let itemType: number;
  let invSlot: number;

  if (side === 'container') {
    const src = resolveVaultSourceSlot(vault, target);
    if (!src) {
      Logger.warn('InventoryVault', 'withdraw: no matching vault slot or type');
      return false;
    }
    vSlot = src.slot;
    itemType = src.itemType;
    const empty = firstEmptyInventorySlot(p);
    if (empty === null) {
      Logger.warn('InventoryVault', 'withdraw: inventory full');
      return false;
    }
    invSlot = empty;
  } else {
    invSlot = Math.trunc(target);
    if (invSlot < 0 || invSlot >= INVENTORY_TOTAL_SLOT_COUNT) {
      Logger.warn('InventoryVault', 'withdraw: invalid destination inventory slot');
      return false;
    }
    if (typeIdAtSlot(p, invSlot) >= 0) {
      Logger.warn('InventoryVault', 'withdraw: destination inventory slot must be empty');
      return false;
    }
    const occ = firstOccupiedVaultSlot(vault);
    if (!occ) {
      Logger.warn('InventoryVault', 'withdraw: vault empty');
      return false;
    }
    vSlot = occ.slot;
    itemType = occ.itemType;
  }

  const curVault = Math.trunc(vault[vSlot] ?? -1) | 0;
  const curInv = typeIdAtSlot(p, invSlot);

  const ok = sendInventorySwap(
    deps,
    c,
    { objectId: vaultOid, slotId: vSlot, objectType: curVault >= 0 ? curVault : itemType },
    { objectId: playerOid, slotId: invSlot, objectType: curInv >= 0 ? curInv : -1 },
  );
  if (!ok) return false;

  setVaultSlot(deps, p, vSlot, -1);
  setSlot(p, invSlot, itemType);
  return true;
}

/**
 * Move one stack from inventory into vault storage (bag → vault).
 *
 * - `side === 'inventory'`: target is inventory slot index or object type id (first match).
 * - `side === 'container'`: target is destination vault slot; first occupied inventory slot is used.
 */
export function depositToVault(
  deps: BridgeDeps,
  target: number,
  side: InventoryStorageSide,
): boolean {
  const c = deps.clientRef.current;
  if (!c?.connected) {
    Logger.warn('InventoryVault', 'deposit: no connection');
    return false;
  }
  if ((c.state?.gameId ?? -999) !== GAME_ID_VAULT) {
    Logger.warn('InventoryVault', 'deposit: must be in vault');
    return false;
  }
  const p = c.playerData;
  const vaultStore = getVaultStore(c);
  const vaultOid = vaultStore?.vault.objectId ?? -1;
  if (vaultOid <= 0) {
    Logger.warn('InventoryVault', 'deposit: vault chest objectId unknown (wait for VAULTCONTENT)');
    return false;
  }
  const playerOid = p.ownerObjectId || c.objectId;
  if (playerOid <= 0) {
    Logger.warn('InventoryVault', 'deposit: player objectId unknown');
    return false;
  }
  const vault = getVaultSlots(deps, p);
  if (!vault || vault.length === 0) {
    Logger.warn('InventoryVault', 'deposit: vault contents unavailable (wait for VAULTCONTENT)');
    return false;
  }

  let invSlot: number;
  let itemType: number;
  let vSlot: number;

  if (side === 'inventory') {
    const src = resolveInventorySourceSlot(p, target);
    if (!src) {
      Logger.warn('InventoryVault', 'deposit: no matching inventory slot or type');
      return false;
    }
    invSlot = src.slot;
    itemType = src.itemType;
    const empty = firstEmptyVaultSlot(vault);
    if (empty === null) {
      Logger.warn('InventoryVault', 'deposit: vault full');
      return false;
    }
    vSlot = empty;
  } else {
    vSlot = Math.trunc(target);
    if (vSlot < 0 || vSlot >= vault.length) {
      Logger.warn('InventoryVault', 'deposit: invalid destination vault slot');
      return false;
    }
    if (vault[vSlot] !== -1 && vault[vSlot] !== undefined) {
      Logger.warn('InventoryVault', 'deposit: destination vault slot must be empty');
      return false;
    }
    const src = firstNonEmptyInventorySlot(p);
    if (src === null) {
      Logger.warn('InventoryVault', 'deposit: inventory empty');
      return false;
    }
    invSlot = src;
    itemType = typeIdAtSlot(p, invSlot);
  }

  const curInv = typeIdAtSlot(p, invSlot);
  const curVault = Math.trunc(vault[vSlot] ?? -1) | 0;

  const ok = sendInventorySwap(
    deps,
    c,
    { objectId: playerOid, slotId: invSlot, objectType: curInv >= 0 ? curInv : itemType },
    { objectId: vaultOid, slotId: vSlot, objectType: curVault >= 0 ? curVault : -1 },
  );
  if (!ok) return false;

  setSlot(p, invSlot, -1);
  setVaultSlot(deps, p, vSlot, itemType);
  return true;
}
