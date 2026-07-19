import { Enemy } from '../types/entities/Enemy';
import { Position } from '../types/world/Position';

/**
 * Combat-targetable enemies on the current map (`Luther.enemies`).
 *
 * This is the typed combat view of world objects. Object types that merely carry
 * an `<Enemy>` game-data tag but are permanently invincible, such as invisible
 * controllers and realm spawners, are intentionally excluded. Use
 * `Luther.world.objects.getByCategory('Enemy')` when inspecting that raw category.
 */
export class Enemies {
    /** Every combat-targetable enemy currently tracked on the map. */
    static getAll(): Enemy[] {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Combat-targetable enemy closest to the player, or `null`. */
    static getNearest(): Enemy | null {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Combat-targetable enemy closest to `position`, or `null`. */
    static getNearestTo(position: Position): Enemy | null {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Closest currently tracked enemy marked as a boss, or `null`. */
    static getBoss(): Enemy | null {
        throw new Error('Must be run inside LutherManager client');
    }

    /** First enemy whose display name contains `name`, case-insensitively. */
    static find(name: string): Enemy | null {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Number of combat-targetable enemies currently tracked on the map. */
    static count(): number {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Enemy by runtime `objectId`, or `null` if it is not targetable or visible. */
    static getById(objectId: number): Enemy | null {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Every combat-targetable enemy with the given game-data `objectType`. */
    static getByType(objectType: number): Enemy[] {
        throw new Error('Must be run inside LutherManager client');
    }
}
