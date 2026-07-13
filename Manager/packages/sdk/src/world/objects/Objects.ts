import { GameObject } from '../../types/entities/GameObject';
import { Enemy } from '../../types/entities/Enemy';
import { PlayerEntity } from '../../types/entities/PlayerEntity';
import { Container } from '../../types/entities/Container';
import { Portal } from '../../types/world/Portal';
import { Position } from '../../types/world/Position';
import { ObjectCategory } from '../../types/world/ObjectCategory';

/**
 * Everything standing on the current map (`Hive.world.objects`).
 *
 * This is the **generic** view of tracked map entities: enemies, portals,
 * players, containers, pets, beacons, props, and controllers. Projectiles are
 * exposed separately through `Hive.world.projectiles`.
 *
 * Prefer `Hive.enemies` or `Hive.players` when you already know what you're
 * looking for. Category convenience methods such as {@link getPortals} return
 * richer typed entities where the SDK has a specialized shape.
 */
export class Objects {
    // ─── Basic lookup ───────────────────────────────────────────────────────

    /** Every tracked object on the current map. */
    static getAll(): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Tracked object by runtime `objectId`, or `null` if it left the map. */
    static getById(objectId: number): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** All objects that share a specific non-instanced `objectType`. */
    static getByType(objectType: number): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Total number of tracked objects on the current map. */
    static count(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** `true` when `objectId` is still present on the map. */
    static exists(objectId: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    // ─── By category ────────────────────────────────────────────────────────

    /**
     * Every object whose raw game-data category matches (e.g. `'Enemy'`,
     * `'Container'`). An `'Enemy'` category query includes invincible controllers
     * and spawners; use {@link getEnemies} for combat targets.
     */
    static getByCategory(category: ObjectCategory): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * All combat-targetable enemies on the map with enemy-specific fields filled in.
     * Permanently invincible enemy-tagged controllers and spawners are excluded.
     * Compatibility convenience alias for `Hive.enemies.getAll()`.
     */
    static getEnemies(): Enemy[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Compatibility convenience alias for `Hive.players.getAll()` (includes you). */
    static getPlayers(): PlayerEntity[] {
        throw new Error('Must be run inside Hive client');
    }

    /** All portals on the map (realm portals, dungeon portals, etc.). */
    static getPortals(): Portal[] {
        throw new Error('Must be run inside Hive client');
    }

    /** All containers on the map — loot bags, vault chests, gift chests, etc. */
    static getContainers(): Container[] {
        throw new Error('Must be run inside Hive client');
    }

    /** All pet entities on the map. */
    static getPets(): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** All beacon entities on the map (guild beacons, event beacons, …). */
    static getBeacons(): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** The current quest object (beacon/boss the server is pointing you at), or `null` if none. */
    static getQuestObject(): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Live instance id from the server's QUESTOBJECTID stat (>0 during a tracked step); `-1` if none. */
    static getQuestTargetId(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** RotMG `objectType` for that instance when tracked, or inferred when exactly one `<Quest>` type is visible; `-1` if unknown. */
    static getQuestTargetType(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Alias for {@link getQuestTargetId}. */
    static getQuestId(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Alias for {@link getQuestTargetType}. */
    static getQuestType(): number {
        throw new Error('Must be run inside Hive client');
    }

    // ─── Spatial ────────────────────────────────────────────────────────────

    /** Closest object to you of any kind, or `null` if the map is empty. */
    static getNearest(): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Closest object to the given world position, or `null`. */
    static getNearestTo(position: Position): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Closest object of a specific `objectType` to you, or `null`. */
    static getNearestOfType(objectType: number): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Closest object in a given category to you, or `null`. */
    static getNearestOfCategory(category: ObjectCategory): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** All objects within `radius` tiles of you (unsorted). */
    static getWithinRadius(radius: number): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** All objects within `radius` tiles of `position` (unsorted). */
    static getWithinRadiusFrom(position: Position, radius: number): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * All objects inside an axis-aligned world rectangle, inclusive on every edge.
     * Useful for scanning a single room or a dungeon arena.
     */
    static getWithinBounds(minX: number, minY: number, maxX: number, maxY: number): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Every tracked object sorted by distance from you, nearest first. */
    static sortByDistance(): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Every tracked object sorted by distance from `position`, nearest first. */
    static sortByDistanceFrom(position: Position): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    // ─── Name lookups ───────────────────────────────────────────────────────

    /** First object whose display name contains `name`, case-insensitively. */
    static findByName(name: string): GameObject | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Every object whose display name contains `name`, case-insensitively. */
    static findAllByName(name: string): GameObject[] {
        throw new Error('Must be run inside Hive client');
    }

    // ─── Portal helpers ─────────────────────────────────────────────────────

    /** First portal whose display name contains `name`, case-insensitively. */
    static findPortal(name: string): Portal | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Closest portal to you, or `null` if the map has none. */
    static getNearestPortal(): Portal | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Every portal currently in its "open" state (walkable by players). */
    static getOpenPortals(): Portal[] {
        throw new Error('Must be run inside Hive client');
    }

    // ─── Container helpers ──────────────────────────────────────────────────

    /** Closest container to you — convenient for auto-loot logic. */
    static getNearestContainer(): Container | null {
        throw new Error('Must be run inside Hive client');
    }

    /** First container whose display name contains `name`, case-insensitively. */
    static findContainer(name: string): Container | null {
        throw new Error('Must be run inside Hive client');
    }

    // ─── Introspection (game-data lookups, no runtime required) ─────────────

    /**
     * Category bucket for an `objectType` (`'Enemy'`, `'Portal'`, `'Container'`, …),
     * or `null` when the type is not found in the loaded game data.
     */
    static getCategory(objectType: number): ObjectCategory | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Display name from game data for a given `objectType` (e.g. `'Dungeon Portal'`). */
    static getTypeName(objectType: number): string {
        throw new Error('Must be run inside Hive client');
    }

    /** Shortcut for `getCategory(objectType) === 'Enemy'`. */
    static isEnemy(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * `true` when the type is an enemy that can participate in combat targeting.
     * Unlike {@link isEnemy}, this excludes permanently invincible enemy-tagged
     * controllers and spawners.
     */
    static isCombatEnemy(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Shortcut for `getCategory(objectType) === 'Portal'`. */
    static isPortal(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Shortcut for `getCategory(objectType) === 'Container'`. */
    static isContainer(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** `true` when game data marks this type as a boss (quest flag or high maxHp). */
    static isBoss(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    // ─── Presence checks ────────────────────────────────────────────────────

    /** `true` when at least one object of `objectType` is on the map. */
    static hasType(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
