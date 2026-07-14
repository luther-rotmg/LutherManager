import { ENEMY_AVOID_RADIUS } from './dodge-collision-world';

export interface PathfindingDataProvider {
  getObject(type: number): {
    occupySquare: boolean;
    isEnemy?: boolean;
    invincible?: boolean;
  } | undefined;
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
const BLOCKED_TARGET_SEARCH_RADIUS = 4;
const MAX_EXPANDED_NODES = 200_000;
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
  private readonly combatEnemies = new Map<number, PathPoint>();
  private target: PathTarget | undefined;
  private combatRange: CombatPathfindingRange | undefined;
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

  setTarget(target: PathPoint, threshold: number): boolean {
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
      && this.target.threshold === threshold) {
      return true;
    }
    this.combatRange = undefined;
    this.target = { x: target.x, y: target.y, threshold };
    this.plan = undefined;
    this.waypointIndex = 0;
    this.failedRevision = -1;
    this.failedStartKey = '';
    return true;
  }

  setCombatTarget(target: PathPoint, range: CombatPathfindingRange): boolean {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)
      || !validCombatRange(range)) {
      return false;
    }
    const tileX = Math.floor(target.x);
    const tileY = Math.floor(target.y);
    if (!this.inBounds(tileX, tileY)) return false;

    if (this.target && this.combatRange
      && sameCombatRange(this.combatRange, range)
      && distance(this.target, target) < COMBAT_TARGET_REPLAN_DISTANCE) {
      return true;
    }

    this.target = { x: target.x, y: target.y, threshold: INTERMEDIATE_THRESHOLD };
    this.combatRange = { ...range };
    this.plan = undefined;
    this.waypointIndex = 0;
    this.failedRevision = -1;
    this.failedStartKey = '';
    return true;
  }

  clearTarget(): void {
    this.target = undefined;
    this.combatRange = undefined;
    this.plan = undefined;
    this.waypointIndex = 0;
    this.failedRevision = -1;
    this.failedStartKey = '';
  }

  hasTarget(): boolean {
    return this.target !== undefined;
  }

  getTarget(): PathTarget | undefined {
    return this.target ? { ...this.target } : undefined;
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
    const isCombatEnemy = !!definition?.isEnemy && !definition.invincible;
    if (!isCombatEnemy) {
      if (oldEnemy) {
        this.combatEnemies.delete(objectId);
        changed = changed || !!this.combatRange;
      }
    } else if (!oldEnemy || !this.combatRange
      || distance(oldEnemy, { x, y }) >= ENEMY_POSITION_REPLAN_DISTANCE) {
      this.combatEnemies.set(objectId, { x, y });
      changed = changed || !!this.combatRange;
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
    if (this.combatEnemies.delete(objectId) && this.combatRange) changed = true;
    if (changed) this.invalidate();
  }

  next(position: PathPoint): PathfindingStep {
    const target = this.target;
    if (!target) return {};
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
    let rawTiles: GridPoint[] | undefined;
    if (this.combatRange) {
      const goals = this.combatGoals(target, start, this.combatRange);
      if (goals.length > 0) rawTiles = this.aStar(start, goals);
    } else {
      const goal = { x: Math.floor(target.x), y: Math.floor(target.y) };
      targetBlocked = this.isBlocked(goal.x, goal.y, start);
      if (targetBlocked) {
        for (let radius = 1; radius <= BLOCKED_TARGET_SEARCH_RADIUS && !rawTiles; radius++) {
          const goals = this.nearbyGoals(goal, start, radius);
          if (goals.some((candidate) => candidate.x === start.x && candidate.y === start.y)) {
            rawTiles = [];
            break;
          }
          if (goals.length > 0) rawTiles = this.aStar(start, goals);
        }
      } else if (goal.x === start.x && goal.y === start.y) {
        rawTiles = [];
      } else {
        rawTiles = this.aStar(start, [goal]);
      }
    }
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
      result.push({ ...selected });
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

  private aStar(start: GridPoint, goals: GridPoint[]): GridPoint[] | undefined {
    const goalKeys = new Set(goals.map((goal) => tileKey(goal.x, goal.y)));
    const startKey = tileKey(start.x, start.y);
    const open = new MinHeap();
    const bestG = new Map<string, number>([[startKey, 0]]);
    const parent = new Map<string, string>();
    const points = new Map<string, GridPoint>([[startKey, start]]);
    let order = 0;
    const startH = heuristic(start, goals);
    open.push({ ...start, g: 0, h: startH, f: startH, order: order++ });

    let expanded = 0;
    while (open.size > 0 && expanded++ < MAX_EXPANDED_NODES) {
      const current = open.pop()!;
      const currentKey = tileKey(current.x, current.y);
      if (current.g !== bestG.get(currentKey)) continue;
      if (goalKeys.has(currentKey)) {
        return reconstruct(currentKey, startKey, parent, points);
      }

      for (const [dx, dy, moveCost] of DIRECTIONS) {
        const x = current.x + dx;
        const y = current.y + dy;
        if (this.isPathBlocked(x, y, start)) continue;
        if (dx !== 0 && dy !== 0
          && (this.isPathBlocked(current.x + dx, current.y, start)
            || this.isPathBlocked(current.x, current.y + dy, start))) {
          continue;
        }
        const key = tileKey(x, y);
        const g = current.g + moveCost;
        if (g >= (bestG.get(key) ?? Infinity)) continue;
        const point = { x, y };
        const h = heuristic(point, goals);
        bestG.set(key, g);
        parent.set(key, currentKey);
        points.set(key, point);
        open.push({ ...point, g, h, f: g + h, order: order++ });
      }
    }
    return undefined;
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

function heuristic(point: GridPoint, goals: GridPoint[]): number {
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
