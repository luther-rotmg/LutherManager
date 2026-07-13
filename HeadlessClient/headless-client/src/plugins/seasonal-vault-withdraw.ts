import { SlotObjectData, VaultContentPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { PluginRuntime } from '../plugin-runtime';
import { EventHook, Plugin } from './decorators';

const MAIN_INVENTORY_SLOTS = [4, 5, 6, 7, 8, 9, 10, 11];
const SWAP_SETTLE_TIMEOUT_MS = 8000;

type State =
  | 'waitingForSeasonalStatus'
  | 'routingToNexus'
  | 'enteringVault'
  | 'awaitingVaultContents'
  | 'withdrawing'
  | 'escaping'
  | 'waitingForNexusInventory'
  | 'done';

export interface VaultItemChoice {
  section: 'vault' | 'gift' | 'potion';
  objectId: number;
  slotId: number;
  itemType: number;
}

/** Returns every withdrawable item represented by one VAULT_CONTENT packet. */
export function vaultItems(packet: VaultContentPacket): VaultItemChoice[] {
  const sections: Array<{
    section: VaultItemChoice['section'];
    objectId: number;
    contents: number[];
  }> = [
    { section: 'vault', objectId: packet.chestObjectId, contents: packet.vaultContents },
    { section: 'gift', objectId: packet.giftObjectId, contents: packet.giftContents },
    { section: 'potion', objectId: packet.potionObjectId, contents: packet.potionContents },
  ];

  return sections.flatMap(({ section, objectId, contents }) =>
    contents.flatMap((itemType, slotId) =>
      itemType === -1 ? [] : [{ section, objectId, slotId, itemType }],
    ),
  );
}

/** Main-inventory slots which are currently empty (equipment/backpack excluded). */
export function emptyMainInventorySlots(inventory: number[]): number[] {
  return MAIN_INVENTORY_SLOTS.filter((slotId) => (inventory[slotId] ?? -1) === -1);
}

/** Picks one item and one destination independently and uniformly. */
export function chooseWithdrawal(
  items: VaultItemChoice[],
  emptySlots: number[],
  random: () => number = Math.random,
): { item: VaultItemChoice; inventorySlot: number } | undefined {
  if (items.length === 0 || emptySlots.length === 0) {
    return undefined;
  }
  return {
    item: items[Math.floor(random() * items.length)],
    inventorySlot: emptySlots[Math.floor(random() * emptySlots.length)],
  };
}

/**
 * One-shot seasonal-character workflow:
 * Nexus -> Vault -> random Vault/Gift/Potion withdrawal -> ESCAPE -> Nexus.
 */
@Plugin({
  name: 'SeasonalVaultWithdraw',
  description: 'On seasonal characters, withdraws one random vault/gift/potion item and escapes to Nexus.',
  author: 'realmlib',
  version: '1.0.0',
})
export class SeasonalVaultWithdraw {
  private state: State = 'waitingForSeasonalStatus';
  private mapName = '';
  private pendingItems: VaultItemChoice[] = [];
  private stopped = false;

  @EventHook(ClientEvent.MapChange)
  onMapChange(client: Client, name: string): void {
    this.mapName = name;
    if (this.state === 'routingToNexus' && name === 'Nexus') {
      this.enterVault(client);
    } else if (this.state === 'enteringVault' && /vault/i.test(name)) {
      this.state = 'awaitingVaultContents';
    } else if (this.state === 'escaping' && name === 'Nexus') {
      // MAPINFO arrives before the character's inventory is loaded. Wait for a
      // Tick event with a real inventory before printing the final snapshot.
      this.state = 'waitingForNexusInventory';
    }
  }

  @EventHook(ClientEvent.Tick)
  onTick(client: Client): void {
    if (this.state === 'waitingForSeasonalStatus') {
      this.observeSeasonalStatus(client);
      return;
    }
    if (this.state !== 'waitingForNexusInventory') {
      return;
    }
    const inventory = client.getInventory();
    if (!inventory) {
      return;
    }
    this.debugInventory(client, 'after ESCAPE / Nexus reload', inventory);
    this.stop(client, 'workflow complete');
  }

  @EventHook(ClientEvent.VaultContents)
  async onVaultContents(client: Client, packet: VaultContentPacket, runtime: PluginRuntime): Promise<void> {
    if (this.state !== 'awaitingVaultContents' && this.state !== 'enteringVault') {
      return;
    }

    this.state = 'awaitingVaultContents';
    this.pendingItems.push(...vaultItems(packet));
    console.log(
      `[${client.alias}] SeasonalVaultWithdraw: VAULT_CONTENT chunk parsed ` +
        `(vault=${countItems(packet.vaultContents)}, gift=${countItems(packet.giftContents)}, ` +
        `potion=${countItems(packet.potionContents)}, last=${packet.lastVaultPacket})`,
    );
    if (!packet.lastVaultPacket) {
      return;
    }

    if (this.pendingItems.length === 0) {
      this.stop(client, 'Vault, Gift Chest, and Potion Storage are all empty');
      return;
    }

    const inventory = client.getInventory();
    if (!inventory) {
      this.stop(client, 'player inventory is not available');
      return;
    }
    const emptySlots = emptyMainInventorySlots(inventory);
    if (emptySlots.length === 0) {
      this.stop(client, 'player main inventory has no empty slot');
      return;
    }

    const choice = chooseWithdrawal(this.pendingItems, emptySlots)!;
    this.state = 'withdrawing';
    this.debugInventory(client, 'before withdrawal', inventory);
    console.log(
      `[${client.alias}] SeasonalVaultWithdraw: selected item ${choice.item.itemType} from ` +
        `${choice.item.section} object ${choice.item.objectId} slot ${choice.item.slotId}; ` +
        `walking to its chest and moving it to inventory slot ${choice.inventorySlot}`,
    );

    const destination = client.getContainerSlot('inventory', choice.inventorySlot);
    const accepted = !!destination && client.swapSlots(
      SlotObjectData.from(choice.item.objectId, choice.item.slotId, choice.item.itemType),
      destination,
    );
    if (!accepted) {
      this.stop(client, `could not walk to storage object ${choice.item.objectId} for INVSWAP`);
      return;
    }

    const confirmed = await this.waitForInventoryItem(
      client,
      choice.inventorySlot,
      choice.item.itemType,
      runtime,
    );
    if (this.stopped) {
      return;
    }
    console.log(
      `[${client.alias}] SeasonalVaultWithdraw: ` +
        (confirmed ? 'INVSWAP confirmed by inventory state' : 'INVSWAP confirmation timed out; continuing'),
    );
    this.debugInventory(client, 'before ESCAPE', client.getInventory() ?? []);
    console.log(`[${client.alias}] SeasonalVaultWithdraw: sending ESCAPE`);
    this.state = 'escaping';
    client.escape();
  }

  onUnload(): void {
    this.stopped = true;
  }

  status(): { state: State; mapName: string; candidates: number } {
    return { state: this.state, mapName: this.mapName, candidates: this.pendingItems.length };
  }

  private observeSeasonalStatus(client: Client): void {
    if (this.state !== 'waitingForSeasonalStatus') {
      return;
    }
    const seasonal = client.isSeasonal();
    if (seasonal === undefined) {
      return;
    }
    if (!seasonal) {
      this.stop(client, 'character is not seasonal');
      return;
    }

    console.log(`[${client.alias}] SeasonalVaultWithdraw: seasonal character detected`);
    if (this.mapName === 'Nexus') {
      this.enterVault(client);
    } else if (/vault/i.test(this.mapName)) {
      this.state = 'awaitingVaultContents';
    } else {
      this.state = 'routingToNexus';
      console.log(`[${client.alias}] SeasonalVaultWithdraw: returning to Nexus before entering the vault`);
      client.escape();
    }
  }

  private enterVault(client: Client): void {
    this.state = 'enteringVault';
    this.pendingItems = [];
    console.log(`[${client.alias}] SeasonalVaultWithdraw: entering the vault`);
    client.enterVault();
  }

  private async waitForInventoryItem(
    client: Client,
    slotId: number,
    itemType: number,
    runtime: PluginRuntime,
  ): Promise<boolean> {
    return runtime.waitUntil(
      () => !this.stopped && client.getContainerSlot('inventory', slotId)?.objectType === itemType,
      SWAP_SETTLE_TIMEOUT_MS,
    );
  }

  private debugInventory(client: Client, stage: string, inventory: number[]): void {
    console.log(`[${client.alias}] SeasonalVaultWithdraw DEBUG inventory ${stage}: ${JSON.stringify(inventory)}`);
  }

  private stop(client: Client, reason: string): void {
    this.state = 'done';
    this.stopped = true;
    console.log(`[${client.alias}] SeasonalVaultWithdraw: ${reason}; stopping`);
  }
}

function countItems(items: number[]): number {
  return items.filter((item) => item !== -1).length;
}
