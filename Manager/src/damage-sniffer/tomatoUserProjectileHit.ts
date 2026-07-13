/**
 * Port of Tomato {@code Entity.userProjectileHit} final damage integer (before Damage object / boss flags).
 */

import { StatType } from '../constants/StatType.js';
import { ConditionEffect } from '../constants/ConditionEffect.js';
import { tomatoDamageWithDefense } from './tomatoProjectileDamage.js';
import type { AbilityScalingManager } from './abilityScalingManager.js';
import { getPlayerCrucibleDamageMultiplier } from './crucibleBonusManager.js';

export interface TomatoProjectileInput {
  damage: number;
  summonerId: number;
  containerType: number;
  bulletType: number;
  armorPiercing: boolean;
  /** Tomato {@code Projectile.getOriginScalingStat()} snapshot when set */
  originScalingStat?: number;
}

function isMainWeaponSlot(slot: number): boolean {
  switch (slot) {
    case 1:
    case 2:
    case 3:
    case 8:
    case 17:
    case 24:
      return true;
    default:
      return false;
  }
}

function playerStatsMultiplierFromStats(
  stats: Record<string, number | string> | undefined,
  isLocalPlayer: boolean,
): number {
  if (!stats) return 1;
  const cond = Number(stats[String(StatType.Effects)] ?? 0);
  const weak = (cond & (1 << ConditionEffect.Weak)) !== 0;
  const damaging = (cond & (1 << ConditionEffect.Damaging)) !== 0;
  const attack = Number(stats[String(StatType.Attack)] ?? 0);
  const exaltRaw = Number(stats[String(StatType.ExaltationDamageMultiplier)] ?? 1000);
  const exaltDmgBonus = exaltRaw / 1000;
  if (weak) return 0.5 * exaltDmgBonus;
  let number = (attack + 25) * 0.02;
  if (damaging) number *= 1.25;
  if (isLocalPlayer) number *= getPlayerCrucibleDamageMultiplier();
  return number * exaltDmgBonus;
}

export function buildLocalPlayerProjectileDamage(
  scaling: AbilityScalingManager,
  params: {
    weaponObjectType: number;
    projectileIndex: number;
    gameData: { getProjectile: (w: number, p: number) => { damage: number; armorPiercing: boolean } | undefined };
    objectDef: { slotType: number } | undefined;
    attackerStats: Record<string, number | string> | undefined;
    rngNext: () => number;
  },
): { damage: number; armorPiercing: boolean; containerType: number; bulletType: number; summonerId: number } | null {
  let projId = params.projectileIndex;
  if (projId === -1) projId = 0;
  const weaponId = params.weaponObjectType;
  const projDef = params.gameData.getProjectile(weaponId, projId);
  if (!projDef) return null;

  const slot = params.objectDef?.slotType ?? -1;
  const mainWeapon = isMainWeaponSlot(slot);

  const min = projDef.damage;
  const max = projDef.damage;
  let dmg: number;
  if (min !== max) {
    const r = Math.abs(params.rngNext());
    dmg = min + (r % (max - min));
  } else {
    dmg = min;
  }

  const isAbilityProjectile = !mainWeapon;
  if (isAbilityProjectile && scaling.hasScaling(weaponId)) {
    const statBonus = scaling.calculateStatBonus(
      weaponId,
      null,
      (id) => {
        const v = params.attackerStats?.[String(id)];
        return typeof v === 'number' ? v : Number(v);
      },
      () => {
        const v = params.attackerStats?.[String(StatType.Inventory1)];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
          const n = Number(v);
          return Number.isFinite(n) ? n : undefined;
        }
        return undefined;
      },
      () => 1,
    );
    dmg += statBonus;
  }

  let f = 1;
  if (mainWeapon) f = playerStatsMultiplierFromStats(params.attackerStats, true);
  const damage = Math.floor(dmg * f);
  return {
    damage,
    armorPiercing: projDef.armorPiercing,
    containerType: weaponId,
    bulletType: projId,
    summonerId: 0,
  };
}

export function computeUserProjectileHitDamage(
  scaling: AbilityScalingManager,
  params: {
    projectile: TomatoProjectileInput;
    attackerId: number;
    clientObjectId: number;
    targetDefense: number;
    targetCondition0: number;
    targetCondition1: number;
    getAttackerNumericStat: (statId: number) => number | undefined;
    getAttackerAbilitySlot1: () => number | undefined;
    getEnchantStatDamageMultiplier: (abilityItemId: number) => number;
  },
): number {
  const projectile = params.projectile;
  if (projectile.damage === 0) return 0;

  const isAbilityProjectile = projectile.summonerId !== 0;
  const isLocalAttacker = params.attackerId === params.clientObjectId;
  const containerType = projectile.containerType;
  const hasContainerType = isLocalAttacker && containerType !== -1;

  let dmg = 0;
  let isProcProjectile = false;

  if (isAbilityProjectile && !hasContainerType) {
    const baseDamage = projectile.damage;
    if (projectile.armorPiercing) {
      dmg = baseDamage;
    } else {
      dmg = tomatoDamageWithDefense(
        baseDamage,
        false,
        params.targetDefense,
        params.targetCondition0,
        params.targetCondition1,
      );
    }
  } else {
    if (containerType !== -1) {
      const hasScaling = scaling.hasScaling(containerType);
      if (hasScaling) {
        const sd = scaling.getScalingData(containerType);
        let statSnapshot: number | null = null;
        try {
          if (
            sd != null &&
            params.getAttackerNumericStat(sd.scalingStatId) != null
          ) {
            statSnapshot = params.getAttackerNumericStat(sd.scalingStatId)!;
          } else if (
            projectile.originScalingStat != null &&
            Number.isFinite(projectile.originScalingStat)
          ) {
            statSnapshot = projectile.originScalingStat;
          }
        } catch {
          /* ignore */
        }
        const statBonus = scaling.calculateStatBonus(
          containerType,
          statSnapshot,
          (id) => params.getAttackerNumericStat(id),
          () => params.getAttackerAbilitySlot1(),
          params.getEnchantStatDamageMultiplier,
        );
        const baseDamage = projectile.damage;
        dmg = baseDamage + statBonus;
        isProcProjectile = true;
      }
    }

    if (containerType !== -1 || !isProcProjectile) {
      const baseDamage = isProcProjectile ? dmg : projectile.damage;
      dmg = tomatoDamageWithDefense(
        baseDamage,
        projectile.armorPiercing,
        params.targetDefense,
        params.targetCondition0,
        params.targetCondition1,
      );
    }
  }

  return dmg;
}
