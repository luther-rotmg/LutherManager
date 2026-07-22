import { config } from './config';
import { ConditionEffectBits } from 'realmlib';

export interface MovementSnapshot {
  playerSpeed: number;
  playerSpeedBoost: number;
  localPos: { x: number; y: number };
  serverPos?: { x: number; y: number };
  condition?: number;
  tileSpeed?: number;
}

export interface MoveTarget {
  x: number;
  y: number;
  threshold: number;
}

export interface MovementUpdate {
  pos: { x: number; y: number };
  reached?: { x: number; y: number };
  stalled?: { distance: number };
}

export interface MovementVelocity {
  x: number;
  y: number;
}

export interface MovementUpdateOptions {
  /** Integrate from locally predicted movement instead of the last server position. */
  integrateFromLocal?: boolean;
  /** Instantly replaces local position; the client reports it in its next normal MOVE. */
  positionOverride?: { x: number; y: number };
  /** Temporarily replaces navigation velocity without changing its target. */
  velocityOverride?: MovementVelocity;
  /** Continue target-progress stall detection while applying the override. */
  trackTargetProgress?: boolean;
}

const SPEED_MIN = 0.004;
const SPEED_MAX = 0.0096;

/** Owns movement target state and local dead-reckoning between server ticks. */
export class MovementController {
  private target: MoveTarget | undefined;
  private bestDist = Infinity;
  private stallMs = 0;
  private stallWarned = false;

  setTarget(target: { x: number; y: number }, threshold = config.arriveThreshold): void {
    this.target = { x: target.x, y: target.y, threshold };
    this.bestDist = Infinity;
    this.stallMs = 0;
    this.stallWarned = false;
  }

  clear(): void {
    this.target = undefined;
    this.bestDist = Infinity;
    this.stallMs = 0;
    this.stallWarned = false;
  }

  hasTarget(): boolean {
    return this.target !== undefined;
  }

  /** Current navigation target for diagnostics and control-panel visualisation. */
  getTarget(): MoveTarget | undefined {
    return this.target ? { ...this.target } : undefined;
  }

  update(snapshot: MovementSnapshot, dt: number, options: MovementUpdateOptions = {}): MovementUpdate {
    if (!this.target && !options.velocityOverride && !options.positionOverride) {
      return { pos: snapshot.localPos };
    }
    const pos = options.positionOverride
      ? { ...options.positionOverride }
      : options.velocityOverride
        ? this.stepWithVelocity(snapshot, dt, options.velocityOverride, !!options.integrateFromLocal)
        : this.stepToward(snapshot, dt, !!options.integrateFromLocal);
    if (!this.target) return { pos };
    const stalled = (options.velocityOverride || options.positionOverride) && !options.trackTargetProgress
      ? undefined
      : this.detectStall(snapshot.serverPos, dt);
    const confirmedPos = snapshot.serverPos ?? pos;
    if (Math.sqrt((this.target.x - confirmedPos.x) * (this.target.x - confirmedPos.x) + (this.target.y - confirmedPos.y) * (this.target.y - confirmedPos.y)) < this.target.threshold) {
      const reached = { x: this.target.x, y: this.target.y };
      this.clear();
      return { pos, reached, stalled };
    }
    return { pos, stalled };
  }

  getIntendedVelocity(snapshot: MovementSnapshot, integrateFromLocal = false): MovementVelocity {
    if (!this.target) return { x: 0, y: 0 };
    const base = integrateFromLocal ? snapshot.localPos : snapshot.serverPos ?? snapshot.localPos;
    const dx = this.target.x - base.x;
    const dy = this.target.y - base.y;
    const distance = Math.sqrt((dx) * (dx) + (dy) * (dy));
    if (distance === 0) return { x: 0, y: 0 };
    const speed = movementSpeed(snapshot);
    return { x: dx / distance * speed, y: dy / distance * speed };
  }

  private stepToward(
    snapshot: MovementSnapshot,
    dt: number,
    integrateFromLocal: boolean,
  ): { x: number; y: number } {
    const target = this.target!;
    const base = integrateFromLocal ? snapshot.localPos : snapshot.serverPos ?? snapshot.localPos;
    const step = movementSpeed(snapshot) * dt;
    const dx = target.x - base.x;
    const dy = target.y - base.y;
    const dist = Math.sqrt((dx) * (dx) + (dy) * (dy));
    if (dist <= step || dist === 0) {
      return { x: target.x, y: target.y };
    }
    return { x: base.x + (dx / dist) * step, y: base.y + (dy / dist) * step };
  }

  private stepWithVelocity(
    snapshot: MovementSnapshot,
    dt: number,
    velocity: MovementVelocity,
    integrateFromLocal: boolean,
  ): { x: number; y: number } {
    const base = integrateFromLocal ? snapshot.localPos : snapshot.serverPos ?? snapshot.localPos;
    return { x: base.x + velocity.x * dt, y: base.y + velocity.y * dt };
  }

  private detectStall(serverPos: { x: number; y: number } | undefined, dt: number): { distance: number } | undefined {
    if (!this.target || !serverPos) {
      return undefined;
    }
    const serverDist = Math.sqrt((this.target.x - serverPos.x) * (this.target.x - serverPos.x) + (this.target.y - serverPos.y) * (this.target.y - serverPos.y));
    if (serverDist < this.bestDist - 0.1) {
      this.bestDist = serverDist;
      this.stallMs = 0;
      this.stallWarned = false;
      return undefined;
    }
    this.stallMs += dt;
    if (this.stallMs > 3000 && !this.stallWarned) {
      this.stallWarned = true;
      return { distance: serverDist };
    }
    return undefined;
  }
}

export function movementSpeed(snapshot: MovementSnapshot): number {
  const tileMultiplier = Math.min(1, Math.max(0, snapshot.tileSpeed ?? 1));
  if (((snapshot.condition ?? 0) & ConditionEffectBits.SLOWED) !== 0) {
    return SPEED_MIN * tileMultiplier;
  }
  const speedStat = snapshot.playerSpeed + snapshot.playerSpeedBoost;
  let speed = SPEED_MIN + (speedStat / 75) * (SPEED_MAX - SPEED_MIN);
  if (((snapshot.condition ?? 0) & (ConditionEffectBits.SPEEDY | ConditionEffectBits.NINJA_SPEEDY)) !== 0) {
    speed *= 1.5;
  }
  return speed * tileMultiplier;
}
