import { MapTile } from '../../types/world/MapTile';
import type { TileCondition } from '../../types/world/TileCondition';

export class Tiles {
    static getAll(filter?: TileCondition | string): MapTile[] {
        throw new Error('Must be run inside Hive client');
    }

    static getNearby(filter: TileCondition | string): MapTile[];
    static getNearby(radius: number, filter?: TileCondition | string): MapTile[];
    static getNearby(radiusOrFilter?: number | TileCondition | string, filter?: TileCondition | string): MapTile[] {
        throw new Error('Must be run inside Hive client');
    }

    static getByType(tileType: number): MapTile[] {
        throw new Error('Must be run inside Hive client');
    }

    static getAt(x: number, y: number): MapTile | null {
        throw new Error('Must be run inside Hive client');
    }

    static isBlocking(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isSafe(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
