import { Position } from '../types/world/Position';
import { Enemy } from '../types/entities/Enemy';

export interface AutoDodgeOptions {
    /** Avoid tiles that deal ground damage. Defaults to true. */
    safeWalk?: boolean;
}

export interface AutoDodgeState {
    enabled: boolean;
    overrideActive: boolean;
    velocity: { x: number; y: number };
    target: { x: number; y: number } | null;
    threatCount: number;
    earliestImpactMs: number | null;
    selectedCandidate: number;
    speedScale: number;
    decision: string;
}

/**
 * A Realm teleport-beacon destination. Canonical region names and common
 * short aliases are suggested while future game destinations remain valid.
 */
export type TeleportBeaconDestination =
    | 'shore'
    | 'beach'
    | 'forest'
    | 'undead forest'
    | 'undead'
    | 'desert'
    | 'plains'
    | 'coral reefs'
    | 'coral'
    | 'dead church'
    | 'church'
    | 'haunted hallows'
    | 'haunted'
    | 'shipwreck cove'
    | 'shipwreck'
    | 'sprite forest'
    | 'sprite'
    | 'deep sea abyss'
    | 'deepsea'
    | 'floral escape'
    | 'floral'
    | 'sanguine forest'
    | 'sanguine'
    | 'runic tundra'
    | 'runic'
    | (string & {});

export class Walking {
    /**
     * Walk directly toward a tile without pathfinding. Pass world **X** and **Y** as two separate numbers
     * (same units as engine/player world coordinates, e.g. from `Hive.self.getX()` / `getY()`).
     */
    static walkTo(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Pathfind toward a tile. Unknown map space remains traversable while observed
     * blocking ground and objects are routed around. `arriveThreshold` stops the
     * route once the player is within that many tiles of the destination.
     */
    static pathfindingWalkTo(x: number, y: number, arriveThreshold?: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToPosition(position: Position): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Walk directly toward the nearest visible combat enemy. */
    static walkToEnemy(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Pathfind to within 1.3 tiles of the nearest visible combat enemy. */
    static pathfindingWalkToEnemy(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToPortal(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToNearestPortal(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static enterPortal(objectId: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static enterVault(): void { throw new Error('Must be run inside Hive client'); }
    static enterPetYard(): void { throw new Error('Must be run inside Hive client'); }
    static enterGuildHall(): void { throw new Error('Must be run inside Hive client'); }
    static enterDailyQuestRoom(): void { throw new Error('Must be run inside Hive client'); }

    static walkToNexusPortal(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToLeftWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToRightWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToTopWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToBottomWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static followPlayer(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static stopMoving(): void {
        throw new Error('Must be run inside Hive client');
    }

    static isMoving(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static hasReached(position: Position, tolerance?: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static nexus(): void {
        throw new Error('Must be run inside Hive client');
    }

    /** Enable predictive projectile and thrown-AOE dodging without clearing the current walk target. */
    static enableAutoDodge(options?: AutoDodgeOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static disableAutoDodge(): void {
        throw new Error('Must be run inside Hive client');
    }

    static isAutoDodgeEnabled(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getAutoDodgeState(): AutoDodgeState | null {
        throw new Error('Must be run inside Hive client');
    }

    static getDodgePosition(): Position | null {
        throw new Error('Must be run inside Hive client');
    }

    static dodge(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static dodgeFrom(enemy: Enemy): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static canTeleport(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static teleportToPlayer(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Teleport to the nearest live teleport beacon matching a region name or alias. */
    static teleportBeacon(destination: TeleportBeaconDestination): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Teleport to a currently tracked teleport beacon by runtime object ID. */
    static teleportToBeacon(objectId: number): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
