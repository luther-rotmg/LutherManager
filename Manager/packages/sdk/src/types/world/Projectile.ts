import { Position } from './Position';

export interface Projectile {
    id: number;
    damage: number;
    speed: number;
    piercing: boolean;
    position: Position;
    angle: number;
    ownerId: number;
}
