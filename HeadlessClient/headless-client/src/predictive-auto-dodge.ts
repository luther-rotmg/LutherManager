import type { CombatProjectileSnapshot } from './combat-tracker';
import {
  cloneDodgeMovementIntent,
  type DodgeMovementIntent,
  type DodgeMovementIntentMode,
} from './dodge-movement-intent';
import {
  SpaceTimeDodgePlanner,
  type DeterministicDodgePlannerMetrics,
  type DodgePlannerMetrics,
  type DodgePlannerOptions,
  type DodgePlanningAoe,
  type DodgePlanningEnvironment,
  type DodgePlanningInput,
  type DodgePlanningResult,
  type DodgeReplanReason,
  type DodgeTrajectory,
  type EmergencyJumpPlan,
  type TimedDodgeWaypoint,
} from './dodge-trajectory-planner';
import {
  MAX_DODGE_JUMP_DISTANCE,
  MIN_DODGE_JUMP_DISTANCE,
  type DodgeJumpStatus,
} from './dodge-jump-limiter';

export type {
  DeterministicDodgePlannerMetrics,
  DodgePlannerMetrics,
  DodgeTrajectory,
  TimedDodgeWaypoint,
} from './dodge-trajectory-planner';

export interface AutoDodgeOptions {
  /** Penalize positive XML floor damage while selecting local trajectories. */
  safeWalk?: boolean;
  /** Allow a limiter-gated emergency MOVE-position jump. Defaults to false. */
  projectileJump?: boolean;
  /** Maximum requested jump distance. Clamped to 0.01-1.5 tiles. */
  maxJumpDistance?: number;
}

// `AutoDodgeAoeThreat` and `AutoDodgeEnvironment` used to exist here as empty
// extensions of `DodgePlanningAoe` and `DodgePlanningEnvironment` respectively.
// They created a naming fork with no semantic difference — consumers had to
// choose between structurally-identical types, and grepping for one name missed
// code using the other. Deleted for the LutherManager fork; use the
// `DodgePlanning*` names directly. Any historical caller compiles against the
// same shape via TypeScript's structural typing.

/** Internal trajectory-controller state; scripts select movement intent, not this state. */
export type DodgeSafetyState = 'normal' | 'evasive' | 'recovering';

export type DodgeReplanCause =
  | 'initial'
  | 'new_threat'
  | 'unsafe'
  | 'intent_changed'
  | 'route_changed'
  | 'drift'
  | 'expired'
  | 'better_plan'
  | 'correction'
  | 'periodic_refresh';

export interface AutoDodgeSnapshot {
  time: number;
  playerId: number;
  position: { x: number; y: number };
  /** Current bounded waypoint supplied by direct walking or global pathfinding. */
  goal?: { x: number; y: number; threshold?: number };
  /** Stable global/script intent; `goal` remains the current local route point. */
  movementIntent?: DodgeMovementIntent | null;
  routeRevision?: number;
  combatTargetPositionAt?: (timeOffsetMs: number) => { x: number; y: number };
  /** Maximum movement speed in tiles per millisecond. */
  moveSpeed: number;
  intentVelocity: { x: number; y: number };
  movementLeadMs: number;
  movementLocked?: boolean;
  jumpAllowance?: number;
  jumpStatus?: DodgeJumpStatus;
  projectiles: Iterable<CombatProjectileSnapshot>;
  aoes: readonly DodgePlanningAoe[];
  environment: DodgePlanningEnvironment;
}

export interface AutoDodgeState {
  enabled: boolean;
  overrideActive: boolean;
  velocity: { x: number; y: number };
  target: { x: number; y: number } | null;
  goal: { x: number; y: number } | null;
  /** Vectorized future route for diagnostics and viewer rendering. */
  path: Array<{ x: number; y: number }>;
  /** Full time-parameterized local plan followed by the movement controller. */
  trajectory: DodgeTrajectory | null;
  jumpTarget: { x: number; y: number } | null;
  jumpDistance: number;
  jumpAllowance: number;
  jumpStatus: DodgeJumpStatus | 'disabled';
  planRevision: number;
  planReused: boolean;
  /** Increments for every planner search, including searches that reuse a plan. */
  searchRevision: number;
  searchPerformed: boolean;
  planCommitted: boolean;
  replanCause: DodgeReplanCause | null;
  movementIntentMode: DodgeMovementIntentMode | null;
  safetyState: DodgeSafetyState;
  /** Scales only combat's soft too-far cost; hard safety remains fully enforced. */
  retreatPenaltyScale: number;
  lastReplanAt: number | null;
  replanReason: DodgeReplanReason | null;
  dangerRevision: number;
  threatCount: number;
  earliestImpactMs: number | null;
  selectedCandidate: number;
  speedScale: number;
  /** Magnitude of the commanded velocity in tiles per millisecond. */
  commandedSpeed: number;
  /** Signed velocity projected onto the selected intent direction, in tiles per millisecond. */
  progressSpeed: number;
  /** Heading of the first control in the committed plan, in radians. */
  firstControlHeading: number | null;
  /** Absolute heading change from the previously committed first control, in radians. */
  headingChange: number | null;
  committedScore: number | null;
  proposedScore: number | null;
  comparisonHorizonMs: number | null;
  movementTargetDistance: number;
  timeSinceLastMovementCommandMs: number | null;
  lookaheadRevision: number;
  lookaheadChanged: boolean;
  decision: string;
  /**
   * Deterministic subset of {@link DodgePlannerMetrics} — the three wall-clock
   * fields (`planningDurationMs`, `averagePlanningDurationMs`,
   * `worstPlanningDurationMs`) are excluded so two byte-identical replays
   * produce byte-identical AutoDodgeState. Live telemetry consumers (dodge
   * viewer, dashboards) should use {@link PredictiveAutoDodgeController.getPlannerMetrics}
   * instead, which still returns the full DodgePlannerMetrics.
   */
  plannerMetrics: DeterministicDodgePlannerMetrics;
}

interface CommittedPlan {
  result: DodgePlanningResult;
  start: { x: number; y: number };
  goal: { x: number; y: number; threshold: number } | null;
  intent: DodgeMovementIntent | null;
  routeRevision: number;
}

const NORMAL_REPLAN_INTERVAL_MS = 100;
const URGENT_REPLAN_INTERVAL_MS = 40;
const MINIMUM_REMAINING_HORIZON_MS = 300;
const TRAJECTORY_DRIFT_TOLERANCE = 0.45;
const GOAL_CHANGE_TOLERANCE = 0.5;
const GOAL_DIRECTION_CHANGE_COSINE = Math.cos(12 * Math.PI / 180);
const RANGE_CHANGE_TOLERANCE = 0.05;
const PLAN_COMPARISON_HORIZON_MS = 350;
const COMMAND_LOOKAHEAD_MS = 60;
const PLAN_SCORE_ABSOLUTE_GAIN = 0.35;
const PLAN_SCORE_RELATIVE_GAIN = 0.08;
const VELOCITY_MATCH_TOLERANCE = 1e-6;
const JUMP_REJECTION_SUPPRESSION_MS = 80;
const EVASIVE_IMPACT_WINDOW_MS = 500;
const EVASIVE_RETREAT_RESPONSE_MS = 80;
const EVASIVE_INITIAL_RESPONSE_MS = 20;
const RECOVERY_RETREAT_RESPONSE_MS = 500;

/**
 * Schedules perception, planning, trajectory hysteresis, and receding-horizon
 * execution around the chronological `SpaceTimeDodgePlanner`.
 */
export class PredictiveAutoDodgeController {
  private readonly planner: SpaceTimeDodgePlanner;
  private enabled = false;
  private safeWalk = true;
  private projectileJump = false;
  private maxJumpDistance = MAX_DODGE_JUMP_DISTANCE;
  private committed: CommittedPlan | undefined;
  private planRevision = 0;
  private lastPlanAt = -Infinity;
  private lastUrgentPlanAt = -Infinity;
  private lastReplanAt: number | null = null;
  private lastEnvironmentRevision: number | undefined;
  private readonly projectileKeys = new Set<string>();
  private readonly aoeKeys = new Set<string>();
  private pendingProjectileUpdates = 0;
  private pendingDangerUpdates = 0;
  private dangerRevision = 0;
  private urgentReplanPending = false;
  private jumpSuppressedUntil = -Infinity;
  private lastCommandVelocity = { x: 0, y: 0 };
  private safetyState: DodgeSafetyState = 'normal';
  private retreatPenaltyScale = 1;
  private dangerPressure = 0;
  private lastSafetyUpdateAt: number | null = null;
  private searchRevision = 0;
  private searchPerformed = false;
  private planCommitted = false;
  private replanCause: DodgeReplanCause | null = null;
  private committedScore: number | null = null;
  private proposedScore: number | null = null;
  private comparisonHorizonMs: number | null = null;
  private firstControlHeading: number | null = null;
  private headingChange: number | null = null;
  private lastLookaheadTarget: { x: number; y: number } | null = null;
  private lookaheadRevision = 0;
  private lastMovementCommandAt: number | null = null;
  private state: AutoDodgeState;

  constructor(plannerOptions: DodgePlannerOptions = {}) {
    this.planner = new SpaceTimeDodgePlanner(plannerOptions);
    this.state = emptyState(false, this.planner.getDeterministicMetrics());
  }

  setEnabled(enabled: boolean, options: AutoDodgeOptions = {}): void {
    this.enabled = enabled;
    if (options.safeWalk !== undefined) this.safeWalk = options.safeWalk;
    if (options.projectileJump !== undefined) this.projectileJump = options.projectileJump;
    if (options.maxJumpDistance !== undefined) {
      this.maxJumpDistance = clamp(
        Number(options.maxJumpDistance),
        MIN_DODGE_JUMP_DISTANCE,
        MAX_DODGE_JUMP_DISTANCE,
      );
    }
    if (!enabled) this.reset();
    else this.state = { ...this.state, enabled: true };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.committed = undefined;
    this.planRevision = 0;
    this.lastPlanAt = -Infinity;
    this.lastUrgentPlanAt = -Infinity;
    this.lastReplanAt = null;
    this.lastEnvironmentRevision = undefined;
    this.projectileKeys.clear();
    this.aoeKeys.clear();
    this.pendingProjectileUpdates = 0;
    this.pendingDangerUpdates = 0;
    this.dangerRevision = 0;
    this.urgentReplanPending = false;
    this.jumpSuppressedUntil = -Infinity;
    this.lastCommandVelocity = { x: 0, y: 0 };
    this.safetyState = 'normal';
    this.retreatPenaltyScale = 1;
    this.dangerPressure = 0;
    this.lastSafetyUpdateAt = null;
    this.searchRevision = 0;
    this.searchPerformed = false;
    this.planCommitted = false;
    this.replanCause = null;
    this.committedScore = null;
    this.proposedScore = null;
    this.comparisonHorizonMs = null;
    this.firstControlHeading = null;
    this.headingChange = null;
    this.lastLookaheadTarget = null;
    this.lookaheadRevision = 0;
    this.lastMovementCommandAt = null;
    this.state = emptyState(this.enabled, this.planner.getDeterministicMetrics());
  }

  getState(): AutoDodgeState {
    return cloneState(this.state);
  }

  getPlannerMetrics(): DodgePlannerMetrics {
    return this.planner.getMetrics();
  }

  /** Marks one or more newly tracked shots without starting a search in the packet handler. */
  noteProjectileUpdate(count = 1): void {
    this.pendingProjectileUpdates += Math.max(1, Math.trunc(count));
  }

  /** Marks an AOE or other time-varying danger update for the next local-frame observation. */
  noteDangerUpdate(count = 1): void {
    this.pendingDangerUpdates += Math.max(1, Math.trunc(count));
  }

  /** Discards all coordinates after an authoritative correction or teleport. */
  rebase(_position: { x: number; y: number }, time: number): void {
    if (this.committed) this.planner.recordTrajectoryInvalidation();
    this.committed = undefined;
    this.lastPlanAt = -Infinity;
    this.lastUrgentPlanAt = Math.min(this.lastUrgentPlanAt, time - URGENT_REPLAN_INTERVAL_MS);
    this.urgentReplanPending = false;
    this.lastCommandVelocity = { x: 0, y: 0 };
    this.firstControlHeading = null;
    this.headingChange = null;
    this.lastLookaheadTarget = null;
    this.replanCause = 'correction';
    this.state = {
      ...emptyState(this.enabled, this.planner.getDeterministicMetrics()),
      planRevision: this.planRevision,
      searchRevision: this.searchRevision,
      lastReplanAt: this.lastReplanAt,
      dangerRevision: this.dangerRevision,
      replanCause: 'correction',
      decision: 'authoritative_rebase',
    };
  }

  /** Records the limiter's authoritative decision about the latest proposed jump. */
  resolveJumpAttempt(committed: boolean, now: number): void {
    if (committed) {
      if (this.committed) this.planner.recordTrajectoryInvalidation();
      this.committed = undefined;
      this.lastPlanAt = -Infinity;
      this.urgentReplanPending = false;
      this.lastCommandVelocity = { x: 0, y: 0 };
      return;
    }
    this.jumpSuppressedUntil = now + JUMP_REJECTION_SUPPRESSION_MS;
  }

  evaluate(snapshot: AutoDodgeSnapshot): AutoDodgeState {
    this.beginEvaluation();
    if (!this.enabled) {
      this.state = emptyState(false, this.planner.getDeterministicMetrics(), snapshot.intentVelocity);
      return this.state;
    }

    const projectiles = [...snapshot.projectiles];
    const dangerChanged = this.observeDanger(snapshot, projectiles);
    const environmentRevision = snapshot.environment.getRevision?.();
    const environmentChanged = environmentRevision !== undefined
      && this.lastEnvironmentRevision !== undefined
      && environmentRevision !== this.lastEnvironmentRevision;
    this.lastEnvironmentRevision = environmentRevision;
    const goal = normalizedGoal(snapshot.goal);
    const intent = normalizedMovementIntent(snapshot, goal);
    const intentChanged = !sameMovementIntent(intent, this.committed?.intent ?? null, snapshot.position);
    const routeRevision = snapshot.routeRevision ?? 0;
    const routeChanged = !!this.committed && routeRevision !== this.committed.routeRevision;
    this.advanceSafetyState(snapshot.time, intent, snapshot.position);
    if (dangerChanged && projectiles.length === 0 && snapshot.aoes.length === 0) {
      this.setDangerPressure(0, snapshot.time);
    }

    if (snapshot.movementLocked || snapshot.moveSpeed <= 0) {
      if (this.committed) this.planner.recordTrajectoryInvalidation();
      this.committed = undefined;
      this.lastCommandVelocity = { x: 0, y: 0 };
      return this.finish(snapshot, goal, {
        velocity: { x: 0, y: 0 },
        target: null,
        path: [],
        trajectory: null,
        overrideActive: false,
        jumpPlan: undefined,
        planReused: false,
        replanReason: null,
        threatCount: projectiles.length + snapshot.aoes.length,
        earliestImpactMs: null,
        selectedCandidate: 0,
        decision: 'movement_locked',
      });
    }

    const hasMovementIntent = !!intent
      || Math.hypot(snapshot.intentVelocity.x, snapshot.intentVelocity.y) > VELOCITY_MATCH_TOLERANCE;
    if (!hasMovementIntent && projectiles.length === 0 && snapshot.aoes.length === 0) {
      this.committed = undefined;
      this.lastCommandVelocity = { x: 0, y: 0 };
      return this.finish(snapshot, goal, {
        velocity: { x: 0, y: 0 },
        target: null,
        path: [],
        trajectory: null,
        overrideActive: false,
        jumpPlan: undefined,
        planReused: false,
        replanReason: null,
        threatCount: 0,
        earliestImpactMs: null,
        selectedCandidate: 0,
        decision: 'idle',
      });
    }

    const input: DodgePlanningInput = {
      time: snapshot.time,
      playerId: snapshot.playerId,
      position: { ...snapshot.position },
      goal: goal ?? undefined,
      intent,
      routeWaypoint: goal ?? undefined,
      preferredDirection: normalizedDirection(snapshot.intentVelocity),
      combatTargetPositionAt: snapshot.combatTargetPositionAt,
      retreatPenaltyScale: this.retreatPenaltyScale,
      moveSpeed: snapshot.moveSpeed,
      intentVelocity: { ...snapshot.intentVelocity },
      previousVelocity: this.committed
        ? { ...this.lastCommandVelocity }
        : { ...snapshot.intentVelocity },
      movementLeadMs: snapshot.movementLeadMs,
      projectiles,
      aoes: snapshot.aoes,
      environment: snapshot.environment,
      safeWalk: this.safeWalk,
    };

    let currentUnsafe = this.urgentReplanPending;
    let remainingMs = this.committed
      ? trajectoryRemainingMs(this.committed.result.trajectory, snapshot.time)
      : 0;
    let drifted = false;
    if (this.committed) {
      const expected = trajectoryPositionAt(
        this.committed.start,
        this.committed.result.trajectory,
        snapshot.time,
      );
      // A controlled-stop fallback has no moving trajectory to drift from. Its
      // start position can differ from a later authoritative position without
      // making the unchanged collision snapshot worth searching every frame.
      drifted = this.committed.result.fallback !== 'stop'
        && Math.hypot(expected.x - snapshot.position.x, expected.y - snapshot.position.y)
          > TRAJECTORY_DRIFT_TOLERANCE;
      if (dangerChanged || environmentChanged || drifted) {
        const assessment = this.planner.assessTrajectory(input, this.committed.result.trajectory);
        currentUnsafe = !assessment.safe;
        this.urgentReplanPending = currentUnsafe;
        remainingMs = assessment.remainingMs;
        if (currentUnsafe) {
          this.setDangerPressure(1, snapshot.time);
          input.retreatPenaltyScale = this.retreatPenaltyScale;
        }
        if (currentUnsafe || drifted) this.planner.recordTrajectoryInvalidation();
      }
    }

    let replanReason: DodgeReplanReason | null = null;
    let replanCause: DodgeReplanCause | null = null;
    const urgentDue = snapshot.time - this.lastUrgentPlanAt >= URGENT_REPLAN_INTERVAL_MS;
    const normalDue = snapshot.time - this.lastPlanAt >= NORMAL_REPLAN_INTERVAL_MS;
    if (!this.committed) {
      // A blocked local collision snapshot can legitimately produce no committed
      // trajectory. Do not search again on every local frame while that snapshot
      // is unchanged; doing so turns a controlled stop into a tight planner loop.
      const hasDanger = projectiles.length > 0 || snapshot.aoes.length > 0;
      if (hasDanger ? urgentDue : normalDue) {
        replanReason = hasDanger ? 'urgent' : 'normal';
        replanCause = 'initial';
      }
    } else if (currentUnsafe) {
      replanReason = urgentDue ? 'urgent' : null;
      if (replanReason) replanCause = dangerChanged ? 'new_threat' : 'unsafe';
    } else if (drifted) {
      replanReason = 'normal';
      replanCause = 'drift';
    } else if (intentChanged) {
      replanReason = 'normal';
      replanCause = 'intent_changed';
    } else if (routeChanged) {
      replanReason = 'normal';
      replanCause = 'route_changed';
    } else if (this.committed.result.fallback !== 'stop'
      && remainingMs <= MINIMUM_REMAINING_HORIZON_MS) {
      replanReason = 'normal';
      replanCause = 'expired';
    } else if (normalDue) {
      replanReason = 'normal';
      replanCause = 'periodic_refresh';
    }

    let planReused = !!this.committed;
    let jumpPlan: EmergencyJumpPlan | undefined;
    if (replanReason) {
      this.searchRevision++;
      this.searchPerformed = true;
      this.replanCause = replanCause;
      const proposed = this.planner.plan(input, replanReason);
      this.setDangerPressure(
        Math.max(
          currentUnsafe ? 1 : 0,
          planningDangerPressure(proposed, snapshot.aoes.length),
        ),
        snapshot.time,
      );
      this.lastPlanAt = snapshot.time;
      if (replanReason === 'urgent') this.lastUrgentPlanAt = snapshot.time;
      const proposedRemainingMs = trajectoryRemainingMs(proposed.trajectory, snapshot.time);
      const comparisonHorizonMs = Math.min(
        PLAN_COMPARISON_HORIZON_MS,
        remainingMs || proposedRemainingMs,
        proposedRemainingMs,
      );
      const currentComparable = this.committed
        ? this.planner.assessTrajectory(
            input,
            this.committed.result.trajectory,
            comparisonHorizonMs,
          )
        : undefined;
      const proposedComparable = this.planner.assessTrajectory(
        input,
        proposed.trajectory,
        comparisonHorizonMs,
      );
      this.committedScore = finiteComparisonScore(currentComparable?.score);
      this.proposedScore = finiteComparisonScore(proposedComparable.score);
      this.comparisonHorizonMs = proposedComparable.comparisonHorizonMs;
      if (currentComparable && !currentComparable.safe) currentUnsafe = true;
      const forceReplace = !this.committed
        || currentUnsafe
        || intentChanged
        || drifted
        || remainingMs <= MINIMUM_REMAINING_HORIZON_MS;
      const meaningfulGain = !!currentComparable
        && proposedComparable.safe
        && proposedComparable.score + PLAN_SCORE_ABSOLUTE_GAIN
          < currentComparable.score * (1 - PLAN_SCORE_RELATIVE_GAIN);
      const safeReplacement = !this.committed || proposedComparable.safe || currentUnsafe;
      if (safeReplacement && (forceReplace || meaningfulGain)) {
        const nextHeading = trajectoryFirstHeading(snapshot.position, proposed.trajectory);
        this.headingChange = headingDifference(this.firstControlHeading, nextHeading);
        this.firstControlHeading = nextHeading;
        this.committed = {
          result: proposed,
          start: { ...snapshot.position },
          goal,
          intent: cloneDodgeMovementIntent(intent),
          routeRevision,
        };
        this.planRevision++;
        this.lastReplanAt = snapshot.time;
        this.planCommitted = true;
        if (meaningfulGain && !forceReplace) this.replanCause = 'better_plan';
        planReused = false;
      } else if (routeChanged && this.committed) {
        // The updated route was searched and did not justify command churn.
        this.committed.routeRevision = routeRevision;
      }
      if (replanReason === 'urgent') {
        this.urgentReplanPending = !proposed.reachesHorizon
          && proposed.activeProjectileCount + snapshot.aoes.length > 0;
      }

      const jumpAllowance = Math.min(
        this.maxJumpDistance,
        Math.max(0, snapshot.jumpAllowance ?? 0),
      );
      const jumpReady = snapshot.jumpStatus === 'ready'
        && jumpAllowance >= MIN_DODGE_JUMP_DISTANCE
        && snapshot.time >= this.jumpSuppressedUntil;
      if (this.projectileJump
        && jumpReady
        && !proposed.reachesHorizon
        && proposed.activeProjectileCount + snapshot.aoes.length > 0) {
        jumpPlan = this.planner.findEmergencyJump(input, jumpAllowance);
      }
    }

    const committed = this.committed;
    if (!committed) {
      this.lastCommandVelocity = { x: 0, y: 0 };
      return this.finish(snapshot, goal, {
        velocity: { x: 0, y: 0 },
        target: null,
        path: [],
        trajectory: null,
        overrideActive: !!intent,
        jumpPlan,
        planReused,
        replanReason,
        threatCount: projectiles.length + snapshot.aoes.length,
        earliestImpactMs: null,
        selectedCandidate: 0,
        decision: intent ? `${intent.mode}_blocked` : 'controlled_stop',
      });
    }

    if (jumpPlan) {
      this.lastCommandVelocity = { x: 0, y: 0 };
      return this.finish(snapshot, goal, {
        velocity: { x: 0, y: 0 },
        target: { ...jumpPlan.target },
        path: [{ ...jumpPlan.target }],
        trajectory: cloneTrajectory(committed.result.trajectory),
        overrideActive: true,
        jumpPlan,
        planReused,
        replanReason,
        threatCount: committed.result.activeProjectileCount + snapshot.aoes.length,
        earliestImpactMs: committed.result.earliestIntentCollisionMs ?? 0,
        selectedCandidate: committed.result.firstControl,
        decision: 'danger_jump',
      });
    }

    const velocity = trajectoryVelocityAt(committed.start, committed.result.trajectory, snapshot.time);
    const target = trajectoryPositionAt(
      committed.start,
      committed.result.trajectory,
      snapshot.time + COMMAND_LOOKAHEAD_MS,
    );
    const path = vectorizedRemainingPath(
      committed.start,
      committed.result.trajectory,
      snapshot.time,
      target,
    );
    const matchesIntent = Math.hypot(
      velocity.x - snapshot.intentVelocity.x,
      velocity.y - snapshot.intentVelocity.y,
    ) <= VELOCITY_MATCH_TOLERANCE;
    const earliestImpactMs = committed.result.earliestIntentCollisionMs ?? null;
    const overrideActive = !!intent || !matchesIntent || earliestImpactMs !== null;
    const commandVelocity = !overrideActive && matchesIntent
      ? { ...snapshot.intentVelocity }
      : velocity;
    this.lastCommandVelocity = { ...commandVelocity };
    const fallback = committed.result.fallback;
    const decision = fallback === 'stop'
      ? (intent ? `${intent.mode}_blocked` : 'controlled_stop')
      : fallback === 'least_risk' || fallback === 'partial'
        ? 'controlled_fallback'
        : overrideActive
          ? (intent?.mode === 'combat_range' ? 'combat_range_path'
            : intent ? 'goal_path' : 'dodge_trajectory')
          : 'preserve_safe_intent';

    return this.finish(snapshot, goal, {
      velocity: commandVelocity,
      target,
      path,
      trajectory: cloneTrajectory(committed.result.trajectory),
      overrideActive,
      jumpPlan: undefined,
      planReused,
      replanReason,
      threatCount: committed.result.activeProjectileCount + snapshot.aoes.length,
      earliestImpactMs,
      selectedCandidate: committed.result.firstControl,
      decision,
    });
  }

  private observeDanger(
    snapshot: AutoDodgeSnapshot,
    projectiles: readonly CombatProjectileSnapshot[],
  ): boolean {
    const nextProjectileKeys = new Set<string>();
    for (const projectile of projectiles) {
      if (projectile.side !== 'enemy' || projectile.hitObjects.has(snapshot.playerId)) continue;
      nextProjectileKeys.add(projectileKey(projectile));
    }
    const nextAoeKeys = new Set(snapshot.aoes.map(aoeKey));
    const projectileSetChanged = !sameSet(this.projectileKeys, nextProjectileKeys);
    const aoeSetChanged = !sameSet(this.aoeKeys, nextAoeKeys);
    const updateCount = this.pendingProjectileUpdates + this.pendingDangerUpdates;
    const changed = projectileSetChanged || aoeSetChanged || updateCount > 0;
    if (changed) {
      this.dangerRevision++;
      this.planner.recordProjectileBatch(Math.max(updateCount, setDifferenceCount(
        this.projectileKeys,
        nextProjectileKeys,
      )));
      replaceSet(this.projectileKeys, nextProjectileKeys);
      replaceSet(this.aoeKeys, nextAoeKeys);
    }
    this.pendingProjectileUpdates = 0;
    this.pendingDangerUpdates = 0;
    return changed;
  }

  private beginEvaluation(): void {
    this.searchPerformed = false;
    this.planCommitted = false;
    this.replanCause = null;
    this.committedScore = null;
    this.proposedScore = null;
    this.comparisonHorizonMs = null;
  }

  private finish(
    snapshot: AutoDodgeSnapshot,
    goal: CommittedPlan['goal'],
    result: {
      velocity: { x: number; y: number };
      target: { x: number; y: number } | null;
      path: Array<{ x: number; y: number }>;
      trajectory: DodgeTrajectory | null;
      overrideActive: boolean;
      jumpPlan: EmergencyJumpPlan | undefined;
      planReused: boolean;
      replanReason: DodgeReplanReason | null;
      threatCount: number;
      earliestImpactMs: number | null;
      selectedCandidate: number;
      decision: string;
    },
  ): AutoDodgeState {
    const jumpAllowance = Math.min(
      this.maxJumpDistance,
      Math.max(0, snapshot.jumpAllowance ?? 0),
    );
    const lookaheadChanged = !sameOptionalPoint(this.lastLookaheadTarget, result.target);
    if (lookaheadChanged) {
      this.lookaheadRevision++;
      this.lastLookaheadTarget = result.target ? { ...result.target } : null;
    }
    if (result.target) this.lastMovementCommandAt = snapshot.time;
    const movementIntent = normalizedMovementIntent(snapshot, goal);
    const intentDirection = telemetryIntentDirection(
      movementIntent,
      snapshot.position,
      snapshot.intentVelocity,
    );
    const commandedSpeed = Math.hypot(result.velocity.x, result.velocity.y);
    this.state = {
      enabled: this.enabled,
      overrideActive: result.overrideActive,
      velocity: { ...result.velocity },
      target: result.target ? { ...result.target } : null,
      goal: goal ? { x: goal.x, y: goal.y } : null,
      path: result.path.map((point) => ({ ...point })),
      trajectory: result.trajectory ? cloneTrajectory(result.trajectory) : null,
      jumpTarget: result.jumpPlan ? { ...result.jumpPlan.target } : null,
      jumpDistance: result.jumpPlan?.distance ?? 0,
      jumpAllowance,
      jumpStatus: this.projectileJump ? snapshot.jumpStatus ?? 'ready' : 'disabled',
      planRevision: this.planRevision,
      planReused: result.planReused,
      searchRevision: this.searchRevision,
      searchPerformed: this.searchPerformed,
      planCommitted: this.planCommitted,
      replanCause: this.replanCause,
      movementIntentMode: movementIntent?.mode ?? null,
      safetyState: this.safetyState,
      retreatPenaltyScale: this.retreatPenaltyScale,
      lastReplanAt: this.lastReplanAt,
      replanReason: result.replanReason,
      dangerRevision: this.dangerRevision,
      threatCount: result.threatCount,
      earliestImpactMs: result.earliestImpactMs,
      selectedCandidate: result.selectedCandidate,
      speedScale: snapshot.moveSpeed > 0
        ? commandedSpeed / snapshot.moveSpeed
        : 0,
      commandedSpeed,
      progressSpeed: intentDirection
        ? result.velocity.x * intentDirection.x + result.velocity.y * intentDirection.y
        : 0,
      firstControlHeading: this.firstControlHeading,
      headingChange: this.headingChange,
      committedScore: this.committedScore,
      proposedScore: this.proposedScore,
      comparisonHorizonMs: this.comparisonHorizonMs,
      movementTargetDistance: result.target
        ? Math.hypot(result.target.x - snapshot.position.x, result.target.y - snapshot.position.y)
        : 0,
      timeSinceLastMovementCommandMs: this.lastMovementCommandAt === null
        ? null
        : Math.max(0, snapshot.time - this.lastMovementCommandAt),
      lookaheadRevision: this.lookaheadRevision,
      lookaheadChanged,
      decision: result.decision,
      plannerMetrics: this.planner.getDeterministicMetrics(),
    };
    return this.state;
  }

  private advanceSafetyState(
    now: number,
    intent: DodgeMovementIntent | null,
    position: { x: number; y: number },
  ): void {
    const previousUpdate = this.lastSafetyUpdateAt;
    this.lastSafetyUpdateAt = now;
    if (previousUpdate === null) return;
    const elapsedMs = Math.max(0, now - previousUpdate);

    if (this.dangerPressure > 0) {
      this.safetyState = 'evasive';
      const targetScale = 1 - this.dangerPressure;
      const response = clamp(elapsedMs / EVASIVE_RETREAT_RESPONSE_MS, 0, 1);
      this.retreatPenaltyScale += (targetScale - this.retreatPenaltyScale) * response;
      return;
    }

    if (this.safetyState === 'evasive') this.safetyState = 'recovering';
    if (this.safetyState !== 'recovering') {
      this.retreatPenaltyScale = 1;
      return;
    }

    this.retreatPenaltyScale = Math.min(
      1,
      this.retreatPenaltyScale + elapsedMs / RECOVERY_RETREAT_RESPONSE_MS,
    );
    if (this.retreatPenaltyScale >= 1 && movementIntentSatisfied(intent, position)) {
      this.safetyState = 'normal';
    }
  }

  private setDangerPressure(pressure: number, now: number): void {
    const normalized = clamp(pressure, 0, 1);
    if (normalized > 0) {
      if (this.safetyState !== 'evasive') {
        const targetScale = 1 - normalized;
        const initialResponse = EVASIVE_INITIAL_RESPONSE_MS / EVASIVE_RETREAT_RESPONSE_MS;
        this.retreatPenaltyScale += (
          targetScale - this.retreatPenaltyScale
        ) * initialResponse;
      }
      this.safetyState = 'evasive';
    } else if (this.dangerPressure > 0 || this.safetyState === 'evasive') {
      this.safetyState = 'recovering';
    }
    this.dangerPressure = normalized;
    this.lastSafetyUpdateAt ??= now;
  }
}

export interface TrackedThrownAoe extends DodgePlanningAoe {
  id: number;
  effectType: number;
}

/** Correlates thrown SHOWEFFECT endpoints with later AOE packets. */
export class ThrownAoeTracker {
  private readonly throws: TrackedThrownAoe[] = [];
  private readonly learnedRadius = new Map<number, number>();
  private readonly learnedBlastDuration = new Map<number, number>();
  private nextId = 1;

  clear(): void {
    this.throws.length = 0;
    this.learnedRadius.clear();
    this.learnedBlastDuration.clear();
    this.nextId = 1;
  }

  track(
    effectType: number,
    end: { x: number; y: number },
    durationSeconds: number,
    now: number,
    blastDurationSeconds?: number,
  ): void {
    const durationMs = Math.max(0, durationSeconds * 1000);
    const normalizedType = effectType >>> 0;
    const learnedBlastMs = this.learnedBlastDuration.get(normalizedType);
    const explicitBlastMs = blastDurationSeconds !== undefined
      ? Math.max(0, blastDurationSeconds * 1000)
      : undefined;
    this.throws.push({
      id: this.nextId++,
      effectType: normalizedType,
      x: end.x,
      y: end.y,
      radius: this.learnedRadius.get(normalizedType) ?? 1,
      landingTime: now + durationMs,
      blastDurationMs: explicitBlastMs ?? learnedBlastMs,
    });
  }

  recordAoe(
    position: { x: number; y: number },
    radius: number,
    now: number,
    blastDurationSeconds?: number,
  ): void {
    let best: TrackedThrownAoe | undefined;
    let bestDistance = 1;
    for (let index = 0; index < this.throws.length; index++) {
      const thrown = this.throws[index]!;
      if (now < thrown.landingTime - 150 || now > thrown.landingTime + 750) continue;
      const distance = Math.hypot(position.x - thrown.x, position.y - thrown.y);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = thrown;
    }
    if (!best) return;
    this.learnedRadius.set(best.effectType, radius);
    best.radius = radius;
    if (blastDurationSeconds !== undefined) {
      const blastMs = Math.max(0, blastDurationSeconds * 1000);
      this.learnedBlastDuration.set(best.effectType, blastMs);
      best.blastDurationMs = blastMs;
    }
    // Do NOT splice the matched throw here — leaving it in place lets
    // getActive() surface it to the planner during the dwell window (see
    // spec docs/superpowers/specs/2026-07-19-aoe-blast-dwell-rewrite-design.md
    // touchpoint 3). Post-dwell expiry happens in getActive() below.
  }

  getActive(now: number): readonly TrackedThrownAoe[] {
    // Fresh array per call — the prior contract returned `this.active` (a
    // mutable buffer swapped on each call), so a caller retaining the array
    // across the next `getActive()` silently got a length-zero view when the
    // buffer was reset. `TrackedThrownAoe` is a flat primitive shape; shallow
    // clone plus a fresh array is cheap and avoids the retention footgun.
    const active: TrackedThrownAoe[] = [];
    for (let index = this.throws.length - 1; index >= 0; index--) {
      const thrown = this.throws[index]!;
      const dwellMs = thrown.blastDurationMs ?? 0;
      const expiresAt = thrown.landingTime + Math.max(750, dwellMs);
      if (now > expiresAt) {
        this.throws.splice(index, 1);
        continue;
      }
      thrown.radius = this.learnedRadius.get(thrown.effectType) ?? thrown.radius;
      const learnedBlast = this.learnedBlastDuration.get(thrown.effectType);
      if (learnedBlast !== undefined) thrown.blastDurationMs = learnedBlast;
      // Include pre-landing throws (existing behavior) AND during-dwell throws
      // (new for P3). Post-dwell throws are cleaned up above.
      if (now < thrown.landingTime + (thrown.blastDurationMs ?? 0)) {
        active.push({ ...thrown });
      }
    }
    return active;
  }
}

function emptyState(
  enabled: boolean,
  metrics: DeterministicDodgePlannerMetrics,
  velocity = { x: 0, y: 0 },
): AutoDodgeState {
  return {
    enabled,
    overrideActive: false,
    velocity: { ...velocity },
    target: null,
    goal: null,
    path: [],
    trajectory: null,
    jumpTarget: null,
    jumpDistance: 0,
    jumpAllowance: 0,
    jumpStatus: 'disabled',
    planRevision: 0,
    planReused: false,
    searchRevision: 0,
    searchPerformed: false,
    planCommitted: false,
    replanCause: null,
    movementIntentMode: null,
    safetyState: 'normal',
    retreatPenaltyScale: 1,
    lastReplanAt: null,
    replanReason: null,
    dangerRevision: 0,
    threatCount: 0,
    earliestImpactMs: null,
    selectedCandidate: 0,
    speedScale: 1,
    commandedSpeed: Math.hypot(velocity.x, velocity.y),
    progressSpeed: 0,
    firstControlHeading: null,
    headingChange: null,
    committedScore: null,
    proposedScore: null,
    comparisonHorizonMs: null,
    movementTargetDistance: 0,
    timeSinceLastMovementCommandMs: null,
    lookaheadRevision: 0,
    lookaheadChanged: false,
    decision: 'none',
    plannerMetrics: cloneMetrics(metrics),
  };
}

function cloneState(state: AutoDodgeState): AutoDodgeState {
  return {
    ...state,
    velocity: { ...state.velocity },
    target: state.target ? { ...state.target } : null,
    goal: state.goal ? { ...state.goal } : null,
    path: state.path.map((point) => ({ ...point })),
    trajectory: state.trajectory ? cloneTrajectory(state.trajectory) : null,
    jumpTarget: state.jumpTarget ? { ...state.jumpTarget } : null,
    plannerMetrics: cloneMetrics(state.plannerMetrics),
  };
}

function cloneMetrics(
  metrics: DeterministicDodgePlannerMetrics,
): DeterministicDodgePlannerMetrics {
  return { ...metrics, statesEnteringLayers: [...metrics.statesEnteringLayers] };
}

function cloneTrajectory(trajectory: DodgeTrajectory): DodgeTrajectory {
  return {
    createdAt: trajectory.createdAt,
    waypoints: trajectory.waypoints.map((waypoint) => ({ ...waypoint })),
  };
}

function trajectoryFirstHeading(
  start: { x: number; y: number },
  trajectory: DodgeTrajectory,
): number | null {
  let previous = start;
  for (const waypoint of trajectory.waypoints) {
    const dx = waypoint.x - previous.x;
    const dy = waypoint.y - previous.y;
    if (Math.hypot(dx, dy) > 1e-9) return Math.atan2(dy, dx);
    previous = waypoint;
  }
  return null;
}

function headingDifference(previous: number | null, next: number | null): number | null {
  if (previous === null || next === null) return null;
  const wrapped = Math.atan2(Math.sin(next - previous), Math.cos(next - previous));
  return Math.abs(wrapped);
}

function finiteComparisonScore(score: number | undefined): number | null {
  return Number.isFinite(score) ? Number(score) : null;
}

function planningDangerPressure(result: DodgePlanningResult, activeAoes: number): number {
  if (!result.reachesHorizon && result.activeProjectileCount + activeAoes > 0) return 1;
  const impactMs = result.earliestIntentCollisionMs;
  if (impactMs === null || impactMs === undefined) return 0;
  return clamp((EVASIVE_IMPACT_WINDOW_MS - impactMs) / EVASIVE_IMPACT_WINDOW_MS, 0, 1);
}

function movementIntentSatisfied(
  intent: DodgeMovementIntent | null,
  position: { x: number; y: number },
): boolean {
  if (intent?.mode !== 'combat_range') return true;
  const distance = Math.hypot(position.x - intent.targetX, position.y - intent.targetY);
  return distance >= intent.preferredMinimumRange - 1e-6
    && distance <= intent.preferredMaximumRange + 1e-6;
}

function trajectoryRemainingMs(trajectory: DodgeTrajectory, now: number): number {
  const end = trajectory.waypoints[trajectory.waypoints.length - 1]?.timeOffsetMs ?? 0;
  return Math.max(0, trajectory.createdAt + end - now);
}

function trajectoryPositionAt(
  start: { x: number; y: number },
  trajectory: DodgeTrajectory,
  absoluteTime: number,
): { x: number; y: number } {
  const elapsed = absoluteTime - trajectory.createdAt;
  if (elapsed <= 0 || trajectory.waypoints.length === 0) return { ...start };
  let previous: { x: number; y: number; timeOffsetMs: number } = {
    ...start,
    timeOffsetMs: 0,
  };
  for (const waypoint of trajectory.waypoints) {
    if (elapsed <= waypoint.timeOffsetMs) {
      const duration = waypoint.timeOffsetMs - previous.timeOffsetMs;
      const ratio = duration <= 0 ? 1 : clamp((elapsed - previous.timeOffsetMs) / duration, 0, 1);
      return {
        x: previous.x + (waypoint.x - previous.x) * ratio,
        y: previous.y + (waypoint.y - previous.y) * ratio,
      };
    }
    previous = waypoint;
  }
  return { x: previous.x, y: previous.y };
}

function trajectoryVelocityAt(
  start: { x: number; y: number },
  trajectory: DodgeTrajectory,
  absoluteTime: number,
): { x: number; y: number } {
  const elapsed = absoluteTime - trajectory.createdAt;
  let previous: { x: number; y: number; timeOffsetMs: number } = {
    ...start,
    timeOffsetMs: 0,
  };
  for (const waypoint of trajectory.waypoints) {
    if (elapsed < waypoint.timeOffsetMs - 1e-9) {
      const duration = waypoint.timeOffsetMs - previous.timeOffsetMs;
      return duration <= 0
        ? { x: 0, y: 0 }
        : {
            x: (waypoint.x - previous.x) / duration,
            y: (waypoint.y - previous.y) / duration,
          };
    }
    previous = waypoint;
  }
  return { x: 0, y: 0 };
}

function vectorizedRemainingPath(
  start: { x: number; y: number },
  trajectory: DodgeTrajectory,
  now: number,
  lookahead: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const elapsed = now - trajectory.createdAt;
  const points = [lookahead, ...trajectory.waypoints
    .filter((waypoint) => waypoint.timeOffsetMs > elapsed + COMMAND_LOOKAHEAD_MS)
    .map((waypoint) => ({ x: waypoint.x, y: waypoint.y }))];
  if (points.length <= 1) return points;
  const output: Array<{ x: number; y: number }> = [{ ...points[0]! }];
  let previousPoint = start;
  let previousDirection: { x: number; y: number } | undefined;
  for (const point of points) {
    const dx = point.x - previousPoint.x;
    const dy = point.y - previousPoint.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) {
      const direction = { x: dx / length, y: dy / length };
      if (previousDirection
        && previousDirection.x * direction.x + previousDirection.y * direction.y < 0.9995) {
        appendDistinct(output, previousPoint);
      }
      previousDirection = direction;
    }
    previousPoint = point;
  }
  appendDistinct(output, points[points.length - 1]!);
  return output;
}

function appendDistinct(
  points: Array<{ x: number; y: number }>,
  point: { x: number; y: number },
): void {
  const previous = points[points.length - 1];
  if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 1e-6) {
    points.push({ ...point });
  }
}

function normalizedGoal(goal: AutoDodgeSnapshot['goal']): CommittedPlan['goal'] {
  if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y)) return null;
  return {
    x: goal.x,
    y: goal.y,
    threshold: Number.isFinite(goal.threshold) ? Math.max(0, Number(goal.threshold)) : 0,
  };
}

function normalizedMovementIntent(
  snapshot: AutoDodgeSnapshot,
  fallbackGoal: CommittedPlan['goal'],
): DodgeMovementIntent | null {
  if (snapshot.movementIntent) return cloneDodgeMovementIntent(snapshot.movementIntent);
  if (!fallbackGoal) return null;
  return {
    mode: 'goal',
    goalX: fallbackGoal.x,
    goalY: fallbackGoal.y,
    arriveThreshold: fallbackGoal.threshold,
  };
}

function sameMovementIntent(
  a: DodgeMovementIntent | null,
  b: DodgeMovementIntent | null,
  position: { x: number; y: number },
): boolean {
  if (!a || !b) return a === b;
  if (a.mode !== b.mode) return false;
  if (a.mode === 'goal' && b.mode === 'goal') {
    if ((a.goalId !== undefined || b.goalId !== undefined) && a.goalId !== b.goalId) return false;
    if (Math.abs((a.arriveThreshold ?? 0) - (b.arriveThreshold ?? 0))
      > RANGE_CHANGE_TOLERANCE) return false;
    const destinationChange = Math.hypot(a.goalX - b.goalX, a.goalY - b.goalY);
    if (destinationChange >= GOAL_CHANGE_TOLERANCE) return false;
    const aDirection = unitDirection(position, { x: a.goalX, y: a.goalY });
    const bDirection = unitDirection(position, { x: b.goalX, y: b.goalY });
    return !aDirection || !bDirection
      || aDirection.x * bDirection.x + aDirection.y * bDirection.y >= GOAL_DIRECTION_CHANGE_COSINE;
  }
  if (a.mode !== 'combat_range' || b.mode !== 'combat_range') return false;
  // Combat-range intents must match on BOTH targetId AND position tolerance:
  // a targetId is stable across ticks even when the server relocates the
  // enemy, so `targetId ===` alone lets a target that moved 20 tiles between
  // frames read as unchanged. Mirror the goal-branch position check.
  const withinDistance = Math.hypot(a.targetX - b.targetX, a.targetY - b.targetY)
    < GOAL_CHANGE_TOLERANCE;
  const sameTarget = a.targetId > 0 || b.targetId > 0
    ? a.targetId === b.targetId && withinDistance
    : withinDistance;
  return sameTarget
    && Math.abs(a.hardMinimumRange - b.hardMinimumRange) <= RANGE_CHANGE_TOLERANCE
    && Math.abs(a.preferredMinimumRange - b.preferredMinimumRange) <= RANGE_CHANGE_TOLERANCE
    && Math.abs(a.preferredMaximumRange - b.preferredMaximumRange) <= RANGE_CHANGE_TOLERANCE;
}

function unitDirection(
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number } | undefined {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  return length > 1e-9 ? { x: dx / length, y: dy / length } : undefined;
}

function normalizedDirection(
  velocity: { x: number; y: number },
): { x: number; y: number } | undefined {
  const speed = Math.hypot(velocity.x, velocity.y);
  return speed > 1e-9 ? { x: velocity.x / speed, y: velocity.y / speed } : undefined;
}

function telemetryIntentDirection(
  intent: DodgeMovementIntent | null,
  position: { x: number; y: number },
  fallbackVelocity: { x: number; y: number },
): { x: number; y: number } | undefined {
  if (intent?.mode === 'combat_range') {
    const target = { x: intent.targetX, y: intent.targetY };
    const targetDistance = Math.hypot(target.x - position.x, target.y - position.y);
    if (targetDistance < intent.preferredMinimumRange) return unitDirection(target, position);
    if (targetDistance > intent.preferredMaximumRange) return unitDirection(position, target);
    return undefined;
  }
  const fallback = normalizedDirection(fallbackVelocity);
  if (fallback) return fallback;
  if (intent?.mode === 'goal') {
    return unitDirection(position, { x: intent.goalX, y: intent.goalY });
  }
  return undefined;
}

function sameOptionalPoint(
  a: { x: number; y: number } | null,
  b: { x: number; y: number } | null,
): boolean {
  if (!a || !b) return a === b;
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-6;
}

function projectileKey(projectile: CombatProjectileSnapshot): string {
  return `${projectile.ownerId}:${projectile.bulletId}:${projectile.startTime}`;
}

function aoeKey(aoe: DodgePlanningAoe): string {
  return `${aoe.landingTime}:${aoe.x}:${aoe.y}:${aoe.radius}`;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function setDifferenceCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const value of a) if (!b.has(value)) count++;
  for (const value of b) if (!a.has(value)) count++;
  return count;
}

function replaceSet(target: Set<string>, source: ReadonlySet<string>): void {
  target.clear();
  for (const value of source) target.add(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return maximum;
  return Math.min(maximum, Math.max(minimum, value));
}
