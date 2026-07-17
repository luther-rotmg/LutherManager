import { ENEMY_AVOID_RADIUS, isEnemyProximityThreat } from './dodge-collision-world';
import type { DodgeMovementIntentId } from './dodge-movement-intent';

export interface PathfindingDataProvider {
  getObject(type: number): {
    occupySquare: boolean;
    isEnemy?: boolean;
    hasProjectiles?: boolean;
    invincible?: boolean;
    subattacks?: ReadonlyArray<{
      patterns: ReadonlyArray<{ projectileId: number }>;
    }>;
  } | undefined;
  getProjectile?(objectType: number, projectileId: number): unknown;
  tileIsBlockingWalk?(tileType: number): boolean;
  getTileDamage?(tileType: number): number | undefined;
}

export interface PathPoint {
  x: number;
  y: number;
}

export interface PathTarget extends PathPoint {
  threshold: number;
}

export interface CombatPathfindingRange {
  minimumDistance: number;
  preferredDistance: number;
  maximumDistance: number;
}

export interface PathfindingStep {
  waypoint?: PathPoint;
  waypointThreshold?: number;
  reached?: PathPoint;
  noPath?: boolean;
  replanned?: boolean;
}

export interface PathfindingIntentRevisions {
  logicalRevision: number;
  routeRevision: number;
}

interface GridPoint {
  x: number;
  y: number;
}

interface PlannedPath {
  startKey: string;
  rawTiles: GridPoint[];
  routeTiles: GridPoint[];
  tileKeys: Set<string>;
  waypoints: PathPoint[];
  targetBlocked: boolean;
  combat: boolean;
  revision: number;
}

interface SegmentTrace {
  travelTiles: GridPoint[];
  corridorTiles: GridPoint[];
}

interface OpenNode extends GridPoint {
  g: number;
  h: number;
  f: number;
  order: number;
}

const INVALID_TILE_TYPE = 0xffff;
const DIAGONAL_COST = Math.SQRT2;
const INTERMEDIATE_THRESHOLD = 0.25;
export const MAX_LOCAL_GOAL_DISTANCE = 5;
const BLOCKED_TARGET_SEARCH_RADIUS = 4;
const COMBAT_TARGET_REPLAN_DISTANCE = 0.35;
const ENEMY_POSITION_REPLAN_DISTANCE = 0.25;
const DISTANCE_EPSILON = 1e-9;

const DIRECTIONS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, DIAGONAL_COST],
  [1, -1, DIAGONAL_COST],
  [-1, 1, DIAGONAL_COST],
  [-1, -1, DIAGONAL_COST],
];

/**
 * Optimistic A* navigation over the map knowledge streamed by UPDATE packets.
 * Unknown cells have exactly the same traversal cost as observed walkable cells.
 */
export class ExplorativePathfinder {
  private width = 0;
  private height = 0;
  private readonly blockedTerrain = new Set<string>();
  private readonly learnedBlocked = new Set<string>();
  private readonly objectTiles = new Map<number, string>();
  private readonly objectBlockCounts = new Map<string, number>();
  private readonly enemyCandidates = new Map<number, PathPoint>();
  private readonly confirmedCombatEnemies = new Set<number>();
  private readonly combatEnemies = new Map<number, PathPoint>();
  private target: PathTarget | undefined;
  private combatRange: CombatPathfindingRange | undefined;
  private goalId: DodgeMovementIntentId | undefined;
  private combatTargetId: number | undefined;
  private logicalIntentRevision = 0;
  private routeRevision = 0;
  private plan: PlannedPath | undefined;
  private waypointIndex = 0;
  private revision = 0;
  private failedRevision = -1;
  private failedStartKey = '';

  constructor(private readonly data?: PathfindingDataProvider) {}

  resetMap(): void {
    this.width = 0;
    this.height = 0;
    this.blockedTerrain.clear();
    this.learnedBlocked.clear();
    this.objectTiles.clear();
    this.objectBlockCounts.clear();
    this.enemyCandidates.clear();
    this.confirmedCombatEnemies.clear();
    this.combatEnemies.clear();
    this.clearTarget();
    this.revision++;
  }

  setMapBounds(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
    const nextHeight = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.invalidate();
  }

  setTarget(target: PathPoint, threshold: number, goalId?: DodgeMovementIntentId): boolean {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)
      || !Number.isFinite(threshold) || threshold < 0) {
      return false;
    }
    const tileX = Math.floor(target.x);
    const tileY = Math.floor(target.y);
    if (!this.inBounds(tileX, tileY)) {
      return false;
    }
    if (!this.combatRange && this.target
      && this.target.x === target.x
      && this.target.y === target.y
      && this.target.threshold === threshold
      && sameIntentId(this.goalId, goalId)) {
      return true;
    }

    const sameLogicalIntent = !this.combatRange && !!this.target
      && sameGoalIdentity(this.target, this.goalId, target, threshold, goalId);
    if (!sameLogicalIntent) this.logicalIntentRevision++;
    const routeChanged = !this.target
      || this.combatRange !== undefined
      || distance(this.target, target) >= GOAL_MATERIAL_CHANGE_DISTANCE
      || Math.abs(this.target.threshold - threshold) > GOAL_THRESHOLD_CHANGE_TOLERANCE;
    this.combatRange = undefined;
    this.combatTargetId = undefined;
    this.goalId = goalId;
    this.target = { x: target.x, y: target.y, threshold };
    if (routeChanged) this.clearPlan();
    return true;
  }

  setCombatTarget(target: PathPoint, range: CombatPathfindingRange, targetId = 0): boolean {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)
      || !validCombatRange(range) || !Number.isInteger(targetId) || targetId < 0) {
      return false;
    }
    const tileX = Math.floor(target.x);
    const tileY = Math.floor(target.y);
    if (!this.inBounds(tileX, tileY)) return false;

    if (this.target && this.combatRange
      && sameCombatRange(this.combatRange, range)
      && sameCombatIdentity(this.combatTargetId, targetId, this.target, target)
      && distance(this.target, target) < COMBAT_TARGET_REPLAN_DISTANCE) {
      this.target = { x: target.x, y: target.y, threshold: INTERMEDIATE_THRESHOLD };
      return true;
    }

    const sameLogicalIntent = !!this.target && !!this.combatRange
      && sameCombatRange(this.combatRange, range)
      && sameCombatIdentity(this.combatTargetId, targetId, this.target, target);
    if (!sameLogicalIntent) this.logicalIntentRevision++;
    this.target = { x: target.x, y: target.y, threshold: INTERMEDIATE_THRESHOLD };
    this.combatRange = { ...range };
    this.goalId = undefined;
    this.combatTargetId = targetId;
    this.clearPlan();
    return true;
  }

  clearTarget(): void {
    if (this.target) this.logicalIntentRevision++;
    this.target = undefined;
    this.combatRange = undefined;
    this.goalId = undefined;
    this.combatTargetId = undefined;
    this.clearPlan();
  }

  hasTarget(): boolean {
    return this.target !== undefined;
  }

  getTarget(): PathTarget | undefined {
    return this.target ? { ...this.target } : undefined;
  }

  getIntentRevisions(): PathfindingIntentRevisions {
    return {
      logicalRevision: this.logicalIntentRevision,
      routeRevision: this.routeRevision,
    };
  }

  getRemainingPath(): PathPoint[] {
    return this.plan?.waypoints.slice(this.waypointIndex).map((point) => ({ ...point })) ?? [];
  }

  getPlannedTiles(): PathPoint[] {
    return this.plan?.rawTiles.map((point) => ({ ...point })) ?? [];
  }

  observeTile(x: number, y: number, tileType: number): void {
    const key = tileKey(Math.trunc(x), Math.trunc(y));
    const blocked = tileType === INVALID_TILE_TYPE
      || !!this.data?.tileIsBlockingWalk?.(tileType)
      || (this.data?.getTileDamage?.(tileType) ?? 0) > 0;
    const changed = blocked ? add(this.blockedTerrain, key) : this.blockedTerrain.delete(key);
    if (changed) this.invalidate();
  }

  upsertObject(objectId: number, objectType: number, x: number, y: number): void {
    const oldKey = this.objectTiles.get(objectId);
    const definition = this.data?.getObject(objectType);
    const newKey = definition?.occupySquare ? tileKey(Math.floor(x), Math.floor(y)) : undefined;
    let changed = false;

    if (oldKey !== newKey && oldKey !== undefined) {
      this.adjustObjectBlockCount(oldKey, -1);
      this.objectTiles.delete(objectId);
      changed = true;
    }
    if (oldKey !== newKey && newKey !== undefined) {
      this.objectTiles.set(objectId, newKey);
      this.adjustObjectBlockCount(newKey, 1);
      changed = true;
    }

    const oldEnemy = this.combatEnemies.get(objectId);
    const enemyCandidate = !!definition?.isEnemy;
    if (!enemyCandidate) {
      this.enemyCandidates.delete(objectId);
      this.confirmedCombatEnemies.delete(objectId);
      if (oldEnemy) {
        this.combatEnemies.delete(objectId);
        changed = changed || !!this.combatRange;
      }
    } else {
      this.enemyCandidates.set(objectId, { x, y });
      const isCombatThreat = isEnemyProximityThreat(this.data!, objectType)
        || this.confirmedCombatEnemies.has(objectId);
      if (!isCombatThreat) {
        if (oldEnemy) {
          this.combatEnemies.delete(objectId);
          changed = changed || !!this.combatRange;
        }
      } else if (!oldEnemy || !this.combatRange
        || distance(oldEnemy, { x, y }) >= ENEMY_POSITION_REPLAN_DISTANCE) {
        this.combatEnemies.set(objectId, { x, y });
        changed = changed || !!this.combatRange;
      }
    }

    if (changed) this.invalidate();
  }

  removeObject(objectId: number): void {
    const key = this.objectTiles.get(objectId);
    let changed = false;
    if (key !== undefined) {
      this.objectTiles.delete(objectId);
      this.adjustObjectBlockCount(key, -1);
      changed = true;
    }
    this.enemyCandidates.delete(objectId);
    this.confirmedCombatEnemies.delete(objectId);
    if (this.combatEnemies.delete(objectId) && this.combatRange) changed = true;
    if (changed) this.invalidate();
  }

  /** Promotes an enemy-tagged object after an authoritative EnemyShoot packet. */
  markEnemyThreat(objectId: number): void {
    const enemy = this.enemyCandidates.get(objectId);
    if (!enemy) return;
    this.confirmedCombatEnemies.add(objectId);
    if (this.combatEnemies.has(objectId)) return;
    this.combatEnemies.set(objectId, { ...enemy });
    if (this.combatRange) this.invalidate();
  }

  next(position: PathPoint): PathfindingStep {
    const target = this.target;
    if (!target) return {};
    // MAPINFO supplies finite bounds before navigation can prove reachability.
    // Keeping the target pending avoids treating a search budget as "no path".
    if (this.width <= 0 || this.height <= 0) return {};
    if (this.combatRange && withinCombatRange(position, target, this.combatRange)) {
      this.plan = undefined;
      this.waypointIndex = 0;
      return {};
    }
    if (!this.combatRange && distance(position, target) <= target.threshold) {
      return this.finishTarget();
    }

    let replanned = false;
    const positionKey = tileKey(Math.floor(position.x), Math.floor(position.y));
    if (this.plan && this.plan.revision === this.revision
      && positionKey !== this.plan.startKey && !this.plan.tileKeys.has(positionKey)) {
      this.plan = undefined;
      this.waypointIndex = 0;
    }
    if (!this.plan && this.failedRevision === this.revision && this.failedStartKey === positionKey) {
      return { noPath: true };
    }
    if (!this.plan || this.plan.revision !== this.revision) {
      this.plan = this.buildPlan(position, target);
      this.routeRevision++;
      this.waypointIndex = 0;
      replanned = true;
    }
    if (!this.plan) {
      this.failedRevision = this.revision;
      this.failedStartKey = positionKey;
      return { noPath: true, replanned };
    }
    this.failedRevision = -1;
    this.failedStartKey = '';

    while (this.waypointIndex < this.plan.waypoints.length) {
      const waypoint = this.plan.waypoints[this.waypointIndex]!;
      const final = this.waypointIndex === this.plan.waypoints.length - 1;
      const threshold = final && !this.plan.targetBlocked && !this.plan.combat
        ? target.threshold
        : INTERMEDIATE_THRESHOLD;
      if (distance(position, waypoint) > threshold) {
        return { waypoint: { ...waypoint }, waypointThreshold: threshold, replanned };
      }
      this.waypointIndex++;
    }

    if (this.combatRange) {
      this.plan = undefined;
      this.waypointIndex = 0;
      return { replanned };
    }
    return this.finishTarget();
  }

  /**
   * Test-only incremental driver: resolves goals like buildPlan and runs PathSearch
   * with step(budgetPerStep) until found/no_path.
   */
  runPathSearchToCompletion(
    position: PathPoint,
    budgetPerStep = Number.POSITIVE_INFINITY,
  ): GridPoint[] | undefined {
    const target = this.target;
    if (!target || this.width <= 0 || this.height <= 0) return undefined;
    const start = { x: Math.floor(position.x), y: Math.floor(position.y) };
    return this.searchRawTiles(start, target, budgetPerStep);
  }

  /** Learns the first unentered route cell as blocked after an authoritative movement stall. */
  reportStall(position: PathPoint): PathPoint | undefined {
    const plan = this.plan;
    if (!plan) return undefined;
    const currentKey = tileKey(Math.floor(position.x), Math.floor(position.y));
    const currentIndex = plan.routeTiles.findIndex((point) => tileKey(point.x, point.y) === currentKey);
    const blocked = plan.routeTiles[currentIndex >= 0 ? currentIndex + 1 : 0];
    if (!blocked || tileKey(blocked.x, blocked.y) === plan.startKey) return undefined;
    if (add(this.learnedBlocked, tileKey(blocked.x, blocked.y))) {
      this.invalidate();
    }
    return { x: blocked.x, y: blocked.y };
  }

  private finishTarget(): PathfindingStep {
    const reached = this.target ? { x: this.target.x, y: this.target.y } : undefined;
    this.clearTarget();
    return reached ? { reached } : {};
  }

  private buildPlan(position: PathPoint, target: PathTarget): PlannedPath | undefined {
    const start = { x: Math.floor(position.x), y: Math.floor(position.y) };
    const combat = !!this.combatRange;
    let targetBlocked = false;
    if (!this.combatRange) {
      const goal = { x: Math.floor(target.x), y: Math.floor(target.y) };
      targetBlocked = this.isBlocked(goal.x, goal.y, start);
    }
    const rawTiles = this.searchRawTiles(start, target, Number.POSITIVE_INFINITY);
    if (!rawTiles) return undefined;
    let waypoints: PathPoint[];
    if (rawTiles.length === 0) {
      waypoints = targetBlocked || combat ? [] : [{ x: target.x, y: target.y }];
    } else {
      const candidates = compressPath(start, rawTiles);
      if (!targetBlocked && !combat) {
        candidates[candidates.length - 1] = { x: target.x, y: target.y };
      }
      const vectorized = this.vectorizePath(position, start, candidates);
      if (!vectorized) return undefined;
      waypoints = vectorized;
    }

    const startKey = tileKey(start.x, start.y);
    const route = this.traceRoute(position, start, waypoints);
    if (!route) return undefined;
    return {
      startKey,
      rawTiles,
      routeTiles: route.travelTiles.filter((point) => tileKey(point.x, point.y) !== startKey),
      tileKeys: new Set([
        startKey,
        ...route.corridorTiles.map((point) => tileKey(point.x, point.y)),
      ]),
      waypoints,
      targetBlocked,
      combat,
      revision: this.revision,
    };
  }

  private combatGoals(
    target: PathPoint,
    start: GridPoint,
    range: CombatPathfindingRange,
  ): GridPoint[] {
    const goals: Array<GridPoint & { preference: number }> = [];
    const minX = Math.floor(target.x - range.maximumDistance - 0.5);
    const maxX = Math.ceil(target.x + range.maximumDistance - 0.5);
    const minY = Math.floor(target.y - range.maximumDistance - 0.5);
    const maxY = Math.ceil(target.y + range.maximumDistance - 0.5);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (x === start.x && y === start.y) continue;
        const center = tileCenter({ x, y });
        const targetDistance = distance(center, target);
        if (targetDistance < range.minimumDistance || targetDistance > range.maximumDistance
          || this.isPathBlocked(x, y, start)) {
          continue;
        }
        goals.push({ x, y, preference: Math.abs(targetDistance - range.preferredDistance) });
      }
    }
    goals.sort((a, b) => a.preference - b.preference);
    return goals.map(({ x, y }) => ({ x, y }));
  }

  /** Pulls the grid route taut into the longest collision-free movement vectors. */
  private vectorizePath(
    position: PathPoint,
    start: GridPoint,
    candidates: PathPoint[],
  ): PathPoint[] | undefined {
    const result: PathPoint[] = [];
    let anchor = { ...position };
    let candidateIndex = 0;
    let centeredOnStart = false;

    while (candidateIndex < candidates.length) {
      let selectedIndex = -1;
      for (let index = candidates.length - 1; index >= candidateIndex; index--) {
        if (this.traceSegment(anchor, candidates[index]!, start)) {
          selectedIndex = index;
          break;
        }
      }

      if (selectedIndex < 0) {
        const startCenter = tileCenter(start);
        if (centeredOnStart || distance(anchor, startCenter) <= Number.EPSILON
          || !this.traceSegment(anchor, startCenter, start)) {
          return undefined;
        }
        result.push(startCenter);
        anchor = startCenter;
        centeredOnStart = true;
        continue;
      }

      const selected = candidates[selectedIndex]!;
      appendBoundedWaypoints(result, anchor, selected, MAX_LOCAL_GOAL_DISTANCE);
      anchor = selected;
      candidateIndex = selectedIndex + 1;
    }

    return result;
  }

  private traceRoute(
    position: PathPoint,
    start: GridPoint,
    waypoints: PathPoint[],
  ): SegmentTrace | undefined {
    const travelTiles: GridPoint[] = [];
    const corridorTiles: GridPoint[] = [];
    const corridorKeys = new Set<string>();
    let anchor = { ...position };

    for (const waypoint of waypoints) {
      const segment = this.traceSegment(anchor, waypoint, start);
      if (!segment) return undefined;
      for (const point of segment.travelTiles) {
        const previous = travelTiles[travelTiles.length - 1];
        if (!previous || previous.x !== point.x || previous.y !== point.y) {
          travelTiles.push(point);
        }
      }
      for (const point of segment.corridorTiles) {
        const key = tileKey(point.x, point.y);
        if (corridorKeys.has(key)) continue;
        corridorKeys.add(key);
        corridorTiles.push(point);
      }
      anchor = waypoint;
    }

    return { travelTiles, corridorTiles };
  }

  /**
   * Traces every grid cell crossed by a vector. Exact corner crossings require
   * both neighboring cells to be open, matching A*'s no-corner-cutting rule.
   */
  private traceSegment(from: PathPoint, to: PathPoint, start: GridPoint): SegmentTrace | undefined {
    let cellX = Math.floor(from.x);
    let cellY = Math.floor(from.y);
    const endX = Math.floor(to.x);
    const endY = Math.floor(to.y);
    if (this.isPathBlocked(cellX, cellY, start) || !this.segmentAvoidsCombatEnemies(from, to)) {
      return undefined;
    }

    const travelTiles: GridPoint[] = [{ x: cellX, y: cellY }];
    const corridorTiles: GridPoint[] = [{ x: cellX, y: cellY }];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const stepX = Math.sign(dx);
    const stepY = Math.sign(dy);
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = stepY === 0 ? Infinity : Math.abs(1 / dy);
    let tMaxX = stepX > 0
      ? (cellX + 1 - from.x) / dx
      : stepX < 0 ? (from.x - cellX) / -dx : Infinity;
    let tMaxY = stepY > 0
      ? (cellY + 1 - from.y) / dy
      : stepY < 0 ? (from.y - cellY) / -dy : Infinity;

    while (cellX !== endX || cellY !== endY) {
      if (Math.abs(tMaxX - tMaxY) <= 1e-10) {
        const sideX = { x: cellX + stepX, y: cellY };
        const sideY = { x: cellX, y: cellY + stepY };
        if (this.isPathBlocked(sideX.x, sideX.y, start)
          || this.isPathBlocked(sideY.x, sideY.y, start)) {
          return undefined;
        }
        corridorTiles.push(sideX, sideY);
        cellX += stepX;
        cellY += stepY;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      } else if (tMaxX < tMaxY) {
        cellX += stepX;
        tMaxX += tDeltaX;
      } else {
        cellY += stepY;
        tMaxY += tDeltaY;
      }

      if (this.isPathBlocked(cellX, cellY, start)) return undefined;
      const point = { x: cellX, y: cellY };
      travelTiles.push(point);
      corridorTiles.push(point);
    }

    return { travelTiles, corridorTiles };
  }

  private nearbyGoals(goal: GridPoint, start: GridPoint, radius: number): GridPoint[] {
    const goals: GridPoint[] = [];
    for (let y = goal.y - radius; y <= goal.y + radius; y++) {
      for (let x = goal.x - radius; x <= goal.x + radius; x++) {
        if (Math.max(Math.abs(x - goal.x), Math.abs(y - goal.y)) !== radius) continue;
        if (!this.isBlocked(x, y, start)) goals.push({ x, y });
      }
    }
    return goals;
  }

  private searchRawTiles(
    start: GridPoint,
    target: PathTarget,
    budgetPerStep: number,
  ): GridPoint[] | undefined {
    if (this.combatRange) {
      const goals = this.combatGoals(target, start, this.combatRange);
      if (goals.length > 0) return this.runPathSearch(start, goals, budgetPerStep);
      return undefined;
    }

    const goal = { x: Math.floor(target.x), y: Math.floor(target.y) };
    if (this.isBlocked(goal.x, goal.y, start)) {
      for (let radius = 1; radius <= BLOCKED_TARGET_SEARCH_RADIUS; radius++) {
        const goals = this.nearbyGoals(goal, start, radius);
        if (goals.some((candidate) => candidate.x === start.x && candidate.y === start.y)) {
          return [];
        }
        if (goals.length > 0) {
          const result = this.runPathSearch(start, goals, budgetPerStep);
          if (result) return result;
        }
      }
      return undefined;
    }
    if (goal.x === start.x && goal.y === start.y) {
      return [];
    }
    return this.runPathSearch(start, [goal], budgetPerStep);
  }

  private runPathSearch(
    start: GridPoint,
    goals: GridPoint[],
    budgetPerStep: number,
  ): GridPoint[] | undefined {
    const search = new PathSearch({
      start,
      goals,
      isPathBlocked: (x, y, s) => this.isPathBlocked(x, y, s),
      mapVersion: this.revision,
    });
    while (search.step(budgetPerStep) === 'searching') {}
    return search.getPath();
  }

  private isBlocked(x: number, y: number, start?: GridPoint): boolean {
    if (start && x === start.x && y === start.y) return false;
    if (!this.inBounds(x, y)) return true;
    const key = tileKey(x, y);
    return this.blockedTerrain.has(key)
      || this.learnedBlocked.has(key)
      || (this.objectBlockCounts.get(key) ?? 0) > 0;
  }

  private isPathBlocked(x: number, y: number, start?: GridPoint): boolean {
    if (this.isBlocked(x, y, start)) return true;
    if (!this.combatRange || !this.target || start && x === start.x && y === start.y) return false;
    const point = tileCenter({ x, y });
    const startPoint = start ? tileCenter(start) : undefined;
    if (violatesExclusion(point, this.target, this.combatRange.minimumDistance, startPoint)) {
      return true;
    }
    for (const enemy of this.combatEnemies.values()) {
      if (violatesExclusion(point, enemy, ENEMY_AVOID_RADIUS, startPoint)) return true;
    }
    return false;
  }

  private segmentAvoidsCombatEnemies(from: PathPoint, to: PathPoint): boolean {
    if (!this.combatRange || !this.target) return true;
    if (!segmentClearsCircle(from, to, this.target, this.combatRange.minimumDistance)) return false;
    for (const enemy of this.combatEnemies.values()) {
      if (!segmentClearsCircle(from, to, enemy, ENEMY_AVOID_RADIUS)) return false;
    }
    return true;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0
      && (this.width === 0 || x < this.width)
      && (this.height === 0 || y < this.height);
  }

  private adjustObjectBlockCount(key: string, delta: number): void {
    const count = (this.objectBlockCounts.get(key) ?? 0) + delta;
    if (count > 0) this.objectBlockCounts.set(key, count);
    else this.objectBlockCounts.delete(key);
  }

  private invalidate(): void {
    this.revision++;
  }

  private clearPlan(): void {
    this.plan = undefined;
    this.waypointIndex = 0;
    this.failedRevision = -1;
    this.failedStartKey = '';
  }
}

type PathSearchStatus = 'searching' | 'found' | 'no_path';

interface PathSearchParams {
  start: GridPoint;
  goals: ReadonlyArray<GridPoint>;
  isPathBlocked: (x: number, y: number, start: GridPoint) => boolean;
  mapVersion: number;
}

class PathSearch {
  private readonly start: GridPoint;
  private readonly startKey: string;
  private readonly goals: ReadonlyArray<GridPoint>;
  private readonly goalKeys: Set<string>;
  private readonly isPathBlocked: (x: number, y: number, start: GridPoint) => boolean;
  private readonly mapVersion: number;
  private readonly open = new MinHeap();
  private readonly bestG = new Map<string, number>();
  private readonly cameFrom = new Map<string, string>();
  private readonly points = new Map<string, GridPoint>();
  private order = 0;
  private expansions = 0;
  private status: PathSearchStatus = 'searching';
  private resultPath: GridPoint[] | undefined;

  constructor(params: PathSearchParams) {
    this.start = params.start;
    this.startKey = tileKey(this.start.x, this.start.y);
    this.goals = params.goals;
    this.goalKeys = new Set(params.goals.map((goal) => tileKey(goal.x, goal.y)));
    this.isPathBlocked = params.isPathBlocked;
    this.mapVersion = params.mapVersion;

    this.bestG.set(this.startKey, 0);
    this.points.set(this.startKey, this.start);
    const startH = heuristic(this.start, this.goals);
    this.open.push({ ...this.start, g: 0, h: startH, f: startH, order: this.order++ });
  }

  step(budget: number): PathSearchStatus {
    void budget;
    if (this.status !== 'searching') {
      return this.status;
    }

    while (this.open.size > 0) {
      const current = this.open.pop()!;
      const currentKey = tileKey(current.x, current.y);
      if (current.g !== this.bestG.get(currentKey)) continue;
      this.expansions++;
      if (this.goalKeys.has(currentKey)) {
        this.resultPath = reconstruct(currentKey, this.startKey, this.cameFrom, this.points);
        this.status = 'found';
        return 'found';
      }

      for (const [dx, dy, moveCost] of DIRECTIONS) {
        const x = current.x + dx;
        const y = current.y + dy;
        if (this.isPathBlocked(x, y, this.start)) continue;
        if (dx !== 0 && dy !== 0
          && (this.isPathBlocked(current.x + dx, current.y, this.start)
            || this.isPathBlocked(current.x, current.y + dy, this.start))) {
          continue;
        }
        const key = tileKey(x, y);
        const g = current.g + moveCost;
        if (g >= (this.bestG.get(key) ?? Infinity)) continue;
        const point = { x, y };
        const h = heuristic(point, this.goals);
        this.bestG.set(key, g);
        this.cameFrom.set(key, currentKey);
        this.points.set(key, point);
        this.open.push({ ...point, g, h, f: g + h, order: this.order++ });
      }
    }
    this.status = 'no_path';
    return 'no_path';
  }

  getStatus(): PathSearchStatus {
    return this.status;
  }

  getPath(): GridPoint[] | undefined {
    return this.status === 'found' ? this.resultPath : undefined;
  }
}

function appendBoundedWaypoints(
  result: PathPoint[],
  from: PathPoint,
  to: PathPoint,
  maximumDistance: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const segmentDistance = Math.hypot(dx, dy);
  const segmentCount = Math.max(1, Math.ceil(segmentDistance / maximumDistance));
  for (let segment = 1; segment <= segmentCount; segment++) {
    const ratio = segment / segmentCount;
    result.push({ x: from.x + dx * ratio, y: from.y + dy * ratio });
  }
}

class MinHeap {
  private readonly values: OpenNode[] = [];

  get size(): number {
    return this.values.length;
  }

  push(value: OpenNode): void {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!less(value, this.values[parent]!)) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): OpenNode | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && less(this.values[right]!, this.values[left]!) ? right : left;
      if (!less(this.values[child]!, last)) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function less(a: OpenNode, b: OpenNode): boolean {
  return a.f < b.f || (a.f === b.f && (a.h < b.h || (a.h === b.h && a.order < b.order)));
}

function heuristic(point: GridPoint, goals: ReadonlyArray<GridPoint>): number {
  let best = Infinity;
  for (const goal of goals) {
    const dx = Math.abs(goal.x - point.x);
    const dy = Math.abs(goal.y - point.y);
    const value = Math.max(dx, dy) + (DIAGONAL_COST - 1) * Math.min(dx, dy);
    if (value < best) best = value;
  }
  return best;
}

function reconstruct(
  goalKey: string,
  startKey: string,
  parent: Map<string, string>,
  points: Map<string, GridPoint>,
): GridPoint[] {
  const result: GridPoint[] = [];
  let cursor = goalKey;
  while (cursor !== startKey) {
    const point = points.get(cursor);
    const previous = parent.get(cursor);
    if (!point || !previous) return [];
    result.push(point);
    cursor = previous;
  }
  result.reverse();
  return result;
}

function compressPath(start: GridPoint, raw: GridPoint[]): PathPoint[] {
  if (raw.length === 0) return [];
  const result: PathPoint[] = [];
  let previous = raw[0]!;
  let directionX = raw[0]!.x - start.x;
  let directionY = raw[0]!.y - start.y;
  for (let index = 1; index < raw.length; index++) {
    const point = raw[index]!;
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    if (dx !== directionX || dy !== directionY) {
      result.push(tileCenter(previous));
      directionX = dx;
      directionY = dy;
    }
    previous = point;
  }
  result.push(tileCenter(raw[raw.length - 1]!));
  return result;
}

function tileCenter(point: GridPoint): PathPoint {
  return { x: point.x + 0.5, y: point.y + 0.5 };
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function distance(a: PathPoint, b: PathPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function validCombatRange(range: CombatPathfindingRange): boolean {
  return Number.isFinite(range.minimumDistance)
    && Number.isFinite(range.preferredDistance)
    && Number.isFinite(range.maximumDistance)
    && range.minimumDistance >= ENEMY_AVOID_RADIUS
    && range.minimumDistance <= range.preferredDistance
    && range.preferredDistance <= range.maximumDistance;
}

function sameCombatRange(a: CombatPathfindingRange, b: CombatPathfindingRange): boolean {
  return a.minimumDistance === b.minimumDistance
    && a.preferredDistance === b.preferredDistance
    && a.maximumDistance === b.maximumDistance;
}

const GOAL_MATERIAL_CHANGE_DISTANCE = 0.5;
const GOAL_THRESHOLD_CHANGE_TOLERANCE = 0.1;
const LEGACY_COMBAT_IDENTITY_DISTANCE = 4;

function sameIntentId(
  a: DodgeMovementIntentId | undefined,
  b: DodgeMovementIntentId | undefined,
): boolean {
  return a === b;
}

function sameGoalIdentity(
  current: PathTarget,
  currentId: DodgeMovementIntentId | undefined,
  next: PathPoint,
  nextThreshold: number,
  nextId: DodgeMovementIntentId | undefined,
): boolean {
  if (currentId !== undefined || nextId !== undefined) return sameIntentId(currentId, nextId);
  return distance(current, next) < GOAL_MATERIAL_CHANGE_DISTANCE
    && Math.abs(current.threshold - nextThreshold) <= GOAL_THRESHOLD_CHANGE_TOLERANCE;
}

function sameCombatIdentity(
  currentId: number | undefined,
  nextId: number,
  current: PathPoint,
  next: PathPoint,
): boolean {
  if ((currentId ?? 0) > 0 || nextId > 0) return currentId === nextId;
  return distance(current, next) < LEGACY_COMBAT_IDENTITY_DISTANCE;
}

function withinCombatRange(
  position: PathPoint,
  target: PathPoint,
  range: CombatPathfindingRange,
): boolean {
  const targetDistance = distance(position, target);
  return targetDistance >= range.minimumDistance && targetDistance <= range.maximumDistance;
}

function segmentClearsCircle(
  from: PathPoint,
  to: PathPoint,
  center: PathPoint,
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

function violatesExclusion(
  point: PathPoint,
  center: PathPoint,
  radius: number,
  start: PathPoint | undefined,
): boolean {
  const pointDistance = distance(point, center);
  if (pointDistance >= radius - DISTANCE_EPSILON) return false;
  if (!start) return true;
  const startDistance = distance(start, center);
  return startDistance >= radius - DISTANCE_EPSILON
    || pointDistance <= startDistance + DISTANCE_EPSILON;
}

function add(values: Set<string>, value: string): boolean {
  if (values.has(value)) return false;
  values.add(value);
  return true;
}
