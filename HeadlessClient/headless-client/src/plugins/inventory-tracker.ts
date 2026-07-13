import { InvResultPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { EventHook, Plugin } from './decorators';

/**
 * Passive inventory observer. It keeps a local copy of the player's 20 item
 * slots and, every tick, diffs it against what the server reports — logging
 * every change with a timestamp and flagging anything that looks like a server
 * bug (an item silently vanishing to an empty slot with no corresponding move).
 *
 * It also logs every INVRESULT the server sends, so you can measure the latency
 * and outcome of inventory operations and see when the server's idea of a slot
 * disagrees with what we asked for. Purely observational — it never sends
 * anything. Use it alongside PetBagRoundTrip to measure void/dedup behaviour.
 *
 * Slot layout: 0-3 equipment, 4-11 inventory, 12-19 backpack.
 */
@Plugin({
  name: 'InventoryTracker',
  description: 'Tracks inventory slots, logs every server change, flags unexpected item voids.',
  author: 'realmlib',
  version: '1.0.0',
})
export class InventoryTracker {
  private last: number[] | undefined;
  private changeCount = 0;
  private voidCount = 0;

  /** Resets the model on each map entry — slots are re-sent fresh after a load. */
  @EventHook(ClientEvent.MapChange)
  onMapChange(): void {
    this.last = undefined;
  }

  /** Diffs the live inventory against the previous snapshot once per tick. */
  @EventHook(ClientEvent.Tick)
  onTick(client: Client): void {
    const current = client.getInventory();
    if (!current) {
      return;
    }
    if (!this.last) {
      this.last = current;
      return;
    }
    // Per-slot transitions are informational: a normal move empties one slot
    // and fills another the same tick, so a lone "→ EMPTY" is NOT a void by
    // itself. Log them at info level for visibility.
    for (let slot = 0; slot < current.length; slot++) {
      const before = this.last[slot] ?? -1;
      const after = current[slot] ?? -1;
      if (before === after) {
        continue;
      }
      this.changeCount++;
      const where = InventoryTracker.slotLabel(slot);
      console.log(
        `[${client.alias}] InventoryTracker: ${where} (slot ${slot}) ${label(before)} → ${label(after)}`,
      );
    }

    // Real voids/dups are net changes in the *multiset* of item ids across all
    // 20 slots. A slot-to-slot move nets zero and is not flagged; only an id
    // whose total count actually drops (void) or rises (possible dup) is.
    const before = countItems(this.last);
    const after = countItems(current);
    for (const [id, wasCount] of before) {
      const nowCount = after.get(id) ?? 0;
      if (nowCount < wasCount) {
        this.voidCount++;
        console.warn(
          `[${client.alias}] InventoryTracker: ⚠ item ${id} count ${wasCount} → ${nowCount} ` +
            `(lost ${wasCount - nowCount} — VOID unless it left to the vault/was consumed)`,
        );
      }
    }
    for (const [id, nowCount] of after) {
      const wasCount = before.get(id) ?? 0;
      if (nowCount > wasCount) {
        console.log(
          `[${client.alias}] InventoryTracker: item ${id} count ${wasCount} → ${nowCount} ` +
            `(gained ${nowCount - wasCount} — loot/deposit, or a dup if unexpected)`,
        );
      }
    }
    this.last = current;
  }

  /** Logs the server's response to an inventory operation. */
  @EventHook(ClientEvent.InventoryResult)
  onInvResult(client: Client, packet: InvResultPacket): void {
    const origin = packet.isUseItemAck() ? 'USEITEM' : 'INVSWAP';
    console.log(
      `[${client.alias}] InventoryTracker: INVRESULT ok=${packet.success} ackType=${packet.ackType} ` +
        `origin=${origin} flags=0x${packet.flags.toString(16)} ` +
        `from(obj ${packet.fromSlot.objectId} slot ${packet.fromSlot.slotId} type ${signed(packet.fromSlot.objectType)}) ` +
        `to(obj ${packet.toSlot.objectId} slot ${packet.toSlot.slotId} type ${signed(packet.toSlot.objectType)})`,
    );
  }

  /** Current counters for console inspection / tests. */
  status(): { changes: number; voids: number } {
    return { changes: this.changeCount, voids: this.voidCount };
  }

  /** Human label for a slot index. */
  static slotLabel(slot: number): string {
    if (slot <= 3) {
      return 'equip';
    }
    if (slot <= 11) {
      return 'inventory';
    }
    return 'backpack';
  }
}

/** Renders the 0xffffffff "empty" sentinel as -1. */
function signed(objectType: number): number {
  return objectType === 0xffffffff ? -1 : objectType;
}

/** Renders an item id for logs (-1 as "EMPTY"). */
function label(itemId: number): string {
  return itemId === -1 ? 'EMPTY' : String(itemId);
}

/** Counts how many of each (non-empty) item id occupy the given slots. */
function countItems(slots: number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const id of slots) {
    if (id !== -1) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return counts;
}
