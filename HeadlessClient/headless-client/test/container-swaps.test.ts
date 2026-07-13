import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvResultPacket, InvSwapPacket, Packet, PlayerData, SlotObjectData, StatData, StatType } from 'realmlib';
import {
  Client,
  POTION_VAULT_OBJECT_TYPE,
  VAULT_CHEST_OBJECT_TYPE,
} from '../src/client';
import { TrackedObject } from '../src/models';
import { ClientEvent } from '../src/events';

interface MutableClientState {
  objectId: number;
  petObjectId: number;
  petInstanceId: number;
  player: PlayerData;
  serverPos: { x: number; y: number };
  io: { send(packet: Packet): void };
  objects: Map<number, TrackedObject>;
  containerSlotItems: Map<number, Map<number, number>>;
  timers: { size: number };
  lastVaultContent?: {
    lastVaultPacket: boolean;
    vaultUpgradeCost: number;
    materialUpgradeCost: number;
    potionUpgradeCost: number;
    currentPotionMax: number;
    nextPotionMax: number;
    at: string;
    sections: Array<{ key: string; label: string; objectId: number; contents: number[] }>;
  };
  capturePetObjectId(stats: StatData[]): void;
  handleInvResult(packet: InvResultPacket): void;
}

test('Client swaps every pairing of inventory, pet bag, vault, and potion vault', () => {
  const { client, sent } = readyClient();

  assert.equal(client.swapInventoryWithPetBag(4, 0), true);
  assert.equal(client.swapInventoryWithVault(4, 0), true);
  assert.equal(client.swapInventoryWithPotionVault(4, 0), true);
  assert.equal(client.swapPetBagWithVault(0, 401, 0), true);
  assert.equal(client.swapPetBagWithPotionVault(0, 401, 0), true);
  assert.equal(client.swapVaultWithPotionVault(0, 0), true);

  assert.deepEqual(sent.map(slotTuple), [
    [500, 4, 101, 32545, 0, -1],
    [500, 4, 101, 9001, 0, 201],
    [500, 4, 101, 9002, 0, 301],
    [32545, 0, 401, 9001, 0, 201],
    [32545, 0, 401, 9002, 0, 301],
    [9001, 0, 201, 9002, 0, 301],
  ]);
});

test('generic container swaps support occupied pet slots in either direction', () => {
  const { client, sent } = readyClient();

  assert.equal(client.swapContainerItems(
    { container: 'petBag', slotId: 2, itemType: 777 },
    { container: 'inventory', slotId: 5 },
  ), true);
  assert.deepEqual(slotTuple(sent[0]), [32545, 2, 777, 500, 5, -1]);

  assert.equal(client.swapContainerItems(
    { container: 'petBag', slotId: 2 },
    { container: 'inventory', slotId: 5 },
  ), false, 'occupied/unknown pet slots require an explicit item type');
  assert.equal(sent.length, 1);
});

test('protocol-native slot getters select filled and empty slots with correct object ids', () => {
  const { client, state } = readyClient();
  state.containerSlotItems.set(32545, new Map([[0, 777], [1, -1]]));

  assertSlot(client.getInventorySlot(), 500, 4, 101);
  assert.equal(client.getInventorySlot(5), null);
  assertSlot(client.getEmptyInventorySlot(), 500, 5, -1);
  assertSlot(client.getVaultSlot(), 9001, 0, 201);
  assert.equal(client.getVaultSlot(1), null);
  assertSlot(client.getPetBagSlot(), 32545, 1, -1);
  assertSlot(client.getPotionVaultSlot(), 9002, 1, -1);
  assertSlot(client.findInventoryItem(101), 500, 4, 101);
  assert.equal(client.getContainerItemCount('vault'), 1);
  assert.equal(client.hasInventorySpace(), true);
});

test('pet-bag slots published on PET_OBJECT_ID are addressed through PET_INSTANCEID', () => {
  const { client, state } = readyClient();
  state.containerSlotItems.set(7331, new Map([[0, 777], [1, -1]]));

  assertSlot(client.getPetBagSlot(), 32545, 1, -1);
  assertSlot(client.getContainerSlot('petBag', 0), 32545, 0, 777);

  state.containerSlotItems.set(32545, new Map([[0, -1]]));
  assertSlot(client.getContainerSlot('petBag', 0), 32545, 0, -1, 'instance updates override visible-pet stats');
  assertSlot(client.getContainerSlot('petBag', 1), 32545, 1, -1, 'unmodified visible-pet slots remain available');
});

test('slot-object overloads execute the requested plugin pseudocode and route storage transfers', async () => {
  const { client, sent, state } = readyClient();
  state.containerSlotItems.set(32545, new Map([[0, -1]]));
  const inventory = client.getInventorySlot(4)!;
  const pet = client.getPetBagSlot()!;
  assert.equal(client.swapInventoryWithPetBag(inventory, pet), true);

  const vault = client.getVaultSlot()!;
  const potion = client.getPotionVaultSlot()!;
  installAutoAck(state, sent);
  assert.equal(await client.swapVaultWithPotionVault(vault, potion), true);
  assert.equal(state.timers.size, 0, 'transfer acknowledgement timers are cleared');
  assert.deepEqual(sent.map(slotTuple), [
    [500, 4, 101, 32545, 0, -1],
    [9001, 0, 201, 500, 5, -1],
    [500, 5, 201, 9002, 1, -1],
  ]);
});

test('occupied storage slots exchange through two empty inventory buffers', async () => {
  const { client, sent, state } = readyClient();
  installAutoAck(state, sent);
  const vault = client.getVaultSlot(0)!;
  const potion = client.getPotionVaultItemSlot(0)!;

  assert.equal(await client.swapVaultWithPotionVault(vault, potion), true);
  assert.deepEqual(sent.map(slotTuple), [
    [9001, 0, 201, 500, 5, -1],
    [9002, 0, 301, 500, 6, -1],
    [500, 6, 301, 9001, 0, -1],
    [500, 5, 201, 9002, 0, -1],
  ]);
  assertSlot(client.getVaultSlot(0), 9001, 0, 301);
  assertSlot(client.getPotionVaultItemSlot(0), 9002, 0, 201);
  assert.equal(client.getInventorySlot(5), null);
  assert.equal(client.getInventorySlot(6), null);
});

test('failed routed transfer rolls a staged item back to its source', async () => {
  const { client, sent, state } = readyClient();
  installAckSequence(state, sent, [true, false, true]);

  assert.equal(await client.swapVaultWithPotionVault(client.getVaultSlot()!, client.getPotionVaultSlot()!), false);
  assert.deepEqual(sent.map(slotTuple), [
    [9001, 0, 201, 500, 5, -1],
    [500, 5, 201, 9002, 1, -1],
    [500, 5, 201, 9001, 0, -1],
  ]);
  assertSlot(client.getVaultSlot(0), 9001, 0, 201);
  assert.equal(client.getInventorySlot(5), null);
  assertSlot(client.getPotionVaultSlot(1), 9002, 1, -1);
});

test('withdrawals put the filled storage slot first and INVRESULT state enables a correct reverse swap', () => {
  const { client, sent, state } = readyClient();
  assert.equal(client.swapInventoryWithVault(5, 0), true);
  assert.deepEqual(slotTuple(sent[0]), [9001, 0, 201, 500, 5, -1]);

  const result = new InvResultPacket();
  result.success = true;
  result.ackType = 0;
  result.fromSlot.objectId = 9001;
  result.fromSlot.slotId = 0;
  result.fromSlot.objectType = -1;
  result.toSlot.objectId = 500;
  result.toSlot.slotId = 5;
  result.toSlot.objectType = 201;
  state.handleInvResult(result);

  assert.equal(client.getInventory()?.[5], 201);
  assert.equal(client.getVaultContent()?.sections.find((section) => section.key === 'vault')?.contents[0], -1);
  assert.equal(client.swapInventoryWithVault(5, 0), true);
  assert.deepEqual(slotTuple(sent[1]), [500, 5, 201, 9001, 0, -1]);
});

test('vault object types 1284 and 1859 resolve to live map-scoped object ids as a fallback', () => {
  const { client, sent, state } = readyClient();
  state.lastVaultContent = undefined;
  state.objects.delete(9001);
  state.objects.delete(9002);
  state.objects.set(7001, tracked(7001, VAULT_CHEST_OBJECT_TYPE));
  state.objects.set(7002, tracked(7002, POTION_VAULT_OBJECT_TYPE));

  assert.equal(client.swapContainerItems(
    { container: 'vault', slotId: 3, itemType: 888 },
    { container: 'potionVault', slotId: 4, itemType: -1 },
  ), true);
  assert.deepEqual(slotTuple(sent[0]), [7001, 3, 888, 7002, 4, -1]);
});

test('PET_INSTANCEID is preferred as the pet-bag container id and PET_OBJECT_ID remains available', () => {
  const { client, state } = readyClient();
  state.petInstanceId = -1;
  state.petObjectId = -1;
  state.capturePetObjectId([
    { statType: StatType.PET_INSTANCEID_STAT, statValue: 38885 },
    { statType: StatType.PET_OBJECT_ID, statValue: 7331 },
  ] as StatData[]);

  assert.equal(client.getPetInstanceId(), 38885);
  assert.equal(client.getPetObjectId(), 7331);
  assert.equal(client.getPetBagContainerId(), 38885);
  state.petInstanceId = -1;
  assert.equal(client.getPetBagContainerId(), 7331, 'PET_OBJECT_ID is the compatibility fallback');
});

test('seasonal and world-object helpers expose plugin-ready state', () => {
  const { client, state } = readyClient();
  state.capturePetObjectId([{ statType: StatType.SEASONAL_CHARACTER_STAT, statValue: 1 }] as StatData[]);
  state.objects.set(8001, trackedAt(8001, 111, 3, 4));
  state.objects.set(8002, trackedAt(8002, 222, 10, 10));

  assert.equal(client.isSeasonal(), true);
  assert.equal(client.getVisibleObject(8001)?.type, 111);
  assert.deepEqual(client.findVisibleObjects((object) => object.type === 222).map((object) => object.objectId), [8002]);
  assert.equal(client.getNearestVisibleObject((object) => object.type === 111 || object.type === 222)?.objectId, 8001);
  assert.equal(client.distanceTo({ x: 3, y: 4 }), 5);
  assert.equal(client.moveToObject(8001), true);
  assert.equal(client.moveToObject(9999), false);
});

test('INVRESULT logging records ack type, origin, flags, and both slots', () => {
  const { client, state } = readyClient();
  const packet = new InvResultPacket();
  packet.success = true;
  packet.ackType = 0;
  packet.flags = 0x60000;
  packet.fromSlot.objectId = 32545;
  packet.fromSlot.slotId = 0;
  packet.fromSlot.objectType = 777;
  packet.toSlot.objectId = 500;
  packet.toSlot.slotId = 5;
  packet.toSlot.objectType = -1;
  const lines: string[] = [];
  let emitted: InvResultPacket | undefined;
  client.once(ClientEvent.InventoryResult, (result) => {
    emitted = result;
  });
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    state.handleInvResult(packet);
  } finally {
    console.log = original;
  }

  assert.deepEqual(client.getLastInvResult(), {
    ok: true,
    code: 0,
    flags: 0x60000,
    from: { objectId: 32545, slotId: 0, itemType: 777 },
    to: { objectId: 500, slotId: 5, itemType: -1 },
    at: client.getLastInvResult()!.at,
  });
  assert.match(lines[0], /INVRESULT ok=true ackType=0 origin=INVSWAP flags=0x60000/);
  assert.match(lines[0], /from\(obj 32545 slot 0 type 777\).*to\(obj 500 slot 5 type -1\)/);
  assert.equal(emitted, packet);
});

test('stall() remains held until unstall()', () => {
  const { client, calls } = clientWithFakeSocket();
  assert.equal(client.stall(), true);
  assert.equal(client.isStalled(), true);
  assert.deepEqual(calls, ['pause']);
  assert.equal(client.getStallInfo().remainingMs, undefined);

  assert.ok(client.unstall() >= 0);
  assert.equal(client.isStalled(), false);
  assert.deepEqual(calls, ['pause', 'resume']);
  assert.equal(client.unstall(), -1);
});

test('stall(ms) automatically resumes and rejects invalid durations', async () => {
  const { client, calls } = clientWithFakeSocket();
  assert.equal(client.stall(0), false);
  assert.equal(client.stall(20), true);
  assert.ok((client.getStallInfo().remainingMs ?? 0) > 0);

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(client.isStalled(), false);
  assert.deepEqual(calls, ['pause', 'resume']);
});

function readyClient(): { client: Client; state: MutableClientState; sent: InvSwapPacket[] } {
  const client = new Client({
    alias: 'swap-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
  });
  const state = client as unknown as MutableClientState;
  const sent: InvSwapPacket[] = [];
  state.objectId = 500;
  state.petObjectId = 7331;
  state.petInstanceId = 32545;
  state.player = { inventory: [-1, -1, -1, -1, 101, -1, -1, -1, -1, -1, -1, -1] } as PlayerData;
  state.serverPos = { x: 0, y: 0 };
  state.io = {
    send: (packet: Packet) => {
      assert.ok(packet instanceof InvSwapPacket);
      sent.push(packet);
    },
  };
  state.objects.set(7331, tracked(7331, 999));
  state.objects.set(9001, tracked(9001, VAULT_CHEST_OBJECT_TYPE));
  state.objects.set(9002, tracked(9002, POTION_VAULT_OBJECT_TYPE));
  state.lastVaultContent = {
    lastVaultPacket: true,
    vaultUpgradeCost: 0,
    materialUpgradeCost: 0,
    potionUpgradeCost: 0,
    currentPotionMax: 0,
    nextPotionMax: 0,
    at: new Date(0).toISOString(),
    sections: [
      { key: 'vault', label: 'Vault', objectId: 9001, contents: [201, -1] },
      { key: 'potion', label: 'Potion Storage', objectId: 9002, contents: [301, -1] },
    ],
  };
  state.containerSlotItems.set(9001, new Map([[0, 201], [1, -1]]));
  state.containerSlotItems.set(9002, new Map([[0, 301], [1, -1]]));
  return { client, state, sent };
}

function clientWithFakeSocket(): { client: Client; calls: string[] } {
  const client = new Client({
    alias: 'stall-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
  });
  const calls: string[] = [];
  const state = client as unknown as {
    socket: { destroyed: boolean; pause(): void; resume(): void };
    connectStart: number;
  };
  state.connectStart = Date.now();
  state.socket = {
    destroyed: false,
    pause: () => calls.push('pause'),
    resume: () => calls.push('resume'),
  };
  return { client, calls };
}

function tracked(objectId: number, type: number): TrackedObject {
  return { objectId, type, x: 0, y: 0 };
}

function trackedAt(objectId: number, type: number, x: number, y: number): TrackedObject {
  return { objectId, type, x, y };
}

function slotTuple(packet: InvSwapPacket): number[] {
  return [
    packet.slotObject1.objectId,
    packet.slotObject1.slotId,
    packet.slotObject1.objectType,
    packet.slotObject2.objectId,
    packet.slotObject2.slotId,
    packet.slotObject2.objectType,
  ];
}

function assertSlot(
  slot: SlotObjectData | null,
  objectId: number,
  slotId: number,
  objectType: number,
  message?: string,
): void {
  assert.ok(slot, message);
  assert.deepEqual([slot.objectId, slot.slotId, slot.objectType], [objectId, slotId, objectType], message);
}

function installAutoAck(state: MutableClientState, sent: InvSwapPacket[]): void {
  installAckSequence(state, sent, []);
}

function installAckSequence(state: MutableClientState, sent: InvSwapPacket[], successes: boolean[]): void {
  state.io = {
    send: (packet: Packet) => {
      assert.ok(packet instanceof InvSwapPacket);
      sent.push(packet);
      const result = new InvResultPacket();
      result.success = successes.length ? successes.shift()! : true;
      result.ackType = 0;
      result.fromSlot.objectId = packet.slotObject1.objectId;
      result.fromSlot.slotId = packet.slotObject1.slotId;
      result.fromSlot.objectType = result.success ? packet.slotObject2.objectType : packet.slotObject1.objectType;
      result.toSlot.objectId = packet.slotObject2.objectId;
      result.toSlot.slotId = packet.slotObject2.slotId;
      result.toSlot.objectType = result.success ? packet.slotObject1.objectType : packet.slotObject2.objectType;
      queueMicrotask(() => state.handleInvResult(result));
    },
  };
}
