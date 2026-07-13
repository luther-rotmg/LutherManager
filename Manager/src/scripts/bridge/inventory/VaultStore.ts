import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { BridgeDeps } from '../BridgeDeps.js';
import { GameId } from '../../../constants/GameId.js';
import { Logger } from '../../../util/Logger.js';

/** Stable RotMG objectType for the main vault chest. */
export const VAULT_CHEST_OBJECT_TYPE = 1284;

/** One chest's live objectId and its current item slots. */
export interface ChestDb {
  /** Live objectId — reissued each vault visit; -1 = not yet seen. */
  objectId: number;
  /** Item type ids per slot; -1 = empty. */
  contents: number[];
}

/** Full state from the last VAULTCONTENT packet, patched live by INVRESULT. */
export interface VaultContentState {
  capturedAt: number;
  lastVaultUpdate: boolean;
  vault: ChestDb;
  material: ChestDb;
  gift: ChestDb;
  potion: ChestDb;
  seasonalSpoils: ChestDb;
  vaultUpgradeCost: number;
  materialUpgradeCost: number;
  seasonalSpoilUpgradeCost: number;
  potionUpgradeCost: number;
  currentPotionMax: number;
  nextPotionMax: number;
  vaultChestEnchants: string;
  giftChestEnchants: string;
  spoilsChestEnchants: string;
}

const stores = new WeakMap<ClientConnection, VaultContentState>();
let hooksInstalled = false;

function emptyChest(objectId = -1): ChestDb {
  return { objectId, contents: [] };
}

function toIntArr(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => {
    const n = Math.trunc(Number(x));
    return Number.isFinite(n) ? n : -1;
  });
}

function toInt(raw: unknown, fallback = 0): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

/** Return the cached vault state for this client, or null if never entered vault. */
export function getVaultStore(c: ClientConnection): VaultContentState | null {
  return stores.get(c) ?? null;
}

/** Patch a single chest slot after an INVRESULT-confirmed swap. */
function patchChest(chest: ChestDb, slotId: number, newType: number): void {
  if (slotId < 0) return;
  // Grow array if needed
  while (chest.contents.length <= slotId) chest.contents.push(-1);
  chest.contents[slotId] = newType < 0 ? -1 : newType;
}

export function installVaultStoreHooks(deps: BridgeDeps): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  // ── VAULTCONTENT: full snapshot on every vault entry ──────────────────────
  deps.proxy.hookPacket('VAULTCONTENT', (client, packet) => {
    if (!packet.isDefined || !packet.data) return;
    const d = packet.data as Record<string, unknown>;

    const state: VaultContentState = {
      capturedAt: Date.now(),
      lastVaultUpdate: Boolean(d.lastVaultUpdate),
      vault: {
        objectId: toInt(d.vaultChestObjectId, -1),
        contents: toIntArr(d.vaultContents),
      },
      material: {
        objectId: toInt(d.materialChestObjectId, -1),
        contents: toIntArr(d.materialContents),
      },
      gift: {
        objectId: toInt(d.giftChestObjectId, -1),
        contents: toIntArr(d.giftContents),
      },
      potion: {
        objectId: toInt(d.potionStorageObjectId, -1),
        contents: toIntArr(d.potionContents),
      },
      seasonalSpoils: {
        objectId: toInt(d.seasonalSpoilChestObjectId, -1),
        contents: toIntArr(d.seasonalSpoilContent),
      },
      vaultUpgradeCost:    toInt(d.vaultUpgradeCost),
      materialUpgradeCost: toInt(d.materialUpgradeCost),
      seasonalSpoilUpgradeCost: toInt(d.seasonalSpoilUpgradeCost),
      potionUpgradeCost:   toInt(d.potionUpgradeCost),
      currentPotionMax:    toInt(d.currentPotionMax),
      nextPotionMax:       toInt(d.nextPotionMax),
      vaultChestEnchants:  String(d.vaultChestEnchants  ?? ''),
      giftChestEnchants:   String(d.giftChestEnchants   ?? ''),
      spoilsChestEnchants: String(d.spoilsChestEnchants ?? ''),
    };

    // Keep PlayerData.vaultChestObjectId in sync for vaultTransfer.ts
    client.playerData.vaultChestObjectId = state.vault.objectId;
    // Clear old cached content array on PlayerData (we own the source of truth now)
    client.playerData.vaultContent = [];

    stores.set(client, state);
    Logger.log(
      'VaultStore',
      `VAULTCONTENT: vault oid=${state.vault.objectId} slots=${state.vault.contents.length} ` +
      `material oid=${state.material.objectId} gift oid=${state.gift.objectId} ` +
      `potion oid=${state.potion.objectId}`,
    );
  });

  // ── INVRESULT: patch the affected chest when a swap completes ─────────────
  // INVRESULT fields: fromSlot { objectId, slotId, objectType }, toSlot { … }
  // Semantics: fromSlot had the item BEFORE the swap; after the swap it contains toSlot.objectType.
  //            toSlot had the item BEFORE the swap; after the swap it contains fromSlot.objectType.
  deps.proxy.hookPacket('INVRESULT', (client, packet) => {
    if (!packet.isDefined || !packet.data) return;
    if ((client.state?.gameId ?? -999) !== GameId.Vault) return;
    const state = stores.get(client);
    if (!state) return;

    const from = packet.data.fromSlot as { objectId: number; slotId: number; objectType: number } | undefined;
    const to   = packet.data.toSlot   as { objectId: number; slotId: number; objectType: number } | undefined;
    if (!from || !to) return;

    const fromOid  = toInt(from.objectId, -1);
    const toOid    = toInt(to.objectId, -1);
    const fromSlot = toInt(from.slotId, -1);
    const toSlot   = toInt(to.slotId, -1);
    const fromType = toInt(from.objectType, -1);
    const toType   = toInt(to.objectType, -1);

    const allChests: ChestDb[] = [
      state.vault,
      state.material,
      state.gift,
      state.potion,
      state.seasonalSpoils,
    ];

    for (const chest of allChests) {
      if (chest.objectId <= 0) continue;
      if (fromOid === chest.objectId) {
        // Item left this chest; slot now holds what was in the destination
        patchChest(chest, fromSlot, toType);
      }
      if (toOid === chest.objectId) {
        // Item arrived at this chest; slot now holds what was in the source
        patchChest(chest, toSlot, fromType);
      }
    }
  });

  // ── MAPINFO: entering a new map clears vault state ────────────────────────
  deps.proxy.hookPacket('MAPINFO', (client) => {
    if (stores.has(client)) {
      stores.delete(client);
      client.playerData.vaultChestObjectId = -1;
    }
  });
}
