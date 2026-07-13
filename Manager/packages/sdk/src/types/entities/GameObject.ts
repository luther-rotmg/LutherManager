import { Position } from '../world/Position';

/**
 * Base type for all game objects in RotMG.
 * Everything in the world (enemies, portals, walls, players, containers)
 * is a GameObject with a type and instance ID.
 */
export interface GameObject {
    /** Non-instanced type ID — identifies what kind of object this is */
    objectType: number;
    /** Instanced ID — unique to this specific object in the current map */
    objectId: number;
    /** Display name of this object */
    name: string;
    /** World position */
    position: Position;
}
