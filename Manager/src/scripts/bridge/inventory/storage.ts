import {
  inventory,
  type ContainerSlot,
  type InventoryStorageContainer,
  type InventoryStorageRange,
  type StorageItem,
} from '@luthermanager/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';

const VAULT_CHEST_SLOT_COUNT = 8;

function slots(container: InventoryStorageContainer | 'inventory'): ContainerSlot[] {
  try {
    return inventory.getContainerSlots(container).map((slot) => ({ ...slot }));
  } catch {
    return [];
  }
}

function rangeBounds(range?: InventoryStorageRange): { start: number; count?: number } {
  const start = Math.max(0, Math.trunc(Number(range?.startSlot) || 0));
  const rawCount = range?.slotCount;
  return {
    start,
    count: rawCount === undefined ? undefined : Math.max(0, Math.trunc(Number(rawCount) || 0)),
  };
}

function rangeSlots(container: InventoryStorageContainer, range?: InventoryStorageRange): ContainerSlot[] {
  const all = slots(container);
  const { start, count } = rangeBounds(range);
  const end = count === undefined ? Number.POSITIVE_INFINITY : start + count;
  return all.filter((slot) => slot.slotId >= start && slot.slotId < end);
}

function matches(deps: BridgeDeps, objectType: number, query: number | string): boolean {
  if (objectType < 0) return false;
  if (typeof query === 'number' && Number.isFinite(query)) return objectType === Math.trunc(query);
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return false;
  const item = deps.gameData.buildSdkItem(objectType);
  const object = deps.gameData.getObject(objectType);
  const names = [item?.name, object?.id, object?.displayId]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().toLowerCase());
  return names.some((value) => value === needle) || names.some((value) => value.includes(needle));
}

function toStorageItem(
  deps: BridgeDeps,
  container: InventoryStorageContainer,
  slot: ContainerSlot,
): StorageItem | null {
  const item = deps.gameData.buildSdkItem(slot.objectType);
  if (!item) return null;
  return {
    ...item,
    objectType: slot.objectType,
    container,
    slotIndex: slot.slotId,
    chestIndex: Math.floor(slot.slotId / VAULT_CHEST_SLOT_COUNT),
  };
}

function storageItems(
  deps: BridgeDeps,
  container: InventoryStorageContainer,
  range?: InventoryStorageRange,
): (StorageItem | null)[] {
  const selected = rangeSlots(container, range);
  const { start, count } = rangeBounds(range);
  if (count === undefined) return selected.map((slot) => toStorageItem(deps, container, slot));
  const byIndex = new Map(selected.map((slot) => [slot.slotId, slot]));
  return Array.from({ length: count }, (_, offset) => {
    const slot = byIndex.get(start + offset);
    return slot ? toStorageItem(deps, container, slot) : null;
  });
}

function findStorageSlot(
  deps: BridgeDeps,
  container: InventoryStorageContainer,
  query: number | string,
  range?: InventoryStorageRange,
): ContainerSlot | null {
  return rangeSlots(container, range).find(
    (slot) => slot.objectType >= 0 && matches(deps, slot.objectType, query),
  ) ?? null;
}

/** Installs the structured account-storage API on `Hive.inventory`. */
export function installStorageApi(deps: BridgeDeps): void {
  inventory.getStorageItems = (container, range) => storageItems(deps, container, range);
  inventory.findStorageItem = (container, query, range) => {
    const slot = findStorageSlot(deps, container, query, range);
    return slot ? toStorageItem(deps, container, slot) : null;
  };
  inventory.storageContains = (container, query, range) =>
    findStorageSlot(deps, container, query, range) !== null;
  inventory.withdrawStorageItem = (container, query, range) => {
    const source = findStorageSlot(deps, container, query, range);
    const destination = slots('inventory').find((slot) => slot.slotId >= 4 && slot.objectType < 0);
    if (!source || !destination) return false;
    return inventory.swapContainers(
      { container, slotId: source.slotId },
      { container: 'inventory', slotId: destination.slotId },
    );
  };
  inventory.withdrawAllStorageItems = (container, range) => {
    const sources = rangeSlots(container, range).filter((slot) => slot.objectType >= 0);
    const destinations = slots('inventory').filter((slot) => slot.slotId >= 4 && slot.objectType < 0);
    const transferCount = Math.min(sources.length, destinations.length);
    let sent = false;
    for (let index = 0; index < transferCount; index++) {
      sent = inventory.swapContainers(
        { container, slotId: sources[index].slotId },
        { container: 'inventory', slotId: destinations[index].slotId },
      ) || sent;
    }
    return sent;
  };
  inventory.depositStorageItem = (container, query, range) => {
    const source = slots('inventory').find(
      (slot) => slot.slotId >= 4 && slot.objectType >= 0 && matches(deps, slot.objectType, query),
    );
    const destination = rangeSlots(container, range).find((slot) => slot.objectType < 0);
    if (!source || !destination) return false;
    return inventory.swapContainers(
      { container: 'inventory', slotId: source.slotId },
      { container, slotId: destination.slotId },
    );
  };
  inventory.getStorageFreeSlots = (container, range) =>
    rangeSlots(container, range).filter((slot) => slot.objectType < 0).length;
  inventory.isStorageFull = (container, range) => {
    const selected = rangeSlots(container, range);
    return selected.length > 0 && selected.every((slot) => slot.objectType >= 0);
  };
}
