import {
  loot,
  type LootBag,
  type LootDropEvent,
  type LootItemEvent,
  type LootRarity,
} from '@luthermanager/sdk';
import { ClientEvent, type Client, type TrackedObject } from 'headless-client';
import { StatType } from '../../../constants/StatType.js';
import type { BridgeDeps } from '../BridgeDeps.js';
import {
  buildLootBag,
  isLootObjectType,
  LOOT_RARITY_RANK,
  type WorldContainerSnapshot,
} from '../loot/model.js';

type LootEventKey = 'bagDropped' | 'bagRemoved';
type LootHandler = (event: LootDropEvent) => void;

interface ClientLootState {
  droppedAt: Map<number, number>;
  handlers: Record<LootEventKey, Set<LootHandler>>;
}

const states = new WeakMap<Client, ClientLootState>();

function active(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

function snapshot(client: Client, object: TrackedObject): WorldContainerSnapshot {
  const stats = { ...(object.rawStats ?? {}) };
  for (const slot of client.getWorldContainerSlots(object.objectId)) {
    if (slot.slotId >= 0 && slot.slotId < 8) {
      stats[String(StatType.Inventory0 + slot.slotId)] = slot.objectType;
    }
  }
  return {
    objectId: object.objectId,
    objectType: object.type,
    x: object.x,
    y: object.y,
    stats,
  };
}

function bagFromObject(
  client: Client,
  object: TrackedObject,
  droppedAt: number,
  deps: BridgeDeps,
): LootBag | null {
  return buildLootBag(snapshot(client, object), droppedAt, deps);
}

function fire(state: ClientLootState, key: LootEventKey, bag: LootBag): void {
  for (const handler of [...state.handlers[key]]) {
    try {
      handler({ bag });
    } catch (error) {
      console.error(`[Hive.loot] ${key} listener failed:`, error);
    }
  }
}

function stateFor(client: Client, deps: BridgeDeps): ClientLootState {
  const current = states.get(client);
  if (current) return current;
  const state: ClientLootState = {
    droppedAt: new Map(),
    handlers: { bagDropped: new Set(), bagRemoved: new Set() },
  };
  states.set(client, state);

  client.on(ClientEvent.ObjectAdded, (object) => {
    if (!isLootObjectType(object.type, deps)) return;
    const droppedAt = Date.now();
    state.droppedAt.set(object.objectId, droppedAt);
    const bag = bagFromObject(client, object, droppedAt, deps);
    if (bag) fire(state, 'bagDropped', bag);
  });
  client.on(ClientEvent.ObjectRemoved, (object) => {
    if (!isLootObjectType(object.type, deps)) return;
    const droppedAt = state.droppedAt.get(object.objectId) ?? Date.now();
    const bag = bagFromObject(client, object, droppedAt, deps);
    state.droppedAt.delete(object.objectId);
    if (bag) fire(state, 'bagRemoved', bag);
  });
  client.on(ClientEvent.MapChange, () => state.droppedAt.clear());
  return state;
}

function currentBags(client: Client, deps: BridgeDeps): LootBag[] {
  const state = stateFor(client, deps);
  const visibleIds = new Set<number>();
  const bags: LootBag[] = [];
  for (const object of client.visibleObjects()) {
    if (!isLootObjectType(object.type, deps)) continue;
    visibleIds.add(object.objectId);
    const droppedAt = state.droppedAt.get(object.objectId) ?? Date.now();
    state.droppedAt.set(object.objectId, droppedAt);
    const bag = bagFromObject(client, object, droppedAt, deps);
    if (bag) bags.push(bag);
  }
  for (const objectId of state.droppedAt.keys()) {
    if (!visibleIds.has(objectId)) state.droppedAt.delete(objectId);
  }
  return bags;
}

function bound(deps: BridgeDeps, handler: LootHandler): LootHandler {
  const session = deps.getScriptSession?.() ?? deps.scriptSession;
  if (!session.scriptId || !deps.runInScriptSession) return handler;
  return (event) => deps.runInScriptSession!(
    { scriptId: session.scriptId!, accountId: session.accountId },
    () => handler(event),
  );
}

function subscribe(deps: BridgeDeps, key: LootEventKey, handler: LootHandler): () => void {
  const client = active(deps);
  if (!client) return () => {};
  const state = stateFor(client, deps);
  const callback = bound(deps, handler);
  state.handlers[key].add(callback);
  return () => state.handlers[key].delete(callback);
}

function inventoryDestinations(client: Client, useBackpack: boolean): ReturnType<Client['getInventorySlots']> {
  const slotIds = useBackpack
    ? client.getCarriedInventorySlotIds()
    : client.getCarriedInventorySlotIds().filter((slotId) => slotId < 12);
  const usable = new Set(slotIds);
  return client.getInventorySlots().filter(
    (slot) => usable.has(slot.slotId) && slot.objectType === -1,
  );
}

function visibleLootObject(client: Client, objectId: number, deps: BridgeDeps): TrackedObject | undefined {
  const object = client.getVisibleObject(objectId);
  return object && isLootObjectType(object.type, deps) ? object : undefined;
}

export function installHeadlessLootBridge(deps: BridgeDeps): void {
  loot.getBags = () => {
    const client = active(deps);
    return client ? currentBags(client, deps) : [];
  };
  loot.getNearbyBags = (radius = 5) => {
    const client = active(deps);
    if (!client) return [];
    const maximum = Math.max(0, Number(radius) || 0);
    return currentBags(client, deps).filter((bag) => client.distanceTo(bag.position) <= maximum);
  };
  loot.getBagsByRarity = (rarity) => loot.getBags().filter((bag) => bag.rarity === rarity);
  loot.getBagsContaining = (objectType) => loot.getBags().filter(
    (bag) => bag.items.some((item) => item.objectType === objectType),
  );

  loot.onBagDropped = (handler) => subscribe(deps, 'bagDropped', handler);
  loot.onBagRemoved = (handler) => subscribe(deps, 'bagRemoved', handler);
  loot.onRareBagDropped = (minimum: LootRarity, handler) => subscribe(deps, 'bagDropped', (event) => {
    if (LOOT_RARITY_RANK[event.bag.rarity] >= LOOT_RARITY_RANK[minimum]) handler(event);
  });
  loot.onItemDropped = (objectType, handler) => subscribe(deps, 'bagDropped', (event) => {
    const item = event.bag.items.find((candidate) => candidate.objectType === objectType);
    if (item) handler({ bag: event.bag, item } satisfies LootItemEvent);
  });

  loot.pickup = (bag, slotIndex, options) => {
    const client = active(deps);
    if (!client) return false;
    const object = visibleLootObject(client, bag.objectId, deps);
    if (!object) return false;
    const source = client.getWorldContainerSlot(object.objectId, slotIndex);
    const destination = inventoryDestinations(client, options?.useBackpack ?? true)[0];
    return !!source && source.objectType > 0 && !!destination && client.swapSlots(source, destination);
  };

  loot.pickupToSlot = (bag, slotIndex, inventorySlotIndex) => {
    const client = active(deps);
    if (!client || !Number.isInteger(inventorySlotIndex) || inventorySlotIndex < 0) return false;
    const object = visibleLootObject(client, bag.objectId, deps);
    if (!object) return false;
    const source = client.getWorldContainerSlot(object.objectId, slotIndex);
    const destination = client.getContainerSlot('inventory', inventorySlotIndex);
    const validDestination = inventorySlotIndex <= 3
      || client.getCarriedInventorySlotIds().includes(inventorySlotIndex);
    return !!source && source.objectType > 0 && !!destination && validDestination
      && client.swapSlots(source, destination);
  };

  loot.pickupId = (bagObjectId, options) => {
    const client = active(deps);
    if (!client) return -1;
    const object = visibleLootObject(client, bagObjectId, deps);
    if (!object) return -1;
    const maximumDistance = Math.max(0, options?.maxDistance ?? 1);
    if (client.distanceTo(object) > maximumDistance) return -1;
    const sources = client.getWorldContainerSlots(bagObjectId).filter(
      (slot) => slot.slotId >= 0 && slot.slotId < 8 && slot.objectType > 0,
    );
    const destinations = inventoryDestinations(client, options?.useBackpack ?? true);
    let sent = 0;
    for (let index = 0; index < Math.min(sources.length, destinations.length); index++) {
      if (client.swapSlots(sources[index], destinations[index])) sent++;
    }
    return sent;
  };

  loot.useFromBag = (bag, slotIndex) => {
    const client = active(deps);
    if (!client || !visibleLootObject(client, bag.objectId, deps)) return false;
    const source = client.getWorldContainerSlot(bag.objectId, slotIndex);
    return !!source && source.objectType > 0 && client.useItemNear(source, undefined, 1);
  };
  loot.getItemInfo = (objectType) => deps.gameData.buildSdkItem(objectType);
}
