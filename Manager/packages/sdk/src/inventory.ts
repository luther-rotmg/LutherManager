import type { InventoryItem, InventoryBackpackTier } from './types/inventory';

/**
 * Which side of the transfer `target` refers to.
 * **container** = external storage (e.g. vault grid), **inventory** = player bag (main + backpack).
 */
export type InventoryStorageSide = 'container' | 'inventory';
export type InventoryContainer = 'inventory' | 'petBag' | 'vault' | 'materialVault' | 'giftChest' | 'potionVault' | 'spoilsChest';
export interface ContainerSlot {
  objectId: number;
  slotId: number;
  objectType: number;
}

/** Main inventory stat slots 8–19 → indices 0–11 (weapon … last bag). */
export const INVENTORY_MAIN_SLOT_COUNT = 12;
/** Backpack stat slots 135–150 → indices 0–15, concatenated after main in `getAll()`. */
export const INVENTORY_BACKPACK_SLOT_COUNT = 16;
/** Length of `getAll()` array: main slots then backpack. */
export const INVENTORY_TOTAL_SLOT_COUNT =
  INVENTORY_MAIN_SLOT_COUNT + INVENTORY_BACKPACK_SLOT_COUNT;

export const inventory = {
  getContainerSlots(_container: InventoryContainer): ContainerSlot[] {
    throw new Error('Must be run inside Hive client');
  },

  getContainerObjectId(_container: InventoryContainer): number {
    throw new Error('Must be run inside Hive client');
  },

  swapContainers(
    _from: { container: InventoryContainer; slotId: number; itemType?: number },
    _to: { container: InventoryContainer; slotId: number; itemType?: number },
  ): boolean {
    throw new Error('Must be run inside Hive client');
  },

  getFirstFilledSlot(_container: InventoryContainer): ContainerSlot | null { throw new Error('Must be run inside Hive client'); },
  getFirstEmptySlot(_container: InventoryContainer): ContainerSlot | null { throw new Error('Must be run inside Hive client'); },
  getContainerItemCount(_container: InventoryContainer): number { throw new Error('Must be run inside Hive client'); },
  hasSpace(): boolean { throw new Error('Must be run inside Hive client'); },
  swapInventoryWithPetBag(_inventorySlot: number, _petBagSlot: number, _petBagItemType?: number): boolean { throw new Error('Must be run inside Hive client'); },
  swapInventoryWithVault(_inventorySlot: number, _vaultSlot: number): boolean { throw new Error('Must be run inside Hive client'); },
  swapInventoryWithPotionVault(_inventorySlot: number, _potionSlot: number): boolean { throw new Error('Must be run inside Hive client'); },

  getSlot(_index: number): InventoryItem | null {
    return null;
  },

  /**
   * Every slot in order: indices 0–11 main inventory, 12–27 backpack.
   * Each value is the object **type id** (decimal), or **-1** if the slot is empty.
   */
  getAll(): number[] {
    return [];
  },

  findItem(_query: number | string): InventoryItem | null {
    return null;
  },

  findItems(_query: number | string): InventoryItem[] {
    return [];
  },

  useItem(_slotIndex: number): void {},

  swapSlots(_slotA: number, _slotB: number): void {},

  isFull(): boolean {
    return false;
  },

  emptySlotCount(): number {
    return 0;
  },

  /**
   * Backpack tier for UI and branching: **1** = none · **2** = unlocked · **3** = unlocked + extender (pet bag).
   * Derived from wire stat **130** (BackpackTier: `0` / `8` / `16`+) with legacy stat **75** when tier is absent or `0`.
   */
  getBackpack(): InventoryBackpackTier {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Item type ids in the main vault chest, `-1` = empty. Throws if the vault has not been entered yet.
   *
   * ```ts
   * const slots = Hive.inventory.getVault();
   * // slots[0] = item type id of first vault slot, -1 if empty
   * ```
   */
  getVault(): number[] {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Full snapshot of every chest from the last `VAULTCONTENT` packet, patched live by `INVRESULT`.
   * Throws if the vault has not been entered yet.
   *
   * ```ts
   * const v = Hive.inventory.getEntireVault();
   * console.log(v.vault);           // main vault chest — number[]
   * console.log(v.material);        // material chest
   * console.log(v.gift);            // gift chest
   * console.log(v.potion);          // potion storage
   * console.log(v.seasonalSpoils);  // seasonal spoils
   * console.log(v.capturedAt);      // timestamp of last VAULTCONTENT
   * ```
   */
  getEntireVault(): {
    capturedAt: number;
    vault: number[];
    material: number[];
    gift: number[];
    potion: number[];
    seasonalSpoils: number[];
  } {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Item type ids in the material chest, `-1` = empty. Throws if the vault has not been entered yet.
   *
   * ```ts
   * const mats = Hive.inventory.getMaterials();
   * ```
   */
  getMaterials(): number[] {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Item type ids in the potion storage chest, `-1` = empty. Throws if the vault has not been entered yet.
   *
   * ```ts
   * const pots = Hive.inventory.getPotions();
   * ```
   */
  getPotions(): number[] {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Item type ids in the gift chest, `-1` = empty. Throws if the vault has not been entered yet.
   *
   * ```ts
   * const gifts = Hive.inventory.getGifts();
   * ```
   */
  getGifts(): number[] {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Item type ids in the seasonal spoils chest, `-1` = empty. Throws if the vault has not been entered yet.
   *
   * ```ts
   * const spoils = Hive.inventory.getSeasonalSpoils();
   * ```
   */
  getSeasonalSpoils(): number[] {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Pull one stack **from vault storage into your inventory**. Requires standing in the vault and
   * receipt of `VAULTCONTENT` (chest id + grid).
   *
   * - **`side === 'container'`** — `target` is on the **vault** side: an occupied **vault slot index**, or an
   *   **object type id** (first cell with that type). Item goes to the **first free inventory** slot.
   * - **`side === 'inventory'`** — `target` is the **destination inventory slot** index (0–27); source is the
   *   **first occupied** vault cell.
   */
  withdraw(_target: number, _side: InventoryStorageSide): boolean {
    throw new Error('Must be run inside Hive client');
  },

  /**
   * Move one stack **from your inventory into vault storage**.
   *
   * - **`side === 'inventory'`** — `target` is on the **bag** side: an occupied **slot index**, or **object type**
   *   (first matching slot). Item goes to the **first empty vault** cell.
   * - **`side === 'container'`** — `target` is the **destination vault slot** index; source is the **first
   *   occupied** inventory slot.
   */
  deposit(_target: number, _side: InventoryStorageSide): boolean {
    throw new Error('Must be run inside Hive client');
  },
};

export type { InventoryItem } from './types/inventory';
