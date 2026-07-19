export interface InventoryItem {
  objectType: number;
  slotIndex: number;
  itemName?: string;
  quantity?: number;
}

/**
 * Shorthand tier from {@link Luther.inventory}'s backpack state (`getBackpack()`).
 *
 * Mirrors wire stat **130** (BackpackSlots / BackpackTier) with legacy fallback on
 * stat **75** (HasBackpack):
 *
 * | Value | Meaning | Usable bag slots |
 * | --- | --- | --- |
 * | **`1`** | No backpack | `[4, 12)` → 4–11 |
 * | **`2`** | Backpack unlocked (wire tier `8`, or non-zero tier below `16`, or legacy HasBackpack when tier is `0`) | `[4, 20)` → 4–19 |
 * | **`3`** | Backpack + pet extender (`tier ≥ 16`) | `[4, 28)` → 4–27 |
 */
export type InventoryBackpackTier = 1 | 2 | 3;

/**
 * Character-specific carried inventory capacity (equipment slots 0–3 excluded).
 * Ranges are half-open: usable ids are `firstSlot .. endExclusive-1`.
 */
export interface InventoryCapacity {
  /** Always `4` for carried inventory. */
  firstSlot: number;
  /** Exclusive end: `12` / `20` / `28`. */
  endExclusive: number;
  /** Concrete usable slot ids in ascending order. */
  slotIds: number[];
  hasBackpack: boolean;
  hasBackpackExtender: boolean;
  /** Same encoding as {@link InventoryBackpackTier}. */
  backpackTier: InventoryBackpackTier;
}
