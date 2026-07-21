import type { CombatDataProvider, CombatProjectileSnapshot } from './combat-tracker';
import {
  ENEMY_AVOID_RADIUS,
  ENEMY_SOFT_AVOID_RADIUS,
  EnemyClearanceOverlay,
} from './enemy-clearance-overlay';
import type { StaticPassabilityStore } from './static-passability-model';
import { createStaticPassabilityStore } from './static-passability-store';

export { ENEMY_AVOID_RADIUS, ENEMY_SOFT_AVOID_RADIUS } from './enemy-clearance-overlay';

interface DodgeObjectRecord {
  key: number;
  x: number;
  y: number;
  occupySquare: boolean;
  fullOccupy: boolean;
  enemyOccupySquare: boolean;
  enemyCandidate: boolean;
}

const INVALID_TILE_TYPE = 0xffff;
const SNAPSHOT_REUSE_PADDING = 1;

/** Compact collision data sampled from the authoritative dodge world for one local plan. */
export interface LocalDodgeCollisionSnapshot {
  originX: number;
  originY: number;
  resolution: number;
  width: number;
  height: number;
  blocked: Uint8Array;
  damagingFloor: Float32Array;
  enemyDistance: Float32Array;
  revision: number;
}

interface CachedLocalSnapshot {
  centerX: number;
  centerY: number;
  requestedRadius: number;
  staticRevision: number;
  enemyRevision: number;
  snapshot: LocalDodgeCollisionSnapshot;
}

interface EnemyThreatDataProvider {
  getObject(type: number): {
    isEnemy?: boolean;
    hasProjectiles?: boolean;
    subattacks?: ReadonlyArray<{
      patterns: ReadonlyArray<{ projectileId: number }>;
    }>;
  } | undefined;
  getProjectile?(objectType: number, projectileId: number): unknown;
}

/** Distinguishes projectile-capable monsters from inert enemy-tagged map objects. */
export function isEnemyProximityThreat(
  data: EnemyThreatDataProvider,
  objectType: number,
): boolean {
  const definition = data.getObject(objectType);
  if (!definition?.isEnemy) return false;
  if (definition.hasProjectiles !== undefined) return definition.hasProjectiles;
  if (!data.getProjectile) return false;

  const projectileIds = new Set<number>([0]);
  for (const subattack of definition.subattacks ?? []) {
    for (const pattern of subattack.patterns) projectileIds.add(pattern.projectileId);
  }
  for (const projectileId of projectileIds) {
    if (data.getProjectile(objectType, projectileId)) return true;
  }
  return false;
}

/**
 * Killable enemy-tagged objects (destructible walls, crates, etc.) should not
 * block movement — path through them and shoot to clear. Invincible enemies
 * still occupy as static geometry.
 */
export function isDamageableEnemyObject(
  definition: { isEnemy?: boolean; invincible?: boolean } | undefined,
): boolean {
  return !!definition?.isEnemy && !definition.invincible;
}

/** Static movement flags after stripping damageable enemy occupy/fullOccupy. */
export function staticMovementProfile(definition: {
  occupySquare?: boolean;
  fullOccupy?: boolean;
  isEnemy?: boolean;
  invincible?: boolean;
} | undefined): { occupySquare: boolean; fullOccupy: boolean } {
  if (!definition) return { occupySquare: false, fullOccupy: false };
  if (isDamageableEnemyObject(definition)) {
    return { occupySquare: false, fullOccupy: false };
  }
  return {
    occupySquare: !!definition.occupySquare,
    fullOccupy: !!definition.fullOccupy,
  };
}

/** Incrementally maintained collision view used by predictive auto-dodge. */
export class DodgeCollisionWorld {
  private readonly staticPassability: StaticPassabilityStore;
  private readonly ownsStaticPassability: boolean;
  private readonly objects = new Map<number, DodgeObjectRecord>();
  private readonly enemyOccupyCounts = new Map<number, number>();
  /** OccupySquare cover for projectiles, including damageable enemy walls. */
  private readonly projectileCoverCounts = new Map<number, number>();
  private readonly confirmedCombatEnemies = new Set<number>();
  private readonly enemyOverlay = new EnemyClearanceOverlay();
  private revision = 0;
  private cachedSnapshot: CachedLocalSnapshot | undefined;

  constructor(
    private readonly data: CombatDataProvider,
    staticPassability?: StaticPassabilityStore,
  ) {
    this.staticPassability = staticPassability ?? createStaticPassabilityStore(data);
    this.ownsStaticPassability = staticPassability === undefined;
  }

  reset(): void {
    if (this.ownsStaticPassability) this.staticPassability.reset();
    this.objects.clear();
    this.enemyOccupyCounts.clear();
    this.projectileCoverCounts.clear();
    this.confirmedCombatEnemies.clear();
    this.enemyOverlay.reset();
    this.touch(true, true);
  }

  setMapBounds(width: number, height: number): void {
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.setMapBounds(width, height);
    if (this.staticPassability.getRevision() !== revisionBefore) this.touch(true, false);
  }

  observeTile(x: number, y: number, type: number): void {
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.observeTile(x, y, type);
    if (this.staticPassability.getRevision() !== revisionBefore) this.touch(true, false);
  }

  /** Allows in-bounds, unobserved cells while an exploratory path is active. */
  setExplorativeUnknown(enabled: boolean): void {
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.setExplorativeUnknown(enabled);
    if (this.staticPassability.getRevision() !== revisionBefore) this.touch(true, false);
  }

  /** Shares collision cells learned from authoritative pathfinding stalls. */
  markBlocked(x: number, y: number): void {
    if (this.staticPassability.markLearnedBlocked(Math.floor(x), Math.floor(y))) {
      this.touch(true, false);
    }
  }

  upsertObject(objectId: number, objectType: number, x: number, y: number): void {
    const previous = this.objects.get(objectId);
    const previousCombat = this.enemyOverlay.get(objectId);
    this.removeObjectRecord(objectId, false);
    const definition = this.data.getObject(objectType);
    if (!definition) {
      this.confirmedCombatEnemies.delete(objectId);
      const staticChanged = !!previous && recordAffectsStaticCollision(previous);
      if (staticChanged || previousCombat) this.touch(staticChanged, !!previousCombat);
      return;
    }
    const enemyCandidate = !!definition.isEnemy;
    if (!enemyCandidate) this.confirmedCombatEnemies.delete(objectId);
    const movement = staticMovementProfile(definition);
    const record: DodgeObjectRecord = {
      key: tileKey(Math.floor(x), Math.floor(y)),
      x,
      y,
      occupySquare: !!definition.occupySquare,
      fullOccupy: !!definition.fullOccupy,
      enemyOccupySquare: !!definition.enemyOccupySquare,
      enemyCandidate,
    };
    if (!record.occupySquare && !record.fullOccupy && !record.enemyOccupySquare && !enemyCandidate) {
      const staticChanged = !!previous && recordAffectsStaticCollision(previous);
      if (staticChanged || previousCombat) this.touch(staticChanged, !!previousCombat);
      return;
    }
    this.objects.set(objectId, record);
    if (enemyCandidate && (isEnemyProximityThreat(this.data, objectType)
      || this.confirmedCombatEnemies.has(objectId))) {
      this.enemyOverlay.set(objectId, { x, y });
    }
    this.adjust(this.enemyOccupyCounts, record.key, record.enemyOccupySquare ? 1 : 0);
    // Keep projectile cover for damageable walls even though movement ignores them.
    this.adjust(this.projectileCoverCounts, record.key, record.occupySquare ? 1 : 0);
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.upsertObject(objectId, objectType, x, y, movement);
    const nextCombat = this.enemyOverlay.get(objectId);
    const staticChanged = this.staticPassability.getRevision() !== revisionBefore
      || staticCollisionChanged(previous, record);
    const enemyChanged = !sameOptionalPosition(previousCombat, nextCombat);
    if (staticChanged || enemyChanged) this.touch(staticChanged, enemyChanged);
  }

  /** Promotes an enemy-tagged object after an authoritative EnemyShoot packet. */
  markEnemyThreat(objectId: number): void {
    const record = this.objects.get(objectId);
    if (!record?.enemyCandidate) return;
    const changed = !this.confirmedCombatEnemies.has(objectId)
      || !this.enemyOverlay.has(objectId);
    this.confirmedCombatEnemies.add(objectId);
    this.enemyOverlay.set(objectId, { x: record.x, y: record.y });
    if (changed) this.touch(false, true);
  }

  removeObject(objectId: number): void {
    const record = this.objects.get(objectId);
    const combatEnemy = this.enemyOverlay.has(objectId);
    const removedRecord = this.removeObjectRecord(objectId, false);
    const removedConfirmation = this.confirmedCombatEnemies.delete(objectId);
    const changed = removedRecord || removedConfirmation;
    if (changed) this.touch(!!record && recordAffectsStaticCollision(record), combatEnemy);
  }

  private removeObjectRecord(objectId: number, notify = true): boolean {
    const record = this.objects.get(objectId);
    if (!record) return false;
    this.objects.delete(objectId);
    this.enemyOverlay.delete(objectId);
    this.adjust(this.enemyOccupyCounts, record.key, record.enemyOccupySquare ? -1 : 0);
    this.adjust(this.projectileCoverCounts, record.key, record.occupySquare ? -1 : 0);
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.removeObject(objectId);
    const staticChanged = this.staticPassability.getRevision() !== revisionBefore
      || recordAffectsStaticCollision(record);
    if (notify) this.touch(staticChanged, record.enemyCandidate);
    return true;
  }

  canOccupy(x: number, y: number, safeWalk: boolean, avoidEnemies = true): boolean {
    if (!this.canOccupyStatic(x, y, safeWalk)) return false;
    return !avoidEnemies || this.enemyOverlay.satisfiesHardClearance(x, y);
  }

  /** Monotonic revision for local-snapshot invalidation. */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Samples the incrementally maintained world into numeric arrays. The planner
   * queries these arrays in its hot loop; all source-of-truth decisions remain here.
   */
  createLocalSnapshot(
    center: { x: number; y: number },
    radius: number,
    resolution = 0.1,
  ): LocalDodgeCollisionSnapshot {
    const safeRadius = Number.isFinite(radius) ? Math.max(1, radius) : 1;
    const safeResolution = Number.isFinite(resolution)
      ? Math.min(0.5, Math.max(0.05, resolution))
      : 0.1;
    const staticRevision = this.staticPassability.getRevision();
    const cached = this.cachedSnapshot;
    const reusableLayout = !!cached
      && cached.snapshot.resolution === safeResolution
      && cached.requestedRadius >= safeRadius
      && Math.abs(center.x - cached.centerX) <= SNAPSHOT_REUSE_PADDING * 0.5
      && Math.abs(center.y - cached.centerY) <= SNAPSHOT_REUSE_PADDING * 0.5;
    if (reusableLayout
      && cached.staticRevision === staticRevision
      && cached.enemyRevision === this.enemyOverlay.getRevision()) {
      return cached.snapshot;
    }

    const sampledRadius = safeRadius + SNAPSHOT_REUSE_PADDING;
    const originX = reusableLayout
      ? cached.snapshot.originX
      : Math.floor((center.x - sampledRadius) / safeResolution) * safeResolution;
    const originY = reusableLayout
      ? cached.snapshot.originY
      : Math.floor((center.y - sampledRadius) / safeResolution) * safeResolution;
    const maximumX = Math.ceil((center.x + sampledRadius) / safeResolution) * safeResolution;
    const maximumY = Math.ceil((center.y + sampledRadius) / safeResolution) * safeResolution;
    const width = reusableLayout
      ? cached.snapshot.width
      : Math.max(2, Math.round((maximumX - originX) / safeResolution) + 1);
    const height = reusableLayout
      ? cached.snapshot.height
      : Math.max(2, Math.round((maximumY - originY) / safeResolution) + 1);
    const size = width * height;
    const reuseStatic = reusableLayout && cached.staticRevision === staticRevision;
    const blocked = reuseStatic ? cached.snapshot.blocked : new Uint8Array(size);
    const damagingFloor = reuseStatic
      ? cached.snapshot.damagingFloor
      : new Float32Array(size);

    if (!reuseStatic) {
      for (let row = 0; row < height; row++) {
        const y = originY + row * safeResolution;
        for (let column = 0; column < width; column++) {
          const x = originX + column * safeResolution;
          const index = row * width + column;
          blocked[index] = this.canOccupyStatic(x, y, false) ? 0 : 1;
          const type = this.staticPassability.getObservedTileType(Math.floor(x), Math.floor(y));
          damagingFloor[index] = type === undefined
            ? 0
            : Math.max(0, this.data.getTileDamage?.(type) ?? 0);
        }
      }
    }

    const reuseEnemy = reusableLayout
      && cached.enemyRevision === this.enemyOverlay.getRevision();
    const enemyDistance = reuseEnemy
      ? cached.snapshot.enemyDistance
      : new Float32Array(size);
    if (!reuseEnemy) {
      const enemies = this.enemyOverlay.copyEnemyPositions();
      if (enemies.length === 0) enemyDistance.fill(Infinity);
      for (let row = 0; row < height && enemies.length > 0; row++) {
        const y = originY + row * safeResolution;
        for (let column = 0; column < width; column++) {
          const x = originX + column * safeResolution;
          const index = row * width + column;
        let nearestSquared = Infinity;
        for (const enemy of enemies) {
          const dx = x - enemy.x;
          const dy = y - enemy.y;
          nearestSquared = Math.min(nearestSquared, dx * dx + dy * dy);
        }
        enemyDistance[index] = Number.isFinite(nearestSquared)
          ? Math.sqrt(nearestSquared)
          : Infinity;
        }
      }
    }

    const snapshot: LocalDodgeCollisionSnapshot = {
      originX,
      originY,
      resolution: safeResolution,
      width,
      height,
      blocked,
      damagingFloor,
      enemyDistance,
      revision: this.revision,
    };
    this.cachedSnapshot = {
      centerX: reusableLayout ? cached.centerX : center.x,
      centerY: reusableLayout ? cached.centerY : center.y,
      requestedRadius: reusableLayout ? cached.requestedRadius : safeRadius,
      staticRevision,
      enemyRevision: this.enemyOverlay.getRevision(),
      snapshot,
    };
    return snapshot;
  }

  private canOccupyStatic(x: number, y: number, safeWalk: boolean): boolean {
    return this.staticPassability.canOccupyAt(x, y, {
      consumer: 'dodge',
      safeWalk,
      checkFullOccupyNeighbors: true,
    });
  }

  /** Monotonic revision for the combat-enemy overlay (not static passability). */
  getEnemyRevision(): number {
    return this.enemyOverlay.getRevision();
  }

  enemyClearance(x: number, y: number): number {
    return this.enemyOverlay.clearanceAt(x, y);
  }

  isProjectileSegmentOpen(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    projectile: CombatProjectileSnapshot,
  ): boolean {
    const dx = toX - fromX;
    const dy = toY - fromY;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.25));
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      if (!this.isProjectilePathOpen(fromX + dx * ratio, fromY + dy * ratio, projectile)) {
        return false;
      }
    }
    return true;
  }

  private isProjectilePathOpen(x: number, y: number, projectile: CombatProjectileSnapshot): boolean {
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    const key = tileKey(tileX, tileY);
    const type = this.staticPassability.getObservedTileType(tileX, tileY);
    if (type === undefined || type === INVALID_TILE_TYPE || !this.staticPassability.inBounds(tileX, tileY)) {
      return false;
    }
    if ((this.enemyOccupyCounts.get(key) ?? 0) > 0) return false;
    const hasCover = this.staticPassability.hasOccupySquareAt(tileX, tileY)
      || (this.projectileCoverCounts.get(key) ?? 0) > 0;
    return projectile.definition.passesCover || !hasCover;
  }

  private adjust(counts: Map<number, number>, key: number, delta: number): void {
    if (delta === 0) return;
    const count = (counts.get(key) ?? 0) + delta;
    if (count > 0) counts.set(key, count);
    else counts.delete(key);
  }

  private touch(staticChanged: boolean, enemyChanged: boolean): void {
    if (!staticChanged && !enemyChanged) return;
    this.revision++;
    if (staticChanged) this.cachedSnapshot = undefined;
  }
}

function recordAffectsStaticCollision(record: DodgeObjectRecord): boolean {
  return record.occupySquare || record.fullOccupy || record.enemyOccupySquare;
}

function staticCollisionChanged(
  previous: DodgeObjectRecord | undefined,
  next: DodgeObjectRecord,
): boolean {
  if (!previous) return recordAffectsStaticCollision(next);
  return previous.key !== next.key
      && (recordAffectsStaticCollision(previous) || recordAffectsStaticCollision(next))
    || previous.occupySquare !== next.occupySquare
    || previous.fullOccupy !== next.fullOccupy
    || previous.enemyOccupySquare !== next.enemyOccupySquare;
}

function sameOptionalPosition(
  first: { x: number; y: number } | undefined,
  second: { x: number; y: number } | undefined,
): boolean {
  return !first || !second
    ? first === second
    : first.x === second.x && first.y === second.y;
}

/**
 * Packed 32-bit tile-key for Map<number, ...> lookups.
 * Assumes integer x, y in [-0x8000, 0x8000) — a RotMG map is 0-2048 tiles
 * so the range is comfortable. Squashes both coordinates into one integer to
 * skip string alloc + Map<string,_> hash-of-string overhead in hot paths.
 * P9 audit item tileKey-template-string-per-sample.
 */
function tileKey(x: number, y: number): number {
  return ((x + 0x8000) << 16) | ((y + 0x8000) & 0xffff);
}
