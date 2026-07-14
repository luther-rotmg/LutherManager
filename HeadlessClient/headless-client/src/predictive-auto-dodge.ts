import {
  isProjectileAliveAt,
  predictProjectilePosition,
  type CombatProjectileSnapshot,
} from './combat-tracker';

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
  threatCount: number;
  earliestImpactMs: number | null;
  selectedCandidate: number;
  speedScale: number;
  decision: string;
}

const DIRECTION_COUNT = 32;
const INTENT_CANDIDATE = DIRECTION_COUNT + 1;
const CANDIDATE_COUNT = DIRECTION_COUNT + 2;
const SAMPLE_MS = 30;
const HORIZON_MS = 600;
const HIT_HALF_SIZE = 0.5;
const RELEVANCE_CLEARANCE = 1;
const INTENT_SAFE_CLEARANCE = 0.08;
const EMERGENCY_INTENT_BAND = 0.14;
const UNAVOIDABLE_IMPACT_BAND_MS = 60;
const UNAVOIDABLE_CLEARANCE_BAND = 0.05;
const EMERGENCY_OVERRIDE_MS = 100;
const HYSTERESIS_MS = 100;
const HYSTERESIS_SCORE_GAIN = 0.25;
const CORRIDOR_NEIGHBORS = 3;
const MAX_TIME = 0x7fffffff;

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
  private readonly candidateValid = new Uint8Array(CANDIDATE_COUNT);
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
    this.state = emptyState(this.enabled);
  }

  getState(): AutoDodgeState {
    return {
      ...this.state,
      velocity: { ...this.state.velocity },
      target: this.state.target ? { ...this.state.target } : null,
    };
  }

  evaluate(snapshot: AutoDodgeSnapshot): AutoDodgeState {
    if (!this.enabled) {
      this.state = emptyState(false, snapshot.intentVelocity);
      return this.state;
    }

    this.resetFrame();
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
      for (let offset = 0; offset <= HORIZON_MS; offset += SAMPLE_MS) {
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
          const previousMovementOffset = snapshot.movementLeadMs + offset - SAMPLE_MS;
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

    if (directProjectileThreats === 0 && !directAoeThreat) {
      return this.finish(snapshot, snapshot.intentVelocity.x, snapshot.intentVelocity.y,
        false, 0, 1, 0, MAX_TIME, 'no_threat');
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
      for (let offset = 0; offset <= HORIZON_MS; offset += SAMPLE_MS) {
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
            const previousMovementOffset = snapshot.movementLeadMs + offset - SAMPLE_MS;
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
            impactOffset = offset - SAMPLE_MS;
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

    let proposedCandidate = 0;
    if (threatCount > 0) {
      let bestScore = this.candidateScore[0];
      let bestImpact = this.candidateImpactMs[0];
      let bestCorridor = this.corridorSafety(0);
      let bestEnemyClearance = this.candidateEnemyClearance[0];
      const intentX = this.candidateX[INTENT_CANDIDATE];
      const intentY = this.candidateY[INTENT_CANDIDATE];
      let bestIntentDot = this.candidateX[0] * intentX + this.candidateY[0] * intentY;
      for (let candidate = 1; candidate <= DIRECTION_COUNT; candidate++) {
        if (!this.candidateValid[candidate]) continue;
        const impact = this.candidateImpactMs[candidate];
        const corridor = this.corridorSafety(candidate);
        const score = this.candidateScore[candidate];
        const enemyClearance = this.candidateEnemyClearance[candidate];
        const intentDot = this.candidateX[candidate] * intentX
          + this.candidateY[candidate] * intentY;
        if (impact > bestImpact
          || impact === bestImpact && corridor > bestCorridor
          || impact === bestImpact && corridor === bestCorridor && score > bestScore
          || impact === bestImpact && corridor === bestCorridor && score === bestScore
            && enemyClearance > bestEnemyClearance
          || impact === bestImpact && corridor === bestCorridor && score === bestScore
            && enemyClearance === bestEnemyClearance && intentDot > bestIntentDot) {
          bestScore = this.candidateScore[candidate];
          bestImpact = this.candidateImpactMs[candidate];
          bestCorridor = corridor;
          bestEnemyClearance = enemyClearance;
          bestIntentDot = intentDot;
          proposedCandidate = candidate;
        }
      }
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
    if (threatCount === 0 || snapshot.moveSpeed <= 0 || snapshot.movementLocked) {
      if (snapshot.time >= this.selectedUntil) this.selectedCandidate = 0;
      return this.finish(snapshot, snapshot.intentVelocity.x, snapshot.intentVelocity.y,
        false, this.selectedCandidate, 1, threatCount, earliestImpactMs,
        threatCount === 0 ? 'no_threat' : 'movement_locked');
    }
    const intendedScore = this.candidateScore[INTENT_CANDIDATE];
    if (intendedScore >= INTENT_SAFE_CLEARANCE) {
      return this.finish(snapshot, snapshot.intentVelocity.x, snapshot.intentVelocity.y,
        false, this.selectedCandidate, 1, threatCount, earliestImpactMs,
        'preserve_safe_intent');
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

  private validateCandidatePaths(snapshot: AutoDodgeSnapshot): void {
    for (let candidate = 1; candidate < CANDIDATE_COUNT; candidate++) {
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
        // Enemy proximity is scored separately so it can never veto the only safe escape.
        if (snapshot.environment.canOccupy(x, y, this.safeWalk, false)) continue;
        this.candidateBlockMs[candidate] = offset;
        this.candidateImpactMs[candidate] = offset;
        if (offset === 0) this.candidateValid[candidate] = 0;
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
      for (let offset = 0; offset <= HORIZON_MS; offset += SAMPLE_MS) {
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
          const previousMovementOffset = snapshot.movementLeadMs + offset - SAMPLE_MS;
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
      this.candidateValid[index] = 1;
    }
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
  ): AutoDodgeState {
    this.state = {
      enabled: this.enabled,
      overrideActive,
      velocity: { x: velocityX, y: velocityY },
      target: overrideActive ? {
        x: snapshot.position.x + velocityX * snapshot.movementLeadMs,
        y: snapshot.position.y + velocityY * snapshot.movementLeadMs,
      } : null,
      threatCount,
      earliestImpactMs: earliestImpactMs === MAX_TIME ? null : earliestImpactMs,
      selectedCandidate,
      speedScale,
      decision,
    };
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
    threatCount: 0,
    earliestImpactMs: null,
    selectedCandidate: 0,
    speedScale: 1,
    decision: 'none',
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
