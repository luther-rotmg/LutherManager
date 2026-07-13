import { Self } from './self/Self';
import { Walking } from './walking/Walking';
import { Combat } from './combat/Combat';
import { Players } from './players/Players';
import { Enemies } from './enemies/Enemies';
import { inventory } from './inventory';
import { Vault } from './vault/Vault';
import { World } from './world/World';
import { Tiles } from './world/tiles/Tiles';
import { Objects } from './world/objects/Objects';
import { Projectiles } from './world/projectiles/Projectiles';
import { Log } from './log/Log';
import { Settings } from './settings/Settings';
import { Timing } from './timing/Timing';
import { chat } from './chat';
import { party } from './party';
import { trade } from './trade';
import { events } from './events';
import { loot } from './loot';
import { discord } from './discord';
import { panel } from './ui/Panel';
import { connection } from './connection';
import { character } from './character';
import { AutoNexus } from './autoNexus/AutoNexus';

export const Hive = {
    self: Self,
    walking: Walking,
    combat: Combat,
    players: Players,
    enemies: Enemies,
    inventory,
    /** @deprecated Use the vault storage and transfer methods on `Hive.inventory`. */
    vault: Vault,
    connection,
    character,
    autoNexus: AutoNexus,
    world: {
        isNexus: World.isNexus,
        isRealm: World.isRealm,
        isDungeon: World.isDungeon,
        isVault: World.isVault,
        isPetYard: World.isPetYard,
        getName: World.getName,
        getServerHost: World.getServerHost,
        getRealmPortals: World.getRealmPortals,
        getVisibleObjects: World.getVisibleObjects,
        getVisibleTiles: World.getVisibleTiles,
        getTile: World.getTile,
        getObject: World.getObject,
        getNearestObject: World.getNearestObject,
        tiles: Tiles,
        objects: Objects,
        projectiles: Projectiles,
    },
    log: Log,
    settings: Settings,
    timing: Timing,
    chat,
    party,
    trade,
    events,
    loot,
    discord,
    /**
     * User-facing dashboard status (wired in Hive host).
     * @example Hive.ui.status('Killing Gods');
     */
    ui: {
        status(_label: string | null | undefined): void {
            throw new Error('Must be run inside Hive client');
        },
        /** Same as `status` — clears when label is null/blank after trim. */
        setStatus(_label: string | null | undefined): void {
            throw new Error('Must be run inside Hive client');
        },
        /**
         * Declarative popout panel for this script. Define widgets once; the
         * dashboard renders them in a centered modal and forwards events back.
         * See `@hive/sdk` `Panel` for widget factories.
         */
        panel,
    },
};
