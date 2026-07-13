import { GameObject } from './GameObject';
import { Stats } from './Stats';

export interface PlayerEntity extends GameObject {
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    stats: Stats;
    className: string;
}
