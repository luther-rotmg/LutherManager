import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SlotObjectData, VaultContentPacket } from 'realmlib';
import { Client } from '../src/client';
import { PluginRuntime } from '../src/plugin-runtime';
import {
  SeasonalVaultWithdraw,
  chooseWithdrawal,
  emptyMainInventorySlots,
  vaultItems,
} from '../src/plugins/seasonal-vault-withdraw';

test('vaultItems includes Vault, Gift, and Potion items with container slot references', () => {
  const packet = new VaultContentPacket();
  packet.chestObjectId = 10;
  packet.giftObjectId = 20;
  packet.potionObjectId = 30;
  packet.vaultContents = [-1, 101];
  packet.giftContents = [202, -1];
  packet.potionContents = [-1, -1, 303];
  packet.materialContents = [404];
  packet.spoilsContents = [505];

  assert.deepEqual(vaultItems(packet), [
    { section: 'vault', objectId: 10, slotId: 1, itemType: 101 },
    { section: 'gift', objectId: 20, slotId: 0, itemType: 202 },
    { section: 'potion', objectId: 30, slotId: 2, itemType: 303 },
  ]);
});

test('emptyMainInventorySlots only returns empty slots 4 through 11', () => {
  const inventory = [-1, -1, -1, -1, 100, -1, 200, -1, 300, 400, 500, -1, -1];
  assert.deepEqual(emptyMainInventorySlots(inventory), [5, 7, 11]);
});

test('chooseWithdrawal uses random item and destination indexes', () => {
  const items = [
    { section: 'vault' as const, objectId: 10, slotId: 0, itemType: 100 },
    { section: 'gift' as const, objectId: 20, slotId: 1, itemType: 200 },
  ];
  const values = [0.75, 0.1];
  const choice = chooseWithdrawal(items, [5, 9], () => values.shift()!);

  assert.deepEqual(choice, { item: items[1], inventorySlot: 5 });
  assert.equal(chooseWithdrawal([], [5]), undefined);
  assert.equal(chooseWithdrawal(items, []), undefined);
});

test('seasonal workflow enters vault, swaps an item, escapes, and completes after Nexus inventory loads', async () => {
  const inventory = new Array<number>(20).fill(-1);
  let enteredVault = 0;
  let escaped = 0;
  const swaps: Array<{ from: { objectId: number; slotId: number; itemType: number }; to: { slotId: number } }> = [];
  const client = {
    alias: 'seasonal-test',
    isSeasonal: () => true,
    getInventory: () => [...inventory],
    getContainerSlot: (container: string, slotId: number) =>
      container === 'inventory' ? SlotObjectData.from(42, slotId, inventory[slotId] ?? -1) : null,
    enterVault: () => {
      enteredVault++;
    },
    escape: () => {
      escaped++;
    },
    swapSlots: (from: SlotObjectData, to: SlotObjectData) => {
      swaps.push({
        from: { objectId: from.objectId, slotId: from.slotId, itemType: from.objectType },
        to: { slotId: to.slotId },
      });
      inventory[to.slotId] = from.objectType;
      return true;
    },
  } as unknown as Client;
  const runtime = {
    waitUntil: async (predicate: () => boolean) => predicate(),
  } as unknown as PluginRuntime;
  const plugin = new SeasonalVaultWithdraw();

  plugin.onMapChange(client, 'Nexus');
  plugin.onTick(client);
  assert.equal(enteredVault, 1);

  plugin.onMapChange(client, 'Vault');
  const vault = new VaultContentPacket();
  vault.lastVaultPacket = true;
  vault.giftObjectId = 99;
  vault.giftContents = [777];
  await plugin.onVaultContents(client, vault, runtime);

  assert.equal(swaps.length, 1);
  assert.deepEqual(swaps[0].from, { objectId: 99, slotId: 0, itemType: 777 });
  assert.ok(swaps[0].to.slotId >= 4 && swaps[0].to.slotId <= 11);
  assert.equal(escaped, 1);

  plugin.onMapChange(client, 'Nexus');
  plugin.onTick(client);
  assert.equal(plugin.status().state, 'done');

  // A subsequent tick cannot restart the one-shot workflow.
  plugin.onTick(client);
  assert.equal(enteredVault, 1);
});
