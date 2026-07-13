import { Position } from '../types/world/Position';
import { Enemy } from '../types/entities/Enemy';

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
     * blocking ground and objects are routed around.
     */
    static pathfindingWalkTo(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToPosition(position: Position): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToEnemy(enemy: Enemy): boolean {
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

    static teleportToBeacon(objectId: number): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
