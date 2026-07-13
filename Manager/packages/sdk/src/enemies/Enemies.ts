import { Enemy } from '../types/entities/Enemy';
import { Position } from '../types/world/Position';

export class Enemies {
    static getAll(): Enemy[] {
        throw new Error('Must be run inside Hive client');
    }

    static getNearest(): Enemy | null {
        throw new Error('Must be run inside Hive client');
    }

    static getNearestTo(position: Position): Enemy | null {
        throw new Error('Must be run inside Hive client');
    }

    static getBoss(): Enemy | null {
        throw new Error('Must be run inside Hive client');
    }

    static getTargetingMe(): Enemy[] {
        throw new Error('Must be run inside Hive client');
    }

    static find(name: string): Enemy | null {
        throw new Error('Must be run inside Hive client');
    }

    static count(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getById(objectId: number): Enemy | null {
        throw new Error('Must be run inside Hive client');
    }

    static getByType(objectType: number): Enemy[] {
        throw new Error('Must be run inside Hive client');
    }
}
