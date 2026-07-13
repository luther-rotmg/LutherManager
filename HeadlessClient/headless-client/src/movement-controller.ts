import { config } from './config';

export interface MovementSnapshot {
  playerSpeed: number;
  playerSpeedBoost: number;
  localPos: { x: number; y: number };
  serverPos?: { x: number; y: number };
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

  update(snapshot: MovementSnapshot, dt: number): MovementUpdate {
    if (!this.target) {
      return { pos: snapshot.localPos };
    }
    const pos = this.stepToward(snapshot, dt);
    const stalled = this.detectStall(snapshot.serverPos, dt);
    if (Math.hypot(this.target.x - pos.x, this.target.y - pos.y) < this.target.threshold) {
      const reached = { x: this.target.x, y: this.target.y };
      this.clear();
      return { pos, reached, stalled };
    }
    return { pos, stalled };
  }

  private stepToward(snapshot: MovementSnapshot, dt: number): { x: number; y: number } {
    const target = this.target!;
    const base = snapshot.serverPos ?? snapshot.localPos;
    const speed = snapshot.playerSpeed + snapshot.playerSpeedBoost;
    const step = (SPEED_MIN + (speed / 75) * (SPEED_MAX - SPEED_MIN)) * dt;
    const dx = target.x - base.x;
    const dy = target.y - base.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= step || dist === 0) {
      return { x: target.x, y: target.y };
    }
    return { x: base.x + (dx / dist) * step, y: base.y + (dy / dist) * step };
  }

  private detectStall(serverPos: { x: number; y: number } | undefined, dt: number): { distance: number } | undefined {
    if (!this.target || !serverPos) {
      return undefined;
    }
    const serverDist = Math.hypot(this.target.x - serverPos.x, this.target.y - serverPos.y);
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
