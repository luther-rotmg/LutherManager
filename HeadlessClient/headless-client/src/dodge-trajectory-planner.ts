import { performance } from 'node:perf_hooks';
import {
  isProjectileAliveAt,
  predictProjectilePosition,
  type CombatProjectileSnapshot,
} from './combat-tracker';
import {
  ENEMY_AVOID_RADIUS,
  ENEMY_SOFT_AVOID_RADIUS,
  type LocalDodgeCollisionSnapshot,
} from './dodge-collision-world';
import {
  normalizeDodgeMovementIntent,
  type CombatRangeDodgeIntent,
  type DodgeMovementIntent,
} from './dodge-movement-intent';
import { isStaticSegmentSupercoverOpen, segmentOccupancySampleInTile } from './static-segment-validation';

export interface DodgePlanningEnvironment {
  canOccupy(x: number, y: number, safeWalk: boolean, avoidEnemies?: boolean): boolean;
  enemyClearance?(x: number, y: number): number;
  isProjectileSegmentOpen(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    projectile: CombatProjectileSnapshot,
  ): boolean;
  createLocalSnapshot?(
    center: { x: number; y: number },
    radius: number,
    resolution?: number,
  ): LocalDodgeCollisionSnapshot;
  getRevision?(): number;
}

export interface DodgePlanningAoe {
  x: number;
  y: number;
  radius: number;
  landingTime: number;
}

export interface TimedDodgeWaypoint {
  timeOffsetMs: number;
  x: number;
  y: number;
  /** Planned speed in tiles per second. */
  speed: number;
}

export interface DodgeTrajectory {
  createdAt: number;
  waypoints: TimedDodgeWaypoint[];
}

export type DodgeReplanReason = 'normal' | 'urgent';
export type DodgeFallback = 'none' | 'partial' | 'least_risk' | 'stop';

export interface DodgePlannerMetrics {
  planningDurationMs: number;
  layerCount: number;
  statesEnteringLayers: number[];
  candidatesGenerated: number;
  candidatesRejectedByGeometry: number;
  candidatesRejectedByProjectiles: number;
  statesMerged: number;
  statesPrunedByBeam: number;
  activeProjectilesConsidered: number;
  trajectoryInvalidations: number;
  normalReplans: number;
  urgentReplans: number;
  totalPlans: number;
  averagePlanningDurationMs: number;
  worstPlanningDurationMs: number;
  coalescedProjectileUpdates: number;
}

export interface DodgePlannerOptions {
  timeLayersMs?: readonly number[];
  maxStatesPerLayer?: number;
  spatialBucketSize?: number;
  collisionResolution?: number;
  projectilePredictionStepMs?: number;
  costWeights?: Partial<DodgeCostWeights>;
}

export interface DodgePlanningInput {
  time: number;
  playerId: number;
  position: { x: number; y: number };
  goal?: { x: number; y: number; threshold?: number };
  /** Stable script/global preference. `goal` remains a legacy local-route fallback. */
  intent?: DodgeMovementIntent | null;
  routeWaypoint?: { x: number; y: number; threshold?: number };
  preferredDirection?: { x: number; y: number };
  combatTargetPositionAt?: (timeOffsetMs: number) => { x: number; y: number };
  /** Scales only the combat too-far preference; hard ranges are never scaled. */
  retreatPenaltyScale?: number;
  /** Maximum speed in tiles per millisecond. */
  moveSpeed: number;
  /** Current global-navigation command in tiles per millisecond. */
  intentVelocity: { x: number; y: number };
  /** Most recently executed local command, used only for stability costs. */
  previousVelocity?: { x: number; y: number };
  movementLeadMs: number;
  projectiles: readonly CombatProjectileSnapshot[];
  aoes: readonly DodgePlanningAoe[];
  environment: DodgePlanningEnvironment;
  safeWalk: boolean;
}

export interface DodgePlanningResult {
  trajectory: DodgeTrajectory;
  cumulativeCost: number;
  terminalScore: number;
  safeThroughMs: number;
  reachesHorizon: boolean;
  fallback: DodgeFallback;
  firstControl: number;
  minimumProjectileClearance: number;
  minimumEnemyClearance: number;
  activeProjectileCount: number;
  /** First collision on the unmodified navigation intent, for diagnostics. */
  earliestIntentCollisionMs?: number | null;
  metrics: DodgePlannerMetrics;
}

export interface DodgeTrajectoryAssessment {
  safe: boolean;
  score: number;
  cumulativeCost: number;
  terminalCost: number;
  intentCost: number;
  comparisonHorizonMs: number;
  remainingMs: number;
  firstUnsafeOffsetMs: number | null;
}

export interface EmergencyJumpPlan {
  target: { x: number; y: number };
  distance: number;
  score: number;
}

const DEFAULT_TIME_LAYERS_MS = Object.freeze([
  0, 20, 40, 65, 95, 130, 175, 230, 300, 400, 550, 750, 1000,
]);
// Movement controls either wait or use the current authoritative maximum speed.
const DEFAULT_SPEED_FRACTIONS = Object.freeze([1]);
const DEFAULT_DIRECTION_COUNT = 16;
// Profiling the 17-control expansion in Node showed that a 1,000-state beam
// cannot sustain the urgent cadence. The cap remains configurable up to 3,000,
// but the responsive normal default retains 64 spatially diverse states.
const DEFAULT_MAX_STATES_PER_LAYER = 64;
const URGENT_MAX_STATES_PER_LAYER = 32;
const DEFAULT_SPATIAL_BUCKET_SIZE = 0.075;
const DEFAULT_COLLISION_RESOLUTION = 0.1;
const DEFAULT_PROJECTILE_STEP_MS = 20;
// CombatTracker resolves projectile hits with a single relative AABB half-extent.
// Keep the planner's hard collision box identical instead of adding projectile
// metadata or prediction margins that would silently turn 0.5 into 0.55+.
const DODGE_HITBOX_HALF_SIZE = 0.5;
const AOE_SAFETY_MARGIN = 0.08;
const PROJECTILE_NEAR_BAND = 0.9;
const AOE_NEAR_BAND = 0.75;
const PROJECTILE_INDEX_CELL_SIZE = 2;
const STATIC_SAMPLE_MAX_MS = 25;
const DISTANCE_EPSILON = 1e-9;
const MAX_CONTROL_COUNT = 64;
const STATES_PER_SPATIAL_BUCKET = 2;
const JUMP_DISTANCE_STEP = 0.25;
const JUMP_LANDING_HOLD_MS = 300;

/**
 * Cost weights are intentionally centralized. Time-integrated weights are in
 * cost units per second; distance weights are in cost units per tile.
 */
export interface DodgeCostWeights {
  basePerSecond: number;
  projectileRiskPerSecond: number;
  enemyRiskPerSecond: number;
  damagingFloorPerDamageSecond: number;
  directionChange: number;
  directionReversal: number;
  speedChange: number;
  pathIntentDeviationPerSecond: number;
  unnecessaryWaitPerSecond: number;
  unnecessaryMotionPerSecond: number;
  combatTooClosePerSecond: number;
  combatTooFarPerSecond: number;
  terminalGoalDistance: number;
  terminalCombatTooClose: number;
  terminalCombatTooFar: number;
  terminalUnnecessarySpeed: number;
  terminalHeadingMismatch: number;
  terminalFutureExposure: number;
  terminalEnemyProximity: number;
  terminalPoorEscape: number;
  incompleteHorizonPerSecond: number;
  lethalFallback: number;
}

export const DODGE_COST_WEIGHTS: Readonly<DodgeCostWeights> = Object.freeze({
  // Small time cost shared by every legal transition; it keeps costs monotonic.
  basePerSecond: 0.05,
  // Squared proximity exposure inside the 0.9-tile band beyond collision.
  projectileRiskPerSecond: 12,
  // Squared exposure between the 1.0-tile hard and 2.3-tile soft enemy radii.
  enemyRiskPerSecond: 3.5,
  // XML floor damage converted to cost per second while safe-walk is enabled.
  damagingFloorPerDamageSecond: 0.02,
  // One-time cost for changing heading; a 180-degree change reaches this scale.
  directionChange: 0.24,
  // Additional one-time cost for immediate left-right or forward-back reversal.
  directionReversal: 0.75,
  // One-time cost for changing normalized speed by the full speed range.
  speedChange: 0.18,
  // Per-second cost for steering away from the current global path direction.
  pathIntentDeviationPerSecond: 0.8,
  // Per-second cost for waiting while a movement goal remains outstanding.
  unnecessaryWaitPerSecond: 1.2,
  // Per-second cost for moving when no navigation or range correction is needed.
  unnecessaryMotionPerSecond: 0.8,
  // Strong per-second pressure away from the selected target's hard range.
  combatTooClosePerSecond: 10,
  // Softer per-second pressure back toward weapon range; scaled down during danger.
  combatTooFarPerSecond: 2.5,
  // Terminal cost per tile remaining to the local global-path waypoint.
  terminalGoalDistance: 4,
  // Terminal range errors around the selected combat target.
  terminalCombatTooClose: 6,
  terminalCombatTooFar: 2,
  // Normalized terminal-speed cost when the current intent calls for holding position.
  terminalUnnecessarySpeed: 0.6,
  // Terminal heading mismatch relative to the local waypoint.
  terminalHeadingMismatch: 0.35,
  // Terminal penalty for ending with close predicted projectile exposure.
  terminalFutureExposure: 0.8,
  // Terminal penalty for ending inside the enemy soft zone.
  terminalEnemyProximity: 1.5,
  // Terminal penalty when few short escape probes remain open.
  terminalPoorEscape: 1.2,
  // Cost per unplanned second when no full-horizon safe route survives.
  incompleteHorizonPerSecond: 30,
  // Dominating cost used only to rank controlled, knowingly unsafe fallbacks.
  lethalFallback: 1000,
});

interface PlannerConfig {
  timeLayersMs: readonly number[];
  maxStatesPerLayer: number;
  spatialBucketSize: number;
  collisionResolution: number;
  projectilePredictionStepMs: number;
}

interface MovementControl {
  x: number;
  y: number;
  speedFraction: number;
  key: number;
  directionBucket: number;
  order: number;
}

interface SearchState {
  index: number;
  layer: number;
  x: number;
  y: number;
  cumulativeCost: number;
  parentIndex: number;
  velocityX: number;
  velocityY: number;
  controlKey: number;
  controlRunLength: number;
  directionBucket: number;
  order: number;
  minimumProjectileClearance: number;
  minimumEnemyClearance: number;
}

interface CandidateState extends Omit<SearchState, 'index'> {
  rankScore: number;
}

interface ProjectileSegment {
  startMs: number;
  endMs: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  velocityX: number;
  velocityY: number;
  collisionRadius: number;
  nearRadius: number;
}

interface EdgeSafety {
  softCost: number;
  collision: boolean;
  minimumProjectileClearance: number;
  minimumEnemyClearance: number;
}

interface CollisionQuery {
  resolution: number;
  blocked(x: number, y: number): boolean;
  damagingFloor(x: number, y: number): number;
  enemyDistance(x: number, y: number): number;
}

interface PlanCounters {
  planningDurationMs: number;
  layerCount: number;
  statesEnteringLayers: number[];
  candidatesGenerated: number;
  candidatesRejectedByGeometry: number;
  candidatesRejectedByProjectiles: number;
  statesMerged: number;
  statesPrunedByBeam: number;
  activeProjectilesConsidered: number;
}

interface PlannerContext {
  input: DodgePlanningInput;
  intent: DodgeMovementIntent | null;
  routeWaypoint: { x: number; y: number; threshold: number } | undefined;
  combatTargetPositions: TimedCombatTargetPosition[];
  combatTargetScratch: { x: number; y: number };
  retreatPenaltyScale: number;
  horizonMs: number;
  collision: CollisionQuery;
  projectileSegments: ProjectileSegment[];
  projectileIndex: ProjectileSpatialIndex;
  /**
   * A defensive copy of `input.aoes` sorted by (landingTime, x, y, radius) so
   * AoE iteration order is deterministic across replays. IEEE-754
   * non-associativity would otherwise let iteration-order permutations flip
   * ULP-scale rankScore ties.
   */
  sortedAoes: readonly DodgePlanningAoe[];
  controls: MovementControl[];
  counters: PlanCounters;
  startEnemyDistance: number;
  stateCap: number;
}

interface TimedCombatTargetPosition {
  timeOffsetMs: number;
  x: number;
  y: number;
}

const FIXED_CONTROLS = createFixedControls();

/** Exact closest approach for two constant-velocity points over one interval. */
export function sweptRelativeMotion(
  playerStart: { x: number; y: number },
  playerVelocity: { x: number; y: number },
  projectileStart: { x: number; y: number },
  projectileVelocity: { x: number; y: number },
  intervalDurationMs: number,
): { closestTimeMs: number; minimumDistance: number } {
  const relativeX = playerStart.x - projectileStart.x;
  const relativeY = playerStart.y - projectileStart.y;
  const velocityX = playerVelocity.x - projectileVelocity.x;
  const velocityY = playerVelocity.y - projectileVelocity.y;
  const velocitySquared = velocityX * velocityX + velocityY * velocityY;
  const closestTimeMs = velocitySquared <= 1e-18
    ? 0
    : clamp(
        -(relativeX * velocityX + relativeY * velocityY) / velocitySquared,
        0,
        Math.max(0, intervalDurationMs),
      );
  return {
    closestTimeMs,
    minimumDistance: Math.hypot(
      relativeX + velocityX * closestTimeMs,
      relativeY + velocityY * closestTimeMs,
    ),
  };
}

/** Chronological continuous-position dynamic planner used by predictive dodge. */
export class SpaceTimeDodgePlanner {
  private readonly config: PlannerConfig;
  private readonly weights: Readonly<DodgeCostWeights>;
  private totalDurationMs = 0;
  private totalPlans = 0;
  private normalReplans = 0;
  private urgentReplans = 0;
  private worstDurationMs = 0;
  private trajectoryInvalidations = 0;
  private coalescedProjectileUpdates = 0;
  private lastCounters = emptyCounters();

  constructor(options: DodgePlannerOptions = {}) {
    const timeLayers = normalizeTimeLayers(options.timeLayersMs ?? DEFAULT_TIME_LAYERS_MS);
    this.config = {
      timeLayersMs: timeLayers,
      maxStatesPerLayer: finiteInteger(
        options.maxStatesPerLayer,
        DEFAULT_MAX_STATES_PER_LAYER,
        32,
        3000,
      ),
      spatialBucketSize: finiteRange(
        options.spatialBucketSize,
        DEFAULT_SPATIAL_BUCKET_SIZE,
        0.05,
        0.5,
      ),
      collisionResolution: finiteRange(
        options.collisionResolution,
        DEFAULT_COLLISION_RESOLUTION,
        0.05,
        0.25,
      ),
      projectilePredictionStepMs: finiteInteger(
        options.projectilePredictionStepMs,
        DEFAULT_PROJECTILE_STEP_MS,
        8,
        50,
      ),
    };
    this.weights = normalizeCostWeights(options.costWeights);
  }

  plan(input: DodgePlanningInput, reason: DodgeReplanReason): DodgePlanningResult {
    const startedAt = performance.now();
    const counters = emptyCounters();
    const horizonMs = this.config.timeLayersMs[this.config.timeLayersMs.length - 1]!;
    const context = this.createContext(
      input,
      horizonMs,
      counters,
      reason === 'urgent'
        ? Math.min(this.config.maxStatesPerLayer, URGENT_MAX_STATES_PER_LAYER)
        : this.config.maxStatesPerLayer,
    );
    const earliestIntentCollisionMs = this.earliestIntentCollision(context);
    const direct = this.tryDirectTrajectory(context);
    if (!direct) counters.statesEnteringLayers.length = 0;
    const result = direct ?? this.search(context);
    result.earliestIntentCollisionMs = earliestIntentCollisionMs;
    counters.planningDurationMs = performance.now() - startedAt;
    counters.layerCount = result.trajectory.waypoints.length;
    this.recordPlan(counters, reason);
    result.metrics = this.getMetrics();
    return result;
  }

  assessTrajectory(
    input: DodgePlanningInput,
    trajectory: DodgeTrajectory,
    comparisonHorizonMs?: number,
  ): DodgeTrajectoryAssessment {
    const elapsed = Math.max(0, input.time - trajectory.createdAt);
    const finalOffsetMs = trajectory.waypoints.at(-1)?.timeOffsetMs ?? 0;
    const remainingMs = Math.max(0, finalOffsetMs - elapsed);
    const requestedHorizon = Number.isFinite(comparisonHorizonMs)
      ? Math.max(0, Number(comparisonHorizonMs))
      : remainingMs;
    const horizonMs = Math.min(remainingMs, requestedHorizon);
    if (horizonMs <= 0) return unsafeAssessment(remainingMs, 0, 0);

    const counters = emptyCounters();
    const context = this.createContext(input, horizonMs, counters);
    let previous = { ...input.position };
    let previousOffsetMs = 0;
    let previousVelocity = input.previousVelocity ?? input.intentVelocity;
    let cumulativeCost = 0;
    let intentCost = 0;
    let minimumProjectileClearance = Infinity;
    let minimumEnemyClearance = context.startEnemyDistance;
    for (const waypoint of trajectory.waypoints) {
      const sourceOffsetMs = waypoint.timeOffsetMs - elapsed;
      if (sourceOffsetMs <= 1e-9) continue;
      let offsetMs = sourceOffsetMs;
      let endpoint = { x: waypoint.x, y: waypoint.y };
      if (offsetMs > horizonMs) {
        const span = offsetMs - previousOffsetMs;
        const ratio = span <= 0 ? 1 : (horizonMs - previousOffsetMs) / span;
        endpoint = {
          x: previous.x + (waypoint.x - previous.x) * ratio,
          y: previous.y + (waypoint.y - previous.y) * ratio,
        };
        offsetMs = horizonMs;
      }
      const durationMs = offsetMs - previousOffsetMs;
      if (durationMs <= 0) continue;
      const velocity = {
        x: (endpoint.x - previous.x) / durationMs,
        y: (endpoint.y - previous.y) / durationMs,
      };
      const safety = this.evaluateEdge(
        context,
        previous,
        endpoint,
        previousOffsetMs,
        offsetMs,
        false,
      );
      if (!safety) return unsafeAssessment(remainingMs, horizonMs, previousOffsetMs);
      cumulativeCost += this.transitionCost(
        context,
        previous,
        velocity,
        previousVelocity,
        durationMs,
        safety,
        offsetMs,
      );
      intentCost += this.calculateIntentTransitionCost(
        context,
        previous,
        velocity,
        durationMs,
        offsetMs,
      );
      minimumProjectileClearance = Math.min(
        minimumProjectileClearance,
        safety.minimumProjectileClearance,
      );
      minimumEnemyClearance = Math.min(minimumEnemyClearance, safety.minimumEnemyClearance);
      previous = endpoint;
      previousVelocity = velocity;
      previousOffsetMs = offsetMs;
      if (offsetMs >= horizonMs - 1e-9) break;
    }
    if (previousOffsetMs < horizonMs - 1e-9) {
      return unsafeAssessment(remainingMs, horizonMs, previousOffsetMs);
    }
    const terminalCost = this.terminalCost(
      context,
      previous,
      previousVelocity,
      minimumProjectileClearance,
      minimumEnemyClearance,
      horizonMs,
    );
    return {
      safe: true,
      score: cumulativeCost + terminalCost,
      cumulativeCost,
      terminalCost,
      intentCost,
      comparisonHorizonMs: horizonMs,
      remainingMs,
      firstUnsafeOffsetMs: null,
    };
  }

  findEmergencyJump(input: DodgePlanningInput, allowance: number): EmergencyJumpPlan | undefined {
    if (!Number.isFinite(allowance) || allowance <= 0) return undefined;
    const counters = emptyCounters();
    const context = this.createContext(input, JUMP_LANDING_HOLD_MS, counters);
    const startEnemy = context.collision.enemyDistance(input.position.x, input.position.y);
    const goal = context.intent?.mode !== 'combat_range' ? goalScoringPoint(context) : undefined;
    const startGoalDistance = goal ? distance(input.position, goal) : 0;
    let best: EmergencyJumpPlan | undefined;

    for (let direction = 0; direction < DEFAULT_DIRECTION_COUNT; direction++) {
      const angle = direction * Math.PI * 2 / DEFAULT_DIRECTION_COUNT;
      const directionX = Math.cos(angle);
      const directionY = Math.sin(angle);
      for (const jumpDistance of jumpDistances(allowance)) {
        const target = {
          x: input.position.x + directionX * jumpDistance,
          y: input.position.y + directionY * jumpDistance,
        };
        if (!this.staticSegmentOpen(context, input.position, target, startEnemy)) continue;
        const landingSafety = this.evaluateEdge(
          context,
          target,
          target,
          0,
          JUMP_LANDING_HOLD_MS,
          false,
        );
        if (!landingSafety) continue;
        const goalProgress = goal
          ? startGoalDistance - distance(target, goal)
          : 0;
        const enemyDistance = context.collision.enemyDistance(target.x, target.y);
        const score = landingSafety.softCost
          - goalProgress * 2
          + (context.intent?.mode === 'combat_range'
            ? combatRangePenalty(
                context,
                target,
                JUMP_LANDING_HOLD_MS,
                this.weights.terminalCombatTooClose,
                this.weights.terminalCombatTooFar * context.retreatPenaltyScale,
              )
            : 0)
          - Math.min(enemyDistance, ENEMY_SOFT_AVOID_RADIUS) * 0.05
          - jumpDistance * 0.02;
        if (!best || score < best.score - 1e-9) {
          best = { target, distance: jumpDistance, score };
        }
      }
    }
    return best;
  }

  recordTrajectoryInvalidation(): void {
    this.trajectoryInvalidations++;
  }

  recordProjectileBatch(updateCount: number): void {
    if (updateCount > 1) this.coalescedProjectileUpdates += updateCount - 1;
  }

  getMetrics(): DodgePlannerMetrics {
    return {
      planningDurationMs: this.lastCounters.planningDurationMs,
      layerCount: this.lastCounters.layerCount,
      statesEnteringLayers: [...this.lastCounters.statesEnteringLayers],
      candidatesGenerated: this.lastCounters.candidatesGenerated,
      candidatesRejectedByGeometry: this.lastCounters.candidatesRejectedByGeometry,
      candidatesRejectedByProjectiles: this.lastCounters.candidatesRejectedByProjectiles,
      statesMerged: this.lastCounters.statesMerged,
      statesPrunedByBeam: this.lastCounters.statesPrunedByBeam,
      activeProjectilesConsidered: this.lastCounters.activeProjectilesConsidered,
      trajectoryInvalidations: this.trajectoryInvalidations,
      normalReplans: this.normalReplans,
      urgentReplans: this.urgentReplans,
      totalPlans: this.totalPlans,
      averagePlanningDurationMs: this.totalPlans > 0 ? this.totalDurationMs / this.totalPlans : 0,
      worstPlanningDurationMs: this.worstDurationMs,
      coalescedProjectileUpdates: this.coalescedProjectileUpdates,
    };
  }

  private createContext(
    input: DodgePlanningInput,
    horizonMs: number,
    counters: PlanCounters,
    stateCap = this.config.maxStatesPerLayer,
  ): PlannerContext {
    const intent = plannerIntent(input);
    const routeWaypoint = validGoal(input.routeWaypoint)
      ? {
          x: input.routeWaypoint.x,
          y: input.routeWaypoint.y,
          threshold: Math.max(0, input.routeWaypoint.threshold ?? 0),
        }
      : validGoal(input.goal)
        ? {
            x: input.goal.x,
            y: input.goal.y,
            threshold: Math.max(0, input.goal.threshold ?? 0),
          }
        : undefined;
    const reachRadius = Math.max(1, input.moveSpeed * horizonMs + 1.5);
    const collision = createCollisionQuery(
      input.environment,
      input.position,
      reachRadius,
      this.config.collisionResolution,
      input.safeWalk,
    );
    const projectileSegments = this.predictProjectileSegments(input, horizonMs, counters);
    const projectileIndex = new ProjectileSpatialIndex(
      projectileSegments,
      input.position,
      reachRadius + PROJECTILE_NEAR_BAND + 1,
    );
    const combatTargetPositions = sampleCombatTargetPositions(
      input,
      intent,
      this.config.timeLayersMs,
      horizonMs,
    );
    const sortedAoes = [...input.aoes].sort((a, b) => {
      return a.landingTime - b.landingTime
        || a.x - b.x
        || a.y - b.y
        || a.radius - b.radius;
    });
    return {
      input,
      intent,
      routeWaypoint,
      combatTargetPositions,
      combatTargetScratch: { x: 0, y: 0 },
      retreatPenaltyScale: clamp(input.retreatPenaltyScale ?? 1, 0, 1),
      horizonMs,
      collision,
      projectileSegments,
      projectileIndex,
      sortedAoes,
      controls: createPlanningControls(input, projectileSegments),
      counters,
      startEnemyDistance: collision.enemyDistance(input.position.x, input.position.y),
      stateCap,
    };
  }

  private tryDirectTrajectory(context: PlannerContext): DodgePlanningResult | undefined {
    const { input } = context;
    // During combat retreat/recovery, the direct shortcut cannot compare waiting
    // against range correction. Let the layered search apply the scaled costs.
    if (context.intent?.mode === 'combat_range' && context.retreatPenaltyScale < 1 - 1e-9) {
      return undefined;
    }
    let current = { ...input.position };
    let previousVelocity = input.previousVelocity ?? input.intentVelocity;
    let cumulativeCost = 0;
    let riskCost = 0;
    let minimumProjectileClearance = Infinity;
    let minimumEnemyClearance = context.startEnemyDistance;
    const waypoints: TimedDodgeWaypoint[] = [];
    context.counters.statesEnteringLayers.push(1);

    for (let layer = 1; layer < this.config.timeLayersMs.length; layer++) {
      const startMs = this.config.timeLayersMs[layer - 1]!;
      const endMs = this.config.timeLayersMs[layer]!;
      const durationMs = endMs - startMs;
      const velocity = directVelocity(context, current, startMs, durationMs);
      const next = {
        x: current.x + velocity.x * durationMs,
        y: current.y + velocity.y * durationMs,
      };
      context.counters.candidatesGenerated++;
      const safety = this.evaluateEdge(context, current, next, startMs, endMs, false);
      if (!safety) return undefined;
      const transitionCost = this.transitionCost(
        context,
        current,
        velocity,
        previousVelocity,
        durationMs,
        safety,
        endMs,
      );
      cumulativeCost += transitionCost;
      riskCost += safety.softCost;
      minimumProjectileClearance = Math.min(
        minimumProjectileClearance,
        safety.minimumProjectileClearance,
      );
      minimumEnemyClearance = Math.min(minimumEnemyClearance, safety.minimumEnemyClearance);
      waypoints.push({
        timeOffsetMs: endMs,
        x: next.x,
        y: next.y,
        speed: Math.hypot(velocity.x, velocity.y) * 1000,
      });
      current = next;
      previousVelocity = velocity;
      context.counters.statesEnteringLayers.push(1);
    }

    // Any soft exposure deserves alternatives; the shortcut is only for a clean corridor.
    if (riskCost > 1e-9) return undefined;
    const terminalScore = cumulativeCost + this.terminalCost(
      context,
      current,
      previousVelocity,
      minimumProjectileClearance,
      minimumEnemyClearance,
      context.horizonMs,
    );
    return {
      trajectory: { createdAt: input.time, waypoints },
      cumulativeCost,
      terminalScore,
      safeThroughMs: context.horizonMs,
      reachesHorizon: true,
      fallback: 'none',
      firstControl: closestFixedControl(waypoints[0], input.position, waypoints[0]?.timeOffsetMs ?? 1),
      minimumProjectileClearance,
      minimumEnemyClearance,
      activeProjectileCount: context.counters.activeProjectilesConsidered,
      metrics: this.getMetrics(),
    };
  }

  private search(context: PlannerContext): DodgePlanningResult {
    const { input } = context;
    const allStates: SearchState[] = [{
      index: 0,
      layer: 0,
      x: input.position.x,
      y: input.position.y,
      cumulativeCost: 0,
      parentIndex: -1,
      velocityX: input.previousVelocity?.x ?? input.intentVelocity.x,
      velocityY: input.previousVelocity?.y ?? input.intentVelocity.y,
      controlKey: -1,
      controlRunLength: 0,
      directionBucket: velocityDirectionBucket(input.previousVelocity ?? input.intentVelocity),
      order: 0,
      minimumProjectileClearance: Infinity,
      minimumEnemyClearance: context.startEnemyDistance,
    }];
    let frontier: SearchState[] = [allStates[0]!];
    let deepestLayer = 0;
    let order = 1;
    context.counters.statesEnteringLayers.push(1);

    const maximumReach = input.moveSpeed * context.horizonMs + 1;
    const bucketRadius = Math.ceil(maximumReach / this.config.spatialBucketSize) + 2;
    const bucketWidth = bucketRadius * 2 + 1;

    for (let layer = 1; layer < this.config.timeLayersMs.length; layer++) {
      const startMs = this.config.timeLayersMs[layer - 1]!;
      const endMs = this.config.timeLayersMs[layer]!;
      const durationMs = endMs - startMs;
      const nextByBucket = new Map<number, CandidateState[]>();

      for (const state of frontier) {
        for (const control of context.controls) {
          context.counters.candidatesGenerated++;
          const velocityX = control.x * input.moveSpeed * control.speedFraction;
          const velocityY = control.y * input.moveSpeed * control.speedFraction;
          const nextX = state.x + velocityX * durationMs;
          const nextY = state.y + velocityY * durationMs;
          if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
            context.counters.candidatesRejectedByGeometry++;
            continue;
          }
          const bucketKey = spatialBucketKey(
            input.position,
            nextX,
            nextY,
            control.key,
            this.config.spatialBucketSize,
            bucketRadius,
            bucketWidth,
          );
          if (bucketKey < 0) {
            context.counters.candidatesRejectedByGeometry++;
            continue;
          }
          const partialRank = this.partialProgressRank(context, nextX, nextY);
          const existing = nextByBucket.get(bucketKey);
          if (existing && candidateDominatedBeforeSafety(
            existing,
            state.cumulativeCost,
            state.cumulativeCost + partialRank,
          )) {
            context.counters.statesMerged++;
            continue;
          }
          const safety = this.evaluateEdge(
            context,
            state,
            { x: nextX, y: nextY },
            startMs,
            endMs,
            false,
          );
          if (!safety) continue;
          const transitionCost = this.transitionCost(
            context,
            state,
            { x: velocityX, y: velocityY },
            { x: state.velocityX, y: state.velocityY },
            durationMs,
            safety,
            endMs,
          );
          const cumulativeCost = state.cumulativeCost + transitionCost;
          const candidate: CandidateState = {
            layer,
            x: nextX,
            y: nextY,
            cumulativeCost,
            parentIndex: state.index,
            velocityX,
            velocityY,
            controlKey: control.key,
            controlRunLength: state.controlKey === control.key ? state.controlRunLength + 1 : 1,
            directionBucket: control.directionBucket,
            order: order++,
            minimumProjectileClearance: Math.min(
              state.minimumProjectileClearance,
              safety.minimumProjectileClearance,
            ),
            minimumEnemyClearance: Math.min(
              state.minimumEnemyClearance,
              safety.minimumEnemyClearance,
            ),
            rankScore: cumulativeCost + partialRank,
          };
          if (!existing) {
            nextByBucket.set(bucketKey, [candidate]);
          } else {
            context.counters.statesMerged++;
            retainSpatialCandidate(existing, candidate);
          }
        }
      }

      let retained: CandidateState[] = [];
      for (const bucket of nextByBucket.values()) retained.push(...bucket);
      if (retained.length > context.stateCap) {
        const before = retained.length;
        retained = this.diverseBeam(retained, context);
        context.counters.statesPrunedByBeam += before - retained.length;
      } else {
        retained.sort(candidateBeforeSort);
      }
      if (retained.length === 0) break;

      frontier = retained.map((candidate) => {
        const state: SearchState = { ...candidate, index: allStates.length };
        allStates.push(state);
        return state;
      });
      deepestLayer = layer;
      context.counters.statesEnteringLayers.push(frontier.length);
    }

    if (deepestLayer === 0 || frontier.length === 0) {
      return this.leastRiskFallback(context);
    }

    const safeThroughMs = this.config.timeLayersMs[deepestLayer]!;
    let best = frontier[0]!;
    let bestScore = this.stateTerminalScore(context, best, safeThroughMs);
    for (let index = 1; index < frontier.length; index++) {
      const candidate = frontier[index]!;
      const score = this.stateTerminalScore(context, candidate, safeThroughMs);
      if (score < bestScore - 1e-9
        || Math.abs(score - bestScore) <= 1e-9 && candidate.order < best.order) {
        best = candidate;
        bestScore = score;
      }
    }

    const waypoints = reconstructTrajectory(allStates, best, this.config.timeLayersMs);
    return {
      trajectory: { createdAt: input.time, waypoints },
      cumulativeCost: best.cumulativeCost,
      terminalScore: bestScore,
      safeThroughMs,
      reachesHorizon: deepestLayer === this.config.timeLayersMs.length - 1,
      fallback: deepestLayer === this.config.timeLayersMs.length - 1 ? 'none' : 'partial',
      firstControl: firstControlKey(allStates, best),
      minimumProjectileClearance: best.minimumProjectileClearance,
      minimumEnemyClearance: best.minimumEnemyClearance,
      activeProjectileCount: context.counters.activeProjectilesConsidered,
      metrics: this.getMetrics(),
    };
  }

  private leastRiskFallback(context: PlannerContext): DodgePlanningResult {
    const { input } = context;
    const endMs = this.config.timeLayersMs[1] ?? 20;
    let best:
      | { control: MovementControl; target: { x: number; y: number }; safety: EdgeSafety; score: number }
      | undefined;
    for (const control of context.controls) {
      context.counters.candidatesGenerated++;
      const velocityX = control.x * input.moveSpeed * control.speedFraction;
      const velocityY = control.y * input.moveSpeed * control.speedFraction;
      const target = {
        x: input.position.x + velocityX * endMs,
        y: input.position.y + velocityY * endMs,
      };
      const safety = this.evaluateEdge(context, input.position, target, 0, endMs, true);
      if (!safety) continue;
      const score = safety.softCost
        + (safety.collision ? this.weights.lethalFallback : 0)
        - Math.min(safety.minimumProjectileClearance, 2)
        - control.speedFraction * 0.1;
      if (!best || score < best.score - 1e-9
        || Math.abs(score - best.score) <= 1e-9 && control.order < best.control.order) {
        best = { control, target, safety, score };
      }
    }

    if (!best) {
      return {
        trajectory: {
          createdAt: input.time,
          waypoints: [{ timeOffsetMs: endMs, x: input.position.x, y: input.position.y, speed: 0 }],
        },
        cumulativeCost: this.weights.lethalFallback,
        terminalScore: this.weights.lethalFallback,
        safeThroughMs: 0,
        reachesHorizon: false,
        fallback: 'stop',
        firstControl: 0,
        minimumProjectileClearance: -Infinity,
        minimumEnemyClearance: context.startEnemyDistance,
        activeProjectileCount: context.counters.activeProjectilesConsidered,
        metrics: this.getMetrics(),
      };
    }

    return {
      trajectory: {
        createdAt: input.time,
        waypoints: [{
          timeOffsetMs: endMs,
          x: best.target.x,
          y: best.target.y,
          speed: input.moveSpeed * best.control.speedFraction * 1000,
        }],
      },
      cumulativeCost: best.score,
      terminalScore: best.score,
      safeThroughMs: best.safety.collision ? 0 : endMs,
      reachesHorizon: false,
      fallback: 'least_risk',
      firstControl: best.control.key,
      minimumProjectileClearance: best.safety.minimumProjectileClearance,
      minimumEnemyClearance: best.safety.minimumEnemyClearance,
      activeProjectileCount: context.counters.activeProjectilesConsidered,
      metrics: this.getMetrics(),
    };
  }

  private evaluateEdge(
    context: PlannerContext,
    from: { x: number; y: number },
    to: { x: number; y: number },
    startMs: number,
    endMs: number,
    allowProjectileCollision: boolean,
  ): EdgeSafety | undefined {
    const durationMs = endMs - startMs;
    if (durationMs <= 0) return undefined;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const travel = Math.hypot(dx, dy);
    if (!Number.isFinite(travel)
      || travel > context.input.moveSpeed * durationMs + 1e-8) {
      context.counters.candidatesRejectedByGeometry++;
      return undefined;
    }

    const startEnemyDistance = context.collision.enemyDistance(from.x, from.y);
    const combatIntent = context.intent?.mode === 'combat_range' ? context.intent : undefined;
    const combatTarget = context.combatTargetScratch;
    if (combatIntent) writeCombatTargetAt(context, startMs, combatTarget);
    const combatStartDistance = combatIntent
      ? Math.hypot(from.x - combatTarget.x, from.y - combatTarget.y)
      : Infinity;
    let priorCombatDistance = combatStartDistance;
    let priorEnemyDistance = startEnemyDistance;
    let minimumEnemyDistance = Math.min(startEnemyDistance, combatStartDistance);
    let enemyExposure = 0;
    let damagingExposure = 0;
    const spatialSteps = Math.ceil(travel / Math.max(0.05, context.collision.resolution));
    const temporalSteps = travel <= DISTANCE_EPSILON ? 1 : Math.ceil(durationMs / STATIC_SAMPLE_MAX_MS);
    const sampleCount = Math.max(1, spatialSteps, temporalSteps);
    for (let sample = 1; sample <= sampleCount; sample++) {
      const ratio = sample / sampleCount;
      const x = from.x + dx * ratio;
      const y = from.y + dy * ratio;
      if (context.collision.blocked(x, y)) {
        context.counters.candidatesRejectedByGeometry++;
        return undefined;
      }
      const enemyDistance = context.collision.enemyDistance(x, y);
      if (startEnemyDistance >= ENEMY_AVOID_RADIUS - DISTANCE_EPSILON) {
        if (enemyDistance < ENEMY_AVOID_RADIUS - DISTANCE_EPSILON) {
          context.counters.candidatesRejectedByGeometry++;
          return undefined;
        }
      } else if (enemyDistance + 1e-6 < priorEnemyDistance) {
        // A correction can place the player inside the hard zone; only monotonic escape is legal.
        context.counters.candidatesRejectedByGeometry++;
        return undefined;
      }
      priorEnemyDistance = enemyDistance;
      minimumEnemyDistance = Math.min(minimumEnemyDistance, enemyDistance);
      if (combatIntent) {
        writeCombatTargetAt(context, startMs + durationMs * ratio, combatTarget);
        const targetDistance = Math.hypot(x - combatTarget.x, y - combatTarget.y);
        const hardMinimum = Math.max(ENEMY_AVOID_RADIUS, combatIntent.hardMinimumRange);
        if (combatStartDistance >= hardMinimum - DISTANCE_EPSILON) {
          if (targetDistance < hardMinimum - DISTANCE_EPSILON) {
            context.counters.candidatesRejectedByGeometry++;
            return undefined;
          }
        } else if (targetDistance + 1e-6 < priorCombatDistance) {
          context.counters.candidatesRejectedByGeometry++;
          return undefined;
        }
        priorCombatDistance = targetDistance;
        minimumEnemyDistance = Math.min(minimumEnemyDistance, targetDistance);
      }
      if (enemyDistance < ENEMY_SOFT_AVOID_RADIUS) {
        const normalized = clamp(
          (ENEMY_SOFT_AVOID_RADIUS - enemyDistance)
            / (ENEMY_SOFT_AVOID_RADIUS - ENEMY_AVOID_RADIUS),
          0,
          1,
        );
        enemyExposure += normalized * normalized;
      }
      if (context.input.safeWalk) {
        damagingExposure += context.collision.damagingFloor(x, y);
      }
    }

    const playerVelocity = { x: dx / durationMs, y: dy / durationMs };
    let projectileCost = 0;
    let collision = false;
    let minimumProjectileClearance = Infinity;
    context.projectileIndex.query(from, to, (segment) => {
      if (segment.endMs <= startMs || segment.startMs >= endMs) return;
      const overlapStart = Math.max(startMs, segment.startMs);
      const overlapEnd = Math.min(endMs, segment.endMs);
      if (overlapEnd <= overlapStart) return;
      const playerStart = {
        x: from.x + playerVelocity.x * (overlapStart - startMs),
        y: from.y + playerVelocity.y * (overlapStart - startMs),
      };
      const projectileStart = {
        x: segment.startX + segment.velocityX * (overlapStart - segment.startMs),
        y: segment.startY + segment.velocityY * (overlapStart - segment.startMs),
      };
      const duration = overlapEnd - overlapStart;
      const closest = sweptRelativeMotion(
        playerStart,
        playerVelocity,
        projectileStart,
        { x: segment.velocityX, y: segment.velocityY },
        duration,
      );
      const clearance = closest.minimumDistance - segment.collisionRadius;
      minimumProjectileClearance = Math.min(minimumProjectileClearance, clearance);
      const aabbCollision = sweptAabbCollision(
        playerStart.x - projectileStart.x,
        playerStart.y - projectileStart.y,
        playerVelocity.x - segment.velocityX,
        playerVelocity.y - segment.velocityY,
        segment.collisionRadius,
        duration,
      );
      if (clearance <= 0 || aabbCollision) collision = true;
      if (clearance < segment.nearRadius - segment.collisionRadius) {
        const normalized = clamp(
          (segment.nearRadius - segment.collisionRadius - clearance) / PROJECTILE_NEAR_BAND,
          0,
          1,
        );
        projectileCost += this.weights.projectileRiskPerSecond
          * (duration / 1000)
          * normalized * normalized;
      }
    });
    if (collision && !allowProjectileCollision) {
      context.counters.candidatesRejectedByProjectiles++;
      return undefined;
    }

    for (const aoe of context.sortedAoes) {
      const landingMs = aoe.landingTime - context.input.time;
      if (landingMs < startMs || landingMs > endMs) continue;
      const ratio = clamp((landingMs - startMs) / durationMs, 0, 1);
      const x = from.x + dx * ratio;
      const y = from.y + dy * ratio;
      const clearance = Math.hypot(x - aoe.x, y - aoe.y)
        - Math.max(0, aoe.radius) - AOE_SAFETY_MARGIN;
      minimumProjectileClearance = Math.min(minimumProjectileClearance, clearance);
      if (clearance <= 0) {
        collision = true;
        if (!allowProjectileCollision) {
          context.counters.candidatesRejectedByProjectiles++;
          return undefined;
        }
      }
      if (clearance < AOE_NEAR_BAND) {
        const normalized = clamp((AOE_NEAR_BAND - clearance) / AOE_NEAR_BAND, 0, 1);
        projectileCost += this.weights.projectileRiskPerSecond
          * 0.05 * normalized * normalized;
      }
    }

    const durationSeconds = durationMs / 1000;
    return {
      softCost: projectileCost
        + this.weights.enemyRiskPerSecond
          * durationSeconds * enemyExposure / sampleCount
        + this.weights.damagingFloorPerDamageSecond
          * durationSeconds * damagingExposure / sampleCount,
      collision,
      minimumProjectileClearance,
      minimumEnemyClearance: minimumEnemyDistance,
    };
  }

  private transitionCost(
    context: PlannerContext,
    from: { x: number; y: number },
    velocity: { x: number; y: number },
    previousVelocity: { x: number; y: number },
    durationMs: number,
    safety: EdgeSafety,
    endMs: number,
  ): number {
    const durationSeconds = durationMs / 1000;
    const speed = Math.hypot(velocity.x, velocity.y);
    const previousSpeed = Math.hypot(previousVelocity.x, previousVelocity.y);
    let cost = safety.softCost + this.weights.basePerSecond * durationSeconds;
    if (speed > 1e-9 && previousSpeed > 1e-9) {
      const dot = clamp(
        (velocity.x * previousVelocity.x + velocity.y * previousVelocity.y)
          / (speed * previousSpeed),
        -1,
        1,
      );
      const change = 1 - dot;
      cost += this.weights.directionChange * change * change;
      if (dot < -0.2) cost += this.weights.directionReversal * (-dot - 0.2) / 0.8;
    }
    if (context.input.moveSpeed > 1e-9) {
      cost += this.weights.speedChange
        * Math.abs(speed - previousSpeed) / context.input.moveSpeed;
    }

    cost += this.calculateIntentTransitionCost(context, from, velocity, durationMs, endMs);
    const desired = desiredDirectionAt(context, from, endMs - durationMs);
    const desiredScale = desiredDirectionCostScaleAt(context, from, endMs - durationMs);
    const desiredActive = !!desired && desiredScale > 1e-9;
    if (speed <= 1e-9 && desiredActive) {
      cost += this.weights.unnecessaryWaitPerSecond * durationSeconds * desiredScale;
    } else if (speed > 1e-9 && !desiredActive && context.input.moveSpeed > 1e-9) {
      cost += this.weights.unnecessaryMotionPerSecond
        * durationSeconds * speed / context.input.moveSpeed;
    }
    if (desiredActive) {
      if (speed > 1e-9) {
        const alignment = clamp(
          (velocity.x * desired.x + velocity.y * desired.y) / speed,
          -1,
          1,
        );
        cost += this.weights.pathIntentDeviationPerSecond
          * durationSeconds * (1 - alignment) * 0.5 * desiredScale;
      }
    }
    return cost;
  }

  private calculateIntentTransitionCost(
    context: PlannerContext,
    from: { x: number; y: number },
    velocity: { x: number; y: number },
    durationMs: number,
    endMs: number,
  ): number {
    if (context.intent?.mode !== 'combat_range') return 0;
    const endpoint = {
      x: from.x + velocity.x * durationMs,
      y: from.y + velocity.y * durationMs,
    };
    const durationSeconds = durationMs / 1000;
    return combatRangePenalty(
      context,
      endpoint,
      endMs,
      this.weights.combatTooClosePerSecond * durationSeconds,
      this.weights.combatTooFarPerSecond * durationSeconds * context.retreatPenaltyScale,
    );
  }

  private partialProgressRank(context: PlannerContext, x: number, y: number): number {
    const position = { x, y };
    if (context.intent?.mode === 'combat_range') {
      return combatRangePenalty(
        context,
        position,
        context.horizonMs,
        0.8,
        context.retreatPenaltyScale * 0.35,
      );
    }
    const goal = goalScoringPoint(context);
    if (!goal) return 0;
    return Math.max(0, distance(position, goal) - goal.threshold) * 0.35;
  }

  private stateTerminalScore(
    context: PlannerContext,
    state: SearchState,
    safeThroughMs: number,
  ): number {
    return state.cumulativeCost + this.terminalCost(
      context,
      state,
      { x: state.velocityX, y: state.velocityY },
      state.minimumProjectileClearance,
      state.minimumEnemyClearance,
      safeThroughMs,
    );
  }

  private terminalCost(
    context: PlannerContext,
    position: { x: number; y: number },
    velocity: { x: number; y: number },
    projectileClearance: number,
    enemyClearance: number,
    safeThroughMs: number,
  ): number {
    let cost = this.weights.incompleteHorizonPerSecond
      * Math.max(0, context.horizonMs - safeThroughMs) / 1000;
    const goal = context.intent?.mode !== 'combat_range' ? goalScoringPoint(context) : undefined;
    if (goal) {
      const remaining = Math.max(0, distance(position, goal) - goal.threshold);
      cost += this.weights.terminalGoalDistance * remaining;
      const speed = Math.hypot(velocity.x, velocity.y);
      if (speed > 1e-9 && remaining > 1e-9) {
        const dx = goal.x - position.x;
        const dy = goal.y - position.y;
        const alignment = clamp((velocity.x * dx + velocity.y * dy) / (speed * Math.hypot(dx, dy)), -1, 1);
        cost += this.weights.terminalHeadingMismatch * (1 - alignment) * 0.5;
      }
    }
    if (context.intent?.mode === 'combat_range') {
      cost += combatRangePenalty(
        context,
        position,
        safeThroughMs,
        this.weights.terminalCombatTooClose,
        this.weights.terminalCombatTooFar * context.retreatPenaltyScale,
      );
    }
    const terminalSpeed = Math.hypot(velocity.x, velocity.y);
    if (desiredDirectionCostScaleAt(context, position, safeThroughMs) <= 1e-9
      && terminalSpeed > 1e-9 && context.input.moveSpeed > 1e-9) {
      cost += this.weights.terminalUnnecessarySpeed
        * Math.min(1, terminalSpeed / context.input.moveSpeed);
    }
    if (Number.isFinite(projectileClearance) && projectileClearance < PROJECTILE_NEAR_BAND) {
      const normalized = clamp((PROJECTILE_NEAR_BAND - projectileClearance) / PROJECTILE_NEAR_BAND, 0, 1);
      cost += this.weights.terminalFutureExposure * normalized * normalized;
    }
    if (Number.isFinite(enemyClearance) && enemyClearance < ENEMY_SOFT_AVOID_RADIUS) {
      const normalized = clamp(
        (ENEMY_SOFT_AVOID_RADIUS - enemyClearance)
          / (ENEMY_SOFT_AVOID_RADIUS - ENEMY_AVOID_RADIUS),
        0,
        1,
      );
      cost += this.weights.terminalEnemyProximity * normalized * normalized;
    }
    const openings = this.escapeOpeningCount(context, position);
    const blockedFraction = 1 - openings / DEFAULT_DIRECTION_COUNT;
    cost += this.weights.terminalPoorEscape * blockedFraction * blockedFraction;
    return cost;
  }

  private escapeOpeningCount(context: PlannerContext, position: { x: number; y: number }): number {
    let openings = 0;
    const probeDistance = 0.4;
    const startEnemy = context.collision.enemyDistance(position.x, position.y);
    for (let direction = 0; direction < DEFAULT_DIRECTION_COUNT; direction++) {
      const angle = direction * Math.PI * 2 / DEFAULT_DIRECTION_COUNT;
      const x = position.x + Math.cos(angle) * probeDistance;
      const y = position.y + Math.sin(angle) * probeDistance;
      if (context.collision.blocked(x, y)) continue;
      const enemyDistance = context.collision.enemyDistance(x, y);
      if (startEnemy >= ENEMY_AVOID_RADIUS
        ? enemyDistance >= ENEMY_AVOID_RADIUS
        : enemyDistance + 1e-6 >= startEnemy) openings++;
    }
    return openings;
  }

  private diverseBeam(candidates: CandidateState[], context: PlannerContext): CandidateState[] {
    candidates.sort(candidateBeforeSort);
    const selected: CandidateState[] = [];
    const selectedOrders = new Set<number>();
    const add = (candidate: CandidateState | undefined): void => {
      if (!candidate || selected.length >= context.stateCap
        || selectedOrders.has(candidate.order)) return;
      selectedOrders.add(candidate.order);
      selected.push(candidate);
    };

    const bestDirection = new Map<number, CandidateState>();
    const mostPersistentDirection = new Map<number, CandidateState>();
    const bestSector = new Map<number, CandidateState[]>();
    for (const candidate of candidates) {
      if (!bestDirection.has(candidate.directionBucket)) {
        bestDirection.set(candidate.directionBucket, candidate);
      }
      const persistent = mostPersistentDirection.get(candidate.directionBucket);
      if (!persistent
        || candidate.controlRunLength > persistent.controlRunLength
        || candidate.controlRunLength === persistent.controlRunLength
          && candidateBeforeSort(candidate, persistent) < 0) {
        mostPersistentDirection.set(candidate.directionBucket, candidate);
      }
      const dx = candidate.x - context.input.position.x;
      const dy = candidate.y - context.input.position.y;
      const radius = Math.hypot(dx, dy);
      const radialBand = Math.min(3, Math.floor(radius / 1.25));
      const angle = Math.atan2(dy, dx);
      const sector = Math.floor((angle + Math.PI) / (Math.PI * 2) * 16) & 15;
      const key = radialBand * 16 + sector;
      const sectorCandidates = bestSector.get(key);
      if (!sectorCandidates) bestSector.set(key, [candidate]);
      else if (sectorCandidates.length < 4) sectorCandidates.push(candidate);
    }
    for (const candidate of [...bestDirection.values()].sort(candidateBeforeSort)) add(candidate);
    for (const candidate of [...mostPersistentDirection.values()].sort(candidateBeforeSort)) add(candidate);
    for (let sectorRank = 0; sectorRank < 4; sectorRank++) {
      const round = [...bestSector.values()]
        .map((sector) => sector[sectorRank])
        .filter((candidate): candidate is CandidateState => !!candidate)
        .sort(candidateBeforeSort);
      for (const candidate of round) add(candidate);
    }

    const regionCounts = new Map<number, number>();
    const regionLimit = Math.max(2, Math.ceil(context.stateCap / 64));
    for (const candidate of candidates) {
      if (selected.length >= context.stateCap) break;
      const regionX = Math.floor((candidate.x - context.input.position.x) / 0.5);
      const regionY = Math.floor((candidate.y - context.input.position.y) / 0.5);
      const region = (regionX + 128) * 512 + regionY + 256;
      const count = regionCounts.get(region) ?? 0;
      if (count >= regionLimit) continue;
      if (!selectedOrders.has(candidate.order)) regionCounts.set(region, count + 1);
      add(candidate);
    }
    for (const candidate of candidates) add(candidate);
    selected.sort(candidateBeforeSort);
    return selected;
  }

  private staticSegmentOpen(
    context: PlannerContext,
    from: { x: number; y: number },
    to: { x: number; y: number },
    startEnemyDistance: number,
  ): boolean {
    const isTileBlocked = (
      tileX: number,
      tileY: number,
      segmentFrom: { x: number; y: number },
      segmentTo: { x: number; y: number },
    ): boolean => {
      const sample = segmentOccupancySampleInTile(segmentFrom, segmentTo, tileX, tileY);
      return context.collision.blocked(sample.x, sample.y);
    };
    if (!isStaticSegmentSupercoverOpen(from, to, isTileBlocked)) return false;

    const travel = distance(from, to);
    const steps = Math.max(1, Math.ceil(travel / (context.collision.resolution * 0.5)));
    let previousEnemyDistance = startEnemyDistance;
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      const x = from.x + (to.x - from.x) * ratio;
      const y = from.y + (to.y - from.y) * ratio;
      const enemyDistance = context.collision.enemyDistance(x, y);
      if (startEnemyDistance >= ENEMY_AVOID_RADIUS
        ? enemyDistance < ENEMY_AVOID_RADIUS
        : enemyDistance + 1e-6 < previousEnemyDistance) return false;
      previousEnemyDistance = enemyDistance;
    }
    return true;
  }

  private predictProjectileSegments(
    input: DodgePlanningInput,
    horizonMs: number,
    counters: PlanCounters,
  ): ProjectileSegment[] {
    const segments: ProjectileSegment[] = [];
    const maximumReach = input.moveSpeed * horizonMs + PROJECTILE_NEAR_BAND + 2;
    // Iterate projectiles in stable (ownerId, bulletId, startTime) order so the
    // segment insertion order — and therefore the per-edge projectileCost sum
    // order — is deterministic across replays. IEEE-754 non-associativity would
    // otherwise let iteration-order permutations flip rankScore ties.
    const sortedProjectiles = [...input.projectiles].sort((a, b) => {
      return a.ownerId - b.ownerId
        || a.bulletId - b.bulletId
        || a.startTime - b.startTime;
    });
    for (const projectile of sortedProjectiles) {
      if (projectile.side !== 'enemy'
        || projectile.hitObjects.has(input.playerId)
        || projectile.startTime > input.time + horizonMs
        || projectile.startTime + projectile.definition.lifetimeMs < input.time) continue;

      const projectileSegments: ProjectileSegment[] = [];
      const firstOffset = Math.max(0, projectile.startTime - input.time);
      const finalOffset = Math.min(
        horizonMs,
        projectile.startTime + projectile.definition.lifetimeMs - input.time,
      );
      if (finalOffset < firstOffset) continue;
      const nonlinear = projectile.definition.wavy
        || projectile.definition.parametric
        || projectile.definition.boomerang
        || projectile.definition.amplitude !== 0
        || projectile.definition.acceleration !== 0;
      const stepMs = nonlinear
        ? Math.min(this.config.projectilePredictionStepMs, 15)
        : Math.max(1, finalOffset - firstOffset);
      const previous = predictProjectilePosition(projectile, input.time + firstOffset);
      let previousOffset = firstOffset;
      let previousPoint = { ...previous };
      const collisionRadius = DODGE_HITBOX_HALF_SIZE;

      while (previousOffset < finalOffset - 1e-9) {
        const nextOffset = Math.min(finalOffset, previousOffset + stepMs);
        if (!isProjectileAliveAt(projectile, input.time + nextOffset)) break;
        const predicted = predictProjectilePosition(projectile, input.time + nextOffset);
        let endPoint = { ...predicted };
        let endOffset = nextOffset;
        const open = input.environment.isProjectileSegmentOpen(
          previousPoint.x,
          previousPoint.y,
          endPoint.x,
          endPoint.y,
          projectile,
        );
        let blocked = !open;
        if (blocked) {
          const clipped = clipProjectileAtCover(
            input.environment,
            projectile,
            previousPoint,
            endPoint,
          );
          if (clipped.ratio <= 1e-3) break;
          endPoint = clipped.point;
          endOffset = previousOffset + (nextOffset - previousOffset) * clipped.ratio;
        }
        const duration = endOffset - previousOffset;
        if (duration > 1e-6) {
          projectileSegments.push({
            startMs: previousOffset,
            endMs: endOffset,
            startX: previousPoint.x,
            startY: previousPoint.y,
            endX: endPoint.x,
            endY: endPoint.y,
            velocityX: (endPoint.x - previousPoint.x) / duration,
            velocityY: (endPoint.y - previousPoint.y) / duration,
            collisionRadius,
            nearRadius: collisionRadius + PROJECTILE_NEAR_BAND,
          });
        }
        if (blocked) break;
        previousPoint = endPoint;
        previousOffset = nextOffset;
      }

      if (!projectileSegments.some((segment) => segmentNearPoint(
        segment,
        input.position,
        maximumReach,
      ))) continue;
      counters.activeProjectilesConsidered++;
      segments.push(...projectileSegments);
    }
    return segments;
  }

  private earliestIntentCollision(context: PlannerContext): number | null {
    const { input } = context;
    let current = { ...input.position };
    let earliest = Infinity;
    for (let layer = 1; layer < this.config.timeLayersMs.length; layer++) {
      const startMs = this.config.timeLayersMs[layer - 1]!;
      const endMs = this.config.timeLayersMs[layer]!;
      const durationMs = endMs - startMs;
      const velocity = directVelocity(context, current, startMs, durationMs);
      const next = {
        x: current.x + velocity.x * durationMs,
        y: current.y + velocity.y * durationMs,
      };
      context.projectileIndex.query(current, next, (segment) => {
        if (segment.endMs <= startMs || segment.startMs >= endMs) return;
        const overlapStart = Math.max(startMs, segment.startMs);
        const overlapEnd = Math.min(endMs, segment.endMs);
        if (overlapEnd <= overlapStart) return;
        const playerStart = {
          x: current.x + velocity.x * (overlapStart - startMs),
          y: current.y + velocity.y * (overlapStart - startMs),
        };
        const projectileStart = {
          x: segment.startX + segment.velocityX * (overlapStart - segment.startMs),
          y: segment.startY + segment.velocityY * (overlapStart - segment.startMs),
        };
        const duration = overlapEnd - overlapStart;
        const relative = sweptRelativeMotion(
          playerStart,
          velocity,
          projectileStart,
          { x: segment.velocityX, y: segment.velocityY },
          duration,
        );
        const aabb = sweptAabbCollision(
          playerStart.x - projectileStart.x,
          playerStart.y - projectileStart.y,
          velocity.x - segment.velocityX,
          velocity.y - segment.velocityY,
          segment.collisionRadius,
          duration,
        );
        if (relative.minimumDistance <= segment.collisionRadius || aabb) {
          earliest = Math.min(
            earliest,
            overlapStart + (relative.minimumDistance <= segment.collisionRadius
              ? relative.closestTimeMs
              : 0),
          );
        }
      });
      for (const aoe of context.sortedAoes) {
        const landingMs = aoe.landingTime - input.time;
        if (landingMs < startMs || landingMs > endMs) continue;
        const ratio = (landingMs - startMs) / durationMs;
        const x = current.x + (next.x - current.x) * ratio;
        const y = current.y + (next.y - current.y) * ratio;
        if (Math.hypot(x - aoe.x, y - aoe.y) <= aoe.radius + AOE_SAFETY_MARGIN) {
          earliest = Math.min(earliest, landingMs);
        }
      }
      current = next;
    }
    return Number.isFinite(earliest) ? earliest : null;
  }

  private recordPlan(counters: PlanCounters, reason: DodgeReplanReason): void {
    this.lastCounters = counters;
    this.totalPlans++;
    this.totalDurationMs += counters.planningDurationMs;
    this.worstDurationMs = Math.max(this.worstDurationMs, counters.planningDurationMs);
    if (reason === 'urgent') this.urgentReplans++;
    else this.normalReplans++;
  }
}

class ProjectileSpatialIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly visited: Int32Array;
  private visitRevision = 0;
  private readonly originX: number;
  private readonly originY: number;
  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly segments: readonly ProjectileSegment[],
    center: { x: number; y: number },
    radius: number,
  ) {
    this.originX = center.x - radius;
    this.originY = center.y - radius;
    this.width = Math.max(1, Math.ceil(radius * 2 / PROJECTILE_INDEX_CELL_SIZE) + 1);
    this.height = this.width;
    this.visited = new Int32Array(segments.length);
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!;
      const minColumn = this.column(Math.min(segment.startX, segment.endX) - segment.nearRadius);
      const maxColumn = this.column(Math.max(segment.startX, segment.endX) + segment.nearRadius);
      const minRow = this.row(Math.min(segment.startY, segment.endY) - segment.nearRadius);
      const maxRow = this.row(Math.max(segment.startY, segment.endY) + segment.nearRadius);
      for (let row = minRow; row <= maxRow; row++) {
        for (let column = minColumn; column <= maxColumn; column++) {
          const key = row * this.width + column;
          const values = this.cells.get(key);
          if (values) values.push(index);
          else this.cells.set(key, [index]);
        }
      }
    }
  }

  query(
    from: { x: number; y: number },
    to: { x: number; y: number },
    visit: (segment: ProjectileSegment) => void,
  ): void {
    if (this.segments.length === 0) return;
    this.visitRevision++;
    if (this.visitRevision === 0x7fffffff) {
      this.visited.fill(0);
      this.visitRevision = 1;
    }
    const minColumn = this.column(Math.min(from.x, to.x));
    const maxColumn = this.column(Math.max(from.x, to.x));
    const minRow = this.row(Math.min(from.y, to.y));
    const maxRow = this.row(Math.max(from.y, to.y));
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        for (const index of this.cells.get(row * this.width + column) ?? []) {
          if (this.visited[index] === this.visitRevision) continue;
          this.visited[index] = this.visitRevision;
          visit(this.segments[index]!);
        }
      }
    }
  }

  private column(x: number): number {
    return clampInteger(Math.floor((x - this.originX) / PROJECTILE_INDEX_CELL_SIZE), 0, this.width - 1);
  }

  private row(y: number): number {
    return clampInteger(Math.floor((y - this.originY) / PROJECTILE_INDEX_CELL_SIZE), 0, this.height - 1);
  }
}

function createCollisionQuery(
  environment: DodgePlanningEnvironment,
  center: { x: number; y: number },
  radius: number,
  resolution: number,
  safeWalk: boolean,
): CollisionQuery {
  const startTileX = Math.floor(center.x);
  const startTileY = Math.floor(center.y);
  const isStartingTile = (x: number, y: number): boolean =>
    Math.floor(x) === startTileX && Math.floor(y) === startTileY;
  const snapshot = environment.createLocalSnapshot?.(center, radius, resolution);
  if (!snapshot) {
    const rawBlocked = (x: number, y: number): boolean =>
      !environment.canOccupy(x, y, safeWalk, false);
    const allowStartingTile = rawBlocked(center.x, center.y)
      && hasOpenNeighbor(startTileX, startTileY, rawBlocked);
    return {
      resolution,
      // The authoritative player position can already overlap an OccupySquare
      // object. Match global pathfinding's start-cell exemption so the local
      // planner can leave that cell, while still rejecting every other block.
      blocked: (x, y) => rawBlocked(x, y)
        && !(allowStartingTile && isStartingTile(x, y)),
      damagingFloor: () => 0,
      enemyDistance: (x, y) => environment.enemyClearance?.(x, y) ?? Infinity,
    };
  }
  const indexAt = (x: number, y: number): number => {
    const column = Math.round((x - snapshot.originX) / snapshot.resolution);
    const row = Math.round((y - snapshot.originY) / snapshot.resolution);
    if (column < 0 || row < 0 || column >= snapshot.width || row >= snapshot.height) return -1;
    return row * snapshot.width + column;
  };
  const startIndex = indexAt(center.x, center.y);
  const startBlocked = startIndex < 0 || snapshot.blocked[startIndex] !== 0;
  const rawBlocked = (x: number, y: number): boolean => {
    const index = indexAt(x, y);
    return index < 0 || snapshot.blocked[index] !== 0;
  };
  const allowStartingTile = startBlocked
    && hasOpenNeighbor(startTileX, startTileY, rawBlocked);
  return {
    resolution: snapshot.resolution,
    blocked: (x, y) => {
      return rawBlocked(x, y) && !(allowStartingTile && isStartingTile(x, y));
    },
    damagingFloor: (x, y) => {
      const index = indexAt(x, y);
      return index < 0 ? Infinity : snapshot.damagingFloor[index] ?? 0;
    },
    enemyDistance: (x, y) => {
      const index = indexAt(x, y);
      return index < 0 ? 0 : snapshot.enemyDistance[index] ?? Infinity;
    },
  };
}

function hasOpenNeighbor(
  tileX: number,
  tileY: number,
  blocked: (x: number, y: number) => boolean,
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (!blocked(tileX + dx + 0.5, tileY + dy + 0.5)) return true;
    }
  }
  return false;
}

function createFixedControls(): MovementControl[] {
  const controls: MovementControl[] = [{
    x: 0,
    y: 0,
    speedFraction: 0,
    key: 0,
    directionBucket: 0,
    order: 0,
  }];
  let key = 1;
  for (let direction = 0; direction < DEFAULT_DIRECTION_COUNT; direction++) {
    const angle = direction * Math.PI * 2 / DEFAULT_DIRECTION_COUNT;
    for (const speedFraction of DEFAULT_SPEED_FRACTIONS) {
      controls.push({
        x: Math.cos(angle),
        y: Math.sin(angle),
        speedFraction,
        key,
        directionBucket: direction + 1,
        order: key,
      });
      key++;
    }
  }
  return controls;
}

function createPlanningControls(
  input: DodgePlanningInput,
  segments: readonly ProjectileSegment[],
): MovementControl[] {
  const controls = FIXED_CONTROLS.map((control) => ({ ...control }));
  const adaptiveDirections: Array<{ x: number; y: number }> = [];
  const desired = desiredDirectionFromInput(input, input.position);
  if (desired) adaptiveDirections.push(desired);

  let nearest: ProjectileSegment | undefined;
  let nearestDistance = Infinity;
  for (const segment of segments) {
    const distance = Math.hypot(segment.startX - input.position.x, segment.startY - input.position.y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = segment;
    }
  }
  if (nearest) {
    const awayX = input.position.x - nearest.startX;
    const awayY = input.position.y - nearest.startY;
    const awayLength = Math.hypot(awayX, awayY);
    if (awayLength > 1e-9) {
      const away = { x: awayX / awayLength, y: awayY / awayLength };
      adaptiveDirections.push(away, { x: -away.y, y: away.x }, { x: away.y, y: -away.x });
    }
  }

  let key = FIXED_CONTROLS.length;
  for (const direction of adaptiveDirections) {
    for (const speedFraction of DEFAULT_SPEED_FRACTIONS) {
      if (controls.length >= MAX_CONTROL_COUNT) break;
      const duplicate = controls.some((control) => control.speedFraction === speedFraction
        && control.speedFraction > 0
        && control.x * direction.x + control.y * direction.y > 0.9995);
      if (duplicate) continue;
      controls.push({
        x: direction.x,
        y: direction.y,
        speedFraction,
        key,
        directionBucket: angleBucket(direction.x, direction.y) + 1,
        order: key,
      });
      key++;
    }
  }
  return controls;
}

function directVelocity(
  context: PlannerContext,
  position: { x: number; y: number },
  startMs: number,
  durationMs: number,
): { x: number; y: number } {
  const { input } = context;
  const desired = desiredDirectionAt(context, position, startMs);
  if (!desired) return { x: 0, y: 0 };

  let maximumTravel = input.moveSpeed * durationMs;
  if (context.intent?.mode === 'combat_range') {
    const target = context.combatTargetScratch;
    writeCombatTargetAt(context, startMs, target);
    const targetDistance = distance(position, target);
    if (targetDistance > context.intent.preferredMaximumRange) {
      maximumTravel = Math.min(
        maximumTravel,
        targetDistance - context.intent.preferredMaximumRange,
      );
    } else if (targetDistance < context.intent.preferredMinimumRange) {
      maximumTravel = Math.min(
        maximumTravel,
        context.intent.preferredMinimumRange - targetDistance,
      );
    }
  } else {
    const goal = goalScoringPoint(context);
    if (goal) {
      maximumTravel = Math.min(
        maximumTravel,
        Math.max(0, distance(position, goal) - goal.threshold * 0.5),
      );
    }
  }
  return {
    x: desired.x * maximumTravel / durationMs,
    y: desired.y * maximumTravel / durationMs,
  };
}

function desiredDirectionFromInput(
  input: DodgePlanningInput,
  position: { x: number; y: number },
): { x: number; y: number } | undefined {
  const intent = plannerIntent(input);
  const route = validGoal(input.routeWaypoint)
    ? input.routeWaypoint
    : validGoal(input.goal) ? input.goal : undefined;
  let dx: number;
  let dy: number;
  if (intent?.mode === 'combat_range') {
    const targetDistance = Math.hypot(position.x - intent.targetX, position.y - intent.targetY);
    if (targetDistance < intent.preferredMinimumRange) {
      dx = position.x - intent.targetX;
      dy = position.y - intent.targetY;
    } else if (targetDistance > intent.preferredMaximumRange) {
      dx = route ? route.x - position.x : intent.targetX - position.x;
      dy = route ? route.y - position.y : intent.targetY - position.y;
    } else {
      return undefined;
    }
  } else if (intent?.mode === 'goal') {
    if (Math.hypot(position.x - intent.goalX, position.y - intent.goalY)
      <= Math.max(0, intent.arriveThreshold ?? 0)) return undefined;
    dx = route ? route.x - position.x : intent.goalX - position.x;
    dy = route ? route.y - position.y : intent.goalY - position.y;
  } else if (input.preferredDirection) {
    dx = input.preferredDirection.x;
    dy = input.preferredDirection.y;
  } else {
    dx = input.intentVelocity.x;
    dy = input.intentVelocity.y;
  }
  const length = Math.hypot(dx, dy);
  if (length <= 1e-9) return undefined;
  return { x: dx / length, y: dy / length };
}

function desiredDirectionAt(
  context: PlannerContext,
  position: { x: number; y: number },
  timeOffsetMs: number,
): { x: number; y: number } | undefined {
  const intent = context.intent;
  if (intent?.mode === 'combat_range') {
    const target = context.combatTargetScratch;
    writeCombatTargetAt(context, timeOffsetMs, target);
    const targetDistance = distance(position, target);
    if (targetDistance >= intent.preferredMinimumRange
      && targetDistance <= intent.preferredMaximumRange) return undefined;
    const destination = targetDistance < intent.preferredMinimumRange
      ? { x: position.x * 2 - target.x, y: position.y * 2 - target.y }
      : context.routeWaypoint ?? target;
    return unitVector(position, destination);
  }
  if (intent?.mode === 'goal') {
    if (Math.hypot(position.x - intent.goalX, position.y - intent.goalY)
      <= Math.max(0, intent.arriveThreshold ?? 0)) return undefined;
    return unitVector(
      position,
      context.routeWaypoint ?? { x: intent.goalX, y: intent.goalY },
    );
  }
  if (context.routeWaypoint) return unitVector(position, context.routeWaypoint);
  if (context.input.preferredDirection) {
    return unitVector({ x: 0, y: 0 }, context.input.preferredDirection);
  }
  return unitVector({ x: 0, y: 0 }, context.input.intentVelocity);
}

function desiredDirectionCostScaleAt(
  context: PlannerContext,
  position: { x: number; y: number },
  timeOffsetMs: number,
): number {
  const intent = context.intent;
  if (intent?.mode !== 'combat_range') {
    return desiredDirectionAt(context, position, timeOffsetMs) ? 1 : 0;
  }
  const target = context.combatTargetScratch;
  writeCombatTargetAt(context, timeOffsetMs, target);
  const targetDistance = distance(position, target);
  if (targetDistance < intent.preferredMinimumRange) return 1;
  if (targetDistance > intent.preferredMaximumRange) return context.retreatPenaltyScale;
  return 0;
}

function reconstructTrajectory(
  states: readonly SearchState[],
  terminal: SearchState,
  timeLayersMs: readonly number[],
): TimedDodgeWaypoint[] {
  const reversed: SearchState[] = [];
  let cursor: SearchState | undefined = terminal;
  while (cursor && cursor.parentIndex >= 0) {
    reversed.push(cursor);
    cursor = states[cursor.parentIndex];
  }
  reversed.reverse();
  return reversed.map((state) => ({
    timeOffsetMs: timeLayersMs[state.layer]!,
    x: state.x,
    y: state.y,
    speed: Math.hypot(state.velocityX, state.velocityY) * 1000,
  }));
}

function firstControlKey(states: readonly SearchState[], terminal: SearchState): number {
  let cursor = terminal;
  while (cursor.parentIndex > 0) cursor = states[cursor.parentIndex]!;
  return cursor.controlKey;
}

function spatialBucketKey(
  start: { x: number; y: number },
  stateX: number,
  stateY: number,
  controlKey: number,
  bucketSize: number,
  bucketRadius: number,
  bucketWidth: number,
): number {
  const x = Math.round((stateX - start.x) / bucketSize) + bucketRadius;
  const y = Math.round((stateY - start.y) / bucketSize) + bucketRadius;
  if (x < 0 || y < 0 || x >= bucketWidth || y >= bucketWidth) return -1;
  return (y * bucketWidth + x) * MAX_CONTROL_COUNT + controlKey;
}

function candidateDominatedBeforeSafety(
  bucket: readonly CandidateState[],
  costLowerBound: number,
  rankLowerBound: number,
): boolean {
  if (bucket.length < STATES_PER_SPATIAL_BUCKET) return false;
  let worst = bucket[0]!;
  for (let index = 1; index < bucket.length; index++) {
    if (candidateBeforeSort(worst, bucket[index]!) < 0) worst = bucket[index]!;
  }
  return worst.rankScore <= rankLowerBound + 1e-9;
}

function candidateBefore(a: CandidateState, b: CandidateState): boolean {
  return a.cumulativeCost < b.cumulativeCost - 1e-9
    || Math.abs(a.cumulativeCost - b.cumulativeCost) <= 1e-9 && a.order < b.order;
}

function retainSpatialCandidate(bucket: CandidateState[], candidate: CandidateState): void {
  if (bucket.length < STATES_PER_SPATIAL_BUCKET) {
    bucket.push(candidate);
    return;
  }
  let worstIndex = 0;
  for (let index = 1; index < bucket.length; index++) {
    // Use the same comparator as every downstream consumer of the bucket
    // (candidateDominatedBeforeSafety, retained.sort, diverseBeam) so we don't
    // drop a rank-better incoming candidate while keeping a rank-worse held one.
    if (candidateBeforeSort(bucket[worstIndex]!, bucket[index]!) < 0) worstIndex = index;
  }
  if (candidateBeforeSort(candidate, bucket[worstIndex]!) < 0) bucket[worstIndex] = candidate;
}

function candidateBeforeSort(a: CandidateState, b: CandidateState): number {
  return a.rankScore - b.rankScore || a.cumulativeCost - b.cumulativeCost || a.order - b.order;
}

function sweptAabbCollision(
  relativeX: number,
  relativeY: number,
  velocityX: number,
  velocityY: number,
  halfSize: number,
  durationMs: number,
): boolean {
  let enter = 0;
  let exit = durationMs;
  const axis = (position: number, velocity: number): boolean => {
    if (Math.abs(velocity) <= 1e-12) return Math.abs(position) <= halfSize;
    const first = (-halfSize - position) / velocity;
    const second = (halfSize - position) / velocity;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    return enter <= exit;
  };
  return axis(relativeX, velocityX) && axis(relativeY, velocityY)
    && exit >= 0 && enter <= durationMs;
}

function clipProjectileAtCover(
  environment: DodgePlanningEnvironment,
  projectile: CombatProjectileSnapshot,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { ratio: number; point: { x: number; y: number } } {
  let openRatio = 0;
  let blockedRatio = 1;
  for (let iteration = 0; iteration < 7; iteration++) {
    const ratio = (openRatio + blockedRatio) * 0.5;
    const point = { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
    if (environment.isProjectileSegmentOpen(from.x, from.y, point.x, point.y, projectile)) {
      openRatio = ratio;
    } else {
      blockedRatio = ratio;
    }
  }
  return {
    ratio: openRatio,
    point: {
      x: from.x + (to.x - from.x) * openRatio,
      y: from.y + (to.y - from.y) * openRatio,
    },
  };
}

function segmentNearPoint(
  segment: ProjectileSegment,
  point: { x: number; y: number },
  radius: number,
): boolean {
  const dx = segment.endX - segment.startX;
  const dy = segment.endY - segment.startY;
  const lengthSquared = dx * dx + dy * dy;
  const ratio = lengthSquared <= 1e-12
    ? 0
    : clamp(
        ((point.x - segment.startX) * dx + (point.y - segment.startY) * dy) / lengthSquared,
        0,
        1,
      );
  return Math.hypot(
    segment.startX + dx * ratio - point.x,
    segment.startY + dy * ratio - point.y,
  ) <= radius;
}

function closestFixedControl(
  waypoint: TimedDodgeWaypoint | undefined,
  start: { x: number; y: number },
  durationMs: number,
): number {
  if (!waypoint || durationMs <= 0) return 0;
  const velocityX = (waypoint.x - start.x) / durationMs;
  const velocityY = (waypoint.y - start.y) / durationMs;
  const speed = Math.hypot(velocityX, velocityY);
  if (speed <= 1e-9) return 0;
  let best = 1;
  let bestDot = -Infinity;
  for (let index = 1; index < FIXED_CONTROLS.length; index++) {
    const control = FIXED_CONTROLS[index]!;
    const dot = control.x * velocityX / speed + control.y * velocityY / speed;
    if (dot > bestDot) {
      bestDot = dot;
      best = control.key;
    }
  }
  return best;
}

function velocityDirectionBucket(velocity: { x: number; y: number }): number {
  return Math.hypot(velocity.x, velocity.y) <= 1e-9
    ? 0
    : angleBucket(velocity.x, velocity.y) + 1;
}

function angleBucket(x: number, y: number): number {
  const normalized = (Math.atan2(y, x) + Math.PI * 2) % (Math.PI * 2);
  return Math.round(normalized / (Math.PI * 2) * DEFAULT_DIRECTION_COUNT)
    % DEFAULT_DIRECTION_COUNT;
}

function jumpDistances(allowance: number): number[] {
  const maximum = Math.max(0.01, Math.min(1.5, allowance));
  const distances = [maximum];
  for (let distance = maximum - JUMP_DISTANCE_STEP; distance > 0.01; distance -= JUMP_DISTANCE_STEP) {
    distances.push(distance);
  }
  if (maximum > 0.01 + 1e-9) distances.push(0.01);
  return distances;
}

function normalizeTimeLayers(values: readonly number[]): readonly number[] {
  const normalized = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .map((value) => Math.round(value));
  if (normalized[0] !== 0 || normalized.length < 3) return DEFAULT_TIME_LAYERS_MS;
  for (let index = 1; index < normalized.length; index++) {
    if (normalized[index]! <= normalized[index - 1]!) return DEFAULT_TIME_LAYERS_MS;
  }
  return Object.freeze(normalized);
}

function emptyCounters(): PlanCounters {
  return {
    planningDurationMs: 0,
    layerCount: 0,
    statesEnteringLayers: [],
    candidatesGenerated: 0,
    candidatesRejectedByGeometry: 0,
    candidatesRejectedByProjectiles: 0,
    statesMerged: 0,
    statesPrunedByBeam: 0,
    activeProjectilesConsidered: 0,
  };
}

function unsafeAssessment(
  remainingMs: number,
  comparisonHorizonMs: number,
  firstUnsafeOffsetMs: number,
): DodgeTrajectoryAssessment {
  return {
    safe: false,
    score: Infinity,
    cumulativeCost: Infinity,
    terminalCost: Infinity,
    intentCost: Infinity,
    comparisonHorizonMs,
    remainingMs,
    firstUnsafeOffsetMs,
  };
}

function plannerIntent(input: DodgePlanningInput): DodgeMovementIntent | null {
  if (input.intent === null) return null;
  if (input.intent !== undefined) {
    const normalized = normalizeDodgeMovementIntent(input.intent);
    if (!normalized) return null;
    if (normalized.mode === 'goal') return normalized;
    const hardMinimumRange = Math.max(ENEMY_AVOID_RADIUS, normalized.hardMinimumRange);
    const preferredMinimumRange = Math.max(hardMinimumRange, normalized.preferredMinimumRange);
    return {
      ...normalized,
      hardMinimumRange,
      preferredMinimumRange,
      preferredMaximumRange: Math.max(preferredMinimumRange, normalized.preferredMaximumRange),
    };
  }
  if (!validGoal(input.goal)) return null;
  return {
    mode: 'goal',
    goalX: input.goal.x,
    goalY: input.goal.y,
    arriveThreshold: Math.max(0, input.goal.threshold ?? 0),
  };
}

function sampleCombatTargetPositions(
  input: DodgePlanningInput,
  intent: DodgeMovementIntent | null,
  timeLayersMs: readonly number[],
  horizonMs: number,
): TimedCombatTargetPosition[] {
  if (intent?.mode !== 'combat_range') return [];
  const positions: TimedCombatTargetPosition[] = [];
  for (const timeOffsetMs of timeLayersMs) {
    if (timeOffsetMs > horizonMs) break;
    const predicted = input.combatTargetPositionAt?.(timeOffsetMs);
    positions.push({
      timeOffsetMs,
      x: predicted && Number.isFinite(predicted.x) ? predicted.x : intent.targetX,
      y: predicted && Number.isFinite(predicted.y) ? predicted.y : intent.targetY,
    });
  }
  if (positions.length === 0 || positions.at(-1)!.timeOffsetMs < horizonMs) {
    const predicted = input.combatTargetPositionAt?.(horizonMs);
    positions.push({
      timeOffsetMs: horizonMs,
      x: predicted && Number.isFinite(predicted.x) ? predicted.x : intent.targetX,
      y: predicted && Number.isFinite(predicted.y) ? predicted.y : intent.targetY,
    });
  }
  return positions;
}

function writeCombatTargetAt(
  context: PlannerContext,
  timeOffsetMs: number,
  out: { x: number; y: number },
): void {
  const intent = context.intent as CombatRangeDodgeIntent;
  const positions = context.combatTargetPositions;
  if (positions.length === 0) {
    out.x = intent.targetX;
    out.y = intent.targetY;
    return;
  }
  if (timeOffsetMs <= positions[0]!.timeOffsetMs) {
    out.x = positions[0]!.x;
    out.y = positions[0]!.y;
    return;
  }
  for (let index = 1; index < positions.length; index++) {
    const next = positions[index]!;
    if (timeOffsetMs > next.timeOffsetMs) continue;
    const previous = positions[index - 1]!;
    const duration = next.timeOffsetMs - previous.timeOffsetMs;
    const ratio = duration <= 0 ? 1 : (timeOffsetMs - previous.timeOffsetMs) / duration;
    out.x = previous.x + (next.x - previous.x) * ratio;
    out.y = previous.y + (next.y - previous.y) * ratio;
    return;
  }
  const last = positions.at(-1)!;
  out.x = last.x;
  out.y = last.y;
}

function combatRangePenalty(
  context: PlannerContext,
  position: { x: number; y: number },
  timeOffsetMs: number,
  tooCloseWeight: number,
  tooFarWeight: number,
): number {
  const intent = context.intent as CombatRangeDodgeIntent;
  const target = context.combatTargetScratch;
  writeCombatTargetAt(context, timeOffsetMs, target);
  const targetDistance = distance(position, target);
  const closeWidth = Math.max(0.25, intent.preferredMinimumRange - intent.hardMinimumRange);
  const farWidth = Math.max(1, intent.preferredMaximumRange - intent.preferredMinimumRange);
  const tooClose = targetDistance < intent.preferredMinimumRange
    ? clamp((intent.preferredMinimumRange - targetDistance) / closeWidth, 0, 1)
    : 0;
  const tooFar = targetDistance > intent.preferredMaximumRange
    ? clamp((targetDistance - intent.preferredMaximumRange) / farWidth, 0, 3)
    : 0;
  return tooCloseWeight * tooClose * tooClose + tooFarWeight * tooFar * tooFar;
}

function goalScoringPoint(
  context: PlannerContext,
): { x: number; y: number; threshold: number } | undefined {
  if (context.intent?.mode === 'goal') {
    const arriveThreshold = Math.max(0, context.intent.arriveThreshold ?? 0);
    if (Math.hypot(
      context.input.position.x - context.intent.goalX,
      context.input.position.y - context.intent.goalY,
    ) <= arriveThreshold) {
      return { x: context.intent.goalX, y: context.intent.goalY, threshold: arriveThreshold };
    }
    return context.routeWaypoint ?? {
      x: context.intent.goalX,
      y: context.intent.goalY,
      threshold: arriveThreshold,
    };
  }
  return context.routeWaypoint;
}

function unitVector(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length } : undefined;
}

function validGoal(
  goal: DodgePlanningInput['goal'],
): goal is { x: number; y: number; threshold?: number } {
  return !!goal && Number.isFinite(goal.x) && Number.isFinite(goal.y);
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeCostWeights(overrides: Partial<DodgeCostWeights> | undefined): Readonly<DodgeCostWeights> {
  const weights: DodgeCostWeights = { ...DODGE_COST_WEIGHTS, ...overrides };
  for (const key of Object.keys(weights) as Array<keyof DodgeCostWeights>) {
    if (!Number.isFinite(weights[key]) || weights[key] < 0) {
      weights[key] = DODGE_COST_WEIGHTS[key];
    }
  }
  return Object.freeze(weights);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function finiteInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? clampInteger(Number(value), minimum, maximum)
    : fallback;
}

function finiteRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value) ? clamp(Number(value), minimum, maximum) : fallback;
}
