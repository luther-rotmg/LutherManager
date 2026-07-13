import { SlotObjectData, VaultContentPacket } from 'realmlib';
import { Client, MAIN_INVENTORY_SLOT_IDS } from '../client';
import { ClientEvent } from '../events';
import { PluginRuntime } from '../plugin-runtime';
import { EventHook, Plugin } from './decorators';

const WAIT_MS = 60_000;
type State = 'idle' | 'goingToVault' | 'moving' | 'escaping' | 'waiting';
type Phase = 'deposit' | 'withdraw';

/** Alternates between depositing main inventory into the vault and restoring it. */
@Plugin({
  name: 'VaultStorage',
  description: 'Loops reversible inventory↔vault transfers, waiting 60 seconds between cycles.',
  author: 'realmlib',
  version: '2.0.0',
})
export class VaultStorage {
  private state: State = 'idle';
  private phase: Phase = 'deposit';
  private runtime: PluginRuntime | undefined;

  onLoad(_client: Client, runtime: PluginRuntime): void {
    this.runtime = runtime;
  }

  @EventHook(ClientEvent.EnterNexus)
  onEnterNexus(client: Client): void {
    if (this.state === 'idle') {
      this.phase = 'deposit';
      this.beginVaultVisit(client);
    } else if (this.state === 'escaping') {
      void this.onReturnedToNexus(client);
    }
  }

  @EventHook(ClientEvent.VaultContents)
  onVault(client: Client, packet: VaultContentPacket): void {
    if (this.state !== 'goingToVault' || !packet.lastVaultPacket) return;
    this.state = 'moving';
    void this.performAndEscape(client);
  }

  status(): { state: State; phase: Phase } {
    return { state: this.state, phase: this.phase };
  }

  private beginVaultVisit(client: Client): void {
    this.state = 'goingToVault';
    console.log(`[${client.alias}] VaultStorage: ${this.phase} — entering vault`);
    client.enterVault();
  }

  private async performAndEscape(client: Client): Promise<void> {
    const moves = this.plan(client);
    console.log(`[${client.alias}] VaultStorage: ${this.phase} — ${moves.length} planned transfer(s)`);
    let completed = 0;
    for (const [from, to] of moves) {
      if (await client.transferBetweenContainers(from, to)) completed++;
      else break;
    }
    console.log(
      `[${client.alias}] VaultStorage: ${completed}/${moves.length} ${this.phase} transfer(s) confirmed by INVRESULT`,
    );
    this.state = 'escaping';
    client.escape();
  }

  private plan(client: Client): Array<[SlotObjectData, SlotObjectData]> {
    const inventory = MAIN_INVENTORY_SLOT_IDS
      .map((slotId) => client.getContainerSlot('inventory', slotId))
      .filter((slot): slot is SlotObjectData => slot !== null);
    if (this.phase === 'deposit') {
      return pair(
        inventory.filter((slot) => slot.objectType !== -1),
        client.getVaultSlots().filter((slot) => slot.objectType === -1),
      );
    }
    return pair(
      client.getVaultSlots().filter((slot) => slot.objectType !== -1),
      inventory.filter((slot) => slot.objectType === -1),
    );
  }

  private async onReturnedToNexus(client: Client): Promise<void> {
    await this.runtime?.waitUntil(() => client.getInventory() !== undefined, 5000);
    const itemCount = MAIN_INVENTORY_SLOT_IDS.filter(
      (slotId) => client.getContainerSlot('inventory', slotId)?.objectType !== -1,
    ).length;
    console.log(
      `[${client.alias}] VaultStorage: ${this.phase} complete; main inventory contains ${itemCount} item(s)`,
    );
    this.state = 'waiting';
    this.runtime?.setTimeout(() => {
      this.phase = this.phase === 'deposit' ? 'withdraw' : 'deposit';
      this.beginVaultVisit(client);
    }, WAIT_MS);
  }
}

function pair(from: SlotObjectData[], to: SlotObjectData[]): Array<[SlotObjectData, SlotObjectData]> {
  return from.slice(0, to.length).map((slot, index) => [slot, to[index]]);
}
