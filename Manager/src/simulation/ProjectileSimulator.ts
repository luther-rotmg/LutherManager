import type { TrackedProjectile } from '../state/ProjectileTracker.js';

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Predicts projectile positions at any point in time.
 * Ported directly from the game client's Projectile.as positionAt() method.
 *
 * Supports all movement patterns:
 *  - Straight-line (default)
 *  - Wavy (angle oscillation)
 *  - Amplitude/Frequency (sinusoidal lateral offset)
 *  - Boomerang (reverses halfway through lifetime)
 *  - Parametric (figure-eight pattern)
 */
export class ProjectileSimulator {

  /**
   * Calculate the position of a projectile at a given elapsed time.
   * @param bullet - The tracked projectile (spawn data + projDef)
   * @param elapsedMs - Milliseconds since the bullet was fired
   * @returns Position {x, y} or null if bullet has expired
   */
  static positionAt(bullet: TrackedProjectile, elapsedMs: number): Vec2 | null {
    const def = bullet.projDef;
    if (!def) {
      // No game data: assume straight line, speed 5 tiles/sec, 10s lifetime.
      // 5 tiles/sec is a conservative middle-ground for unknown projectiles.
      return ProjectileSimulator.straightLine(
        bullet.startX,
        bullet.startY,
        bullet.angle,
        elapsedMs,
        5,   // tiles/sec — consistent with ProjectileTracker fallback
        10000,
        false,
      );
    }

    const lifetime = def.lifetimeMs;
    if (elapsedMs < 0 || elapsedMs > lifetime) return null;

    // Speed in the game is stored as raw value, actual tiles/ms = speed / 10000.
    const speed = def.speed / 10000;
    let distance = elapsedMs * speed;
    const phase = (bullet.bulletId % 2 === 0) ? 0 : Math.PI;

    let x = bullet.startX;
    let y = bullet.startY;

    if (def.wavy) {
      const period = 6 * Math.PI;
      const amplitude = Math.PI / 64;
      const effectiveAngle = bullet.angle +
        amplitude * Math.sin(phase + (period * elapsedMs) / 1000);
      x += distance * Math.cos(effectiveAngle);
      y += distance * Math.sin(effectiveAngle);
    } else if (def.parametric) {
      const t = ((elapsedMs / lifetime) * 2) * Math.PI;
      const sin1 = Math.sin(t) * ((bullet.bulletId % 2) ? 1 : -1);
      const sin2 = Math.sin(2 * t) * (((bullet.bulletId % 4) < 2) ? 1 : -1);
      const sinAngle = Math.sin(bullet.angle);
      const cosAngle = Math.cos(bullet.angle);
      const mag = def.magnitude || 1;
      x += (sin1 * cosAngle - sin2 * sinAngle) * mag;
      y += (sin1 * sinAngle + sin2 * cosAngle) * mag;
    } else {
      if (def.boomerang) {
        const halfDist = (lifetime * speed) / 2;
        if (distance > halfDist) {
          distance = halfDist - (distance - halfDist);
        }
      }

      x += distance * Math.cos(bullet.angle);
      y += distance * Math.sin(bullet.angle);

      if (def.amplitude !== 0) {
        const lateralOffset = def.amplitude * Math.sin(
          phase + ((elapsedMs / lifetime) * def.frequency * 2 * Math.PI),
        );
        x += lateralOffset * Math.cos(bullet.angle + Math.PI / 2);
        y += lateralOffset * Math.sin(bullet.angle + Math.PI / 2);
      }
    }

    return { x, y };
  }

  private static straightLine(
    startX: number,
    startY: number,
    angle: number,
    elapsedMs: number,
    speedTilesPerSec: number,
    lifetimeMs: number,
    boomerang: boolean,
  ): Vec2 | null {
    if (elapsedMs < 0 || elapsedMs > lifetimeMs) return null;

    let distance = (elapsedMs / 1000) * speedTilesPerSec;
    if (boomerang) {
      const halfDist = (lifetimeMs / 1000) * speedTilesPerSec / 2;
      if (distance > halfDist) {
        distance = halfDist - (distance - halfDist);
      }
    }

    return {
      x: startX + distance * Math.cos(angle),
      y: startY + distance * Math.sin(angle),
    };
  }

  static futurePositions(
    bullet: TrackedProjectile,
    nowMs: number,
    offsets: number[],
  ): { timeOffset: number; pos: Vec2 }[] {
    const results: { timeOffset: number; pos: Vec2 }[] = [];
    for (const offset of offsets) {
      const elapsed = (nowMs + offset) - bullet.spawnTime;
      const pos = ProjectileSimulator.positionAt(bullet, elapsed);
      if (pos) results.push({ timeOffset: offset, pos });
    }
    return results;
  }

  static closestApproach(
    bullet: TrackedProjectile,
    targetX: number,
    targetY: number,
    nowMs: number,
    horizonMs: number,
    sampleCount = 8,
  ): number {
    let minDist = Infinity;
    for (let i = 0; i <= sampleCount; i++) {
      const t = nowMs + (horizonMs * i) / sampleCount;
      const elapsed = t - bullet.spawnTime;
      const pos = ProjectileSimulator.positionAt(bullet, elapsed);
      if (!pos) continue;
      const dx = pos.x - targetX;
      const dy = pos.y - targetY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  }
}
