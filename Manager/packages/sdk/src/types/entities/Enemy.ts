import { GameObject } from './GameObject';
import { Stats } from './Stats';

export interface Enemy extends GameObject {
    hp: number;
    maxHp: number;
    defense: number;
    stats: Stats;
    phase: number;
    isEnraged: boolean;
    isBoss: boolean;
}
