import type { TrackedProjectile } from '../state/ProjectileTracker.js';
import { ProjectileSimulator, type Vec2 } from './ProjectileSimulator.js';

export interface Threat {
  bullet: TrackedProjectile;
  /** Closest distance the bullet will get to the player. */
  closestDist: number;
  /** Position of the bullet at its closest approach. */
  closestPos: Vec2;
  /** Time offset (ms from now) of closest approach. */
  closestTimeOffset: number;
}

export interface DodgeVector {
  /** Normalized direction to move (unit vector). */
  x: number;
  y: number;
  /** How urgent the dodge is (0–1). Higher = closer threat. */
  urgency: number;
}

/**
 * Analyzes active projectiles and determines:
 * 1. Which projectiles are threats (will pass near the player)
 * 2. The best direction to dodge
 *
 * Uses ProjectileSimulator to predict bullet positions over a
 * time horizon (default 600ms ≈ 3 game ticks).
 */
export class ThreatAssessor {
  /** How far ahead to look for threats (ms). */
  private horizonMs: number;
  /** Distance threshold — bullets closer than this are threats. */
  private threatRadius: number;
  /** Number of sample points along each trajectory. */
  private sampleCount: number;
  /** Number of candidate directions to evaluate for dodging. */
  private directionCount: number;

  constructor(options?: {
    horizonMs?: number;
    threatRadius?: number;
    sampleCount?: number;
    directionCount?: number;
  }) {
    this.horizonMs = options?.horizonMs ?? 600;
    this.threatRadius = options?.threatRadius ?? 1.0;
    this.sampleCount = options?.sampleCount ?? 10;
    this.directionCount = options?.directionCount ?? 16;
  }

  /**
   * Find all projectiles that threaten the player's current position.
   */
  findThreats(
    playerPos: Vec2,
    projectiles: TrackedProjectile[],
    nowMs: number,
  ): Threat[] {
    const threats: Threat[] = [];

    for (const bullet of projectiles) {
      // Quick reject: if bullet spawn is very far away, skip detailed check
      const spawnDx = bullet.startX - playerPos.x;
      const spawnDy = bullet.startY - playerPos.y;
      const spawnDist = Math.sqrt(spawnDx * spawnDx + spawnDy * spawnDy);
      // Max possible range: speed * lifetime. For unknown, cap at 20 tiles.
      // Note: speed is tiles/ms (rawSpeed/10000), so multiply by lifetimeMs directly.
      const maxRange = bullet.projDef
        ? (bullet.projDef.speed / 10000) * bullet.projDef.lifetimeMs
        : 20;
      if (spawnDist > maxRange + this.threatRadius + 5) continue;

      // Sample the bullet's trajectory over the horizon
      let closestDist = Infinity;
      let closestPos: Vec2 = { x: 0, y: 0 };
      let closestTimeOffset = 0;

      for (let i = 0; i <= this.sampleCount; i++) {
        const timeOffset = (this.horizonMs * i) / this.sampleCount;
        const elapsed = (nowMs + timeOffset) - bullet.spawnTime;
        const pos = ProjectileSimulator.positionAt(bullet, elapsed);
        if (!pos) continue;

        const dx = pos.x - playerPos.x;
        const dy = pos.y - playerPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < closestDist) {
          closestDist = dist;
          closestPos = pos;
          closestTimeOffset = timeOffset;
        }
      }

      if (closestDist <= this.threatRadius) {
        threats.push({ bullet, closestDist, closestPos, closestTimeOffset });
      }
    }

    // Sort by closest first (most dangerous)
    threats.sort((a, b) => a.closestDist - b.closestDist);
    return threats;
  }

  /**
   * Calculate the best dodge direction given a set of threats.
   * Evaluates candidate directions and picks the one that maximizes
   * minimum distance from all threatening projectiles.
   *
   * @param playerPos - Current player position
   * @param threats - Active threats from findThreats()
   * @param projectiles - All active projectiles (for evaluating candidate positions)
   * @param nowMs - Current time
   * @param moveSpeed - Player move speed in tiles/tick (from player speed stat)
   * @returns Best dodge vector, or null if no threats
   */
  calculateDodge(
    playerPos: Vec2,
    threats: Threat[],
    projectiles: TrackedProjectile[],
    nowMs: number,
    moveSpeed: number,
  ): DodgeVector | null {
    if (threats.length === 0) return null;

    // How far the player can move in one tick (~200ms)
    const moveDistPerTick = moveSpeed;

    let bestDir: Vec2 | null = null;
    let bestScore = -Infinity;

    // Evaluate candidate directions evenly spaced around the player
    for (let i = 0; i < this.directionCount; i++) {
      const angle = (2 * Math.PI * i) / this.directionCount;
      const candidateX = playerPos.x + Math.cos(angle) * moveDistPerTick;
      const candidateY = playerPos.y + Math.sin(angle) * moveDistPerTick;

      // Score = minimum distance from any threat at candidate position
      // over the horizon. Higher is better (farther from all bullets).
      let minDist = Infinity;

      for (const bullet of projectiles) {
        // Only check bullets that are actually threats or nearby
        const elapsed = nowMs - bullet.spawnTime;
        const lifetime = bullet.projDef?.lifetimeMs ?? 10000;
        if (elapsed > lifetime) continue;

        // Check multiple sample points along the bullet trajectory
        // for the next ~400ms (2 ticks) from the candidate position
        for (let s = 0; s <= 4; s++) {
          const futureOffset = (400 * s) / 4;
          const futureElapsed = elapsed + futureOffset;
          const pos = ProjectileSimulator.positionAt(bullet, futureElapsed);
          if (!pos) continue;

          const dx = pos.x - candidateX;
          const dy = pos.y - candidateY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < minDist) minDist = dist;
        }
      }

      if (minDist > bestScore) {
        bestScore = minDist;
        bestDir = { x: Math.cos(angle), y: Math.sin(angle) };
      }
    }

    if (!bestDir) return null;

    // Also consider staying still — if it's already the safest option
    let stayMinDist = Infinity;
    for (const threat of threats) {
      if (threat.closestDist < stayMinDist) {
        stayMinDist = threat.closestDist;
      }
    }

    // Only dodge if moving is actually better than staying
    if (bestScore <= stayMinDist + 0.1) return null;

    // Urgency based on how close the nearest threat is
    const nearestDist = threats[0].closestDist;
    const urgency = Math.max(0, Math.min(1,
      1 - (nearestDist / this.threatRadius),
    ));

    return { x: bestDir.x, y: bestDir.y, urgency };
  }

  setHorizonMs(ms: number): void {
    this.horizonMs = ms;
  }

  setThreatRadius(r: number): void {
    this.threatRadius = r;
  }
}
