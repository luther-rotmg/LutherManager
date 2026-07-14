import { Position } from '../types/world/Position';
import { Stats } from '../types/entities/Stats';
import { ExaltedBonuses } from '../types/entities/ExaltedBonuses';
import { GearBonuses } from '../types/entities/GearBonuses';
import { StatusEffect } from '../types/entities/StatusEffect';
import { Item } from '../types/items/Item';
import { Pet } from './Pet';

export class Self {
    static pet = Pet;

    static getObjectId(): number {
        throw new Error('Must be run inside Hive client');
    }

    static isSeasonal(): boolean | undefined {
        throw new Error('Must be run inside Hive client');
    }

    static getX(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getY(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getPosition(): Position {
        throw new Error('Must be run inside Hive client');
    }

    static distanceTo(other: Position): number {
        throw new Error('Must be run inside Hive client');
    }

    static getHP(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getMaxHP(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getHPPercent(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getMP(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getMaxMP(): number {
        throw new Error('Must be run inside Hive client');
    }

    static getMPPercent(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Current character level reported by the active player state. */
    static getLevel(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Final stats after gear and exaltation bonuses. */
    static getStats(): Stats {
        throw new Error('Must be run inside Hive client');
    }

    /** Base stats before gear and exaltation bonuses. */
    static getBaseStats(): Stats {
        throw new Error('Must be run inside Hive client');
    }

    /** Natural 8/8 stat caps for the active class, before gear and exaltation bonuses. */
    static getStatCaps(): Stats {
        throw new Error('Must be run inside Hive client');
    }

    /** Stats after gear bonuses but before exaltation bonuses. */
    static getStatsWithGear(): Stats {
        throw new Error('Must be run inside Hive client');
    }

    /** Base max HP before gear and exaltation bonuses. */
    static getBaseMaxHP(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Max HP after gear bonuses but before exaltation bonuses. */
    static getMaxHPWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base max MP before gear and exaltation bonuses. */
    static getBaseMaxMP(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Max MP after gear bonuses but before exaltation bonuses. */
    static getMaxMPWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base attack before gear and exaltation bonuses. */
    static getBaseAtk(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Attack after gear bonuses but before exaltation bonuses. */
    static getAtkWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base defense before gear and exaltation bonuses. */
    static getBaseDef(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Defense after gear bonuses but before exaltation bonuses. */
    static getDefWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base speed before gear and exaltation bonuses. */
    static getBaseSpd(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Speed after gear bonuses but before exaltation bonuses. */
    static getSpdWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base dexterity before gear and exaltation bonuses. */
    static getBaseDex(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Dexterity after gear bonuses but before exaltation bonuses. */
    static getDexWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base vitality before gear and exaltation bonuses. */
    static getBaseVit(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Vitality after gear bonuses but before exaltation bonuses. */
    static getVitWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Base wisdom before gear and exaltation bonuses. */
    static getBaseWis(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Wisdom after gear bonuses but before exaltation bonuses. */
    static getWisWithGear(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** All eight exaltation-only bonuses (wire 105–112). */
    static getExaltedBonuses(): ExaltedBonuses {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only max HP bonus (wire 111). */
    static getExaltedMaxHP(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only max MP bonus (wire 112). */
    static getExaltedMaxMP(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only attack bonus (wire 105). */
    static getExaltedAtk(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only defense bonus (wire 106). */
    static getExaltedDef(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only speed bonus (wire 107). */
    static getExaltedSpd(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only dexterity bonus (wire 109). */
    static getExaltedDex(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only vitality bonus (wire 108). */
    static getExaltedVit(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Exaltation-only wisdom bonus (wire 110). */
    static getExaltedWis(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** All eight gear-only bonuses (combined 46–53 minus exalt 105–112). */
    static getGearBonuses(): GearBonuses {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only max HP bonus (HpBoost 46 minus exalt max HP 111). */
    static getGearMaxHP(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only max MP bonus (MpBoost 47 minus exalt max MP 112). */
    static getGearMaxMP(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only attack bonus (48 minus 105). */
    static getGearAtk(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only defense bonus (49 minus 106). */
    static getGearDef(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only speed bonus (50 minus 107). */
    static getGearSpd(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only dexterity bonus (53 minus 109). */
    static getGearDex(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only vitality bonus (51 minus 108). */
    static getGearVit(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Gear-only wisdom bonus (52 minus 110). */
    static getGearWis(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Total attack (base + gear + exalt). Same as `getStats().attack`. */
    static getAtk(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Total defense. Same as `getStats().defense`. */
    static getDef(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Total speed. Same as `getStats().speed`. */
    static getSpd(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Total dexterity. Same as `getStats().dexterity`. */
    static getDex(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Total vitality. Same as `getStats().vitality`. */
    static getVit(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Total wisdom. Same as `getStats().wisdom`. */
    static getWis(): number {
        throw new Error('Must be run inside Hive client');
    }

    static hasEffect(effect: StatusEffect): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getEffects(): StatusEffect[] {
        throw new Error('Must be run inside Hive client');
    }

    static getWeapon(): Item | null {
        throw new Error('Must be run inside Hive client');
    }

    static getAbility(): Item | null {
        throw new Error('Must be run inside Hive client');
    }

    static getArmor(): Item | null {
        throw new Error('Must be run inside Hive client');
    }

    static getRing(): Item | null {
        throw new Error('Must be run inside Hive client');
    }

    /** Whether the current class can equip an item in one of its four gear slots. */
    static canEquip(objectType: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getName(): string {
        throw new Error('Must be run inside Hive client');
    }

    static getClass(): string {
        throw new Error('Must be run inside Hive client');
    }

    static isDead(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isInCombat(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isInvisible(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Account `CurrentFame` from player stat **39** (not per-character alive fame). */
    static getAccountFame(): number {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Fame for the current character while alive (player stat type **57**).
     * Not the same as `getAccountFame()` (stat 39).
     */
    static getCharacterFame(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Power level from player stat **124**. */
    static getPowerLevel(): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Account star count from player stat **30**. */
    static getStars(): number {
        throw new Error('Must be run inside Hive client');
    }
}
