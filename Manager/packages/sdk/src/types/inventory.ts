export interface InventoryItem {
  objectType: number;
  slotIndex: number;
  itemName?: string;
  quantity?: number;
}

/**
 * Shorthand tier from {@link Hive.inventory}'s backpack state (`getBackpack()`).
 *
 * Mirrors wire stat **130** (BackpackTier) with legacy fallback on stat **75** (HasBackpack):
 *
 * | Value | Meaning |
 * | --- | --- |
 * | **`1`** | No backpack |
 * | **`2`** | Backpack unlocked (wire tier `8`, or non-zero tier below `16`, or legacy HasBackpack when tier is `0`) |
 * | **`3`** | Backpack + pet extender (`tier ≥ 16`) |
 */
export type InventoryBackpackTier = 1 | 2 | 3;
