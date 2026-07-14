import {
  ConditionEffectBits,
  PlayerData,
  StatType,
} from 'realmlib';
import type { CombatDataProvider, CombatProjectileDefinition } from './combat-tracker';
import type { WeaponAimPreview } from './command-sender';
import type { TrackedObject } from './models';
import { TargetMotionPredictor, type MotionObservation } from './target-motion-predictor';

export type AutoAimMode = 'closest' | 'maxHp' | 'lowestHp' | 'random';

export interface AutoAimOptions {
  mode?: AutoAimMode;
  /** Maximum range in tiles. Zero derives range from the equipped weapon. */
  range?: number;
  bossPriority?: boolean;
  leadTargets?: boolean;
  includeInvulnerable?: boolean;
  weaponSlot?: number;
}

export interface AutoAbilityOptions {
  /** Minimum current MP percentage (0-100). */
  minMpPercent?: number;
  /** Only use the ability when the selected target has at least this much HP. */
  minTargetHp?: number;
  /** Minimum number of valid enemies within ability range. */
  minTargets?: number;
  /** Maximum range in tiles. Zero derives range from the ability projectile. */
  range?: number;
  /** Additional minimum cooldown; the item's own cooldown is always respected. */
  cooldownMs?: number;
  /** Teleporting abilities are skipped unless explicitly enabled. */
  allowTeleport?: boolean;
}

export interface AutoCombatState {
  autoAimEnabled: boolean;
  autoAbilityEnabled: boolean;
  mode: AutoAimMode;
  targetObjectId: number | null;
  fixedPosition: { x: number; y: number } | null;
  autoAim: Required<AutoAimOptions>;
  autoAbility: Required<AutoAbilityOptions>;
}

export interface AutoCombatSnapshot {
  inWorld: boolean;
  safeMap: boolean;
  player: PlayerData | undefined;
  playerPos: { x: number; y: number };
  objects: Iterable<TrackedObject>;
}

export interface AutoCombatActions {
  previewWeaponAim?(weaponSlot: number): WeaponAimPreview | null;
  shootAt(target: { x: number; y: number }, weaponSlot: number): boolean;
  useAbilityAt(target: { x: number; y: number }): boolean;
}

interface TargetCandidate {
  object: TrackedObject;
  hp: number;
  maxHp: number;
  distance: number;
  boss: boolean;
}

const DEFAULT_AUTO_AIM: Required<AutoAimOptions> = {
  mode: 'closest',
  range: 0,
  bossPriority: true,
  leadTargets: true,
  includeInvulnerable: false,
  weaponSlot: 0,
};

const DEFAULT_AUTO_ABILITY: Required<AutoAbilityOptions> = {
  minMpPercent: 50,
  minTargetHp: 0,
  minTargets: 1,
  range: 0,
  cooldownMs: 0,
  allowTeleport: false,
};

const DEFAULT_WEAPON_RANGE = 8;
const DEFAULT_ABILITY_RANGE = 12;
const DEFAULT_ABILITY_COOLDOWN_MS = 550;
const SHOT_SPAWN_OFFSET = 0.3;
const INTERCEPT_SAMPLE_MS = 8;

/** Per-client target selection and firing state. Driven by Client's combat timer. */
export class AutoCombatController {
  private aim = { ...DEFAULT_AUTO_AIM };
  private ability = { ...DEFAULT_AUTO_ABILITY };
  private autoAimEnabled = false;
  private autoAbilityEnabled = false;
  private fixedObjectId: number | null = null;
  private fixedPosition: { x: number; y: number } | null = null;
  private selectedObjectId: number | null = null;
  private lastAbilityAt = -Infinity;
  private lastUpdateAt = -Infinity;
  private readonly motion = new TargetMotionPredictor();

  constructor(private readonly data: CombatDataProvider) {}

  aimAt(objectId: number): boolean {
    if (!Number.isFinite(objectId) || objectId <= 0) return false;
    this.fixedObjectId = Math.trunc(objectId);
    this.fixedPosition = null;
    this.autoAimEnabled = false;
    this.selectedObjectId = this.fixedObjectId;
    return true;
  }

  aimAtPosition(x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    this.fixedPosition = { x, y };
    this.fixedObjectId = null;
    this.autoAimEnabled = false;
    this.selectedObjectId = null;
    return true;
  }

  stopAiming(): void {
    this.fixedObjectId = null;
    this.fixedPosition = null;
    this.selectedObjectId = null;
    this.autoAimEnabled = false;
  }

  enableAutoAim(options?: AutoAimOptions): boolean {
    if (options && !this.configureAutoAim(options)) return false;
    this.fixedObjectId = null;
    this.fixedPosition = null;
    this.autoAimEnabled = true;
    return true;
  }

  configureAutoAim(options: AutoAimMode | AutoAimOptions): boolean {
    const next = typeof options === 'string' ? { mode: options } : options;
    const mode = next.mode === undefined ? this.aim.mode : normalizeMode(next.mode);
    if (!mode) return false;
    this.aim = {
      mode,
      range: finiteNonNegative(next.range, this.aim.range),
      bossPriority: next.bossPriority ?? this.aim.bossPriority,
      leadTargets: next.leadTargets ?? this.aim.leadTargets,
      includeInvulnerable: next.includeInvulnerable ?? this.aim.includeInvulnerable,
      weaponSlot: Math.trunc(finiteNonNegative(next.weaponSlot, this.aim.weaponSlot)),
    };
    return true;
  }

  enableAutoAbility(options?: AutoAbilityOptions): boolean {
    if (options && !this.configureAutoAbility(options)) return false;
    this.autoAbilityEnabled = true;
    return true;
  }

  configureAutoAbility(options: AutoAbilityOptions): boolean {
    this.ability = {
      minMpPercent: clamp(finiteNonNegative(options.minMpPercent, this.ability.minMpPercent), 0, 100),
      minTargetHp: finiteNonNegative(options.minTargetHp, this.ability.minTargetHp),
      minTargets: Math.max(1, Math.trunc(finiteNonNegative(options.minTargets, this.ability.minTargets))),
      range: finiteNonNegative(options.range, this.ability.range),
      cooldownMs: finiteNonNegative(options.cooldownMs, this.ability.cooldownMs),
      allowTeleport: options.allowTeleport ?? this.ability.allowTeleport,
    };
    return true;
  }

  disableAutoAbility(): void {
    this.autoAbilityEnabled = false;
  }

  getState(): AutoCombatState {
    return {
      autoAimEnabled: this.autoAimEnabled,
      autoAbilityEnabled: this.autoAbilityEnabled,
      mode: this.aim.mode,
      targetObjectId: this.selectedObjectId,
      fixedPosition: this.fixedPosition ? { ...this.fixedPosition } : null,
      autoAim: { ...this.aim },
      autoAbility: { ...this.ability },
    };
  }

  /** Clears map-scoped locks and motion samples while preserving enabled automation settings. */
  clearMap(): void {
    this.fixedObjectId = null;
    this.fixedPosition = null;
    this.selectedObjectId = null;
    this.motion.clear();
    this.lastUpdateAt = -Infinity;
    this.lastAbilityAt = -Infinity;
  }

  /** Records authoritative NEWTICK endpoints before frame-level aiming resumes. */
  observeWorldTick(now: number, tickTime: number, observations: Iterable<MotionObservation>): void {
    this.motion.observeTick(now, tickTime, observations);
  }

  snapObject(objectId: number, position: { x: number; y: number }, now: number): void {
    this.motion.snap(objectId, position, now);
  }

  removeObject(objectId: number): void {
    this.motion.remove(objectId);
  }

  currentObjectPosition(object: MotionObservation, now: number): { x: number; y: number } {
    return this.motion.currentPosition(object.objectId, object, now);
  }

  update(now: number, snapshot: AutoCombatSnapshot, actions: AutoCombatActions): void {
    const objects = [...snapshot.objects];
    if (now < this.lastUpdateAt) this.clearMap();
    this.lastUpdateAt = now;
    this.motion.observeSnapshot(now, objects.filter((object) => {
      const definition = this.data.getObject(object.type);
      return !!definition?.isEnemy && !definition.invincible;
    }));

    if (!snapshot.inWorld || snapshot.safeMap || !snapshot.player) {
      this.selectedObjectId = null;
      return;
    }

    const player = snapshot.player;
    const weaponType = player.inventory?.[this.aim.weaponSlot] ?? -1;
    const weaponAim = actions.previewWeaponAim?.(this.aim.weaponSlot) ?? undefined;
    const rangeProjectile = weaponType >= 0 ? this.data.getProjectile(weaponType, 0) : undefined;
    const weaponProjectile = weaponType >= 0 && weaponAim
      ? this.data.getProjectile(weaponType, weaponAim.projectileId) ?? rangeProjectile
      : rangeProjectile;
    const weaponRange = this.aim.range || projectileRange(rangeProjectile) || DEFAULT_WEAPON_RANGE;
    const weaponCandidates = this.candidates(objects, snapshot.playerPos, weaponRange);
    const selected = this.resolveTarget(weaponCandidates);
    const fixedPoint = this.fixedPosition;
    const shouldShoot = !!fixedPoint || this.fixedObjectId !== null || this.autoAimEnabled;

    if (shouldShoot) {
      const point = fixedPoint ?? (selected
        ? this.aimPoint(
            selected.object,
            snapshot.playerPos,
            weaponProjectile,
            player.projSpeedMult,
            player.projLifeMult,
            weaponAim,
          )
        : null);
      this.selectedObjectId = selected?.object.objectId ?? null;
      if (point) actions.shootAt(point, this.aim.weaponSlot);
    } else {
      this.selectedObjectId = null;
    }

    if (!this.autoAbilityEnabled) return;
    this.updateAutoAbility(now, snapshot, objects, selected, actions);
  }

  private updateAutoAbility(
    now: number,
    snapshot: AutoCombatSnapshot,
    objects: TrackedObject[],
    weaponTarget: TargetCandidate | null,
    actions: AutoCombatActions,
  ): void {
    const player = snapshot.player!;
    const abilityType = player.inventory?.[1] ?? -1;
    if (abilityType < 0) return;
    const definition = this.data.getObject(abilityType);
    if (definition?.usable === false) return;
    const effects = definition?.activateEffects?.map((effect) => effect.toLowerCase()) ?? [];
    if (!this.ability.allowTeleport && effects.some((effect) => effect.includes('teleport'))) {
      return;
    }
    const maxMp = Math.max(0, player.maxMP ?? 0);
    const mpPercent = maxMp > 0 ? (player.mp ?? 0) / maxMp * 100 : 0;
    if (mpPercent < this.ability.minMpPercent) return;

    const projectile = this.data.getProjectile(abilityType, 0);
    const range = this.ability.range || projectileRange(projectile) || DEFAULT_ABILITY_RANGE;
    const candidates = this.candidates(objects, snapshot.playerPos, range);
    if (candidates.length < this.ability.minTargets) return;
    const selected = this.fixedObjectId !== null
      ? candidates.find((candidate) => candidate.object.objectId === this.fixedObjectId) ?? null
      : weaponTarget && weaponTarget.distance <= range
        ? weaponTarget
        : this.selectCandidate(candidates);
    if (selected && selected.hp < this.ability.minTargetHp) return;
    const point = this.fixedPosition
      ?? (selected ? this.aimPoint(selected.object, snapshot.playerPos, projectile) : snapshot.playerPos);
    const itemCooldown = Math.max(DEFAULT_ABILITY_COOLDOWN_MS, definition?.cooldownMs ?? 0);
    const cooldown = Math.max(itemCooldown, this.ability.cooldownMs);
    if (now < this.lastAbilityAt + cooldown) return;
    if (actions.useAbilityAt(point)) this.lastAbilityAt = now;
  }

  private candidates(objects: TrackedObject[], playerPos: { x: number; y: number }, range: number): TargetCandidate[] {
    const result: TargetCandidate[] = [];
    for (const object of objects) {
      const definition = this.data.getObject(object.type);
      if (!definition?.isEnemy || definition.invincible) continue;
      const condition = object.player?.condition ?? rawNumber(object, StatType.CONDITION_STAT, 0);
      const blocked = ConditionEffectBits.PAUSED | ConditionEffectBits.STASIS | ConditionEffectBits.INVINCIBLE;
      if ((condition & blocked) !== 0) continue;
      if (!this.aim.includeInvulnerable && (condition & ConditionEffectBits.INVULNERABLE) !== 0) continue;
      const hp = object.player?.hp ?? rawNumber(object, StatType.HP_STAT, definition.maxHp ?? 0);
      if (hp <= 0) continue;
      const distance = Math.hypot(object.x - playerPos.x, object.y - playerPos.y);
      if (distance > range) continue;
      const maxHp = object.player?.maxHP ?? rawNumber(object, StatType.MAX_HP_STAT, definition.maxHp ?? hp);
      result.push({
        object,
        hp,
        maxHp,
        distance,
        boss: !!definition.quest && maxHp >= 5_000,
      });
    }
    return result;
  }

  private resolveTarget(candidates: TargetCandidate[]): TargetCandidate | null {
    if (this.fixedObjectId !== null) {
      return candidates.find((candidate) => candidate.object.objectId === this.fixedObjectId) ?? null;
    }
    return this.autoAimEnabled || this.autoAbilityEnabled ? this.selectCandidate(candidates) : null;
  }

  private selectCandidate(candidates: TargetCandidate[]): TargetCandidate | null {
    if (candidates.length === 0) return null;
    const bosses = this.aim.bossPriority ? candidates.filter((candidate) => candidate.boss) : [];
    const pool = bosses.length > 0 ? bosses : candidates;
    switch (this.aim.mode) {
      case 'maxHp':
        return [...pool].sort((a, b) => b.maxHp - a.maxHp || b.hp - a.hp || a.distance - b.distance)[0] ?? null;
      case 'lowestHp':
        return [...pool].sort((a, b) => a.hp - b.hp || a.distance - b.distance)[0] ?? null;
      case 'random':
        return pool[Math.floor(Math.random() * pool.length)] ?? null;
      case 'closest':
      default:
        return [...pool].sort((a, b) => a.distance - b.distance)[0] ?? null;
    }
  }

  private aimPoint(
    object: TrackedObject,
    playerPos: { x: number; y: number },
    projectile: CombatProjectileDefinition | undefined,
    speedMultiplier = 1,
    lifetimeMultiplier = 1,
    shotProfile?: WeaponAimPreview,
  ): { x: number; y: number } {
    const current = this.motion.currentPosition(object.objectId, object, this.lastUpdateAt);
    if (!this.aim.leadTargets || !projectile) return current;
    return predictedInterceptPoint(
      playerPos,
      current,
      projectile,
      speedMultiplier,
      lifetimeMultiplier,
      shotProfile,
      (futureMs) => this.motion.predictPosition(object.objectId, object, this.lastUpdateAt, futureMs),
    ) ?? current;
  }
}

function rawNumber(object: TrackedObject, stat: number, fallback: number): number {
  const value = object.rawStats?.[String(stat)];
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function projectileRange(
  projectile: CombatProjectileDefinition | undefined,
): number {
  return projectile && projectile.speed > 0 && projectile.lifetimeMs > 0
    ? projectile.speed * projectile.lifetimeMs / 10_000
    : 0;
}

function normalizeMode(mode: string): AutoAimMode | null {
  switch (String(mode).trim().toLowerCase().replace(/[\s_-]+/g, '')) {
    case 'closest': return 'closest';
    case 'maxhp': return 'maxHp';
    case 'lowesthp': return 'lowestHp';
    case 'random': return 'random';
    default: return null;
  }
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function predictedInterceptPoint(
  shooter: { x: number; y: number },
  currentTarget: { x: number; y: number },
  projectile: CombatProjectileDefinition,
  speedMultiplier: number,
  lifetimeMultiplier: number,
  shotProfile: WeaponAimPreview | undefined,
  targetAt: (futureMs: number) => { x: number; y: number },
): { x: number; y: number } | null {
  const lifetime = projectile.lifetimeMs * validMultiplier(lifetimeMultiplier);
  if (lifetime <= 0) return null;
  const separation = (time: number): number => {
    const target = time === 0 ? currentTarget : targetAt(time);
    const projectilePosition = projectileLocalPositionAt(
      projectile,
      time,
      speedMultiplier,
      lifetimeMultiplier,
      shotProfile,
    );
    return Math.hypot(target.x - shooter.x, target.y - shooter.y)
      - Math.hypot(projectilePosition.x, projectilePosition.y);
  };
  const aimAt = (time: number): { x: number; y: number } | null => {
    const target = time === 0 ? currentTarget : targetAt(time);
    const targetX = target.x - shooter.x;
    const targetY = target.y - shooter.y;
    const targetDistance = Math.hypot(targetX, targetY);
    const projectilePosition = projectileLocalPositionAt(
      projectile,
      time,
      speedMultiplier,
      lifetimeMultiplier,
      shotProfile,
    );
    const projectileDistance = Math.hypot(projectilePosition.x, projectilePosition.y);
    if (targetDistance <= 1e-9 || projectileDistance <= 1e-9) return null;
    const baseAngle = Math.atan2(targetY, targetX)
      - Math.atan2(projectilePosition.y, projectilePosition.x);
    return {
      x: shooter.x + targetDistance * Math.cos(baseAngle),
      y: shooter.y + targetDistance * Math.sin(baseAngle),
    };
  };

  let previousTime = 0;
  let previousSeparation = separation(0);
  if (Math.abs(previousSeparation) <= 1e-9) return aimAt(0);
  for (let time = Math.min(INTERCEPT_SAMPLE_MS, lifetime); time <= lifetime; time += INTERCEPT_SAMPLE_MS) {
    const currentTime = Math.min(time, lifetime);
    const currentSeparation = separation(currentTime);
    if (Math.abs(currentSeparation) <= 1e-9
      || Math.sign(currentSeparation) !== Math.sign(previousSeparation)) {
      let low = previousTime;
      let high = currentTime;
      const lowSign = Math.sign(previousSeparation);
      for (let iteration = 0; iteration < 20; iteration++) {
        const middle = (low + high) * 0.5;
        if (Math.sign(separation(middle)) === lowSign) low = middle;
        else high = middle;
      }
      return aimAt(high);
    }
    previousTime = currentTime;
    previousSeparation = currentSeparation;
    if (currentTime === lifetime) break;
    if (time + INTERCEPT_SAMPLE_MS > lifetime) time = lifetime - INTERCEPT_SAMPLE_MS;
  }
  return null;
}

function projectileLocalPositionAt(
  projectile: CombatProjectileDefinition,
  elapsedMs: number,
  speedMultiplier = 1,
  lifetimeMultiplier = 1,
  shotProfile?: WeaponAimPreview,
): { x: number; y: number } {
  const profile = shotProfile ?? {
    projectileId: 0,
    bulletId: 0,
    angleOffset: 0,
    spawnDistance: SHOT_SPAWN_OFFSET,
    spawnOffsetX: 0,
  };
  const trajectoryLifetime = projectile.trajectoryLifetimeMs ?? projectile.lifetimeMs;
  const elapsed = Math.max(0, Math.min(
    projectile.lifetimeMs * validMultiplier(lifetimeMultiplier),
    elapsedMs,
  ));
  const phase = profile.bulletId % 2 === 0 ? 0 : Math.PI;
  let travelX: number;
  let travelY: number;

  if (projectile.parametric) {
    const t = trajectoryLifetime > 0 ? elapsed / trajectoryLifetime * 2 * Math.PI : 0;
    travelX = Math.sin(t) * (profile.bulletId % 2 ? 1 : -1) * projectile.magnitude;
    travelY = Math.sin(2 * t) * (profile.bulletId % 4 < 2 ? 1 : -1) * projectile.magnitude;
  } else {
    const distance = projectileDistanceAt(projectile, elapsed, speedMultiplier, lifetimeMultiplier);
    if (projectile.wavy) {
      const waveAngle = Math.PI / 64 * Math.sin(phase + 6 * Math.PI * elapsed / 1000);
      travelX = distance * Math.cos(waveAngle);
      travelY = distance * Math.sin(waveAngle);
    } else {
      travelX = distance;
      travelY = projectile.amplitude * Math.sin(
        phase + (trajectoryLifetime > 0 ? elapsed / trajectoryLifetime : 0)
          * projectile.frequency * 2 * Math.PI,
      );
    }
  }

  const cos = Math.cos(profile.angleOffset);
  const sin = Math.sin(profile.angleOffset);
  return {
    x: profile.spawnDistance + travelX * cos - travelY * sin,
    y: profile.spawnOffsetX + travelX * sin + travelY * cos,
  };
}

function projectileDistanceAt(
  projectile: CombatProjectileDefinition,
  elapsedMs: number,
  speedMultiplier = 1,
  lifetimeMultiplier = 1,
): number {
  const elapsed = Math.max(0, Math.min(
    projectile.lifetimeMs * validMultiplier(lifetimeMultiplier),
    elapsedMs,
  ));
  const scaledSpeed = projectile.speed * validMultiplier(speedMultiplier);
  const baseSpeed = scaledSpeed / 10_000;
  let distance: number;
  if (projectile.acceleration === 0 || elapsed < projectile.accelerationDelay) {
    distance = elapsed * baseSpeed;
  } else {
    const accelerationElapsed = elapsed - projectile.accelerationDelay;
    let accelerationTime = accelerationElapsed;
    let clampedTime = 0;
    let clampedSpeed = 0;
    if (projectile.speedClamp !== -1 && projectile.acceleration !== 0) {
      clampedSpeed = projectile.speedClamp / 10_000;
      const speedNeeded = Math.abs(projectile.speedClamp - scaledSpeed);
      const timeToClamp = speedNeeded / Math.abs(projectile.acceleration) * 1000;
      accelerationTime = Math.min(accelerationElapsed, timeToClamp);
      clampedTime = Math.max(0, accelerationElapsed - accelerationTime);
    }
    distance = projectile.accelerationDelay * baseSpeed
      + accelerationTime * baseSpeed
      + accelerationTime * accelerationTime / 1000 * 0.5 * (projectile.acceleration / 10_000)
      + clampedTime * clampedSpeed;
  }

  if (projectile.boomerang) {
    const trajectoryLifetime = projectile.trajectoryLifetimeMs ?? projectile.lifetimeMs;
    const halfway = trajectoryLifetime * baseSpeed * 0.5;
    if (distance > halfway) distance = halfway - (distance - halfway);
  }
  return Math.max(0, distance);
}

function validMultiplier(value: number | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}
