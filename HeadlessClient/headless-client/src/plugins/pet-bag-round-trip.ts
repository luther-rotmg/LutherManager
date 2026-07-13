import { SlotObjectData } from 'realmlib';
import { Client, MAIN_INVENTORY_SLOT_IDS } from '../client';
import { PluginRuntime } from '../plugin-runtime';
import { Plugin } from './decorators';

const DEFAULT_TIMEOUT_MS = 5000;

export interface PetBagTripResult {
  itemType: number;
  inventorySlot: number;
  petBagSlot: number;
  outwardMs: number;
  outwardOk: boolean;
  returnMs: number;
  returnOk: boolean;
}

/** Reversibly exercises the real PET_INSTANCEID-backed pet-bag container. */
@Plugin({
  name: 'PetBagRoundTrip',
  description: 'Round-trips main-inventory items through the real pet bag and reports INVRESULT-backed timings.',
  author: 'realmlib',
  version: '2.0.0',
})
export class PetBagRoundTrip {
  private running = false;
  private runtime: PluginRuntime | undefined;

  onLoad(_client: Client, runtime: PluginRuntime): void {
    this.runtime = runtime;
  }

  /** Moves each current main-inventory item into one empty pet slot and immediately restores it. */
  async run(client: Client, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<PetBagTripResult[]> {
    if (this.running) {
      console.log(`[${client.alias}] PetBagRoundTrip: already running`);
      return [];
    }
    if (!this.runtime || this.runtime.isDisposed) {
      console.warn(`[${client.alias}] PetBagRoundTrip: plugin runtime is unavailable`);
      return [];
    }
    if (!client.hasPetBag()) {
      console.warn(`[${client.alias}] PetBagRoundTrip: PET_INSTANCEID/PET_OBJECT_ID is not known`);
      return [];
    }

    const items = MAIN_INVENTORY_SLOT_IDS
      .map((slotId) => client.getInventorySlot(slotId))
      .filter((slot): slot is SlotObjectData => slot !== null);
    if (items.length === 0) {
      console.log(`[${client.alias}] PetBagRoundTrip: no main-inventory items to test`);
      return [];
    }
    if (!client.getPetBagSlot()) {
      console.warn(
        `[${client.alias}] PetBagRoundTrip: no known empty pet-bag slot; ` +
          `the active pet must expose its bag inventory stats`,
      );
      return [];
    }

    this.running = true;
    const results: PetBagTripResult[] = [];
    console.log(
      `[${client.alias}] PetBagRoundTrip: testing ${items.length} item(s) with pet container ` +
        `${client.getPetBagContainerId()}`,
    );
    try {
      for (const original of items) {
        const inventorySlot = client.getInventorySlot(original.slotId);
        const petBagSlot = client.getPetBagSlot();
        if (!inventorySlot || !petBagSlot) {
          console.warn(`[${client.alias}] PetBagRoundTrip: source item or empty pet slot is no longer available`);
          break;
        }

        const result: PetBagTripResult = {
          itemType: inventorySlot.objectType,
          inventorySlot: inventorySlot.slotId,
          petBagSlot: petBagSlot.slotId,
          outwardMs: -1,
          outwardOk: false,
          returnMs: -1,
          returnOk: false,
        };
        results.push(result);

        let started = Date.now();
        const sentOut = client.swapInventoryWithPetBag(inventorySlot, petBagSlot);
        result.outwardOk = sentOut && await this.runtime.waitUntil(
          () => this.slotHas(client, 'petBag', petBagSlot.slotId, result.itemType) &&
            this.slotHas(client, 'inventory', inventorySlot.slotId, -1),
          timeoutMs,
        );
        result.outwardMs = Date.now() - started;
        if (!result.outwardOk) {
          this.logFailure(client, 'inventory→pet', result);
          continue;
        }

        const filledPetSlot = client.getContainerSlot('petBag', petBagSlot.slotId);
        const emptyInventorySlot = client.getContainerSlot('inventory', inventorySlot.slotId);
        if (!filledPetSlot || !emptyInventorySlot) {
          this.logFailure(client, 'pet→inventory state refresh', result);
          continue;
        }

        started = Date.now();
        const sentBack = client.swapInventoryWithPetBag(emptyInventorySlot, filledPetSlot);
        result.returnOk = sentBack && await this.runtime.waitUntil(
          () => this.slotHas(client, 'inventory', inventorySlot.slotId, result.itemType) &&
            this.slotHas(client, 'petBag', petBagSlot.slotId, -1),
          timeoutMs,
        );
        result.returnMs = Date.now() - started;
        if (!result.returnOk) {
          this.logFailure(client, 'pet→inventory', result);
        }
      }
    } finally {
      this.running = false;
    }

    const clean = results.filter((result) => result.outwardOk && result.returnOk);
    console.table(results);
    console.log(
      `[${client.alias}] PetBagRoundTrip: ${clean.length}/${results.length} clean round-trip(s)` +
        (clean.length === results.length ? '; inventory restored' : '; inspect INVRESULT logs before retrying'),
    );
    return results;
  }

  private slotHas(client: Client, container: 'inventory' | 'petBag', slotId: number, itemType: number): boolean {
    return client.getContainerSlot(container, slotId)?.objectType === itemType;
  }

  private logFailure(client: Client, leg: string, result: PetBagTripResult): void {
    const inv = client.getContainerSlot('inventory', result.inventorySlot)?.objectType;
    const pet = client.getContainerSlot('petBag', result.petBagSlot)?.objectType;
    console.warn(
      `[${client.alias}] PetBagRoundTrip: ${leg} failed for item ${result.itemType}; ` +
        `inventory[${result.inventorySlot}]=${inv ?? 'unknown'}, petBag[${result.petBagSlot}]=${pet ?? 'unknown'}`,
    );
  }
}
