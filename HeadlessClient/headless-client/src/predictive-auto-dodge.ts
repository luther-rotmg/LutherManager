import {
  isProjectileAliveAt,
  predictProjectilePosition,
  type CombatProjectileSnapshot,
} from './combat-tracker';
import { ENEMY_AVOID_RADIUS } from './dodge-collision-world';

export interface AutoDodgeOptions {
  /** Avoid ground with positive XML damage while selecting escape paths. */
  safeWalk?: boolean;
}

export interface AutoDodgeAoeThreat {
  x: number;
  y: number;
  radius: number;
  landingTime: number;
}

export interface AutoDodgeEnvironment {
  canOccupy(x: number, y: number, safeWalk: boolean, avoidEnemies?: boolean): boolean;
  enemyClearance?(x: number, y: number): number;
  isProjectileSegmentOpen(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    projectile: CombatProjectileSnapshot,
  ): boolean;
}

export interface AutoDodgeSnapshot {
  time: number;
  playerId: number;
  position: { x: number; y: number };
  /** Current local navigation waypoint supplied by direct walking or pathfinding. */
  goal?: { x: number; y: number; threshold?: number };
  moveSpeed: number;
  intentVelocity: { x: number; y: number };
  movementLeadMs: number;
  movementLocked?: boolean;
  projectiles: Iterable<CombatProjectileSnapshot>;
  aoes: readonly AutoDodgeAoeThreat[];
  environment: AutoDodgeEnvironment;
}

export interface AutoDodgeState {
  enabled: boolean;
  overrideActive: boolean;
  velocity: { x: number; y: number };
  target: { x: number; y: number } | null;
  goal: { x: number; y: number } | null;
  /** Absolute world-space points in the active short-horizon dodge route. */
  path: Array<{ x: number; y: number }>;
  threatCount: number;
  earliestImpactMs: number | null;
  selectedCandidate: number;
  speedScale: number;
  decision: string;
  switches: number;
}

const DIRECTION_COUNT = 32;
const INTENT_CANDIDATE = DIRECTION_COUNT + 1;
const CANDIDATE_COUNT = DIRECTION_COUNT + 2;
const SAMPLE_MS = 30;
const HORIZON_MS = 600;
const LANE_HORIZON_MS = HORIZON_MS * 2;
const LANE_SHORT_THRESHOLD_MS = HORIZON_MS + 100;
const HIT_HALF_SIZE = 0.5;
const RELEVANCE_CLEARANCE = 1;
const INTENT_SAFE_CLEARANCE = 0.08;
const EMERGENCY_INTENT_BAND = 0.14;
const UNAVOIDABLE_IMPACT_BAND_MS = 60;
const UNAVOIDABLE_CLEARANCE_BAND = 0.05;
const EMERGENCY_OVERRIDE_MS = 100;
const HYSTERESIS_MS = 180;
const HYSTERESIS_SCORE_GAIN = 0.25;
const SMOOTHING_ALPHA = 0.35;
const COMMIT_BONUS = 0.05;
const CORRIDOR_NEIGHBORS = 3;
const LOCAL_PLAN_STEP_MS = 60;
const LOCAL_PLAN_BEAM_WIDTH = 40;
const LOCAL_PLAN_DIRECTION_STRIDE = 4;
const LOCAL_PLAN_CELL_SIZE = 0.25;
const GOAL_PROGRESS_TOLERANCE = 0.25;
const GOAL_PATH_POINT_EPSILON = 0.02;
const MAX_TIME = 0x7fffffff;
const MIN_SAMPLE_MS = 8;
const CURVED_TRAJECTORY_MAX_SAMPLE_MS = 15;

interface GoalDodgePlan {
  candidate: number;
  velocityX: number;
  velocityY: number;
  speedScale: number;
  path: Array<{ x: number; y: number }>;
}

interface LocalPlanNode {
  x: number;
  y: number;
  timeMs: number;
  headingX: number;
  headingY: number;
  firstCandidate: number;
  firstVelocityX: number;
  firstVelocityY: number;
  minThreatClearance: number;
  minEnemyClearance: number;
  turnCost: number;
  parent?: LocalPlanNode;
}

interface LocalProjectileTrack {
  points: Array<{ x: number; y: number }>;
  stepMs: number;
}

interface LocalEdgeSafety {
  minThreatClearance: number;
  minEnemyClearance: number;
}

/** Port of ProdMafia's short-horizon predictive auto-dodge controller. */
export class PredictiveAutoDodgeController {
  private enabled = false;
  private safeWalk = true;
  private readonly candidateX = new Float64Array(CANDIDATE_COUNT);
  private readonly candidateY = new Float64Array(CANDIDATE_COUNT);
  private readonly candidateScore = new Float64Array(CANDIDATE_COUNT);
  private readonly candidateImpactMs = new Int32Array(CANDIDATE_COUNT);
  private readonly candidateBlockMs = new Int32Array(CANDIDATE_COUNT);
  private readonly candidateEnemyClearance = new Float64Array(CANDIDATE_COUNT);
  private readonly candidateOpenLaneMs = new Float64Array(CANDIDATE_COUNT);
  private readonly candidateValid = new Uint8Array(CANDIDATE_COUNT);
  private readonly smoothedScore = new Float64Array(CANDIDATE_COUNT);
  private readonly previousBulletKeys = new Set<string>();
  private previousAoeCount = 0;
  private previousOverrideActive = false;
  private totalSwitches = 0;
  private readonly relevantProjectiles: CombatProjectileSnapshot[] = [];
  private readonly projectilePosition = { x: 0, y: 0 };
  private readonly previousProjectilePosition = { x: 0, y: 0 };
  private selectedCandidate = 0;
  private selectedUntil = 0;
  private state: AutoDodgeState = emptyState(false);

  constructor() {
    for (let index = 0; index < DIRECTION_COUNT; index++) {
      const angle = index * Math.PI * 2 / DIRECTION_COUNT;
      this.candidateX[index + 1] = Math.cos(angle);
      this.candidateY[index + 1] = Math.sin(angle);
    }
    for (let index = 0; index < CANDIDATE_COUNT; index++) {
      this.smoothedScore[index] = Infinity;
    }
  }

  setEnabled(enabled: boolean, options: AutoDodgeOptions = {}): void {
    this.enabled = enabled;
    if (options.safeWalk !== undefined) this.safeWalk = options.safeWalk;
    if (!enabled) this.reset();
    else this.state = { ...this.state, enabled: true };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  reset(): void {
    this.selectedCandidate = 0;
    this.selectedUntil = 0;
    this.relevantProjectiles.length = 0;
    this.totalSwitches = 0;
    this.state = emptyState(this.enabled);
  }

  getState(): AutoDodgeState {
    return {
      ...this.state,
      velocity: { ...this.state.velocity },
      target: this.state.target ? { ...this.state.target } : null,
      goal: this.state.goal ? { ...this.state.goal } : null,
      path: this.state.path.map((point) => ({ ...point })),
    };
  }

  evaluate(snapshot: AutoDodgeSnapshot): AutoDodgeState {
    if (!this.enabled) {
      this.state = emptyState(false, snapshot.intentVelocity);
      return this.state;
    }

    snapshot = this.withGoalIntent(snapshot);
    this.resetFrame();
    const threatSetChanged = this.detectThreatSetChange(snapshot);
    const intentLength = Math.hypot(snapshot.intentVelocity.x, snapshot.intentVelocity.y);
    this.candidateX[INTENT_CANDIDATE] = intentLength > 0.000001
      ? snapshot.intentVelocity.x / intentLength : 0;
    this.candidateY[INTENT_CANDIDATE] = intentLength > 0.000001
      ? snapshot.intentVelocity.y / intentLength : 0;

    let directProjectileThreats = 0;
    for (const projectile of snapshot.projectiles) {
      if (!this.isThreatTo(projectile, snapshot)) continue;
      let envelopeRelevant = false;
      let directRelevant = false;
      let previousSet = false;
      const projectileStep = this.getSampleStepMs(projectile);
      for (let offset = 0; offset <= HORIZON_MS; offset += projectileStep) {
        const sampleTime = snapshot.time + offset;
        if (!isProjectileAliveAt(projectile, sampleTime)) break;
        predictProjectilePosition(projectile, sampleTime, this.projectilePosition);
        const movementOffset = snapshot.movementLeadMs + offset;
        const reachable = snapshot.moveSpeed * movementOffset + HIT_HALF_SIZE + RELEVANCE_CLEARANCE;
        const intentX = snapshot.position.x
          + this.candidateX[INTENT_CANDIDATE] * snapshot.moveSpeed * movementOffset;
        const intentY = snapshot.position.y
          + this.candidateY[INTENT_CANDIDATE] * snapshot.moveSpeed * movementOffset;
        if (!previousSet) {
          envelopeRelevant = chebyshev(
            this.projectilePosition.x - snapshot.position.x,
            this.projectilePosition.y - snapshot.position.y,
          ) <= reachable;
          directRelevant = Math.min(
            chebyshev(this.projectilePosition.x - snapshot.position.x,
              this.projectilePosition.y - snapshot.position.y),
            chebyshev(this.projectilePosition.x - intentX, this.projectilePosition.y - intentY),
          ) <= HIT_HALF_SIZE + RELEVANCE_CLEARANCE;
        } else {
          if (minimumChebyshevOnSegment(
            this.previousProjectilePosition.x - snapshot.position.x,
            this.previousProjectilePosition.y - snapshot.position.y,
            this.projectilePosition.x - snapshot.position.x,
            this.projectilePosition.y - snapshot.position.y,
          ) <= reachable) {
            envelopeRelevant = true;
          }
          const previousMovementOffset = snapshot.movementLeadMs + offset - projectileStep;
          const previousIntentX = snapshot.position.x
            + this.candidateX[INTENT_CANDIDATE] * snapshot.moveSpeed * previousMovementOffset;
          const previousIntentY = snapshot.position.y
            + this.candidateY[INTENT_CANDIDATE] * snapshot.moveSpeed * previousMovementOffset;
          if (Math.min(
            minimumChebyshevOnSegment(
              this.previousProjectilePosition.x - snapshot.position.x,
              this.previousProjectilePosition.y - snapshot.position.y,
              this.projectilePosition.x - snapshot.position.x,
              this.projectilePosition.y - snapshot.position.y,
            ),
            minimumChebyshevOnSegment(
              this.previousProjectilePosition.x - previousIntentX,
              this.previousProjectilePosition.y - previousIntentY,
              this.projectilePosition.x - intentX,
              this.projectilePosition.y - intentY,
            ),
          ) <= HIT_HALF_SIZE + RELEVANCE_CLEARANCE) {
            directRelevant = true;
          }
        }
        copyPoint(this.previousProjectilePosition, this.projectilePosition);
        previousSet = true;
      }
      if (envelopeRelevant) this.relevantProjectiles.push(projectile);
      if (directRelevant) directProjectileThreats++;
    }

    const aoes = snapshot.aoes;
    let directAoeThreat = false;
    for (const aoe of aoes) {
      const landingOffset = aoe.landingTime - snapshot.time;
      if (landingOffset <= 0 || landingOffset > HORIZON_MS) continue;
      const movementOffset = snapshot.movementLeadMs + landingOffset;
      const centerDistance = Math.hypot(aoe.x - snapshot.position.x, aoe.y - snapshot.position.y);
      if (centerDistance > aoe.radius + snapshot.moveSpeed * movementOffset + RELEVANCE_CLEARANCE) continue;
      const intentX = snapshot.position.x
        + this.candidateX[INTENT_CANDIDATE] * snapshot.moveSpeed * movementOffset;
      const intentY = snapshot.position.y
        + this.candidateY[INTENT_CANDIDATE] * snapshot.moveSpeed * movementOffset;
      if (Math.min(centerDistance, Math.hypot(aoe.x - intentX, aoe.y - intentY)) - aoe.radius
        <= RELEVANCE_CLEARANCE) {
        directAoeThreat = true;
      }
    }

    const hasGoal = !!snapshot.goal
      && Number.isFinite(snapshot.goal.x)
      && Number.isFinite(snapshot.goal.y);
    if (directProjectileThreats === 0 && !directAoeThreat && !hasGoal) {
      return this.finishGoalOrIntent(snapshot, 0, 1, 0, MAX_TIME, 'no_threat');
    }

    this.candidateEnemyClearance[0] = snapshot.environment.enemyClearance?.(
      snapshot.position.x, snapshot.position.y,
    ) ?? Infinity;
    this.validateCandidatePaths(snapshot);
    let earliestImpactMs = MAX_TIME;
    let threatCount = 0;

    for (const projectile of this.relevantProjectiles) {
      let standingClearance = Infinity;
      let intentClearance = Infinity;
      let previousSet = false;
      const projectileStep = this.getSampleStepMs(projectile);
      for (let offset = 0; offset <= HORIZON_MS; offset += projectileStep) {
        const sampleTime = snapshot.time + offset;
        if (!isProjectileAliveAt(projectile, sampleTime)) break;
        predictProjectilePosition(projectile, sampleTime, this.projectilePosition);
        if (previousSet && !snapshot.environment.isProjectileSegmentOpen(
          this.previousProjectilePosition.x,
          this.previousProjectilePosition.y,
          this.projectilePosition.x,
          this.projectilePosition.y,
          projectile,
        )) break;

        for (let candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
          if (!this.candidateValid[candidate] || offset >= this.candidateBlockMs[candidate]) continue;
          const movementOffset = snapshot.movementLeadMs + offset;
          const playerX = snapshot.position.x
            + this.candidateX[candidate] * snapshot.moveSpeed * movementOffset;
          const playerY = snapshot.position.y
            + this.candidateY[candidate] * snapshot.moveSpeed * movementOffset;
          let clearance: number;
          let impactOffset = offset;
          if (!previousSet) {
            clearance = chebyshev(this.projectilePosition.x - playerX,
              this.projectilePosition.y - playerY) - HIT_HALF_SIZE;
          } else {
            const previousMovementOffset = snapshot.movementLeadMs + offset - projectileStep;
            const previousPlayerX = snapshot.position.x
              + this.candidateX[candidate] * snapshot.moveSpeed * previousMovementOffset;
            const previousPlayerY = snapshot.position.y
              + this.candidateY[candidate] * snapshot.moveSpeed * previousMovementOffset;
            clearance = minimumChebyshevOnSegment(
              this.previousProjectilePosition.x - previousPlayerX,
              this.previousProjectilePosition.y - previousPlayerY,
              this.projectilePosition.x - playerX,
              this.projectilePosition.y - playerY,
            ) - HIT_HALF_SIZE;
            impactOffset = offset - projectileStep;
          }
          if (clearance < this.candidateScore[candidate]) this.candidateScore[candidate] = clearance;
          if (clearance <= 0 && impactOffset < this.candidateImpactMs[candidate]) {
            this.candidateImpactMs[candidate] = impactOffset;
          }
          if (candidate === 0) {
            standingClearance = Math.min(standingClearance, clearance);
            if (clearance <= 0) earliestImpactMs = Math.min(earliestImpactMs, impactOffset);
          } else if (candidate === INTENT_CANDIDATE) {
            intentClearance = Math.min(intentClearance, clearance);
            if (clearance <= 0) earliestImpactMs = Math.min(earliestImpactMs, impactOffset);
          }
        }
        copyPoint(this.previousProjectilePosition, this.projectilePosition);
        previousSet = true;
      }
      const effectiveIntentClearance = this.candidateValid[INTENT_CANDIDATE]
        ? intentClearance : standingClearance;
      if (Math.min(standingClearance, effectiveIntentClearance) <= RELEVANCE_CLEARANCE) threatCount++;
    }

    for (const aoe of aoes) {
      const landingOffset = aoe.landingTime - snapshot.time;
      if (landingOffset <= 0 || landingOffset > HORIZON_MS) continue;
      const movementOffset = snapshot.movementLeadMs + landingOffset;
      if (Math.hypot(aoe.x - snapshot.position.x, aoe.y - snapshot.position.y)
        > aoe.radius + snapshot.moveSpeed * movementOffset + RELEVANCE_CLEARANCE) continue;
      let standingClearance = Infinity;
      let intentClearance = Infinity;
      for (let candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
        if (!this.candidateValid[candidate] || landingOffset >= this.candidateBlockMs[candidate]) continue;
        const playerX = snapshot.position.x
          + this.candidateX[candidate] * snapshot.moveSpeed * movementOffset;
        const playerY = snapshot.position.y
          + this.candidateY[candidate] * snapshot.moveSpeed * movementOffset;
        const clearance = Math.hypot(aoe.x - playerX, aoe.y - playerY) - aoe.radius;
        if (clearance < this.candidateScore[candidate]) this.candidateScore[candidate] = clearance;
        if (clearance <= 0 && landingOffset < this.candidateImpactMs[candidate]) {
          this.candidateImpactMs[candidate] = landingOffset;
        }
        if (candidate === 0) standingClearance = clearance;
        else if (candidate === INTENT_CANDIDATE) intentClearance = clearance;
      }
      const effectiveIntentClearance = this.candidateValid[INTENT_CANDIDATE]
        ? intentClearance : standingClearance;
      if (Math.min(standingClearance, effectiveIntentClearance) <= RELEVANCE_CLEARANCE) {
        threatCount++;
        if (Math.min(standingClearance, effectiveIntentClearance) <= 0) {
          earliestImpactMs = Math.min(earliestImpactMs, landingOffset);
        }
      }
    }

    if (!Number.isFinite(this.candidateScore[INTENT_CANDIDATE])) {
      this.candidateScore[INTENT_CANDIDATE] = this.candidateScore[0];
      this.candidateImpactMs[INTENT_CANDIDATE] = this.candidateImpactMs[0];
      this.candidateBlockMs[INTENT_CANDIDATE] = this.candidateBlockMs[0];
      this.candidateValid[INTENT_CANDIDATE] = this.candidateValid[0];
    }

    this.updateSmoothedScores(threatSetChanged);
    const scoreFor = (candidate: number): number => {
      const base = this.smoothedScore[candidate];
      return candidate === this.selectedCandidate
        && this.candidateValid[candidate]
        && this.candidateScore[candidate] >= INTENT_SAFE_CLEARANCE
        ? base + COMMIT_BONUS
        : base;
    };

    let proposedCandidate = 0;
    if (threatCount > 0) {
      let bestScore = scoreFor(0);
      let bestImpact = this.candidateImpactMs[0];
      let bestCorridor = this.corridorSafety(0);
      let bestOpenLane = this.candidateOpenLaneMs[0];
      let bestEnemyClearance = this.candidateEnemyClearance[0];
      const intentX = this.candidateX[INTENT_CANDIDATE];
      const intentY = this.candidateY[INTENT_CANDIDATE];
      let bestIntentDot = this.candidateX[0] * intentX + this.candidateY[0] * intentY;
      for (let candidate = 1; candidate <= DIRECTION_COUNT; candidate++) {
        if (!this.candidateValid[candidate]) continue;
        const impact = this.candidateImpactMs[candidate];
        const corridor = this.corridorSafety(candidate);
        const openLane = this.candidateOpenLaneMs[candidate];
        const score = scoreFor(candidate);
        const enemyClearance = this.candidateEnemyClearance[candidate];
        const intentDot = this.candidateX[candidate] * intentX
          + this.candidateY[candidate] * intentY;
        if (impact > bestImpact
          || impact === bestImpact && corridor > bestCorridor
          || impact === bestImpact && corridor === bestCorridor && openLane > bestOpenLane
          || impact === bestImpact && corridor === bestCorridor && openLane === bestOpenLane
            && score > bestScore
          || impact === bestImpact && corridor === bestCorridor && openLane === bestOpenLane
            && score === bestScore && enemyClearance > bestEnemyClearance
          || impact === bestImpact && corridor === bestCorridor && openLane === bestOpenLane
            && score === bestScore && enemyClearance === bestEnemyClearance
            && intentDot > bestIntentDot) {
          bestScore = scoreFor(candidate);
          bestImpact = this.candidateImpactMs[candidate];
          bestCorridor = corridor;
          bestOpenLane = openLane;
          bestEnemyClearance = enemyClearance;
          bestIntentDot = intentDot;
          proposedCandidate = candidate;
        }
      }
    }

    if (threatCount > 0 && proposedCandidate !== 0
      && this.candidateOpenLaneMs[proposedCandidate] < LANE_SHORT_THRESHOLD_MS) {
      const winnerImpact = this.candidateImpactMs[proposedCandidate];
      const winnerCorridor = this.corridorSafety(proposedCandidate);
      let bestAltLane = this.candidateOpenLaneMs[proposedCandidate];
      let bestAlt = -1;
      for (let candidate = 1; candidate <= DIRECTION_COUNT; candidate++) {
        if (candidate === proposedCandidate || !this.candidateValid[candidate]) continue;
        if (this.candidateOpenLaneMs[candidate] < LANE_SHORT_THRESHOLD_MS) continue;
        if (Math.abs(this.candidateImpactMs[candidate] - winnerImpact) > SAMPLE_MS) continue;
        if (Math.abs(this.corridorSafety(candidate) - winnerCorridor) > 2 * SAMPLE_MS) continue;
        if (this.candidateOpenLaneMs[candidate] <= bestAltLane) continue;
        bestAltLane = this.candidateOpenLaneMs[candidate];
        bestAlt = candidate;
      }
      if (bestAlt !== -1) proposedCandidate = bestAlt;
    }

    return this.applyChoice(snapshot, threatCount, earliestImpactMs, proposedCandidate, aoes);
  }

  private applyChoice(
    snapshot: AutoDodgeSnapshot,
    threatCount: number,
    earliestImpactMs: number,
    proposedCandidate: number,
    aoes: readonly AutoDodgeAoeThreat[],
  ): AutoDodgeState {
    if (snapshot.moveSpeed <= 0 || snapshot.movementLocked) {
      if (snapshot.time >= this.selectedUntil) this.selectedCandidate = 0;
      return this.finishGoalOrIntent(
        snapshot,
        this.selectedCandidate,
        1,
        threatCount,
        earliestImpactMs,
        'movement_locked',
      );
    }
    const intendedScore = this.candidateScore[INTENT_CANDIDATE];
    const goalPlan = this.findGoalPath(snapshot, aoes);
    if (goalPlan) {
      this.selectedCandidate = goalPlan.candidate;
      this.selectedUntil = snapshot.time + HYSTERESIS_MS;
      return this.finish(
        snapshot,
        goalPlan.velocityX,
        goalPlan.velocityY,
        true,
        goalPlan.candidate,
        goalPlan.speedScale,
        threatCount,
        earliestImpactMs,
        'goal_path',
        goalPlan.path,
      );
    }
    if (threatCount === 0) {
      if (snapshot.goal && Number.isFinite(snapshot.goal.x) && Number.isFinite(snapshot.goal.y)) {
        return this.finish(
          snapshot,
          0,
          0,
          true,
          0,
          0,
          0,
          earliestImpactMs,
          'goal_blocked',
        );
      }
      return this.finishGoalOrIntent(
        snapshot,
        this.selectedCandidate,
        1,
        0,
        earliestImpactMs,
        'no_threat',
      );
    }
    if (intendedScore >= INTENT_SAFE_CLEARANCE) {
      return this.finishGoalOrIntent(
        snapshot,
        this.selectedCandidate,
        1,
        threatCount,
        earliestImpactMs,
        'preserve_safe_intent',
      );
    }

    let choice = proposedCandidate;
    const intentX = this.candidateX[INTENT_CANDIDATE];
    const intentY = this.candidateY[INTENT_CANDIDATE];
    let decision = earliestImpactMs >= EMERGENCY_OVERRIDE_MS
      ? 'gentle_override' : 'emergency_override';
    if (earliestImpactMs >= EMERGENCY_OVERRIDE_MS) {
      let bestDot = -Infinity;
      for (let candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
        if (!this.candidateValid[candidate]
          || this.candidateScore[candidate] < INTENT_SAFE_CLEARANCE) continue;
        const dot = this.candidateX[candidate] * intentX + this.candidateY[candidate] * intentY;
        if (dot > bestDot) {
          bestDot = dot;
          choice = candidate;
        }
      }
      if (choice !== proposedCandidate) decision = 'gentle_manual_blend';
    } else {
      const bestEmergencyScore = this.candidateScore[choice];
      if (intentLengthSquared(intentX, intentY) > 0.000001
        && bestEmergencyScore >= INTENT_SAFE_CLEARANCE) {
        const acceptableScore = Math.max(INTENT_SAFE_CLEARANCE,
          bestEmergencyScore - EMERGENCY_INTENT_BAND);
        let bestDot = -Infinity;
        for (let candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
          if (!this.candidateValid[candidate] || this.candidateScore[candidate] < acceptableScore) continue;
          const dot = this.candidateX[candidate] * intentX + this.candidateY[candidate] * intentY;
          if (dot > bestDot) {
            bestDot = dot;
            choice = candidate;
          }
        }
        if (choice !== proposedCandidate) decision = 'emergency_manual_blend';
      } else if (intentLengthSquared(intentX, intentY) > 0.000001) {
        const acceptableImpact = Math.max(0,
          this.candidateImpactMs[choice] - UNAVOIDABLE_IMPACT_BAND_MS);
        const acceptableClearance = this.candidateScore[choice] - UNAVOIDABLE_CLEARANCE_BAND;
        let bestDot = -Infinity;
        for (let candidate = 0; candidate < CANDIDATE_COUNT; candidate++) {
          if (!this.candidateValid[candidate]
            || this.candidateImpactMs[candidate] < acceptableImpact
            || this.candidateScore[candidate] < acceptableClearance) continue;
          const dot = this.candidateX[candidate] * intentX + this.candidateY[candidate] * intentY;
          if (dot > bestDot) {
            bestDot = dot;
            choice = candidate;
          }
        }
        if (choice !== proposedCandidate) decision = 'unavoidable_manual_blend';
      }
    }

    const choiceIntentDot = this.candidateX[choice] * intentX + this.candidateY[choice] * intentY;
    const selectedIntentDot = this.candidateX[this.selectedCandidate] * intentX
      + this.candidateY[this.selectedCandidate] * intentY;
    if (snapshot.time < this.selectedUntil
      && this.candidateValid[this.selectedCandidate]
      && this.candidateScore[this.selectedCandidate] >= INTENT_SAFE_CLEARANCE
      && (intentLengthSquared(intentX, intentY) <= 0.000001
        || selectedIntentDot >= choiceIntentDot - 0.05)
      && this.candidateScore[choice]
        < this.candidateScore[this.selectedCandidate] + HYSTERESIS_SCORE_GAIN) {
      choice = this.selectedCandidate;
    } else {
      if (this.previousOverrideActive && choice !== this.selectedCandidate) {
        this.totalSwitches++;
      }
      this.selectedCandidate = choice;
      this.selectedUntil = snapshot.time + HYSTERESIS_MS;
    }

    let speedScale = 1;
    if (choice !== 0 && this.candidateValid[choice]
      && this.candidateScore[choice] >= INTENT_SAFE_CLEARANCE) {
      speedScale = this.selectManualAlignedSpeed(snapshot, choice, aoes);
    }
    return this.finish(
      snapshot,
      this.candidateX[choice] * snapshot.moveSpeed * speedScale,
      this.candidateY[choice] * snapshot.moveSpeed * speedScale,
      true,
      choice,
      speedScale,
      threatCount,
      earliestImpactMs,
      decision,
    );
  }

  /**
   * Beam-searches a time-expanded local movement lattice. Each edge is checked
   * against static collision, enemy clearance, timed AOEs, and continuous
   * projectile segments. Only the first velocity is executed before replanning.
   */
  private findGoalPath(
    snapshot: AutoDodgeSnapshot,
    aoes: readonly AutoDodgeAoeThreat[],
  ): GoalDodgePlan | undefined {
    const goal = snapshot.goal;
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y)) return undefined;
    const initialGoalDistance = Math.hypot(goal.x - snapshot.position.x, goal.y - snapshot.position.y);
    if (initialGoalDistance <= GOAL_PATH_POINT_EPSILON) return undefined;

    const goalThreshold = Number.isFinite(goal.threshold)
      ? Math.max(0, Number(goal.threshold))
      : 0;
    const projectileTracks = this.buildLocalProjectileTracks(snapshot);
    const directPlan = this.directLocalGoalPlan(
      snapshot,
      goal,
      goalThreshold,
      projectileTracks,
      aoes,
    );
    if (directPlan) return directPlan;

    let frontier: LocalPlanNode[] = [{
      x: snapshot.position.x,
      y: snapshot.position.y,
      timeMs: 0,
      headingX: 0,
      headingY: 0,
      firstCandidate: 0,
      firstVelocityX: 0,
      firstVelocityY: 0,
      minThreatClearance: Infinity,
      minEnemyClearance: snapshot.environment.enemyClearance?.(
        snapshot.position.x,
        snapshot.position.y,
      ) ?? Infinity,
      turnCost: 0,
    }];

    for (let timeMs = 0; timeMs < HORIZON_MS; timeMs += LOCAL_PLAN_STEP_MS) {
      const nextByKey = new Map<string, LocalPlanNode>();
      for (const node of frontier) {
        const nodeGoalDistance = Math.hypot(goal.x - node.x, goal.y - node.y);
        const atGoal = nodeGoalDistance <= Math.max(goalThreshold, GOAL_PATH_POINT_EPSILON);
        const moves: Array<{ candidate: number; x: number; y: number; exactGoal: boolean }> = [
          { candidate: 0, x: 0, y: 0, exactGoal: false },
        ];
        if (!atGoal) {
          for (let direction = 0; direction < DIRECTION_COUNT; direction += LOCAL_PLAN_DIRECTION_STRIDE) {
            const candidate = direction + 1;
            moves.push({
              candidate,
              x: this.candidateX[candidate],
              y: this.candidateY[candidate],
              exactGoal: false,
            });
          }
          if (this.selectedCandidate > 0 && this.selectedCandidate <= DIRECTION_COUNT
            && !moves.some((move) => move.candidate === this.selectedCandidate)) {
            moves.push({
              candidate: this.selectedCandidate,
              x: this.candidateX[this.selectedCandidate],
              y: this.candidateY[this.selectedCandidate],
              exactGoal: false,
            });
          }
          moves.push({
            candidate: INTENT_CANDIDATE,
            x: (goal.x - node.x) / nodeGoalDistance,
            y: (goal.y - node.y) / nodeGoalDistance,
            exactGoal: true,
          });
        }

        for (const move of moves) {
          const maximumTravel = snapshot.moveSpeed * LOCAL_PLAN_STEP_MS;
          const travel = move.exactGoal ? Math.min(maximumTravel, nodeGoalDistance) : maximumTravel;
          const nextX = node.x + move.x * travel;
          const nextY = node.y + move.y * travel;
          const edgeSafety = this.evaluateLocalEdge(
            snapshot,
            node,
            { x: nextX, y: nextY },
            timeMs,
            timeMs + LOCAL_PLAN_STEP_MS,
            projectileTracks,
            aoes,
          );
          if (!edgeSafety) continue;

          const moveVelocityX = (nextX - node.x) / LOCAL_PLAN_STEP_MS;
          const moveVelocityY = (nextY - node.y) / LOCAL_PLAN_STEP_MS;
          const moving = intentLengthSquared(move.x, move.y) > 0.000001;
          const wasMoving = intentLengthSquared(node.headingX, node.headingY) > 0.000001;
          const turnCost = moving && wasMoving
            ? Math.max(0, 1 - (move.x * node.headingX + move.y * node.headingY))
            : moving === wasMoving ? 0 : 0.15;
          const child: LocalPlanNode = {
            x: nextX,
            y: nextY,
            timeMs: timeMs + LOCAL_PLAN_STEP_MS,
            headingX: move.x,
            headingY: move.y,
            firstCandidate: node.timeMs === 0 ? move.candidate : node.firstCandidate,
            firstVelocityX: node.timeMs === 0 ? moveVelocityX : node.firstVelocityX,
            firstVelocityY: node.timeMs === 0 ? moveVelocityY : node.firstVelocityY,
            minThreatClearance: Math.min(node.minThreatClearance, edgeSafety.minThreatClearance),
            minEnemyClearance: Math.min(node.minEnemyClearance, edgeSafety.minEnemyClearance),
            turnCost: node.turnCost + turnCost,
            parent: node,
          };
          const key = this.localNodeKey(child);
          const existing = nextByKey.get(key);
          if (!existing || this.localNodeScore(child, goal, goalThreshold, snapshot)
            < this.localNodeScore(existing, goal, goalThreshold, snapshot)) {
            nextByKey.set(key, child);
          }
        }
      }

      frontier = [...nextByKey.values()]
        .sort((left, right) => this.localNodeScore(left, goal, goalThreshold, snapshot)
          - this.localNodeScore(right, goal, goalThreshold, snapshot))
        .slice(0, LOCAL_PLAN_BEAM_WIDTH);
      if (frontier.length === 0) return undefined;
    }

    const best = frontier
      .filter((node) => Math.hypot(goal.x - node.x, goal.y - node.y)
        <= initialGoalDistance + GOAL_PROGRESS_TOLERANCE)
      .sort((left, right) => this.localNodeScore(left, goal, goalThreshold, snapshot)
        - this.localNodeScore(right, goal, goalThreshold, snapshot))[0];
    if (!best) return undefined;

    const path: Array<{ x: number; y: number }> = [];
    let cursor: LocalPlanNode | undefined = best;
    while (cursor?.parent) {
      path.push({ x: cursor.x, y: cursor.y });
      cursor = cursor.parent;
    }
    path.reverse();
    const firstSpeed = Math.hypot(best.firstVelocityX, best.firstVelocityY);
    return {
      candidate: best.firstCandidate,
      velocityX: best.firstVelocityX,
      velocityY: best.firstVelocityY,
      speedScale: snapshot.moveSpeed > 0 ? firstSpeed / snapshot.moveSpeed : 0,
      path,
    };
  }

  private directLocalGoalPlan(
    snapshot: AutoDodgeSnapshot,
    goal: { x: number; y: number },
    goalThreshold: number,
    projectileTracks: readonly LocalProjectileTrack[],
    aoes: readonly AutoDodgeAoeThreat[],
  ): GoalDodgePlan | undefined {
    let current = { x: snapshot.position.x, y: snapshot.position.y };
    const path: Array<{ x: number; y: number }> = [];
    let firstVelocityX = 0;
    let firstVelocityY = 0;
    for (let timeMs = 0; timeMs < HORIZON_MS; timeMs += LOCAL_PLAN_STEP_MS) {
      const dx = goal.x - current.x;
      const dy = goal.y - current.y;
      const distance = Math.hypot(dx, dy);
      let next = current;
      if (distance > Math.max(goalThreshold, GOAL_PATH_POINT_EPSILON)) {
        const travel = Math.min(snapshot.moveSpeed * LOCAL_PLAN_STEP_MS, distance);
        next = { x: current.x + dx / distance * travel, y: current.y + dy / distance * travel };
      }
      if (!this.evaluateLocalEdge(
        snapshot,
        current,
        next,
        timeMs,
        timeMs + LOCAL_PLAN_STEP_MS,
        projectileTracks,
        aoes,
      )) return undefined;
      if (timeMs === 0) {
        firstVelocityX = (next.x - current.x) / LOCAL_PLAN_STEP_MS;
        firstVelocityY = (next.y - current.y) / LOCAL_PLAN_STEP_MS;
      }
      if (path.length === 0 || Math.hypot(
        next.x - path[path.length - 1]!.x,
        next.y - path[path.length - 1]!.y,
      ) > GOAL_PATH_POINT_EPSILON) {
        path.push({ ...next });
      }
      current = next;
    }
    const firstSpeed = Math.hypot(firstVelocityX, firstVelocityY);
    return {
      candidate: INTENT_CANDIDATE,
      velocityX: firstVelocityX,
      velocityY: firstVelocityY,
      speedScale: snapshot.moveSpeed > 0 ? firstSpeed / snapshot.moveSpeed : 0,
      path,
    };
  }

  private buildLocalProjectileTracks(snapshot: AutoDodgeSnapshot): LocalProjectileTrack[] {
    const tracks: LocalProjectileTrack[] = [];
    for (const projectile of this.relevantProjectiles) {
      const points: Array<{ x: number; y: number }> = [];
      let previous: { x: number; y: number } | undefined;
      const projectileStep = this.getSampleStepMs(projectile);
      for (let offset = 0; offset <= HORIZON_MS; offset += projectileStep) {
        const sampleTime = snapshot.time + offset;
        if (!isProjectileAliveAt(projectile, sampleTime)) break;
        predictProjectilePosition(projectile, sampleTime, this.projectilePosition);
        if (previous && !snapshot.environment.isProjectileSegmentOpen(
          previous.x,
          previous.y,
          this.projectilePosition.x,
          this.projectilePosition.y,
          projectile,
        )) break;
        const point = { ...this.projectilePosition };
        points.push(point);
        previous = point;
      }
      if (points.length > 0) tracks.push({ points, stepMs: projectileStep });
    }
    return tracks;
  }

  private evaluateLocalEdge(
    snapshot: AutoDodgeSnapshot,
    from: { x: number; y: number },
    to: { x: number; y: number },
    startTimeMs: number,
    endTimeMs: number,
    projectileTracks: readonly LocalProjectileTrack[],
    aoes: readonly AutoDodgeAoeThreat[],
  ): LocalEdgeSafety | undefined {
    let minThreatClearance = Infinity;
    let minEnemyClearance = Infinity;
    const startEnemyClearance = snapshot.environment.enemyClearance?.(from.x, from.y) ?? Infinity;
    for (let timeMs = startTimeMs + SAMPLE_MS; timeMs <= endTimeMs; timeMs += SAMPLE_MS) {
      const ratio = (timeMs - startTimeMs) / (endTimeMs - startTimeMs);
      const x = from.x + (to.x - from.x) * ratio;
      const y = from.y + (to.y - from.y) * ratio;
      if (!snapshot.environment.canOccupy(x, y, this.safeWalk, false)) return undefined;
      const enemyClearance = snapshot.environment.enemyClearance?.(x, y) ?? Infinity;
      if (startEnemyClearance >= ENEMY_AVOID_RADIUS
        ? enemyClearance < ENEMY_AVOID_RADIUS
        : enemyClearance + 1e-9 < startEnemyClearance) {
        return undefined;
      }
      minEnemyClearance = Math.min(minEnemyClearance, enemyClearance);
    }

    for (const track of projectileTracks) {
      const trackStep = track.stepMs;
      const startIndex = Math.trunc(startTimeMs / trackStep);
      const endIndex = Math.trunc(endTimeMs / trackStep);
      if (startIndex >= track.points.length) continue;
      let previousProjectile = track.points[startIndex]!;
      let previousPlayer = { x: from.x, y: from.y };
      let clearance = chebyshev(
        previousProjectile.x - previousPlayer.x,
        previousProjectile.y - previousPlayer.y,
      ) - HIT_HALF_SIZE;
      if (clearance < INTENT_SAFE_CLEARANCE) return undefined;
      minThreatClearance = Math.min(minThreatClearance, clearance);

      for (let index = startIndex + 1; index <= endIndex && index < track.points.length; index++) {
        const projectile = track.points[index]!;
        const ratio = (index * trackStep - startTimeMs) / (endTimeMs - startTimeMs);
        const player = {
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
        };
        clearance = minimumChebyshevOnSegment(
          previousProjectile.x - previousPlayer.x,
          previousProjectile.y - previousPlayer.y,
          projectile.x - player.x,
          projectile.y - player.y,
        ) - HIT_HALF_SIZE;
        if (clearance < INTENT_SAFE_CLEARANCE) return undefined;
        minThreatClearance = Math.min(minThreatClearance, clearance);
        previousProjectile = projectile;
        previousPlayer = player;
      }
    }

    for (const aoe of aoes) {
      const landingTimeMs = aoe.landingTime - snapshot.time;
      if (landingTimeMs <= startTimeMs || landingTimeMs > endTimeMs) continue;
      const ratio = (landingTimeMs - startTimeMs) / (endTimeMs - startTimeMs);
      const playerX = from.x + (to.x - from.x) * ratio;
      const playerY = from.y + (to.y - from.y) * ratio;
      const clearance = Math.hypot(aoe.x - playerX, aoe.y - playerY) - aoe.radius;
      if (clearance < INTENT_SAFE_CLEARANCE) return undefined;
      minThreatClearance = Math.min(minThreatClearance, clearance);
    }
    return { minThreatClearance, minEnemyClearance };
  }

  private localNodeKey(node: LocalPlanNode): string {
    const x = Math.round(node.x / LOCAL_PLAN_CELL_SIZE);
    const y = Math.round(node.y / LOCAL_PLAN_CELL_SIZE);
    const heading = intentLengthSquared(node.headingX, node.headingY) <= 0.000001
      ? 'w'
      : Math.round((Math.atan2(node.headingY, node.headingX) + Math.PI) * 8 / Math.PI);
    return `${x},${y},${heading}`;
  }

  private localNodeScore(
    node: LocalPlanNode,
    goal: { x: number; y: number },
    goalThreshold: number,
    snapshot: AutoDodgeSnapshot,
  ): number {
    const goalDistance = Math.max(0, Math.hypot(goal.x - node.x, goal.y - node.y) - goalThreshold);
    const threatClearance = Math.min(node.minThreatClearance, 0.75);
    const enemyClearance = Math.min(node.minEnemyClearance, 3);
    const continuity = snapshot.time < this.selectedUntil
      && node.firstCandidate === this.selectedCandidate ? 0.2 : 0;
    return goalDistance * 4
      + node.turnCost * 0.12
      - threatClearance * 0.5
      - enemyClearance * 0.03
      - continuity;
  }

  /** Goal coordinates, rather than pathfinder velocity, own normal movement while dodge is enabled. */
  private withGoalIntent(snapshot: AutoDodgeSnapshot): AutoDodgeSnapshot {
    const goal = snapshot.goal;
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.y)) return snapshot;
    if (snapshot.movementLocked) {
      return { ...snapshot, intentVelocity: { x: 0, y: 0 } };
    }

    const dx = goal.x - snapshot.position.x;
    const dy = goal.y - snapshot.position.y;
    const distance = Math.hypot(dx, dy);
    const threshold = Number.isFinite(goal.threshold)
      ? Math.max(0, Number(goal.threshold))
      : 0;
    if (distance <= threshold || distance <= GOAL_PATH_POINT_EPSILON) {
      return { ...snapshot, intentVelocity: { x: 0, y: 0 } };
    }

    // Clamp the last movement frame inside the arrival radius instead of
    // overshooting now that the dodge controller owns safe movement too.
    const targetTravel = Math.max(0, distance - threshold * 0.5);
    const speed = Math.min(
      snapshot.moveSpeed,
      targetTravel / Math.max(1, snapshot.movementLeadMs),
    );
    return {
      ...snapshot,
      intentVelocity: {
        x: dx / distance * speed,
        y: dy / distance * speed,
      },
    };
  }

  private finishGoalOrIntent(
    snapshot: AutoDodgeSnapshot,
    selectedCandidate: number,
    speedScale: number,
    threatCount: number,
    earliestImpactMs: number,
    fallbackDecision: string,
  ): AutoDodgeState {
    const goal = snapshot.goal;
    const ownsMovement = !!goal
      && Number.isFinite(goal.x)
      && Number.isFinite(goal.y)
      && !snapshot.movementLocked;
    return this.finish(
      snapshot,
      snapshot.intentVelocity.x,
      snapshot.intentVelocity.y,
      ownsMovement,
      selectedCandidate,
      speedScale,
      threatCount,
      earliestImpactMs,
      ownsMovement ? 'follow_goal' : fallbackDecision,
      ownsMovement ? [{ x: goal.x, y: goal.y }] : [],
    );
  }

  private validateCandidatePaths(snapshot: AutoDodgeSnapshot): void {
    for (let candidate = 1; candidate < CANDIDATE_COUNT; candidate++) {
      let horizonHit = false;
      for (let offset = 0; offset <= HORIZON_MS; offset += SAMPLE_MS) {
        const movementOffset = snapshot.movementLeadMs + offset;
        const x = snapshot.position.x
          + this.candidateX[candidate] * snapshot.moveSpeed * movementOffset;
        const y = snapshot.position.y
          + this.candidateY[candidate] * snapshot.moveSpeed * movementOffset;
        const enemyClearance = snapshot.environment.enemyClearance?.(x, y) ?? Infinity;
        this.candidateEnemyClearance[candidate] = Math.min(
          this.candidateEnemyClearance[candidate], enemyClearance,
        );
        if (snapshot.environment.canOccupy(x, y, this.safeWalk, false)) continue;
        this.candidateBlockMs[candidate] = offset;
        this.candidateImpactMs[candidate] = offset;
        this.candidateOpenLaneMs[candidate] = offset;
        if (offset === 0) this.candidateValid[candidate] = 0;
        horizonHit = true;
        break;
      }
      if (horizonHit || !this.candidateValid[candidate]) continue;
      for (let offset = HORIZON_MS + SAMPLE_MS; offset <= LANE_HORIZON_MS; offset += SAMPLE_MS) {
        const movementOffset = snapshot.movementLeadMs + offset;
        const x = snapshot.position.x
          + this.candidateX[candidate] * snapshot.moveSpeed * movementOffset;
        const y = snapshot.position.y
          + this.candidateY[candidate] * snapshot.moveSpeed * movementOffset;
        if (snapshot.environment.canOccupy(x, y, this.safeWalk, false)) continue;
        this.candidateOpenLaneMs[candidate] = offset;
        break;
      }
    }
  }

  private selectManualAlignedSpeed(
    snapshot: AutoDodgeSnapshot,
    candidate: number,
    aoes: readonly AutoDodgeAoeThreat[],
  ): number {
    let bestScale = 1;
    const fullX = this.candidateX[candidate] * snapshot.moveSpeed;
    const fullY = this.candidateY[candidate] * snapshot.moveSpeed;
    let bestDifference = squaredDistance(fullX, fullY,
      snapshot.intentVelocity.x, snapshot.intentVelocity.y);
    for (let step = 1; step <= 4; step++) {
      const scale = step * 0.2;
      const velocityX = fullX * scale;
      const velocityY = fullY * scale;
      const difference = squaredDistance(velocityX, velocityY,
        snapshot.intentVelocity.x, snapshot.intentVelocity.y);
      if (difference >= bestDifference
        || !this.isVelocitySafe(snapshot, velocityX, velocityY, aoes)) continue;
      bestDifference = difference;
      bestScale = scale;
    }
    return bestScale;
  }

  private isVelocitySafe(
    snapshot: AutoDodgeSnapshot,
    velocityX: number,
    velocityY: number,
    aoes: readonly AutoDodgeAoeThreat[],
  ): boolean {
    for (let offset = 0; offset <= HORIZON_MS; offset += SAMPLE_MS) {
      const movementOffset = snapshot.movementLeadMs + offset;
      if (!snapshot.environment.canOccupy(
        snapshot.position.x + velocityX * movementOffset,
        snapshot.position.y + velocityY * movementOffset,
        this.safeWalk,
        false,
      )) return false;
    }
    for (const aoe of aoes) {
      const landingOffset = aoe.landingTime - snapshot.time;
      if (landingOffset <= 0 || landingOffset > HORIZON_MS) continue;
      const movementOffset = snapshot.movementLeadMs + landingOffset;
      if (Math.hypot(
        aoe.x - (snapshot.position.x + velocityX * movementOffset),
        aoe.y - (snapshot.position.y + velocityY * movementOffset),
      ) - aoe.radius < INTENT_SAFE_CLEARANCE) return false;
    }
    for (const projectile of this.relevantProjectiles) {
      let previousSet = false;
      const projectileStep = this.getSampleStepMs(projectile);
      for (let offset = 0; offset <= HORIZON_MS; offset += projectileStep) {
        const sampleTime = snapshot.time + offset;
        if (!isProjectileAliveAt(projectile, sampleTime)) break;
        predictProjectilePosition(projectile, sampleTime, this.projectilePosition);
        if (previousSet && !snapshot.environment.isProjectileSegmentOpen(
          this.previousProjectilePosition.x,
          this.previousProjectilePosition.y,
          this.projectilePosition.x,
          this.projectilePosition.y,
          projectile,
        )) break;
        const movementOffset = snapshot.movementLeadMs + offset;
        const playerX = snapshot.position.x + velocityX * movementOffset;
        const playerY = snapshot.position.y + velocityY * movementOffset;
        let clearance: number;
        if (previousSet) {
          const previousMovementOffset = snapshot.movementLeadMs + offset - projectileStep;
          clearance = minimumChebyshevOnSegment(
            this.previousProjectilePosition.x
              - (snapshot.position.x + velocityX * previousMovementOffset),
            this.previousProjectilePosition.y
              - (snapshot.position.y + velocityY * previousMovementOffset),
            this.projectilePosition.x - playerX,
            this.projectilePosition.y - playerY,
          ) - HIT_HALF_SIZE;
        } else {
          clearance = chebyshev(this.projectilePosition.x - playerX,
            this.projectilePosition.y - playerY) - HIT_HALF_SIZE;
        }
        if (clearance < INTENT_SAFE_CLEARANCE) return false;
        copyPoint(this.previousProjectilePosition, this.projectilePosition);
        previousSet = true;
      }
    }
    return true;
  }

  private isThreatTo(projectile: CombatProjectileSnapshot, snapshot: AutoDodgeSnapshot): boolean {
    return projectile.side === 'enemy'
      && isProjectileAliveAt(projectile, snapshot.time)
      && !projectile.hitObjects.has(snapshot.playerId);
  }

  private resetFrame(): void {
    this.relevantProjectiles.length = 0;
    for (let index = 0; index < CANDIDATE_COUNT; index++) {
      this.candidateScore[index] = Infinity;
      this.candidateImpactMs[index] = MAX_TIME;
      this.candidateBlockMs[index] = MAX_TIME;
      this.candidateEnemyClearance[index] = Infinity;
      this.candidateOpenLaneMs[index] = LANE_HORIZON_MS;
      this.candidateValid[index] = 1;
    }
  }

  private getSampleStepMs(projectile: CombatProjectileSnapshot): number {
    const definition = projectile.definition;
    const speedFactor = Math.max(0.5, Math.min(1, 80 / Math.max(1, definition.speed)));
    let step = Math.max(MIN_SAMPLE_MS, Math.min(SAMPLE_MS, Math.round(SAMPLE_MS * speedFactor)));
    if (definition.wavy
      || definition.parametric
      || definition.boomerang
      || definition.amplitude !== 0
      || definition.acceleration !== 0) {
      step = Math.min(step, CURVED_TRAJECTORY_MAX_SAMPLE_MS);
    }
    return step;
  }

  private detectThreatSetChange(snapshot: AutoDodgeSnapshot): boolean {
    let sizeMatch = true;
    let seen = 0;
    for (const projectile of snapshot.projectiles) {
      if (projectile.side !== 'enemy') continue;
      const key = `${projectile.ownerId}:${projectile.bulletId}`;
      if (!this.previousBulletKeys.has(key)) sizeMatch = false;
      seen++;
    }
    if (seen !== this.previousBulletKeys.size) sizeMatch = false;
    const aoeCount = snapshot.aoes.length;
    const overrideEdge = this.previousOverrideActive !== this.state.overrideActive;
    return !sizeMatch || aoeCount !== this.previousAoeCount || overrideEdge;
  }

  /** Favors broad safe lanes over isolated directions that are safe by only a few degrees. */
  private corridorSafety(candidate: number): number {
    const cappedImpact = (index: number): number => this.candidateValid[index]
      ? Math.min(this.candidateImpactMs[index], HORIZON_MS + SAMPLE_MS)
      : 0;
    if (candidate === 0) return cappedImpact(0) * (CORRIDOR_NEIGHBORS * 2 + 1);

    let score = cappedImpact(candidate);
    const direction = candidate - 1;
    for (let gap = 1; gap <= CORRIDOR_NEIGHBORS; gap++) {
      score += cappedImpact(((direction + gap) % DIRECTION_COUNT) + 1);
      score += cappedImpact(((direction - gap + DIRECTION_COUNT) % DIRECTION_COUNT) + 1);
    }
    return score;
  }

  private updateSmoothedScores(threatSetChanged: boolean): void {
    for (let index = 0; index < CANDIDATE_COUNT; index++) {
      const raw = this.candidateScore[index];
      if (threatSetChanged || !Number.isFinite(this.smoothedScore[index])) {
        this.smoothedScore[index] = raw;
        continue;
      }
      if (!Number.isFinite(raw)) {
        this.smoothedScore[index] = raw;
        continue;
      }
      const previous = this.smoothedScore[index];
      this.smoothedScore[index] = previous + SMOOTHING_ALPHA * (raw - previous);
    }
  }

  private finish(
    snapshot: AutoDodgeSnapshot,
    velocityX: number,
    velocityY: number,
    overrideActive: boolean,
    selectedCandidate: number,
    speedScale: number,
    threatCount: number,
    earliestImpactMs: number,
    decision: string,
    plannedPath: readonly { x: number; y: number }[] = [],
  ): AutoDodgeState {
    const path = overrideActive
      ? plannedPath.length > 0
        ? plannedPath.map((point) => ({ ...point }))
        : [{
            x: snapshot.position.x + velocityX * (snapshot.movementLeadMs + HORIZON_MS),
            y: snapshot.position.y + velocityY * (snapshot.movementLeadMs + HORIZON_MS),
          }]
      : [];
    const target = plannedPath[0]
      ? { ...plannedPath[0] }
      : {
          x: snapshot.position.x + velocityX * snapshot.movementLeadMs,
          y: snapshot.position.y + velocityY * snapshot.movementLeadMs,
        };
    this.state = {
      enabled: this.enabled,
      overrideActive,
      velocity: { x: velocityX, y: velocityY },
      target: overrideActive ? target : null,
      goal: snapshot.goal && Number.isFinite(snapshot.goal.x) && Number.isFinite(snapshot.goal.y)
        ? { x: snapshot.goal.x, y: snapshot.goal.y }
        : null,
      path,
      threatCount,
      earliestImpactMs: earliestImpactMs === MAX_TIME ? null : earliestImpactMs,
      selectedCandidate,
      speedScale,
      decision,
      switches: this.totalSwitches,
    };
    this.previousBulletKeys.clear();
    for (const projectile of snapshot.projectiles) {
      if (projectile.side === 'enemy') {
        this.previousBulletKeys.add(`${projectile.ownerId}:${projectile.bulletId}`);
      }
    }
    this.previousAoeCount = snapshot.aoes.length;
    this.previousOverrideActive = overrideActive;
    return this.state;
  }
}

interface TrackedThrownAoe extends AutoDodgeAoeThreat {
  effectType: number;
}

/** Correlates thrown SHOWEFFECT endpoints with later AOE packets. */
export class ThrownAoeTracker {
  private readonly throws: TrackedThrownAoe[] = [];
  private readonly learnedRadius = new Map<number, number>();
  private readonly active: AutoDodgeAoeThreat[] = [];

  clear(): void {
    this.throws.length = 0;
    this.learnedRadius.clear();
    this.active.length = 0;
  }

  track(
    effectType: number,
    end: { x: number; y: number },
    durationSeconds: number,
    now: number,
  ): void {
    const durationMs = Math.max(0, durationSeconds * 1000);
    this.throws.push({
      effectType: effectType >>> 0,
      x: end.x,
      y: end.y,
      radius: this.learnedRadius.get(effectType >>> 0) ?? 1,
      landingTime: now + durationMs,
    });
  }

  recordAoe(position: { x: number; y: number }, radius: number, now: number): void {
    let best: TrackedThrownAoe | undefined;
    let bestDistance = 1;
    for (const thrown of this.throws) {
      if (now < thrown.landingTime - 150 || now > thrown.landingTime + 750) continue;
      const distance = Math.hypot(position.x - thrown.x, position.y - thrown.y);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = thrown;
    }
    if (!best) return;
    this.learnedRadius.set(best.effectType, radius);
    best.radius = radius;
  }

  getActive(now: number): readonly AutoDodgeAoeThreat[] {
    this.active.length = 0;
    for (let index = this.throws.length - 1; index >= 0; index--) {
      const thrown = this.throws[index]!;
      if (now > thrown.landingTime + 750) {
        this.throws.splice(index, 1);
        continue;
      }
      if (now < thrown.landingTime) {
        thrown.radius = this.learnedRadius.get(thrown.effectType) ?? thrown.radius;
        this.active.push(thrown);
      }
    }
    return this.active;
  }
}

function emptyState(enabled: boolean, velocity = { x: 0, y: 0 }): AutoDodgeState {
  return {
    enabled,
    overrideActive: false,
    velocity: { ...velocity },
    target: null,
    goal: null,
    path: [],
    threatCount: 0,
    earliestImpactMs: null,
    selectedCandidate: 0,
    speedScale: 1,
    decision: 'none',
    switches: 0,
  };
}

function chebyshev(x: number, y: number): number {
  return Math.max(Math.abs(x), Math.abs(y));
}

/** Exact minimum L-infinity distance from the origin to a line segment. */
function minimumChebyshevOnSegment(x0: number, y0: number, x1: number, y1: number): number {
  let best = Math.min(chebyshev(x0, y0), chebyshev(x1, y1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const consider = (t: number): void => {
    if (t <= 0 || t >= 1) return;
    best = Math.min(best, chebyshev(x0 + dx * t, y0 + dy * t));
  };
  if (dx !== 0) consider(-x0 / dx);
  if (dy !== 0) consider(-y0 / dy);
  if (dx !== dy) consider((y0 - x0) / (dx - dy));
  if (dx !== -dy) consider((-y0 - x0) / (dx + dy));
  return best;
}

function intentLengthSquared(x: number, y: number): number {
  return x * x + y * y;
}

function squaredDistance(x0: number, y0: number, x1: number, y1: number): number {
  const dx = x0 - x1;
  const dy = y0 - y1;
  return dx * dx + dy * dy;
}

function copyPoint(target: { x: number; y: number }, source: { x: number; y: number }): void {
  target.x = source.x;
  target.y = source.y;
}
