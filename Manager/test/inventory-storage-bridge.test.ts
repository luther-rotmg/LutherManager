import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inventory,
  type ContainerSlot,
  type InventoryContainer,
} from '@luthermanager/sdk';
import type { BridgeDeps } from '../src/scripts/bridge/BridgeDeps.js';
import { installStorageApi } from '../src/scripts/bridge/inventory/storage.js';

test('Hive.inventory exposes structured operations for every account storage section', () => {
  const names = new Map<number, string>([
    [101, 'Vault Sword'],
    [102, 'Second Chest Item'],
    [201, 'Ancient Material'],
    [301, 'Greater Potion'],
    [401, 'Gift Token'],
    [501, 'Seasonal Reward'],
    [901, 'Bag Item'],
  ]);
  const containers = new Map<InventoryContainer, ContainerSlot[]>([
    ['inventory', slotRange(500, 8, new Map([[4, 901]]), 4)],
    ['vault', slotRange(1001, 16, new Map([[0, 101], [8, 102]]))],
    ['materialVault', slotRange(1002, 2, new Map([[0, 201]]))],
    ['giftChest', slotRange(1003, 2, new Map([[0, 401]]))],
    ['potionVault', slotRange(1004, 2, new Map([[0, 301]]))],
    ['spoilsChest', slotRange(1005, 2, new Map([[0, 501]]))],
    ['petBag', []],
  ]);
  const swaps: Array<[
    { container: InventoryContainer; slotId: number },
    { container: InventoryContainer; slotId: number },
  ]> = [];

  inventory.getContainerSlots = (container) => containers.get(container)?.map((slot) => ({ ...slot })) ?? [];
  inventory.swapContainers = (from, to) => {
    swaps.push([
      { container: from.container, slotId: from.slotId },
      { container: to.container, slotId: to.slotId },
    ]);
    return true;
  };

  const deps = {
    gameData: {
      buildSdkItem(objectType: number) {
        const name = names.get(objectType);
        return name ? {
          id: objectType,
          name,
          tier: '',
          slotType: 'material',
          feedPower: 0,
          bagType: 0,
          soulbound: false,
          tradeable: true,
        } : null;
      },
      getObject(objectType: number) {
        const name = names.get(objectType);
        return name ? { id: name, displayId: name } : undefined;
      },
    },
  } as unknown as BridgeDeps;

  installStorageApi(deps);

  const firstChest = { startSlot: 0, slotCount: 8 };
  assert.equal(inventory.getStorageItems('vault', firstChest).length, 8);
  assert.equal(inventory.getStorageItems('vault', firstChest)[0]?.objectType, 101);
  assert.equal(inventory.getStorageItems('vault', firstChest)[0]?.container, 'vault');
  assert.equal(inventory.getStorageItems('vault', firstChest)[0]?.chestIndex, 0);
  assert.equal(inventory.findStorageItem('vault', 'Second Chest')?.chestIndex, 1);
  assert.equal(inventory.storageContains('giftChest', 'Gift Token'), true);
  assert.equal(inventory.getStorageFreeSlots('vault', firstChest), 7);
  assert.equal(inventory.isStorageFull('vault', firstChest), false);
  assert.equal(inventory.withdrawStorageItem('vault', 'Vault Sword', firstChest), true);
  assert.equal(inventory.depositStorageItem('vault', 'Bag Item', firstChest), true);
  assert.equal(inventory.withdrawStorageItem('materialVault', 201), true);
  assert.equal(inventory.withdrawStorageItem('spoilsChest', 'Seasonal Reward'), true);
  assert.equal(inventory.getStorageItems('potionVault')[0]?.name, 'Greater Potion');

  assert.deepEqual(swaps, [
    [{ container: 'vault', slotId: 0 }, { container: 'inventory', slotId: 5 }],
    [{ container: 'inventory', slotId: 4 }, { container: 'vault', slotId: 1 }],
    [{ container: 'materialVault', slotId: 0 }, { container: 'inventory', slotId: 5 }],
    [{ container: 'spoilsChest', slotId: 0 }, { container: 'inventory', slotId: 5 }],
  ]);
});

function slotRange(
  objectId: number,
  count: number,
  filled: Map<number, number>,
  start = 0,
): ContainerSlot[] {
  return Array.from({ length: count }, (_, offset) => ({
    objectId,
    slotId: start + offset,
    objectType: filled.get(start + offset) ?? -1,
  }));
}
