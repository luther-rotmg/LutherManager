import {
  ENEMY_AVOID_RADIUS,
  EnemyClearanceOverlay,
  pointViolatesCircularExclusion,
  segmentClearsCircle,
} from './enemy-clearance-overlay';
import { isEnemyProximityThreat, staticMovementProfile } from './dodge-collision-world';
import type { DodgeMovementIntentId } from './dodge-movement-intent';
import {
  PASSABILITY_SCHEMA_VERSION,
  type StaticPassabilityStore,
} from './static-passability-model';
import { createStaticPassabilityStore } from './static-passability-store';
import { traceStaticSegmentSupercover } from './static-segment-validation';

export interface PathfindingDataProvider {
  getObject(type: number): {
    occupySquare: boolean;
    fullOccupy?: boolean;
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

interface NoPathCacheEntry {
  startKey: string;
  goalCell: GridPoint;
  mapVersion: number;
  /** Must match {@link PASSABILITY_SCHEMA_VERSION} or the entry is ignored. */
  schemaVersion: number;
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

const DIAGONAL_COST = Math.SQRT2;
const INTERMEDIATE_THRESHOLD = 0.25;
export const MAX_LOCAL_GOAL_DISTANCE = 5;
/** Sync driver and tests: one-shot search with no clock reads. */
export const SYNC_PATH_SEARCH_BUDGET: PathSearchStepBudget = {
  maxNodes: Number.POSITIVE_INFINITY,
  maxMs: Number.POSITIVE_INFINITY,
};
/** Per navigation tick: real time cap, generous node safety cap. */
export const NAVIGATION_PATH_SEARCH_BUDGET: PathSearchStepBudget = {
  maxNodes: Number.POSITIVE_INFINITY,
  maxMs: 2,
};
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
  private readonly staticPassability: StaticPassabilityStore;
  private readonly enemyOverlay = new EnemyClearanceOverlay();
  private readonly enemyCandidates = new Map<number, PathPoint>();
  private readonly confirmedCombatEnemies = new Set<number>();
  private target: PathTarget | undefined;
  private combatRange: CombatPathfindingRange | undefined;
  private goalId: DodgeMovementIntentId | undefined;
  private combatTargetId: number | undefined;
  private logicalIntentRevision = 0;
  private routeRevision = 0;
  private plan: PlannedPath | undefined;
  private waypointIndex = 0;
  /** Monotonic passability revision; wired to PathSearch as mapVersion. */
  private revision = 0;
  private noPathCache: NoPathCacheEntry | undefined;
  /** Set by the most recent PathSearch run inside buildPlan. */
  private lastSearchOpenSetExhausted = false;
  /** In-flight raw-tile search; resume when start, goals, and mapVersion still match. */
  private activePathSearch: ActivePathSearchState | undefined;
  /** Raw tiles from the latest found search, awaiting assemblePlan on swap. */
  private pendingRawTiles: GridPoint[] | undefined;
  private goalSearchAttempts: GridPoint[][] | undefined;
  private goalSearchAttemptIndex = 0;
  private goalSearchSessionKey: string | undefined;

  constructor(
    private readonly data?: PathfindingDataProvider,
    staticPassability?: StaticPassabilityStore,
  ) {
    this.staticPassability = staticPassability ?? createStaticPassabilityStore(data);
  }

  getStaticPassabilityStore(): StaticPassabilityStore {
    return this.staticPassability;
  }

  resetMap(): void {
    this.staticPassability.reset();
    this.enemyOverlay.reset();
    this.enemyCandidates.clear();
    this.confirmedCombatEnemies.clear();
    this.clearTarget();
    this.revision++;
  }

  setMapBounds(width: number, height: number): void {
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.setMapBounds(width, height);
    if (this.staticPassability.getRevision() !== revisionBefore) this.invalidate();
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
    const previousCombatTargetId = this.combatTargetId;
    this.combatRange = undefined;
    this.combatTargetId = undefined;
    if (this.syncPrimaryEnemyOverlay(previousCombatTargetId, undefined)) this.invalidate();
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
    const previousCombatTargetId = this.combatTargetId;
    this.target = { x: target.x, y: target.y, threshold: INTERMEDIATE_THRESHOLD };
    this.combatRange = { ...range };
    this.goalId = undefined;
    this.combatTargetId = targetId;
    if (this.syncPrimaryEnemyOverlay(previousCombatTargetId, targetId)) this.invalidate();
    this.clearPlan();
    return true;
  }

  clearTarget(): void {
    if (this.target) this.logicalIntentRevision++;
    const previousCombatTargetId = this.combatTargetId;
    this.target = undefined;
    this.combatRange = undefined;
    this.goalId = undefined;
    this.combatTargetId = undefined;
    if (this.syncPrimaryEnemyOverlay(previousCombatTargetId, undefined)) this.invalidate();
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

  /** Combat-enemy overlay revision; independent of static passability mapVersion. */
  getEnemyRevision(): number {
    return this.enemyOverlay.getRevision();
  }

  /** Passability revision bumped by terrain, objects, learned blocks, and map resets. */
  getMapVersion(): number {
    return this.revision;
  }

  /** Status of the in-flight raw-tile search, if any. */
  getActivePathSearchStatus(): PathSearchStatus | undefined {
    return this.activePathSearch?.search.getStatus();
  }

  /**
   * True when an in-flight search already targets the same start, goals, and
   * {@link getMapVersion}. Used to no-op repeated navigation submissions while planning.
   */
  matchesInFlightPathSearch(
    start: GridPoint,
    goals: ReadonlyArray<GridPoint>,
  ): boolean {
    const active = this.activePathSearch;
    if (!active || active.search.getStatus() !== 'searching') return false;
    return active.start.x === start.x
      && active.start.y === start.y
      && active.goalKey === goalsKey(goals)
      && active.mapVersion === this.revision;
  }

  getRemainingPath(): PathPoint[] {
    return this.plan?.waypoints.slice(this.waypointIndex).map((point) => ({ ...point })) ?? [];
  }

  getPlannedTiles(): PathPoint[] {
    return this.plan?.rawTiles.map((point) => ({ ...point })) ?? [];
  }

  observeTile(x: number, y: number, tileType: number): void {
    const tileX = Math.trunc(x);
    const tileY = Math.trunc(y);
    const blockedBefore = this.staticPassability.isTileStaticallyBlocked(tileX, tileY, {
      consumer: 'pathfinding',
    });
    this.staticPassability.observeTile(x, y, tileType);
    const blockedAfter = this.staticPassability.isTileStaticallyBlocked(tileX, tileY, {
      consumer: 'pathfinding',
    });
    if (blockedBefore !== blockedAfter) this.invalidate();
  }

  upsertObject(objectId: number, objectType: number, x: number, y: number): void {
    const definition = this.data?.getObject(objectType);
    const revisionBefore = this.staticPassability.getRevision();
    // Damageable enemy walls/crates are pathable; auto-aim shoots them clear.
    this.staticPassability.upsertObject(
      objectId,
      objectType,
      x,
      y,
      staticMovementProfile(definition),
    );
    let changed = this.staticPassability.getRevision() !== revisionBefore;

    const oldEnemy = this.enemyOverlay.get(objectId);
    const enemyCandidate = !!definition?.isEnemy;
    if (!enemyCandidate) {
      this.enemyCandidates.delete(objectId);
      this.confirmedCombatEnemies.delete(objectId);
      if (oldEnemy) {
        const removed = this.enemyOverlay.delete(objectId);
        changed = changed || (removed && !!this.combatRange);
      }
    } else {
      this.enemyCandidates.set(objectId, { x, y });
      const isCombatThreat = isEnemyProximityThreat(this.data!, objectType)
        || this.confirmedCombatEnemies.has(objectId);
      if (!isCombatThreat) {
        if (oldEnemy) {
          const removed = this.enemyOverlay.delete(objectId);
          changed = changed || (removed && !!this.combatRange);
        }
      } else if (objectId === this.combatTargetId) {
        if (oldEnemy) {
          const removed = this.enemyOverlay.delete(objectId);
          changed = changed || (removed && !!this.combatRange);
        }
      } else if (!oldEnemy || !this.combatRange
        || distance(oldEnemy, { x, y }) >= ENEMY_POSITION_REPLAN_DISTANCE) {
        const updated = this.enemyOverlay.set(objectId, { x, y });
        changed = changed || (updated && !!this.combatRange);
      }
    }

    if (changed) this.invalidate();
  }

  removeObject(objectId: number): void {
    const revisionBefore = this.staticPassability.getRevision();
    this.staticPassability.removeObject(objectId);
    let changed = this.staticPassability.getRevision() !== revisionBefore;
    this.enemyCandidates.delete(objectId);
    this.confirmedCombatEnemies.delete(objectId);
    if (this.enemyOverlay.delete(objectId) && this.combatRange) changed = true;
    if (changed) this.invalidate();
  }

  /** Promotes an enemy-tagged object after an authoritative EnemyShoot packet. */
  markEnemyThreat(objectId: number): void {
    const enemy = this.enemyCandidates.get(objectId);
    if (!enemy) return;
    this.confirmedCombatEnemies.add(objectId);
    if (objectId === this.combatTargetId || this.enemyOverlay.has(objectId)) return;
    this.enemyOverlay.set(objectId, { ...enemy });
    if (this.combatRange) this.invalidate();
  }

  next(
    position: PathPoint,
    searchBudget: PathSearchStepBudget = SYNC_PATH_SEARCH_BUDGET,
  ): PathfindingStep {
    const target = this.target;
    if (!target) return {};
    // MAPINFO supplies finite bounds before navigation can prove reachability.
    // Keeping the target pending avoids treating a search budget as "no path".
    if (this.staticPassability.getWidth() <= 0 || this.staticPassability.getHeight() <= 0) return {};
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
    const goalCell = this.resolveGoalCell(target);
    if (!this.plan && this.matchesNoPathCache(positionKey, goalCell)) {
      return { noPath: true };
    }
    if (!this.plan || this.plan.revision !== this.revision) {
      const searchStatus = this.advancePlanSearch(position, target, searchBudget);
      if (searchStatus === 'found') {
        const newPlan = this.consumePendingPlan(position, target);
        if (newPlan) {
          this.plan = newPlan;
          this.routeRevision++;
          this.waypointIndex = 0;
          replanned = true;
        } else if (!this.plan) {
          if (this.lastSearchOpenSetExhausted) {
            this.writeNoPathCache(positionKey, goalCell);
          }
          return { noPath: true, replanned: true };
        }
      } else if (searchStatus === 'no_path') {
        if (!this.plan) {
          if (this.lastSearchOpenSetExhausted) {
            this.writeNoPathCache(positionKey, goalCell);
          }
          return { noPath: true, replanned: true };
        }
      } else if (!this.plan) {
        return { replanned: true };
      }
    }
    if (!this.plan) {
      return { replanned };
    }
    this.clearNoPathCache();

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
   * with step({ maxNodes, maxMs: Infinity }) until found/no_path.
   * Pass a number for uniform maxNodes per step, or a schedule to vary maxNodes each step.
   */
  runPathSearchToCompletion(
    position: PathPoint,
    maxNodesPerStep: number | readonly number[] = Number.POSITIVE_INFINITY,
  ): GridPoint[] | undefined {
    const target = this.target;
    if (!target || this.staticPassability.getWidth() <= 0 || this.staticPassability.getHeight() <= 0) {
      return undefined;
    }
    const start = { x: Math.floor(position.x), y: Math.floor(position.y) };
    return this.searchRawTiles(start, target, maxNodesPerStep);
  }

  /**
   * Begin or resume a raw-tile search. Reuses the in-flight PathSearch when
   * start, goals, and mapVersion are unchanged; otherwise starts a new search.
   */
  beginPathSearch(
    start: GridPoint,
    goals: ReadonlyArray<GridPoint>,
  ): PathSearchHandle {
    const search = this.acquirePathSearch(start, goals);
    return new ActivePathSearchHandle(this, search);
  }

  /** Drops any in-flight search handle without retaining search state. */
  cancelPathSearch(): void {
    this.activePathSearch = undefined;
  }

  /** Learns the first unentered route cell as blocked after an authoritative movement stall. */
  reportStall(position: PathPoint): PathPoint | undefined {
    const plan = this.plan;
    if (!plan) return undefined;
    const currentKey = tileKey(Math.floor(position.x), Math.floor(position.y));
    const currentIndex = plan.routeTiles.findIndex((point) => tileKey(point.x, point.y) === currentKey);
    const blocked = plan.routeTiles[currentIndex >= 0 ? currentIndex + 1 : 0];
    if (!blocked || tileKey(blocked.x, blocked.y) === plan.startKey) return undefined;
    // Stalling against a shootable enemy wall is expected — keep retrying the route.
    if (this.hasDamageableEnemyAt(blocked.x, blocked.y)) return undefined;
    if (this.staticPassability.markLearnedBlocked(blocked.x, blocked.y)) {
      this.invalidate();
    }
    return { x: blocked.x, y: blocked.y };
  }

  private hasDamageableEnemyAt(tileX: number, tileY: number): boolean {
    for (const enemy of this.enemyCandidates.values()) {
      if (Math.floor(enemy.x) === tileX && Math.floor(enemy.y) === tileY) return true;
    }
    return false;
  }

  private finishTarget(): PathfindingStep {
    const reached = this.target ? { x: this.target.x, y: this.target.y } : undefined;
    this.clearTarget();
    return reached ? { reached } : {};
  }

  private advancePlanSearch(
    position: PathPoint,
    target: PathTarget,
    budget: PathSearchStepBudget,
  ): PathSearchStatus {
    this.lastSearchOpenSetExhausted = false;
    const start = { x: Math.floor(position.x), y: Math.floor(position.y) };
    const sessionKey = this.planSearchSessionKey(start, target);
    if (this.goalSearchSessionKey !== sessionKey) {
      this.goalSearchSessionKey = sessionKey;
      this.goalSearchAttempts = this.resolveGoalSearchAttempts(start, target);
      this.goalSearchAttemptIndex = 0;
      this.pendingRawTiles = undefined;
      this.cancelPathSearch();
    }

    const attempts = this.goalSearchAttempts;
    if (!attempts || attempts.length === 0) {
      this.lastSearchOpenSetExhausted = true;
      return 'no_path';
    }

    while (this.goalSearchAttemptIndex < attempts.length) {
      const goals = attempts[this.goalSearchAttemptIndex]!;
      if (goals.length === 0) {
        this.pendingRawTiles = [];
        return 'found';
      }

      const handle = this.beginPathSearch(start, goals);
      const status = handle.step(budget);
      if (status === 'searching') {
        return 'searching';
      }
      if (status === 'found') {
        this.pendingRawTiles = handle.getPath() ? [...handle.getPath()!] : [];
        return 'found';
      }

      this.lastSearchOpenSetExhausted = handle.wasOpenSetExhausted();
      this.goalSearchAttemptIndex++;
      if (this.goalSearchAttemptIndex >= attempts.length) {
        this.clearGoalSearchSession();
        return 'no_path';
      }
    }

    this.clearGoalSearchSession();
    return 'no_path';
  }

  private consumePendingPlan(position: PathPoint, target: PathTarget): PlannedPath | undefined {
    const rawTiles = this.pendingRawTiles;
    this.clearGoalSearchSession();
    if (rawTiles === undefined) return undefined;
    return this.assemblePlan(position, target, rawTiles);
  }

  private clearGoalSearchSession(): void {
    this.goalSearchSessionKey = undefined;
    this.goalSearchAttempts = undefined;
    this.goalSearchAttemptIndex = 0;
    this.pendingRawTiles = undefined;
  }

  private planSearchSessionKey(start: GridPoint, target: PathTarget): string {
    if (this.combatRange) {
      const goals = this.combatGoals(target, start, this.combatRange);
      return `${tileKey(start.x, start.y)}|combat:${goalsKey(goals)}|${this.revision}`;
    }
    return `${tileKey(start.x, start.y)}|goal:${Math.floor(target.x)},${Math.floor(target.y)}|${this.revision}`;
  }

  private resolveGoalSearchAttempts(start: GridPoint, target: PathTarget): GridPoint[][] {
    if (this.combatRange) {
      const goals = this.combatGoals(target, start, this.combatRange);
      return goals.length > 0 ? [goals] : [];
    }

    const goal = { x: Math.floor(target.x), y: Math.floor(target.y) };
    if (this.isBlocked(goal.x, goal.y, start)) {
      const attempts: GridPoint[][] = [];
      for (let radius = 1; radius <= BLOCKED_TARGET_SEARCH_RADIUS; radius++) {
        const goals = this.nearbyGoals(goal, start, radius);
        if (goals.some((candidate) => candidate.x === start.x && candidate.y === start.y)) {
          attempts.push([]);
          return attempts;
        }
        if (goals.length > 0) attempts.push(goals);
      }
      return attempts;
    }
    if (goal.x === start.x && goal.y === start.y) {
      return [[]];
    }
    return [[goal]];
  }

  private assemblePlan(
    position: PathPoint,
    target: PathTarget,
    rawTiles: GridPoint[],
  ): PlannedPath | undefined {
    const start = { x: Math.floor(position.x), y: Math.floor(position.y) };
    const combat = !!this.combatRange;
    let targetBlocked = false;
    if (!this.combatRange) {
      const goal = { x: Math.floor(target.x), y: Math.floor(target.y) };
      targetBlocked = this.isBlocked(goal.x, goal.y, start);
    }
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
    if (!this.segmentAvoidsCombatEnemies(from, to)) return undefined;
    return traceStaticSegmentSupercover(
      from,
      to,
      (tileX, tileY) => this.isPathBlocked(tileX, tileY, start),
    );
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
    maxNodesPerStep: number | readonly number[],
  ): GridPoint[] | undefined {
    if (this.combatRange) {
      const goals = this.combatGoals(target, start, this.combatRange);
      if (goals.length > 0) return this.runPathSearch(start, goals, maxNodesPerStep);
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
          const result = this.runPathSearch(start, goals, maxNodesPerStep);
          if (result) return result;
        }
      }
      return undefined;
    }
    if (goal.x === start.x && goal.y === start.y) {
      return [];
    }
    return this.runPathSearch(start, [goal], maxNodesPerStep);
  }

  private runPathSearch(
    start: GridPoint,
    goals: GridPoint[],
    maxNodesPerStep: number | readonly number[],
  ): GridPoint[] | undefined {
    const search = this.acquirePathSearch(start, goals);
    const unlimited = { maxNodes: Number.POSITIVE_INFINITY, maxMs: Number.POSITIVE_INFINITY };
    if (typeof maxNodesPerStep === 'number') {
      const budget = maxNodesPerStep === Number.POSITIVE_INFINITY
        ? unlimited
        : { maxNodes: maxNodesPerStep, maxMs: Number.POSITIVE_INFINITY };
      while (search.step(budget) === 'searching') {}
    } else {
      let scheduleIndex = 0;
      while (search.step({
        maxNodes: maxNodesPerStep[scheduleIndex % maxNodesPerStep.length]!,
        maxMs: Number.POSITIVE_INFINITY,
      }) === 'searching') {
        scheduleIndex++;
      }
    }
    this.lastSearchOpenSetExhausted = search.getStatus() === 'no_path';
    const path = search.getPath();
    if (search.getStatus() !== 'searching') {
      this.releaseActivePathSearch(search);
    }
    return path;
  }

  private acquirePathSearch(
    start: GridPoint,
    goals: ReadonlyArray<GridPoint>,
  ): PathSearch {
    const goalKey = goalsKey(goals);
    const mapVersion = this.revision;
    const active = this.activePathSearch;
    if (active
      && active.start.x === start.x
      && active.start.y === start.y
      && active.goalKey === goalKey
      && active.mapVersion === mapVersion
      && active.search.getStatus() === 'searching') {
      return active.search;
    }

    const search = new PathSearch({
      start,
      goals,
      isPathBlocked: (x, y, s) => this.isPathBlocked(x, y, s),
      mapVersion,
    });
    this.activePathSearch = { search, start: { ...start }, goalKey, mapVersion };
    return search;
  }

  releaseActivePathSearch(search: PathSearch): void {
    if (this.activePathSearch?.search === search) {
      this.activePathSearch = undefined;
    }
  }

  isActivePathSearch(search: PathSearch): boolean {
    return this.activePathSearch?.search === search;
  }

  private isBlocked(x: number, y: number, start?: GridPoint): boolean {
    return this.staticPassability.isTileStaticallyBlocked(x, y, {
      consumer: 'pathfinding',
      exemptTile: start,
    });
  }

  private isPathBlocked(x: number, y: number, start?: GridPoint): boolean {
    if (this.isBlocked(x, y, start)) return true;
    if (!this.combatRange || !this.target || start && x === start.x && y === start.y) return false;
    const point = tileCenter({ x, y });
    const startPoint = start ? tileCenter(start) : undefined;
    if (pointViolatesCircularExclusion(point, this.target, this.combatRange.minimumDistance, startPoint)) {
      return true;
    }
    return this.enemyOverlay.tileCenterViolatesHardClearance(x, y, startPoint);
  }

  private segmentAvoidsCombatEnemies(from: PathPoint, to: PathPoint): boolean {
    if (!this.combatRange || !this.target) return true;
    if (!segmentClearsCircle(from, to, this.target, this.combatRange.minimumDistance)) return false;
    return this.enemyOverlay.segmentAvoidsHardClearance(from, to);
  }

  private inBounds(x: number, y: number): boolean {
    return this.staticPassability.inBounds(x, y);
  }

  private invalidate(): void {
    this.revision++;
  }

  /** Primary combat targets use combatRange; overlay tracks other threats only. */
  private syncPrimaryEnemyOverlay(
    previousId: number | undefined,
    nextId: number | undefined,
  ): boolean {
    let changed = false;
    if (previousId !== undefined && previousId > 0 && previousId !== nextId
      && this.confirmedCombatEnemies.has(previousId)) {
      const candidate = this.enemyCandidates.get(previousId);
      if (candidate) {
        changed = this.enemyOverlay.set(previousId, { ...candidate }) || changed;
      }
    }
    if (nextId !== undefined && nextId > 0) {
      changed = this.enemyOverlay.delete(nextId) || changed;
    }
    return changed;
  }

  private resolveGoalCell(target: PathTarget): GridPoint {
    return { x: Math.floor(target.x), y: Math.floor(target.y) };
  }

  private matchesNoPathCache(startKey: string, goalCell: GridPoint): boolean {
    const cache = this.noPathCache;
    return cache !== undefined
      && cache.startKey === startKey
      && cache.goalCell.x === goalCell.x
      && cache.goalCell.y === goalCell.y
      && cache.mapVersion === this.revision
      && cache.schemaVersion === PASSABILITY_SCHEMA_VERSION;
  }

  private writeNoPathCache(startKey: string, goalCell: GridPoint): void {
    this.noPathCache = {
      startKey,
      goalCell: { ...goalCell },
      mapVersion: this.revision,
      schemaVersion: PASSABILITY_SCHEMA_VERSION,
    };
  }

  private clearNoPathCache(): void {
    this.noPathCache = undefined;
  }

  private clearPlan(): void {
    this.plan = undefined;
    this.waypointIndex = 0;
    this.clearNoPathCache();
    this.clearGoalSearchSession();
    this.cancelPathSearch();
  }
}

export type PathSearchStatus = 'searching' | 'found' | 'no_path';

export interface PathSearchStepBudget {
  maxNodes: number;
  maxMs: number;
}

/**
 * Handle for an incremental path search started via {@link ExplorativePathfinder.beginPathSearch}.
 *
 * Plan minimum (step 6.1): `status()` and `cancel()`. This interface also exposes
 * `step()` and `getPath()` from the step 3.5 incremental driver.
 */
export interface PathSearchHandle {
  status(): PathSearchStatus;
  cancel(): void;
  step(budget: PathSearchStepBudget): PathSearchStatus;
  getPath(): ReadonlyArray<{ x: number; y: number }> | undefined;
  /** True when a terminal `no_path` came from open-set exhaustion, not budget yield. */
  wasOpenSetExhausted(): boolean;
}

interface ActivePathSearchState {
  search: PathSearch;
  start: GridPoint;
  goalKey: string;
  mapVersion: number;
}

class ActivePathSearchHandle implements PathSearchHandle {
  private openSetExhaustedOnNoPath = false;

  constructor(
    private readonly pathfinder: ExplorativePathfinder,
    private readonly search: PathSearch,
  ) {}

  status(): PathSearchStatus {
    return this.search.getStatus();
  }

  step(budget: PathSearchStepBudget): PathSearchStatus {
    const status = this.search.step(budget);
    if (status === 'no_path') {
      this.openSetExhaustedOnNoPath = this.search.isOpenSetEmpty();
    }
    if (status !== 'searching') {
      this.pathfinder.releaseActivePathSearch(this.search);
    }
    return status;
  }

  cancel(): void {
    if (this.pathfinder.isActivePathSearch(this.search)) {
      this.pathfinder.cancelPathSearch();
    }
  }

  getPath(): GridPoint[] | undefined {
    return this.search.getPath();
  }

  wasOpenSetExhausted(): boolean {
    return this.openSetExhaustedOnNoPath;
  }
}

/** Non-stale heap pops between performance.now() checks (64 ≈ 2×32, fewer syscalls). */
const EXPANSIONS_PER_CLOCK_CHECK = 64;

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

  /**
   * Advance search until found, exhausted, or either per-call budget cap is reached.
   * Stops when maxNodes non-stale expansions or maxMs elapses (whichever first).
   * Infinity maxMs skips all performance.now() reads; terminal results beat budget caps.
   */
  step(budget: PathSearchStepBudget): PathSearchStatus {
    if (this.status !== 'searching') {
      return this.status;
    }

    const { maxNodes, maxMs } = budget;
    const checkClock = Number.isFinite(maxMs);
    const checkNodes = Number.isFinite(maxNodes);
    let nonStaleExpansionsThisStep = 0;
    let stepStartTime = 0;

    if (checkClock) {
      stepStartTime = performance.now();
      if (performance.now() - stepStartTime >= maxMs) {
        return 'searching';
      }
    }
    if (checkNodes && maxNodes <= 0) {
      return 'searching';
    }

    while (this.open.size > 0) {
      const current = this.open.pop()!;
      const currentKey = tileKey(current.x, current.y);
      if (current.g !== this.bestG.get(currentKey)) continue;

      this.expansions++;
      nonStaleExpansionsThisStep++;

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

      if (checkNodes && nonStaleExpansionsThisStep >= maxNodes) {
        return 'searching';
      }
      if (checkClock && nonStaleExpansionsThisStep % EXPANSIONS_PER_CLOCK_CHECK === 0) {
        if (performance.now() - stepStartTime >= maxMs) {
          return 'searching';
        }
      }
    }
    this.status = 'no_path';
    return 'no_path';
  }

  getStatus(): PathSearchStatus {
    return this.status;
  }

  /** Snapshot of ExplorativePathfinder revision at construction; compared on resume in 3.5. */
  getMapVersion(): number {
    return this.mapVersion;
  }

  /** True only after the open set is fully exhausted (never on budget yield). */
  isOpenSetEmpty(): boolean {
    return this.open.size === 0;
  }

  getPath(): GridPoint[] | undefined {
    return this.status === 'found' ? this.resultPath : undefined;
  }

  /** Non-stale node expansions so far (test + resume verification). */
  getExpansionCount(): number {
    return this.expansions;
  }
}

function goalsKey(goals: ReadonlyArray<GridPoint>): string {
  return goals.map((goal) => tileKey(goal.x, goal.y)).sort().join('|');
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

