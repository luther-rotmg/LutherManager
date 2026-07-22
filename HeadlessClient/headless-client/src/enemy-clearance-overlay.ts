/**
 * Commit 5.4 — Hard enemy clearance overlay (Euclidean, not static grid).
 *
 * Combat enemy positions live here, keyed by enemyRevision. Static passability
 * dilation and terrain revision never include this layer.
 */

/** Hard movement exclusion around confirmed projectile-capable combat enemies, in tiles. */
export const ENEMY_AVOID_RADIUS = 1.0;
/** Outer edge of the nonlinear enemy-proximity cost, in tiles. */
export const ENEMY_SOFT_AVOID_RADIUS = 2.3;

const DISTANCE_EPSILON = 1e-9;

export interface EnemyPosition {
  x: number;
  y: number;
}

/**
 * Versioned combat-enemy list used as an overlay on static passability.
 * Bumps enemyRevision on any membership or position change.
 */
export class EnemyClearanceOverlay {
  private readonly enemies = new Map<number, EnemyPosition>();
  private revision = 0;

  reset(): void {
    if (this.enemies.size === 0) return;
    this.enemies.clear();
    this.revision++;
  }

  /** Monotonic revision bumped by enemy membership or position changes. */
  getRevision(): number {
    return this.revision;
  }

  has(objectId: number): boolean {
    return this.enemies.has(objectId);
  }

  get(objectId: number): EnemyPosition | undefined {
    const enemy = this.enemies.get(objectId);
    return enemy ? { ...enemy } : undefined;
  }

  /** @returns true when the stored enemy list changed. */
  set(objectId: number, position: EnemyPosition): boolean {
    const previous = this.enemies.get(objectId);
    if (previous && previous.x === position.x && previous.y === position.y) return false;
    this.enemies.set(objectId, { x: position.x, y: position.y });
    this.revision++;
    return true;
  }

  /** @returns true when the stored enemy list changed. */
  delete(objectId: number): boolean {
    if (!this.enemies.delete(objectId)) return false;
    this.revision++;
    return true;
  }

  forEach(callback: (position: EnemyPosition, objectId: number) => void): void {
    for (const [objectId, position] of this.enemies) {
      callback(position, objectId);
    }
  }

  /** Euclidean distance to the nearest tracked combat enemy. */
  clearanceAt(x: number, y: number): number {
    let clearance = Infinity;
    for (const enemy of this.enemies.values()) {
      clearance = Math.min(clearance, euclideanDistance({ x, y }, enemy));
    }
    return clearance;
  }

  satisfiesHardClearance(x: number, y: number): boolean {
    return this.clearanceAt(x, y) >= ENEMY_AVOID_RADIUS - DISTANCE_EPSILON;
  }

  /** Integer-tile pathfinding check at tile center with optional start exemption. */
  tileCenterViolatesHardClearance(
    tileX: number,
    tileY: number,
    startPoint?: EnemyPosition,
  ): boolean {
    const point = { x: tileX + 0.5, y: tileY + 0.5 };
    for (const enemy of this.enemies.values()) {
      if (pointViolatesCircularExclusion(point, enemy, ENEMY_AVOID_RADIUS, startPoint)) {
        return true;
      }
    }
    return false;
  }

  /** Swept segment check against every tracked enemy hard-exclusion disc. */
  segmentAvoidsHardClearance(from: EnemyPosition, to: EnemyPosition): boolean {
    for (const enemy of this.enemies.values()) {
      if (!segmentClearsCircle(from, to, enemy, ENEMY_AVOID_RADIUS)) return false;
    }
    return true;
  }

  /** @internal Snapshot sampling copies enemy positions without exposing the map. */
  copyEnemyPositions(): EnemyPosition[] {
    return [...this.enemies.values()].map((enemy) => ({ ...enemy }));
  }
}

export function euclideanDistance(a: EnemyPosition, b: EnemyPosition): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}

export function pointViolatesCircularExclusion(
  point: EnemyPosition,
  center: EnemyPosition,
  radius: number,
  start: EnemyPosition | undefined,
): boolean {
  const pointDistance = euclideanDistance(point, center);
  if (pointDistance >= radius - DISTANCE_EPSILON) return false;
  if (!start) return true;
  const startDistance = euclideanDistance(start, center);
  return startDistance >= radius - DISTANCE_EPSILON
    || pointDistance <= startDistance + DISTANCE_EPSILON;
}

export function segmentClearsCircle(
  from: EnemyPosition,
  to: EnemyPosition,
  center: EnemyPosition,
  radius: number,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const fromX = from.x - center.x;
  const fromY = from.y - center.y;
  const fromDistanceSquared = fromX * fromX + fromY * fromY;
  const radiusSquared = radius * radius;
  if (lengthSquared <= DISTANCE_EPSILON) {
    return fromDistanceSquared >= radiusSquared - DISTANCE_EPSILON;
  }

  const projection = -(fromX * dx + fromY * dy) / lengthSquared;
  const toX = to.x - center.x;
  const toY = to.y - center.y;
  const toDistanceSquared = toX * toX + toY * toY;
  if (fromDistanceSquared < radiusSquared - DISTANCE_EPSILON) {
    return projection <= 0 && toDistanceSquared > fromDistanceSquared;
  }

  const closest = Math.max(0, Math.min(1, projection));
  const closestX = fromX + dx * closest;
  const closestY = fromY + dy * closest;
  return closestX * closestX + closestY * closestY >= radiusSquared - DISTANCE_EPSILON;
}
