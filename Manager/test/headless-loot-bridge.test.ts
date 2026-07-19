import assert from 'node:assert/strict';
import test from 'node:test';
import { loot, type LootBag } from '@luthermanager/sdk';
import type { Client, TrackedObject } from 'headless-client';
import type { BridgeDeps } from '../src/scripts/bridge/BridgeDeps.js';
import { installHeadlessLootBridge } from '../src/scripts/bridge/headless/HeadlessLootBridge.js';

interface TestSlot {
  objectId: number;
  slotId: number;
  objectType: number;
}

function slot(objectId: number, slotId: number, objectType: number): TestSlot {
  return { objectId, slotId, objectType };
}

test('headless pickupToSlot swaps a bag upgrade with occupied equipment', () => {
  const bagObjectId = 700;
  const playerObjectId = 500;
  const tier9Staff = 9009;
  const tier7Staff = 9007;
  const swaps: Array<[TestSlot, TestSlot]> = [];
  const bagObject = { objectId: bagObjectId, type: 1280 } as TrackedObject;
  const client = {
    getVisibleObject: (objectId: number) => objectId === bagObjectId ? bagObject : undefined,
    getWorldContainerSlot: (objectId: number, slotIndex: number) =>
      objectId === bagObjectId && slotIndex === 0
        ? slot(bagObjectId, 0, tier9Staff)
        : null,
    getContainerSlot: (container: string, slotIndex: number) =>
      container === 'inventory' && slotIndex === 0
        ? slot(playerObjectId, 0, tier7Staff)
        : null,
    getCarriedInventorySlotIds: () => [4, 5, 6, 7, 8, 9, 10, 11],
    swapSlots: (source: TestSlot, destination: TestSlot) => {
      swaps.push([source, destination]);
      return true;
    },
  } as unknown as Client;
  const deps = {
    getHeadlessClient: () => client,
    gameData: {
      getObject: (objectType: number) => objectType === bagObject.type
        ? { isLoot: true }
        : undefined,
    },
  } as unknown as BridgeDeps;
  const bag = { objectId: bagObjectId } as LootBag;

  installHeadlessLootBridge(deps);

  assert.equal(loot.pickupToSlot(bag, 0, 0), true);
  assert.equal(swaps.length, 1);
  assert.equal(swaps[0][0].objectType, tier9Staff);
  assert.equal(swaps[0][1].objectType, tier7Staff);
  assert.equal(swaps[0][1].slotId, 0);
});
