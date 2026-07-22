export type DodgeJumpStatus =
  | 'ready'
  | 'recovering'
  | 'awaiting_move'
  | 'awaiting_confirmation'
  | 'backoff';

export interface DodgeJumpLimiterState {
  allowance: number;
  learnedMaxDistance: number;
  availableDistance: number;
  status: DodgeJumpStatus;
  pendingDistance: number | null;
  backoffRemainingMs: number;
  lastOutcome: 'none' | 'confirmed' | 'corrected' | 'disconnect';
}

interface PendingJump {
  from: { x: number; y: number };
  target: { x: number; y: number };
  expected: { x: number; y: number };
  distance: number;
  queuedAt: number;
  sentAt?: number;
}

export const MIN_DODGE_JUMP_DISTANCE = 0.01;
export const MAX_DODGE_JUMP_DISTANCE = 1.5;
const INITIAL_MAX_DISTANCE = 1;
const DISTANCE_RECOVERY_PER_MS = 1 / 1000;
const MIN_JUMP_INTERVAL_MS = 750;
const CONFIRM_TOLERANCE = 0.35;
const CORRECTION_GRACE_MS = 350;
const CONFIRM_TIMEOUT_MS = 900;
const CORRECTION_BACKOFF_MS = 2500;
const DISCONNECT_BACKOFF_MS = 5000;
const RECENT_DISCONNECT_WINDOW_MS = 2000;
const LEARN_AFTER_CONFIRMATIONS = 2;
const LEARNED_DISTANCE_STEP = 0.1;

/**
 * Learns a conservative MOVE-position jump allowance from authoritative ticks.
 * Only one jump may be unconfirmed, and spent distance recovers over time.
 */
export class DodgeJumpLimiter {
  private learnedMaxDistance = INITIAL_MAX_DISTANCE;
  private availableDistance = INITIAL_MAX_DISTANCE;
  private lastUpdatedAt: number | undefined;
  private backoffUntil = 0;
  private pending: PendingJump | undefined;
  private consecutiveConfirmations = 0;
  private lastJumpAt = -Infinity;
  private lastPenalizedJumpAt = -Infinity;
  private lastJumpDistance = 0;
  private lastOutcome: DodgeJumpLimiterState['lastOutcome'] = 'none';
  private correctionRequiresRebase = false;

  getState(now: number, configuredMaxDistance = MAX_DODGE_JUMP_DISTANCE): DodgeJumpLimiterState {
    this.refresh(now);
    const maximum = clampJumpDistance(configuredMaxDistance);
    const intervalReady = now - this.lastJumpAt >= MIN_JUMP_INTERVAL_MS;
    const allowance = this.pending || now < this.backoffUntil || !intervalReady
      ? 0
      : Math.min(maximum, this.learnedMaxDistance, this.availableDistance);
    let status: DodgeJumpStatus;
    if (this.pending?.sentAt !== undefined) status = 'awaiting_confirmation';
    else if (this.pending) status = 'awaiting_move';
    else if (now < this.backoffUntil) status = 'backoff';
    else if (!intervalReady
      || allowance < Math.min(maximum, this.learnedMaxDistance)) status = 'recovering';
    else status = 'ready';
    return {
      allowance: allowance >= MIN_DODGE_JUMP_DISTANCE ? allowance : 0,
      learnedMaxDistance: this.learnedMaxDistance,
      availableDistance: this.availableDistance,
      status,
      pendingDistance: this.pending?.distance ?? null,
      backoffRemainingMs: Math.max(0, this.backoffUntil - now),
      lastOutcome: this.lastOutcome,
    };
  }

  commit(
    now: number,
    from: { x: number; y: number },
    target: { x: number; y: number },
    configuredMaxDistance = MAX_DODGE_JUMP_DISTANCE,
  ): boolean {
    const distance = Math.sqrt((target.x - from.x) * (target.x - from.x) + (target.y - from.y) * (target.y - from.y));
    const allowance = this.getState(now, configuredMaxDistance).allowance;
    if (!Number.isFinite(distance)
      || distance < MIN_DODGE_JUMP_DISTANCE
      || distance > allowance + 1e-9) return false;
    this.availableDistance = Math.max(0, this.availableDistance - distance);
    this.pending = {
      from: { ...from },
      target: { ...target },
      expected: { ...target },
      distance,
      queuedAt: now,
    };
    this.lastJumpAt = now;
    this.lastJumpDistance = distance;
    return true;
  }

  /** Marks the first normal MOVE record containing the jumped local position. */
  markSent(now: number, position: { x: number; y: number }): void {
    if (!this.pending || this.pending.sentAt !== undefined) return;
    this.pending.sentAt = now;
    this.pending.expected = { ...position };
  }

  observeAuthoritative(now: number, position: { x: number; y: number }): void {
    this.refresh(now);
    const pending = this.pending;
    if (pending?.sentAt === undefined) return;
    if (distance(position, pending.expected) <= CONFIRM_TOLERANCE) {
      this.confirmPending();
      return;
    }
    const elapsed = now - pending.sentAt;
    const remainsNearOrigin = distance(position, pending.from) + CONFIRM_TOLERANCE
      < distance(position, pending.expected);
    if (elapsed >= CONFIRM_TIMEOUT_MS
      || elapsed >= CORRECTION_GRACE_MS && remainsNearOrigin) {
      this.rejectPending(now, 'corrected', CORRECTION_BACKOFF_MS, 0.8);
    }
  }

  /** Penalizes a recent jump when the connection closes before it is trusted. */
  noteDisconnect(now: number): boolean {
    this.refresh(now);
    if (now - this.lastJumpAt > RECENT_DISCONNECT_WINDOW_MS
      || this.lastJumpAt <= this.lastPenalizedJumpAt) return false;
    const distance = this.pending?.distance ?? this.lastJumpDistance;
    this.reduceLearnedMaximum(distance, 0.65);
    this.pending = undefined;
    this.availableDistance = 0;
    this.backoffUntil = Math.max(this.backoffUntil, now + DISCONNECT_BACKOFF_MS);
    this.consecutiveConfirmations = 0;
    this.lastOutcome = 'disconnect';
    this.lastPenalizedJumpAt = this.lastJumpAt;
    return true;
  }

  resetMap(now: number): void {
    this.refresh(now);
    this.pending = undefined;
    this.availableDistance = Math.min(this.availableDistance, this.learnedMaxDistance);
    this.correctionRequiresRebase = false;
  }

  consumeCorrectionRebase(): boolean {
    const required = this.correctionRequiresRebase;
    this.correctionRequiresRebase = false;
    return required;
  }

  private refresh(now: number): void {
    if (!Number.isFinite(now)) return;
    if (this.lastUpdatedAt === undefined) {
      this.lastUpdatedAt = now;
    } else if (now > this.lastUpdatedAt) {
      this.availableDistance = Math.min(
        this.learnedMaxDistance,
        this.availableDistance + (now - this.lastUpdatedAt) * DISTANCE_RECOVERY_PER_MS,
      );
      this.lastUpdatedAt = now;
    }
  }

  private confirmPending(): void {
    this.pending = undefined;
    this.lastOutcome = 'confirmed';
    this.consecutiveConfirmations++;
    if (this.consecutiveConfirmations < LEARN_AFTER_CONFIRMATIONS) return;
    this.consecutiveConfirmations = 0;
    this.learnedMaxDistance = Math.min(
      MAX_DODGE_JUMP_DISTANCE,
      this.learnedMaxDistance + LEARNED_DISTANCE_STEP,
    );
  }

  private rejectPending(
    now: number,
    outcome: 'corrected' | 'disconnect',
    backoffMs: number,
    scale: number,
  ): void {
    const distance = this.pending?.distance ?? this.lastJumpDistance;
    this.reduceLearnedMaximum(distance, scale);
    this.pending = undefined;
    this.availableDistance = 0;
    this.backoffUntil = Math.max(this.backoffUntil, now + backoffMs);
    this.consecutiveConfirmations = 0;
    this.lastOutcome = outcome;
    this.lastPenalizedJumpAt = this.lastJumpAt;
    if (outcome === 'corrected') this.correctionRequiresRebase = true;
  }

  private reduceLearnedMaximum(distance: number, scale: number): void {
    const reduced = Math.max(MIN_DODGE_JUMP_DISTANCE, distance * scale);
    this.learnedMaxDistance = Math.min(this.learnedMaxDistance, reduced);
  }
}

function clampJumpDistance(value: number): number {
  if (!Number.isFinite(value)) return MAX_DODGE_JUMP_DISTANCE;
  return Math.min(MAX_DODGE_JUMP_DISTANCE, Math.max(MIN_DODGE_JUMP_DISTANCE, value));
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}
