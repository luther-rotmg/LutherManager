import { InvResultPacket, SlotObjectData, VaultContentPacket } from 'realmlib';
import { Client, ItemContainer } from '../client';
import { ClientEvent } from '../events';
import { PluginRuntime } from '../plugin-runtime';
import { EventHook, Plugin } from './decorators';

const CONTAINERS: ItemContainer[] = ['inventory', 'petBag', 'vault', 'potionVault'];
type State = 'waiting' | 'nexus' | 'waitingVault' | 'vault' | 'done';

/** Guarded, reversible live integration matrix for the public container API. */
@Plugin({
  name: 'LiveContainerSwapTest',
  description: 'Guarded reversible matrix for inventory, pet-bag, vault, and potion-vault transfers.',
  author: 'realmlib',
  version: '2.0.0',
})
export class LiveContainerSwapTest {
  private state: State = 'waiting';
  private runtime: PluginRuntime | undefined;

  onLoad(client: Client, runtime: PluginRuntime): void {
    this.runtime = runtime;
    if (process.env.LIVE_CONTAINER_SWAP_TEST !== '1') {
      console.warn(`[${client.alias}] LiveSwap: set LIVE_CONTAINER_SWAP_TEST=1 to enable live mutations`);
      this.state = 'done';
      return;
    }
    runtime.setTimeout(() => void this.start(client), 0);
  }

  @EventHook(ClientEvent.InventoryResult)
  onInvResult(client: Client, packet: InvResultPacket): void {
    console.log(
      `[${client.alias}] LiveSwap INVRESULT ok=${packet.success} ackType=${packet.ackType} ` +
        `from=${packet.fromSlot.objectId}:${packet.fromSlot.slotId}:${packet.fromSlot.objectType} ` +
        `to=${packet.toSlot.objectId}:${packet.toSlot.slotId}:${packet.toSlot.objectType}`,
    );
  }

  @EventHook(ClientEvent.VaultContents)
  onVaultContents(client: Client, packet: VaultContentPacket): void {
    if (this.state !== 'waitingVault' || !packet.lastVaultPacket) return;
    this.state = 'vault';
    void this.runVaultMatrix(client, packet);
  }

  private async start(client: Client): Promise<void> {
    if (!this.runtime) return;
    const ready = await this.runtime.waitUntil(
      () => client.isInNexus() && client.isSeasonal() !== undefined && client.getInventory() !== undefined,
      15_000,
    );
    if (!ready) {
      console.warn(`[${client.alias}] LiveSwap: timed out waiting for Nexus character state`);
      this.state = 'done';
      return;
    }

    this.state = 'nexus';
    console.log(
      `[${client.alias}] LiveSwap START character=${client.isSeasonal() ? 'SEASONAL' : 'NON-SEASONAL'} ` +
        `player=${client.getObjectId()} PET_INSTANCEID=${client.getPetInstanceId()} ` +
        `PET_OBJECT_ID=${client.getPetObjectId()} petBag=${client.getPetBagContainerId()}`,
    );
    this.logInventory(client, 'initial Nexus');
    await this.inventoryPetRoundTrip(client);
    this.state = 'waitingVault';
    client.enterVault();
  }

  private async runVaultMatrix(client: Client, packet: VaultContentPacket): Promise<void> {
    console.log(
      `[${client.alias}] LiveSwap CONTAINER IDS vault=${packet.chestObjectId} material=${packet.materialObjectId} ` +
        `gift=${packet.giftObjectId} potion=${packet.potionObjectId} spoils=${packet.spoilsObjectId}`,
    );
    for (const section of client.getVaultContent()?.sections ?? []) {
      console.log(
        `[${client.alias}] LiveSwap ${section.key}: objectId=${section.objectId} ` +
          `slots=${section.contents.length} items=${section.contents.filter((item) => item !== -1).length}`,
      );
    }

    let seed: { inventorySlot: number; vaultSlot: number; itemType: number } | undefined;
    if (!client.getInventorySlot()) seed = await this.seedFromVault(client);

    await this.inventoryStorageRoundTrip(client, 'vault');
    await this.inventoryStorageRoundTrip(client, 'potionVault');
    await this.petStorageRoundTrip(client, 'vault');
    await this.petStorageRoundTrip(client, 'potionVault');

    const vaultItem = client.getVaultSlot();
    const potionEmpty = client.getPotionVaultSlot();
    if (vaultItem && potionEmpty) {
      await this.roundTrip(client, 'vault↔potionVault (buffered)', vaultItem, potionEmpty);
    } else {
      console.warn(`[${client.alias}] LiveSwap vault↔potionVault: skipped (filled/empty pair unavailable)`);
    }

    if (seed) await this.restoreSeed(client, seed);
    this.logInventory(client, 'final Vault');
    this.state = 'done';
    console.log(`[${client.alias}] LiveSwap COMPLETE; sending ESCAPE`);
    client.escape();
  }

  private async inventoryPetRoundTrip(client: Client): Promise<boolean> {
    const item = client.getInventorySlot();
    const empty = client.getPetBagSlot();
    if (!item || !empty) {
      console.warn(`[${client.alias}] LiveSwap inventory↔petBag: skipped (known slot pair unavailable)`);
      return false;
    }
    return this.roundTrip(client, 'inventory↔petBag', item, empty);
  }

  private async inventoryStorageRoundTrip(client: Client, container: 'vault' | 'potionVault'): Promise<boolean> {
    const item = client.getInventorySlot();
    const empty = client.getFirstEmptySlot(container);
    if (!item || !empty) {
      console.warn(`[${client.alias}] LiveSwap inventory↔${container}: skipped (slot pair unavailable)`);
      return false;
    }
    return this.roundTrip(client, `inventory↔${container}`, item, empty);
  }

  private async petStorageRoundTrip(client: Client, container: 'vault' | 'potionVault'): Promise<boolean> {
    const item = client.getInventorySlot();
    const petEmpty = client.getPetBagSlot();
    const storageEmpty = client.getFirstEmptySlot(container);
    if (!item || !petEmpty || !storageEmpty) {
      console.warn(`[${client.alias}] LiveSwap petBag↔${container}: skipped (slot pair unavailable)`);
      return false;
    }
    if (!await client.transferBetweenContainers(item, petEmpty)) return false;
    const petItem = client.getContainerSlot('petBag', petEmpty.slotId);
    if (!petItem || !await this.roundTrip(client, `petBag↔${container}`, petItem, storageEmpty)) {
      await this.restorePetItem(client, petEmpty.slotId, item.slotId);
      return false;
    }
    return this.restorePetItem(client, petEmpty.slotId, item.slotId);
  }

  private async roundTrip(client: Client, label: string, first: SlotObjectData, second: SlotObjectData): Promise<boolean> {
    const firstType = first.objectType;
    const secondType = second.objectType;
    const outward = await client.transferBetweenContainers(first, second);
    const currentFirst = this.currentSlot(client, first);
    const currentSecond = this.currentSlot(client, second);
    const returned = outward && !!currentFirst && !!currentSecond &&
      await client.transferBetweenContainers(currentFirst, currentSecond);
    const restored = returned &&
      this.currentSlot(client, first)?.objectType === firstType &&
      this.currentSlot(client, second)?.objectType === secondType;
    console.log(`[${client.alias}] LiveSwap ${label}: ${restored ? 'PASS' : 'FAIL'}`);
    return restored;
  }

  private currentSlot(client: Client, original: SlotObjectData): SlotObjectData | null {
    for (const container of CONTAINERS) {
      if (client.getContainerObjectId(container) === original.objectId) {
        return client.getContainerSlot(container, original.slotId);
      }
    }
    return null;
  }

  private async restorePetItem(client: Client, petSlotId: number, inventorySlotId: number): Promise<boolean> {
    const petItem = client.getContainerSlot('petBag', petSlotId);
    const inventoryEmpty = client.getContainerSlot('inventory', inventorySlotId);
    return !!petItem && !!inventoryEmpty && client.transferBetweenContainers(petItem, inventoryEmpty);
  }

  private async seedFromVault(client: Client): Promise<{ inventorySlot: number; vaultSlot: number; itemType: number } | undefined> {
    const vaultItem = client.getVaultSlot();
    const inventoryEmpty = client.getEmptyInventorySlot();
    if (!vaultItem || !inventoryEmpty || !await client.transferBetweenContainers(vaultItem, inventoryEmpty)) return undefined;
    return { inventorySlot: inventoryEmpty.slotId, vaultSlot: vaultItem.slotId, itemType: vaultItem.objectType };
  }

  private async restoreSeed(
    client: Client,
    seed: { inventorySlot: number; vaultSlot: number; itemType: number },
  ): Promise<void> {
    const item = client.getInventorySlot(seed.inventorySlot);
    const empty = client.getContainerSlot('vault', seed.vaultSlot);
    const restored = !!item && item.objectType === seed.itemType && !!empty &&
      await client.transferBetweenContainers(item, empty);
    console.log(`[${client.alias}] LiveSwap seed restoration: ${restored ? 'PASS' : 'FAIL'}`);
  }

  private logInventory(client: Client, stage: string): void {
    console.log(`[${client.alias}] LiveSwap inventory ${stage}: ${JSON.stringify(client.getInventory() ?? [])}`);
  }
}
