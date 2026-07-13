import {
  InvResultPacket,
  InvSwapPacket,
  MapInfoPacket,
  NewTickPacket,
  ObjectStatusData,
  SlotObjectData,
  StatData,
  StatType,
  UpdatePacket,
  UseItemPacket,
  WorldPosData,
  inventorySlotIndex,
} from 'realmlib';

/**
 * Inventory swapping + tracking, consolidated in the headless client (this was
 * previously split between realmlib and here). realmlib remains the source of
 * the wire packets (`InvSwapPacket`, `InvResultPacket`, `SlotObjectData`) and
 * the stat<->slot mapping (`inventorySlotIndex`); the higher-level logic lives
 * here.
 */

/** A single slot in some container, used to build INVSWAP packets. */
export interface SlotRef {
  /** Object id of the container that owns the slot (player, pet, vault chest). */
  objectId: number;
  /** Slot index within that container (e.g. 0 for the first slot). */
  slotId: number;
  /** Item id presently in the slot, or -1 if the slot is empty. */
  itemType: number;
}

// ------------------------------------------------------------ consumable slots

/**
 * Special player slot ids for the consumable/quickslot belt. Any consumable
 * item can be swapped into one of these via an ordinary INVSWAP whose
 * destination slot id is one of these values.
 *
 * `1000000` and `1000001` are always present; `1000002` is the third slot,
 * which only exists when the character has a **potion belt** equipped (see
 * `Client.hasPotionBelt()`). `1000003` does not exist. (Verified against
 * captured traffic: 1000000/1000001 appear constantly, 1000002 only with a
 * belt, 1000003 never.)
 */
export const CONSUMABLE_SLOT_IDS = [1000000, 1000001, 1000002] as const;

/** The consumable slot that only exists with a potion belt equipped. */
export const POTION_BELT_SLOT_ID = 1000002;

export type ConsumableSlotId = (typeof CONSUMABLE_SLOT_IDS)[number];

/** Whether `slotId` is one of the usable consumable-belt slot ids. */
export function isConsumableSlot(slotId: number): slotId is ConsumableSlotId {
  return (CONSUMABLE_SLOT_IDS as readonly number[]).includes(slotId);
}

// --------------------------------------------------------------- swap building

/** Builds a `SlotObjectData` from a plain {@link SlotRef}. */
export function makeSlot(ref: SlotRef): SlotObjectData {
  const slot = new SlotObjectData();
  slot.objectId = ref.objectId;
  slot.slotId = ref.slotId;
  // -1 marks an empty slot; keep it signed so it serializes as 0xFFFFFFFF.
  slot.objectType = ref.itemType;
  return slot;
}

/**
 * Builds a ready-to-send `InvSwapPacket`.
 *
 * @param time The client time (ms since connect), as sent in MOVE packets.
 * @param position The player's current position.
 * @param from The slot the item is taken from.
 * @param to The slot the item is placed in (its `itemType` is the item
 * currently there, or -1 when empty).
 */
export function buildInvSwap(
  time: number,
  position: { x: number; y: number },
  from: SlotRef,
  to: SlotRef,
): InvSwapPacket {
  const swap = new InvSwapPacket();
  swap.time = time;
  swap.position = new WorldPosData(position.x, position.y);
  swap.slotObject1 = makeSlot(from);
  swap.slotObject2 = makeSlot(to);
  return swap;
}

// -------------------------------------------------------- INVRESULT semantics

/**
 * The semantic meaning of an `InvResultPacket` (see the packet docs for the
 * underlying `ackType`/null-slot/flags conventions).
 */
export type InvResultClassification =
  /** Acknowledges the client's own InvSwapPacket. */
  | { kind: 'swap-ack'; success: boolean; from: SlotObjectData; to: SlotObjectData }
  /**
   * Acknowledges a UseItemPacket. `flags` is the raw (undecoded) bitfield;
   * consumption is not knowable from the ack, so it is not reported here.
   */
  | { kind: 'use-ack'; from: SlotObjectData; flags: number };

/** Classifies an `InvResultPacket` into its semantic meaning (stateless). */
export function classifyInvResult(result: InvResultPacket): InvResultClassification {
  if (!result.isUseItemAck()) {
    return { kind: 'swap-ack', success: result.success, from: result.fromSlot, to: result.toSlot };
  }
  return { kind: 'use-ack', from: result.fromSlot, flags: result.flags };
}

/** A swap awaiting its acknowledgement. */
export interface PendingSwap {
  swap: InvSwapPacket;
  /** The caller's timestamp from {@link SwapCorrelator.sent}. */
  sentAt: number;
}

/**
 * Correlates sent `InvSwapPacket`s with their `INVRESULT` acknowledgements.
 * Register each outgoing swap with {@link sent}; feed every incoming
 * `InvResultPacket` to {@link onResult}. Unmatched pending swaps (via
 * {@link pending}) indicate the server never answered — an early desync warning.
 */
export class SwapCorrelator {
  private queue: PendingSwap[] = [];

  /** Registers an outgoing swap. `sentAt` is any caller-side timestamp. */
  sent(swap: InvSwapPacket, sentAt: number): void {
    this.queue.push({ swap, sentAt });
  }

  /**
   * Processes an incoming result. If it is a swap ack matching a pending
   * swap's slots, that swap is removed from the queue and returned; otherwise
   * (use acks, unmatched acks) returns null.
   */
  onResult(result: InvResultPacket): PendingSwap | null {
    if (result.isUseItemAck()) {
      return null;
    }
    const index = this.queue.findIndex(
      ({ swap }) =>
        this.slotsMatch(swap.slotObject1, result.fromSlot) &&
        this.slotsMatch(swap.slotObject2, result.toSlot),
    );
    if (index === -1) {
      return null;
    }
    return this.queue.splice(index, 1)[0];
  }

  /** Swaps still awaiting acknowledgement, oldest first. */
  pending(): readonly PendingSwap[] {
    return this.queue;
  }

  /** Drops (and returns) pending swaps sent at or before `cutoff`. */
  expire(cutoff: number): PendingSwap[] {
    const expired = this.queue.filter((p) => p.sentAt <= cutoff);
    this.queue = this.queue.filter((p) => p.sentAt > cutoff);
    return expired;
  }

  private slotsMatch(a: SlotObjectData, b: SlotObjectData): boolean {
    return a.objectId === b.objectId && a.slotId === b.slotId;
  }
}

// ---------------------------------------------------- map-scoped state tracker

/**
 * An object (player, container, loot bag, ...) whose inventory-carrying stats
 * have been observed in the current map.
 */
export interface InventoryObject {
  objectId: number;
  /** The object's type, or -1 if only seen via NEWTICK (which omits it). */
  objectType: number;
  /** The object's name, if it has broadcast a NAME stat. */
  name?: string;
  /** Whether the object has broadcast SEASONAL_CHARACTER_STAT = 1. */
  seasonal?: boolean;
  /** Flat slot index (0-11 inventory, 12-19 backpack) -> item id, -1 = empty. */
  slots: Map<number, number>;
}

/** A location of an item: which object holds it, and in which flat slot. */
export interface ItemLocation {
  objectId: number;
  slotIndex: number;
}

/** Events produced by {@link InventoryState.applyInvResult}. */
export type InventoryEvent =
  /** Acknowledges the client's InvSwapPacket. */
  | { kind: 'swap-ack'; result: InvResultPacket }
  /** Acknowledges the client's UseItemPacket (consumption not knowable). */
  | { kind: 'use-ack'; result: InvResultPacket }
  /** A use ack with `success = false` — the server *rejected* the use. */
  | { kind: 'use-rejected'; result: InvResultPacket }
  /** A successful use-shaped ack with no matching USEITEM fed to the tracker. */
  | { kind: 'unmatched-use-ack'; result: InvResultPacket };

/**
 * Reconstructs per-object inventory state from the packet stream. Feed it
 * MAPINFO, UPDATE, NEWTICK, USEITEM and INVRESULT (in stream order) and it
 * maintains a *map-scoped* view of every object's inventory slots plus a
 * classification of every INVRESULT. Map-scoped is crucial: object ids are
 * reissued on every map transition, so cross-map accumulation makes one item
 * look like many. Resets on every {@link applyMapInfo}.
 */
export class InventoryState {
  /** The name of the current map, from the last MAPINFO. */
  mapName = '';
  /** How many maps have been entered (MAPINFO packets applied). */
  mapCount = 0;

  private objects = new Map<number, InventoryObject>();
  /** item id -> count of USEITEMs not yet acknowledged by an INVRESULT. */
  private pendingUses = new Map<number, number>();

  /** All objects observed in the current map. */
  get objectsInView(): ReadonlyMap<number, InventoryObject> {
    return this.objects;
  }

  /** Resets all state for a new map. Call for every MAPINFO packet. */
  applyMapInfo(mapInfo: MapInfoPacket): void {
    this.objects.clear();
    this.pendingUses.clear();
    this.mapName = mapInfo.name;
    this.mapCount++;
  }

  /** Applies newly visible objects and drops. Call for every UPDATE packet. */
  applyUpdate(update: UpdatePacket): void {
    for (const obj of update.newObjects) {
      this.applyStatus(obj.status, obj.objectType);
    }
    for (const objectId of update.drops) {
      this.objects.delete(objectId);
    }
  }

  /** Applies per-tick stat deltas. Call for every NEWTICK packet. */
  applyNewTick(newTick: NewTickPacket): void {
    for (const status of newTick.statuses) {
      this.applyStatus(status, null);
    }
  }

  /** Registers an outgoing item use so its INVRESULT ack can be matched. */
  applyUseItem(useItem: UseItemPacket): void {
    const item = useItem.slotObject.objectType;
    this.pendingUses.set(item, (this.pendingUses.get(item) ?? 0) + 1);
  }

  /** Classifies an INVRESULT (see {@link InventoryEvent}). */
  applyInvResult(result: InvResultPacket): InventoryEvent[] {
    if (!result.isUseItemAck()) {
      return [{ kind: 'swap-ack', result }];
    }
    if (!result.success) {
      return [{ kind: 'use-rejected', result }];
    }
    const item = result.fromSlot.objectType;
    const pending = this.pendingUses.get(item) ?? 0;
    if (pending > 0) {
      if (pending === 1) this.pendingUses.delete(item);
      else this.pendingUses.set(item, pending - 1);
      return [{ kind: 'use-ack', result }];
    }
    return [{ kind: 'unmatched-use-ack', result }];
  }

  /** The tracked state of an object, if it has been seen this map. */
  getObject(objectId: number): InventoryObject | undefined {
    return this.objects.get(objectId);
  }

  /** Every location currently holding `itemType` in this map. */
  locationsOf(itemType: number): ItemLocation[] {
    const locations: ItemLocation[] = [];
    for (const [objectId, obj] of this.objects) {
      for (const [slotIndex, item] of obj.slots) {
        if (item === itemType) {
          locations.push({ objectId, slotIndex });
        }
      }
    }
    return locations;
  }

  private applyStatus(status: ObjectStatusData, objectType: number | null): void {
    let obj = this.objects.get(status.objectId);
    if (!obj) {
      obj = { objectId: status.objectId, objectType: objectType ?? -1, slots: new Map() };
      this.objects.set(status.objectId, obj);
    } else if (objectType !== null) {
      obj.objectType = objectType;
    }
    for (const stat of status.stats) {
      this.applyStat(obj, stat);
    }
  }

  private applyStat(obj: InventoryObject, stat: StatData): void {
    const slotIndex = inventorySlotIndex(stat.statType);
    if (slotIndex !== null) {
      obj.slots.set(slotIndex, stat.statValue);
      return;
    }
    if (stat.statType === StatType.NAME_STAT) {
      obj.name = stat.stringStatValue;
    } else if (stat.statType === StatType.SEASONAL_CHARACTER_STAT) {
      obj.seasonal = stat.statValue !== 0;
    }
  }
}
