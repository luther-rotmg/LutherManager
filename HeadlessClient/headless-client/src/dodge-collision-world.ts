import type { CombatDataProvider, CombatProjectileSnapshot } from './combat-tracker';

interface DodgeObjectRecord {
  key: string;
  occupySquare: boolean;
  fullOccupy: boolean;
  enemyOccupySquare: boolean;
}

const INVALID_TILE_TYPE = 0xffff;
export const ENEMY_AVOID_RADIUS = 1.3;
const DISTANCE_EPSILON = 1e-9;

/** Incrementally maintained collision view used by predictive auto-dodge. */
export class DodgeCollisionWorld {
  private width = 0;
  private height = 0;
  private explorativeUnknown = false;
  private readonly tiles = new Map<string, number>();
  private readonly learnedBlocked = new Set<string>();
  private readonly objects = new Map<number, DodgeObjectRecord>();
  private readonly occupyCounts = new Map<string, number>();
  private readonly fullOccupyCounts = new Map<string, number>();
  private readonly enemyOccupyCounts = new Map<string, number>();
  private readonly combatEnemies = new Map<number, { x: number; y: number }>();

  constructor(private readonly data: CombatDataProvider) {}

  reset(): void {
    this.width = 0;
    this.height = 0;
    this.explorativeUnknown = false;
    this.tiles.clear();
    this.learnedBlocked.clear();
    this.objects.clear();
    this.occupyCounts.clear();
    this.fullOccupyCounts.clear();
    this.enemyOccupyCounts.clear();
    this.combatEnemies.clear();
  }

  setMapBounds(width: number, height: number): void {
    this.width = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
    this.height = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
  }

  observeTile(x: number, y: number, type: number): void {
    this.tiles.set(tileKey(Math.trunc(x), Math.trunc(y)), Math.trunc(type));
  }

  /** Allows in-bounds, unobserved cells while an exploratory path is active. */
  setExplorativeUnknown(enabled: boolean): void {
    this.explorativeUnknown = enabled;
  }

  /** Shares collision cells learned from authoritative pathfinding stalls. */
  markBlocked(x: number, y: number): void {
    this.learnedBlocked.add(tileKey(Math.floor(x), Math.floor(y)));
  }

  upsertObject(objectId: number, objectType: number, x: number, y: number): void {
    this.removeObject(objectId);
    const definition = this.data.getObject(objectType);
    if (!definition) return;
    const isCombatEnemy = !!definition.isEnemy && !definition.invincible;
    const record: DodgeObjectRecord = {
      key: tileKey(Math.floor(x), Math.floor(y)),
      occupySquare: !!definition.occupySquare,
      fullOccupy: !!definition.fullOccupy,
      enemyOccupySquare: !!definition.enemyOccupySquare,
    };
    if (!record.occupySquare && !record.fullOccupy && !record.enemyOccupySquare && !isCombatEnemy) return;
    this.objects.set(objectId, record);
    if (isCombatEnemy) this.combatEnemies.set(objectId, { x, y });
    this.adjust(this.occupyCounts, record.key, record.occupySquare ? 1 : 0);
    this.adjust(this.fullOccupyCounts, record.key, record.fullOccupy ? 1 : 0);
    this.adjust(this.enemyOccupyCounts, record.key, record.enemyOccupySquare ? 1 : 0);
  }

  removeObject(objectId: number): void {
    const record = this.objects.get(objectId);
    if (!record) return;
    this.objects.delete(objectId);
    this.combatEnemies.delete(objectId);
    this.adjust(this.occupyCounts, record.key, record.occupySquare ? -1 : 0);
    this.adjust(this.fullOccupyCounts, record.key, record.fullOccupy ? -1 : 0);
    this.adjust(this.enemyOccupyCounts, record.key, record.enemyOccupySquare ? -1 : 0);
  }

  canOccupy(x: number, y: number, safeWalk: boolean, avoidEnemies = true): boolean {
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    const key = tileKey(tileX, tileY);
    const type = this.tiles.get(key);
    if (!this.inBounds(tileX, tileY)
      || type === INVALID_TILE_TYPE
      || type === undefined && !this.explorativeUnknown
      || this.learnedBlocked.has(key)
      || type !== undefined && !!this.data.tileIsBlockingWalk?.(type)
      || type !== undefined && safeWalk && (this.data.getTileDamage?.(type) ?? 0) > 0
      || (this.occupyCounts.get(key) ?? 0) > 0) {
      return false;
    }

    if (avoidEnemies
      && this.enemyClearance(x, y) < ENEMY_AVOID_RADIUS - DISTANCE_EPSILON) return false;

    const fracX = x - tileX;
    const fracY = y - tileY;
    const minX = fracX < 0.5 ? tileX - 1 : tileX;
    const maxX = fracX > 0.5 ? tileX + 1 : tileX;
    const minY = fracY < 0.5 ? tileY - 1 : tileY;
    const maxY = fracY > 0.5 ? tileY + 1 : tileY;
    for (let neighborX = minX; neighborX <= maxX; neighborX++) {
      for (let neighborY = minY; neighborY <= maxY; neighborY++) {
        if (neighborX === tileX && neighborY === tileY) continue;
        const key = tileKey(neighborX, neighborY);
        const neighborType = this.tiles.get(key);
        if (!this.inBounds(neighborX, neighborY)
          || neighborType === INVALID_TILE_TYPE
          || neighborType === undefined && !this.explorativeUnknown
          || this.learnedBlocked.has(key)
          || (this.fullOccupyCounts.get(key) ?? 0) > 0) {
          return false;
        }
      }
    }
    return true;
  }

  enemyClearance(x: number, y: number): number {
    let clearance = Infinity;
    for (const enemy of this.combatEnemies.values()) {
      const dx = x - enemy.x;
      const dy = y - enemy.y;
      clearance = Math.min(clearance, Math.hypot(dx, dy));
    }
    return clearance;
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
    const type = this.tiles.get(key);
    if (type === undefined || type === INVALID_TILE_TYPE || !this.inBounds(tileX, tileY)) return false;
    if ((this.enemyOccupyCounts.get(key) ?? 0) > 0) return false;
    return projectile.definition.passesCover || (this.occupyCounts.get(key) ?? 0) === 0;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0
      && (this.width === 0 || x < this.width)
      && (this.height === 0 || y < this.height);
  }

  private adjust(counts: Map<string, number>, key: string, delta: number): void {
    if (delta === 0) return;
    const count = (counts.get(key) ?? 0) + delta;
    if (count > 0) counts.set(key, count);
    else counts.delete(key);
  }
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}
