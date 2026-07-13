/**
 * Gear-only stat bonuses: combined wire boosts (46–53) minus exalt slices (105–112).
 * Same shape as totals’ bonus breakdown in the client UI.
 */
export interface GearBonuses {
    maxHP: number;
    maxMP: number;
    attack: number;
    defense: number;
    speed: number;
    dexterity: number;
    vitality: number;
    wisdom: number;
}
