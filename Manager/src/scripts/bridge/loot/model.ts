import type {
  LootBag,
  LootItem,
  LootItemEnchantments,
  LootRarity,
} from '@luthermanager/sdk';
import { parseEnchantments, type SlotEnchantments } from 'headless-client';
import { StatType } from '../../../constants/StatType.js';
import type { BridgeDeps } from '../BridgeDeps.js';

export interface WorldContainerSnapshot {
  objectId: number;
  objectType: number;
  x: number;
  y: number;
  stats: Record<string, number | string>;
}

const BAG_COLOR_BY_NUMBER: Readonly<Record<number, LootRarity>> = {
  0: 'brown',
  1: 'pink',
  2: 'purple',
  3: 'egg',
  7: 'cyan',
  4: 'blue',
  5: 'orange',
  8: 'red',
  9: 'white',
};

const BAG_COLOR_BY_TEXTURE: Readonly<Record<number, LootRarity>> = {
  0xd0: 'brown',
  0xd1: 'pink',
  0xd2: 'purple',
  0xd3: 'egg',
  0xd4: 'cyan',
  0xd5: 'blue',
  0xd6: 'orange',
  0xd7: 'red',
  0xd8: 'white',
  0xe0: 'brown',
  0xe1: 'pink',
  0xe2: 'purple',
  0xe3: 'egg',
  0xe4: 'cyan',
  0xe5: 'blue',
  0xe6: 'orange',
  0xe7: 'red',
  0xe8: 'white',
};

export const LOOT_RARITY_RANK: Readonly<Record<LootRarity, number>> = {
  unknown: -1,
  common: 0,
  brown: 0,
  pink: 1,
  green: 2,
  purple: 2,
  egg: 2,
  cyan: 3,
  blue: 4,
  orange: 5,
  red: 6,
  white: 7,
};

export function isLootObjectType(objectType: number, deps: BridgeDeps): boolean {
  return deps.gameData.getObject(objectType)?.isLoot === true;
}

export function lootRarityForType(objectType: number, deps: BridgeDeps): LootRarity {
  const def = deps.gameData.getObject(objectType);
  if (!def?.isLoot) return 'unknown';
  const numberMatch = def.id.match(/^Loot Bag (\d+)(?:\s|$)/i);
  if (numberMatch) {
    const byNumber = BAG_COLOR_BY_NUMBER[Number(numberMatch[1])];
    if (byNumber) return byNumber;
  }
  if (/soulbound bag/i.test(def.id)) return 'purple';
  if (/lofiObj4/i.test(def.textureFile)) {
    return BAG_COLOR_BY_TEXTURE[def.textureIndex] ?? 'unknown';
  }
  return 'unknown';
}

function enchantmentsForSlot(
  rawBySlot: Map<number, SlotEnchantments>,
  slotIndex: number,
  deps: BridgeDeps,
): LootItemEnchantments | undefined {
  const parsed = rawBySlot.get(slotIndex);
  if (!parsed) return undefined;
  return {
    raw: parsed.raw,
    isEmpty: parsed.isEmpty,
    slotCount: parsed.slotCount,
    typeIds: [...parsed.enchantmentTypeIds],
    entries: parsed.enchantmentTypeIds.map((type) => {
      const def = deps.gameData.getEnchantment(type);
      return {
        type,
        id: def?.id,
        name: def?.displayId,
        description: def?.description,
        labels: def ? [...def.labels] : [],
      };
    }),
    suffixHex: parsed.suffix.toString('hex'),
  };
}

export function buildSlotEnchantments(
  raw: string | undefined,
  slotIndex: number,
  deps: BridgeDeps,
): LootItemEnchantments | null {
  const parsed = parseEnchantments(raw);
  const bySlot = new Map(parsed.map((entry) => [entry.slot, entry]));
  return enchantmentsForSlot(bySlot, slotIndex, deps) ?? null;
}

export function buildContainerItems(
  stats: Record<string, number | string>,
  deps: BridgeDeps,
): LootItem[] {
  const enchantmentStat = stats[String(StatType.Enchantments)];
  const parsedEnchantments = parseEnchantments(
    typeof enchantmentStat === 'string' ? enchantmentStat : undefined,
  );
  const enchantmentsBySlot = new Map(parsedEnchantments.map((entry) => [entry.slot, entry]));
  const items: LootItem[] = [];
  for (let slotIndex = 0; slotIndex < 8; slotIndex++) {
    const objectType = Number(stats[String(StatType.Inventory0 + slotIndex)]);
    if (!Number.isFinite(objectType) || objectType <= 0) continue;
    const def = deps.gameData.getObject(objectType);
    items.push({
      objectType,
      slotIndex,
      itemName: def?.displayId || def?.id,
      enchantments: enchantmentsForSlot(enchantmentsBySlot, slotIndex, deps),
    });
  }
  return items;
}

export function buildLootBag(
  snapshot: WorldContainerSnapshot,
  droppedAt: number,
  deps: BridgeDeps,
): LootBag | null {
  if (!isLootObjectType(snapshot.objectType, deps)) return null;
  const ownerName = snapshot.stats[String(StatType.NameStat)];
  const ownerAccountId = snapshot.stats[String(StatType.OwnerAccountId)];
  return {
    objectId: snapshot.objectId,
    bagType: snapshot.objectType,
    rarity: lootRarityForType(snapshot.objectType, deps),
    position: { x: snapshot.x, y: snapshot.y },
    items: buildContainerItems(snapshot.stats, deps),
    droppedAt,
    ...(typeof ownerName === 'string' && ownerName ? { ownerName } : {}),
    ...(typeof ownerAccountId === 'string' && ownerAccountId ? { ownerAccountId } : {}),
  };
}
