import {
  INVENTORY_BACKPACK_SLOT_COUNT,
  INVENTORY_MAIN_SLOT_COUNT,
  INVENTORY_TOTAL_SLOT_COUNT,
  Inventory,
} from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { PlayerData } from '../../../state/PlayerData.js';
import { warnUnimplemented } from '../stubWarn.js';

function playerData(deps: BridgeDeps): PlayerData | null {
  return deps.clientRef.current?.playerData ?? null;
}

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

export class BridgeInventory {  
  static install(deps: BridgeDeps): void {
    Inventory.getAll = (): string[] => {
      const p = playerData(deps);
      if (!p) return [];
      const lines: string[] = [];
      for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
        const tid = typeIdAtSlot(p, slot);
        if (tid < 0) continue;
        lines.push(`${tid}; ${slot}`);
      }
      return lines;
    };
    Inventory.contains = (name: string) => {
      const q = name.trim().toLowerCase();
      if (!q) return false;
      const p = playerData(deps);
      if (!p) return false;
      for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
        const tid = typeIdAtSlot(p, slot);
        if (tid < 0) continue;
        const item = deps.gameData.buildSdkItem(tid);
        if (item?.name.toLowerCase().includes(q)) return true;
        const def = deps.gameData.getObject(tid);
        if (def?.id.toLowerCase().includes(q)) return true;
      }
      return false;
    };
    Inventory.getCount = (name: string) => {
      const q = name.trim().toLowerCase();
      if (!q) return 0;
      const p = playerData(deps);
      if (!p) return 0;
      let c = 0;
      for (let slot = 0; slot < INVENTORY_TOTAL_SLOT_COUNT; slot++) {
        const tid = typeIdAtSlot(p, slot);
        if (tid < 0) continue;
        const item = deps.gameData.buildSdkItem(tid);
        const def = deps.gameData.getObject(tid);
        const byName = item?.name.toLowerCase().includes(q);
        const byId = def?.id.toLowerCase().includes(q);
        if (byName || byId) c++;
      }
      return c;
    };
    /** Empty bag slots in main inventory only (indices 4–11), same as `Hive.inventory.emptySlotCount`. */
    Inventory.getFreeSlots = () => {
      const p = playerData(deps);
      if (!p) return 8;
      let n = 0;
      for (let i = 4; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
        if (typeIdAtSlot(p, i) < 0) n++;
      }
      return n;
    };
    /** True when all eight main bag slots (4–11) are occupied. */
    Inventory.isFull = () => {
      const p = playerData(deps);
      if (!p) return false;
      for (let i = 4; i < INVENTORY_MAIN_SLOT_COUNT; i++) {
        if (typeIdAtSlot(p, i) < 0) return false;
      }
      return true;
    };
    Inventory.use = (_name: string) => {
      warnUnimplemented('Inventory.use');
      return false;
    };
    Inventory.useBySlot = (_slotIndex: number) => {
      warnUnimplemented('Inventory.useBySlot');
      return false;
    };
    Inventory.drop = (_name: string) => {
      warnUnimplemented('Inventory.drop');
      return false;
    };
  }
}
