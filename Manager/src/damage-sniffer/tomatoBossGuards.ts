/**
 * Boss-phase "guarded" hit detection aligned with RealmShark Tomato
 * {@code Entity.bossPhaseDamage} / {@code GuardsHandler.hasGuardedDamage}.
 *
 * Wire stat id matches {@code packets.data.enums.StatType.ANIMATION_STAT} from RealmShark JAR
 * (Tomato v1.9.2) — not the same as {@link StatType} keys in this repo for all ids.
 */
export const TOMATO_ANIMATION_STAT_WIRE = 125;

const ORYX_THE_MAD_GOD = 45363;
const ORYX_THE_MAD_GOD_GUARD_ANIMATION = -935464302;
const ORYX_THE_MAD_GOD_GUARD_EXALTED_ANIMATION = -918686683;
const CHANCELLOR_DAMMAH = 9635;
const FORGOTTEN_KING = 29039;
const FORGOTTEN_KING_REFLECTOR_ANIMATION = -123818367;

/** Tomato TomatoData.hasGuardedPhaseEntity — garden phase entities beside Forgotten King */
export const TOMATO_GUARDED_PHASE_OBJECT_TYPES = new Set<number>([33656, 33557, 33572]);

export interface TomatoBossPhaseGuardParams {
  targetObjectType: number;
  /** Raw Animation stat from target entity (wire id {@link TOMATO_ANIMATION_STAT_WIRE}) */
  animationStat: number | undefined;
  /** From {@link TOMATO_GUARDED_PHASE_OBJECT_TYPES} presence on map */
  hasGuardedPhaseEntity: boolean;
  /**
   * Tomato {@code Entity.dammahCountered} — not toggled in shipped Tomato Entity.java;
   * reserved for parity if counter phase is detected later.
   */
  dammahCountered: boolean;
}

/**
 * Per damage line: true when Tomato would set {@code hasGuardedDamage} for that hit
 * (O3 guard anim, walled garden reflector + phase entities, or Dammah counter + chancellor flag).
 */
export function tomatoLineIsGuarded(p: TomatoBossPhaseGuardParams): boolean {
  const oryx3 =
    p.targetObjectType === ORYX_THE_MAD_GOD &&
    p.animationStat != null &&
    (p.animationStat === ORYX_THE_MAD_GOD_GUARD_ANIMATION ||
      p.animationStat === ORYX_THE_MAD_GOD_GUARD_EXALTED_ANIMATION);

  const garden =
    p.targetObjectType === FORGOTTEN_KING &&
    p.animationStat === FORGOTTEN_KING_REFLECTOR_ANIMATION &&
    p.hasGuardedPhaseEntity;

  const dammah = p.targetObjectType === CHANCELLOR_DAMMAH && p.dammahCountered;

  return oryx3 || garden || dammah;
}
