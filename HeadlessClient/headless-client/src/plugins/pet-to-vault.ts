import { SlotObjectData, VaultContentPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { PluginRuntime } from '../plugin-runtime';
import { EventHook, Plugin } from './decorators';

const DEFAULT_TIMEOUT_MS = 5000;
const STALL_MS = 5000;

type State =
  | 'idle'
  | 'movingToPet'
  | 'stalling'
  | 'movingToPlayer'
  | 'enteringVault'
  | 'depositing'
  | 'done'
  | 'failed';

/** Exercises inventory → pet bag → inventory → vault using the public client API. */
@Plugin({
  name: 'PetToVault',
  description: 'Moves an inventory item through the pet bag and into the vault using client slot helpers.',
  author: 'realmlib',
  version: '2.0.0',
})
export class PetToVault {
  private state: State = 'idle';
  private running = false;
  private runtime: PluginRuntime | undefined;
  private originalSlot: SlotObjectData | undefined;

  onLoad(_client: Client, runtime: PluginRuntime): void {
    this.runtime = runtime;
  }

  @EventHook(ClientEvent.EnterNexus)
  onNexus(client: Client): void {
    if (this.state === 'idle') void this.run(client);
  }

  @EventHook(ClientEvent.VaultContents)
  onVault(client: Client, packet: VaultContentPacket): void {
    if (this.state === 'enteringVault' && packet.lastVaultPacket) {
      void this.deposit(client);
    }
  }

  async run(client: Client, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    if (this.running) {
      console.log(`[${client.alias}] PetToVault: already running`);
      return;
    }
    if (!this.runtime || this.runtime.isDisposed) {
      this.fail(client, 'plugin runtime is unavailable');
      return;
    }

    this.running = true;
    this.state = 'idle';
    this.originalSlot = undefined;
    const ready = await this.runtime.waitUntil(
      () => client.getInventorySlot() !== null && client.getPetBagSlot() !== null,
      timeoutMs,
    );
    const inventorySlot = client.getInventorySlot();
    const petBagSlot = client.getPetBagSlot();
    if (!ready || !inventorySlot || !petBagSlot) {
      this.fail(client, 'a filled inventory slot and known empty pet-bag slot are required');
      return;
    }
    this.originalSlot = inventorySlot;

    this.state = 'movingToPet';
    console.log(
      `[${client.alias}] PetToVault: item ${inventorySlot.objectType} inventory ${inventorySlot.slotId} ` +
        `→ pet container ${petBagSlot.objectId} slot ${petBagSlot.slotId}`,
    );
    if (!client.swapInventoryWithPetBag(inventorySlot, petBagSlot) ||
        !await this.waitForSlot(client, 'petBag', petBagSlot.slotId, inventorySlot.objectType, timeoutMs)) {
      this.fail(client, 'inventory → pet-bag swap was rejected or timed out');
      return;
    }

    this.state = 'stalling';
    if (!client.stall()) {
      this.fail(client, 'could not stall the client');
      return;
    }
    await this.runtime.sleep(STALL_MS);

    console.log(`[${client.alias}] PetToVault: queueing seasonal conversion and pet-bag return`);
    client.sendSeasonalConversion();
    const filledPetSlot = client.getContainerSlot('petBag', petBagSlot.slotId);
    const emptyInventorySlot = client.getContainerSlot('inventory', inventorySlot.slotId);
    this.state = 'movingToPlayer';
    if (!filledPetSlot || !emptyInventorySlot ||
        !client.swapInventoryWithPetBag(emptyInventorySlot, filledPetSlot)) {
      this.fail(client, 'could not queue pet-bag → inventory swap');
      return;
    }
    client.unstall();

    if (!await this.waitForSlot(client, 'inventory', inventorySlot.slotId, inventorySlot.objectType, timeoutMs)) {
      this.fail(client, 'item did not return to inventory after unstall');
      return;
    }

    this.state = 'enteringVault';
    console.log(`[${client.alias}] PetToVault: inventory restored; entering vault`);
    client.enterVault();
  }

  status(): { state: State; itemType: number; inventorySlot: number } {
    return {
      state: this.state,
      itemType: this.originalSlot?.objectType ?? -1,
      inventorySlot: this.originalSlot?.slotId ?? -1,
    };
  }

  private async deposit(client: Client): Promise<void> {
    if (!this.runtime || !this.originalSlot) return;
    const inventorySlot = client.getInventorySlot(this.originalSlot.slotId);
    const vaultSlot = client.getFirstEmptySlot('vault');
    if (!inventorySlot || inventorySlot.objectType !== this.originalSlot.objectType || !vaultSlot) {
      this.fail(client, 'source item is missing or the vault has no empty slot');
      return;
    }

    this.state = 'depositing';
    console.log(
      `[${client.alias}] PetToVault: item ${inventorySlot.objectType} inventory ${inventorySlot.slotId} ` +
        `→ vault ${vaultSlot.objectId} slot ${vaultSlot.slotId}`,
    );
    const accepted = client.swapInventoryWithVault(inventorySlot, vaultSlot);
    const deposited = accepted && await this.waitForSlot(
      client,
      'vault',
      vaultSlot.slotId,
      inventorySlot.objectType,
      DEFAULT_TIMEOUT_MS,
    );
    if (!deposited) {
      this.fail(client, 'inventory → vault swap was rejected or timed out');
      return;
    }

    this.state = 'done';
    this.running = false;
    console.log(`[${client.alias}] PetToVault: ✓ item ${inventorySlot.objectType} is in the vault`);
  }

  private waitForSlot(
    client: Client,
    container: 'inventory' | 'petBag' | 'vault',
    slotId: number,
    itemType: number,
    timeoutMs: number,
  ): Promise<boolean> {
    return this.runtime?.waitUntil(
      () => client.getContainerSlot(container, slotId)?.objectType === itemType,
      timeoutMs,
    ) ?? Promise.resolve(false);
  }

  private fail(client: Client, reason: string): void {
    if (client.isStalled()) client.unstall();
    this.state = 'failed';
    this.running = false;
    console.warn(`[${client.alias}] PetToVault: failed — ${reason}`);
  }
}
