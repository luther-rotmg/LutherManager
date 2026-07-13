/**
 * Damage calculation for RotMG.
 * Formula from KRelayBetter's AutoNexus.cs:
 *   effectiveDef = armored ? def*2 : (piercing || armorBroken) ? 0 : def
 *   damage = max(max(baseDmg - effectiveDef, 0), floor(0.15 * baseDmg))
 */
export class DamageCalculator {
  /**
   * Calculate actual damage dealt to a player.
   * @param baseDamage - Raw damage from projectile/AOE
   * @param defense - Player's total defense (base + boosts)
   * @param armorPiercing - Projectile ignores defense
   * @param armorBroken - Player has ArmorBroken condition (defense = 0)
   * @param armored - Player has Armored condition (defense * 2)
   */
  static calculate(
    baseDamage: number,
    defense: number,
    armorPiercing = false,
    armorBroken = false,
    armored = false,
  ): number {
    let effectiveDef = defense;

    if (armorPiercing || armorBroken) {
      effectiveDef = 0;
    } else if (armored) {
      effectiveDef = defense * 2;
    }

    // Minimum 10% of base damage always goes through (MultiTool parity)
    return Math.max(
      Math.max(baseDamage - effectiveDef, 0),
      Math.floor(0.10 * baseDamage),
    );
  }

  /**
   * Calculate max-health-based damage (e.g., 0.06 = 6% of max HP).
   * Some bosses deal % based damage in addition to flat damage.
   */
  static calculateMaxHpDamage(
    maxHp: number,
    maxHealthDamagePercent: number,
  ): number {
    if (maxHealthDamagePercent <= 0) return 0;
    return Math.floor(maxHp * maxHealthDamagePercent);
  }

  /**
   * HP regen per tick (200ms) when not In Combat.
   * From KRelay: 0.2 + vitality * 0.024 per tick.
   */
  static regenPerTick(vitality: number): number {
    return 0.2 + vitality * 0.024;
  }
}
