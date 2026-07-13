/**
 * Port of Tomato {@code Projectile.damageWithDefense} (mob / entity target).
 * Uses CONDITION_STAT + NEW_CON_STAT bitmasks as in RealmShark.
 */
export function tomatoDamageWithDefense(
  damage: number,
  armorPiercing: boolean,
  defence: number,
  condition0: number,
  condition1: number,
): number {
  if (damage === 0) return 0;

  let def = defence;
  if (armorPiercing || (condition0 & 0x4000000) !== 0) {
    def = 0;
  } else if ((condition0 & 0x2000000) !== 0) {
    def = Math.floor(def * 1.5);
  }
  if ((condition1 & 0x20000) !== 0) {
    def -= 20;
  }
  const minDmg = Math.floor((damage * 2) / 20);
  let dmg = Math.max(minDmg, damage - def);

  if ((condition0 & 0x1000000) !== 0) {
    dmg = 0;
  }
  if ((condition1 & 0x8) !== 0) {
    dmg = Math.floor(dmg * 0.9);
  }
  if ((condition1 & 0x40) !== 0) {
    dmg = Math.floor(dmg * 1.25);
  }
  return dmg;
}
