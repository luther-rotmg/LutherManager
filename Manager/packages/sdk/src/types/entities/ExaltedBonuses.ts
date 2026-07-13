/**
 * Exaltation-only bonuses from player status wire ids 105–112.
 * These are the slices subtracted from combined boosts (46–53) to get gear-only bonuses.
 */
export interface ExaltedBonuses {
    maxHP: number;
    maxMP: number;
    attack: number;
    defense: number;
    speed: number;
    dexterity: number;
    vitality: number;
    wisdom: number;
}
