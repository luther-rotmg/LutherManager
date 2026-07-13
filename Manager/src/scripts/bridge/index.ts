import { BridgeSelf } from './self/Self.js';
import { BridgeWalking } from './walking/Walking.js';
import { BridgeCombat } from './combat/Combat.js';
import { BridgePlayers } from './players/Players.js';
import { BridgeEnemies } from './enemies/Enemies.js';
import { BridgeInventory } from './inventory/Inventory.js';
import { BridgeVault } from './vault/Vault.js';
import { BridgeVaultChest } from './vault/VaultChest.js';
import { BridgeGiftChest } from './vault/GiftChest.js';
import { BridgeWorld } from './world/World.js';
import { BridgeTiles } from './world/tiles/Tiles.js';
import { BridgeObjects } from './world/objects/Objects.js';
import { BridgeProjectiles } from './world/projectiles/Projectiles.js';
import { BridgeLog } from './log/Log.js';
import { BridgeSettings } from './settings/Settings.js';
import { BridgeTiming } from './timing/Timing.js';
import { BridgeAutoNexus } from './autoNexus/AutoNexus.js';
import { install as installChat } from './chat/index.js';
import { install as installParty } from './party/index.js';
import { install as installTrade } from './trade/index.js';
import { install as installEvents } from './events/index.js';
import { install as installInventoryNs } from './inventory/index.js';
import { install as installLoot } from './loot/index.js';
import { install as installDiscord } from './discord/index.js';
import { install as installGuild } from './guild/index.js';
import { installScriptUiBridge } from './scriptUi/ScriptUi.js';
import { installHeadlessBridge } from './headless/HeadlessBridge.js';
import type { ScriptPanelRegistry } from './scriptUi/ScriptPanels.js';
import type { BridgeDeps } from './BridgeDeps.js';
import {
  chat, party, trade, events, inventory, guild, GuildRank, connection, character, Pet,
  INVENTORY_MAIN_SLOT_COUNT, INVENTORY_BACKPACK_SLOT_COUNT, INVENTORY_TOTAL_SLOT_COUNT,
  loot, discord, DiscordWebhook,
  Self, Walking, Combat, Players, Enemies, Inventory, Vault, World, Tiles, Objects, Projectiles,
  Log, Settings, Timing, AutoNexus, Hive, Position, StatusEffect, Panel, uiPanel,
  TreeScript, Root, Branch, Leaf, leaf, branch, when, not, always, cooldown, once, sequence, parallel,
} from '@hive/sdk';

export type { BridgeDeps, ScriptLogLevel } from './BridgeDeps.js';
export type { ScriptPanelRegistry } from './scriptUi/ScriptPanels.js';

export class SDKBridge {
  static panelRegistry: ScriptPanelRegistry | undefined;

  static install(deps: BridgeDeps): void {
    BridgeVaultChest.install(deps);
    BridgeGiftChest.install(deps);
    BridgeVault.install(deps);

    BridgeSelf.install(deps);
    BridgeWalking.install(deps);
    BridgeCombat.install(deps);
    BridgePlayers.install(deps);
    BridgeEnemies.install(deps);
    BridgeInventory.install(deps);
    BridgeWorld.install(deps);
    BridgeTiles.install(deps);
    BridgeObjects.install(deps);
    BridgeProjectiles.install(deps);
    BridgeLog.install(deps);
    BridgeSettings.install(deps);
    BridgeTiming.install(deps);
    BridgeAutoNexus.install(deps);
    installChat(deps);
    installParty(deps);
    installTrade(deps);
    installEvents(deps);
    installInventoryNs(deps);
    installLoot(deps);
    installDiscord(deps);
    installGuild(deps);
    installHeadlessBridge(deps);

    // Expose all patched SDK exports via globalThis so user scripts importing
    // @hive/sdk from the deployed Documents stub get the live patched objects.
    (globalThis as any).__hiveSDK = {
      chat, party, trade, events, inventory, connection, character,
      INVENTORY_MAIN_SLOT_COUNT, INVENTORY_BACKPACK_SLOT_COUNT, INVENTORY_TOTAL_SLOT_COUNT,
      loot, discord, DiscordWebhook, guild, GuildRank,
      Self, Pet, Walking, Combat, Players, Enemies, Inventory, Vault, World, Tiles, Objects, Projectiles,
      Log, Settings, Timing, AutoNexus, Hive, Position, StatusEffect, Panel, uiPanel,
      TreeScript, Root, Branch, Leaf, leaf, branch, when, not, always, cooldown, once, sequence, parallel,
    };

    SDKBridge.panelRegistry = installScriptUiBridge(deps);
  }
}
