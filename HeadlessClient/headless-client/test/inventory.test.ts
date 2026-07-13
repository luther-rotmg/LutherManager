import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvResultPacket, InvSwapPacket, MapInfoPacket, SlotObjectData } from 'realmlib';
import {
  CONSUMABLE_SLOT_IDS,
  InventoryState,
  SwapCorrelator,
  buildInvSwap,
  classifyInvResult,
  isConsumableSlot,
} from '../src/inventory';

test('consumable slot ids', () => {
  assert.deepEqual([...CONSUMABLE_SLOT_IDS], [1000000, 1000001, 1000002]);
  assert.equal(isConsumableSlot(1000000), true);
  assert.equal(isConsumableSlot(1000001), true);
  assert.equal(isConsumableSlot(1000002), true); // third slot — needs a potion belt
  assert.equal(isConsumableSlot(1000003), false); // does not exist
  assert.equal(isConsumableSlot(4), false);
});

test('buildInvSwap builds a packet with the given slots', () => {
  const swap = buildInvSwap(
    1234,
    { x: 10.5, y: 20.25 },
    { objectId: 100, slotId: 4, itemType: 2594 },
    { objectId: 100, slotId: 1000000, itemType: -1 },
  );
  assert.ok(swap instanceof InvSwapPacket);
  assert.equal(swap.time, 1234);
  assert.equal(swap.slotObject1.objectType, 2594);
  assert.equal(swap.slotObject2.slotId, 1000000);
  assert.equal(swap.slotObject2.objectType, -1);
});

function invResult(ackType: number, success: boolean, fromItem: number): InvResultPacket {
  const p = new InvResultPacket();
  p.success = success;
  p.ackType = ackType;
  p.fromSlot = SlotObjectData.from(1, 1, fromItem);
  p.toSlot = SlotObjectData.from(ackType === 1 ? 0 : 2, ackType === 1 ? 0 : 1, -1);
  return p;
}

test('classifyInvResult separates swap acks from use acks', () => {
  assert.equal(classifyInvResult(invResult(0, true, 2594)).kind, 'swap-ack');
  assert.equal(classifyInvResult(invResult(1, true, 2594)).kind, 'use-ack');
});

test('SwapCorrelator matches an ack to its pending swap', () => {
  const correlator = new SwapCorrelator();
  const swap = buildInvSwap(0, { x: 0, y: 0 }, { objectId: 1, slotId: 1, itemType: 5 }, { objectId: 2, slotId: 1, itemType: -1 });
  correlator.sent(swap, 100);
  // An ack echoes the swap's slots (owner + slot id), with the items swapped.
  const ack = new InvResultPacket();
  ack.ackType = 0;
  ack.success = true;
  ack.fromSlot = SlotObjectData.from(1, 1, -1);
  ack.toSlot = SlotObjectData.from(2, 1, 5);
  const matched = correlator.onResult(ack);
  assert.equal(matched?.swap, swap);
  assert.equal(correlator.pending().length, 0);
});

test('SwapCorrelator pending / expire', () => {
  const correlator = new SwapCorrelator();
  correlator.sent(buildInvSwap(0, { x: 0, y: 0 }, { objectId: 1, slotId: 0, itemType: 5 }, { objectId: 2, slotId: 1, itemType: -1 }), 100);
  correlator.sent(buildInvSwap(0, { x: 0, y: 0 }, { objectId: 3, slotId: 0, itemType: 6 }, { objectId: 4, slotId: 1, itemType: -1 }), 300);
  assert.equal(correlator.pending().length, 2);
  const expired = correlator.expire(200);
  assert.equal(expired.length, 1);
  assert.equal(correlator.pending().length, 1);
});

test('InventoryState classifies a success=false use as rejected', () => {
  const state = new InventoryState();
  const map = new MapInfoPacket();
  map.name = 'Vault';
  state.applyMapInfo(map);
  const events = state.applyInvResult(invResult(1, false, -1));
  assert.deepEqual(events.map((e) => e.kind), ['use-rejected']);
  assert.equal(state.mapCount, 1);
  assert.equal(state.mapName, 'Vault');
});
