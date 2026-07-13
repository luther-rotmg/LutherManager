import {
  ConditionEffectBits,
  PlayerData,
  StatType,
} from 'realmlib';
import type { CombatDataProvider } from './combat-tracker';
import type { TrackedObject } from './models';

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

interface PositionSample {
  x: number;
  y: number;
  at: number;
}

interface Velocity {
  x: number;
  y: number;
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
const TARGET_VELOCITY_MAX_AGE_MS = 750;

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
  private readonly samples = new Map<number, PositionSample>();
  private readonly velocities = new Map<number, Velocity>();

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
    this.samples.clear();
    this.velocities.clear();
    this.lastUpdateAt = -Infinity;
    this.lastAbilityAt = -Infinity;
  }

  update(now: number, snapshot: AutoCombatSnapshot, actions: AutoCombatActions): void {
    const objects = [...snapshot.objects];
    if (now < this.lastUpdateAt) this.clearMap();
    this.lastUpdateAt = now;
    this.updateMotion(now, objects);

    if (!snapshot.inWorld || snapshot.safeMap || !snapshot.player) {
      this.selectedObjectId = null;
      return;
    }

    const player = snapshot.player;
    const weaponType = player.inventory?.[this.aim.weaponSlot] ?? -1;
    const weaponProjectile = weaponType >= 0 ? this.data.getProjectile(weaponType, 0) : undefined;
    const weaponRange = this.aim.range || projectileRange(weaponProjectile) || DEFAULT_WEAPON_RANGE;
    const weaponCandidates = this.candidates(objects, snapshot.playerPos, weaponRange);
    const selected = this.resolveTarget(weaponCandidates);
    const fixedPoint = this.fixedPosition;
    const shouldShoot = !!fixedPoint || this.fixedObjectId !== null || this.autoAimEnabled;

    if (shouldShoot) {
      const point = fixedPoint ?? (selected
        ? this.aimPoint(selected.object, snapshot.playerPos, weaponProjectile)
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
    projectile: { speed: number; lifetimeMs: number } | undefined,
  ): { x: number; y: number } {
    if (!this.aim.leadTargets || !projectile || projectile.speed <= 0) return { x: object.x, y: object.y };
    const velocity = this.velocities.get(object.objectId);
    const sample = this.samples.get(object.objectId);
    if (!velocity || !sample || this.lastUpdateAt - sample.at > TARGET_VELOCITY_MAX_AGE_MS
      || (velocity.x === 0 && velocity.y === 0)) {
      return { x: object.x, y: object.y };
    }
    const speed = projectile.speed / 10_000;
    const time = interceptTime(playerPos, object, velocity, speed);
    if (time === null || time > projectile.lifetimeMs) return { x: object.x, y: object.y };
    return { x: object.x + velocity.x * time, y: object.y + velocity.y * time };
  }

  private updateMotion(now: number, objects: TrackedObject[]): void {
    const visible = new Set<number>();
    for (const object of objects) {
      visible.add(object.objectId);
      const previous = this.samples.get(object.objectId);
      if (!previous) {
        this.samples.set(object.objectId, { x: object.x, y: object.y, at: now });
        continue;
      }
      if (previous.x === object.x && previous.y === object.y) continue;
      const elapsed = now - previous.at;
      if (elapsed > 0) {
        this.velocities.set(object.objectId, {
          x: (object.x - previous.x) / elapsed,
          y: (object.y - previous.y) / elapsed,
        });
      }
      this.samples.set(object.objectId, { x: object.x, y: object.y, at: now });
    }
    for (const objectId of this.samples.keys()) {
      if (!visible.has(objectId)) {
        this.samples.delete(objectId);
        this.velocities.delete(objectId);
      }
    }
  }
}

function rawNumber(object: TrackedObject, stat: number, fallback: number): number {
  const value = object.rawStats?.[String(stat)];
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function projectileRange(projectile: { speed: number; lifetimeMs: number } | undefined): number {
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

function interceptTime(
  shooter: { x: number; y: number },
  target: { x: number; y: number },
  velocity: Velocity,
  projectileSpeed: number,
): number | null {
  if (projectileSpeed <= 0) return null;
  const px = target.x - shooter.x;
  const py = target.y - shooter.y;
  const a = velocity.x * velocity.x + velocity.y * velocity.y - projectileSpeed * projectileSpeed;
  const b = 2 * (px * velocity.x + py * velocity.y);
  const c = px * px + py * py;
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return null;
    const time = -c / b;
    return time >= 0 ? time : null;
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  const valid = [first, second].filter((time) => Number.isFinite(time) && time >= 0).sort((x, y) => x - y);
  return valid[0] ?? null;
}
