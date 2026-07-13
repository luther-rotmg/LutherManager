import {
  InvSwapPacket,
  Packet,
  PlayerData,
  PlayerShootPacket,
  PlayerTextPacket,
  UsePortalPacket,
} from 'realmlib';
import { CONSUMABLE_SLOT_IDS, isConsumableSlot, makeSlot, type SlotRef } from './inventory';

export type { SlotRef } from './inventory';

interface CommandState {
  io: PacketSink | undefined;
  time: number;
  pos: { x: number; y: number };
  objectId: number;
  player: PlayerData | undefined;
  nextBulletId(): number;
}

export interface PacketSink {
  send(packet: Packet): void;
}

/** Builds and sends outgoing gameplay packets from the current client state. */
export class CommandSender {
  constructor(private readonly state: () => CommandState) {}

  send(packet: Packet): void {
    this.state().io?.send(packet);
  }

  say(message: string): void {
    const packet = new PlayerTextPacket();
    packet.text = message;
    this.send(packet);
  }

  usePortal(objectId: number): void {
    const use = new UsePortalPacket();
    use.objectId = objectId;
    this.send(use);
  }

  swapInventorySlots(fromSlotId: number, toSlotId: number): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) {
      return false;
    }
    const packet = new InvSwapPacket();
    packet.time = state.time;
    packet.position.x = state.pos.x;
    packet.position.y = state.pos.y;
    packet.slotObject1 = makeSlot({
      objectId: state.objectId,
      slotId: fromSlotId,
      itemType: state.player.inventory?.[fromSlotId] ?? -1,
    });
    packet.slotObject2 = makeSlot({
      objectId: state.objectId,
      slotId: toSlotId,
      itemType: state.player.inventory?.[toSlotId] ?? -1,
    });
    state.io.send(packet);
    return true;
  }

  invSwap(from: SlotRef, to: SlotRef): boolean {
    const state = this.state();
    if (state.objectId === -1 || !state.io) {
      return false;
    }
    const packet = new InvSwapPacket();
    packet.time = state.time;
    packet.position.x = state.pos.x;
    packet.position.y = state.pos.y;
    packet.slotObject1 = makeSlot(from);
    packet.slotObject2 = makeSlot(to);
    state.io.send(packet);
    return true;
  }

  /**
   * Swaps the consumable item in the player's inventory slot `fromSlotId` into
   * a consumable-belt slot (`1000000`, `1000001`, or `1000003`) via an INVSWAP.
   * Returns false if not in-world, the destination isn't a valid consumable
   * slot, or the source slot is empty.
   */
  swapToConsumable(fromSlotId: number, consumableSlotId: number): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) {
      return false;
    }
    if (!isConsumableSlot(consumableSlotId)) {
      console.warn(`invalid consumable slot ${consumableSlotId} (valid: ${CONSUMABLE_SLOT_IDS.join(', ')})`);
      return false;
    }
    const itemType = state.player.inventory?.[fromSlotId] ?? -1;
    if (itemType === -1) {
      return false; // nothing in the source slot to move
    }
    return this.invSwap(
      { objectId: state.objectId, slotId: fromSlotId, itemType },
      { objectId: state.objectId, slotId: consumableSlotId, itemType: -1 },
    );
  }

  shootAt(target: { x: number; y: number }, weaponSlot = 0): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) {
      return false;
    }
    const weaponType = state.player.inventory?.[weaponSlot] ?? -1;
    if (weaponType === -1) {
      return false;
    }
    const shot = new PlayerShootPacket();
    shot.time = state.time;
    shot.bulletId = state.nextBulletId();
    shot.containerType = weaponType;
    shot.unknownByte = 0;
    shot.startingPos.x = state.pos.x;
    shot.startingPos.y = state.pos.y;
    shot.angle = Math.atan2(target.y - state.pos.y, target.x - state.pos.x);
    shot.isBurst = false;
    shot.unknownShort = 0;
    shot.playerPos.x = state.pos.x;
    shot.playerPos.y = state.pos.y;
    state.io.send(shot);
    return true;
  }
}
