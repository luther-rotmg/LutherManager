/**
 * Commit 5.1 — Chebyshev morphological dilation for unified static passability.
 *
 * playerRadius matches DODGE_HITBOX_HALF_SIZE (1.0×1.0 player hitbox half-extent).
 * clearance reproduces the inlined 0.5 fractional neighbor window in canOccupyAt().
 */

/** Half-extent of the 1.0×1.0 player hitbox; aligned with DODGE_HITBOX_HALF_SIZE. */
export const INFLATED_PLAYER_RADIUS = 0.5;

/**
 * Fractional threshold from canOccupyAt() neighbor window (static-passability-store.ts).
 * When fracX < threshold the left neighbor is checked; when fracX > threshold the right.
 */
export const FULL_OCCUPY_NEIGHBOR_THRESHOLD = 0.5;

/** Extra fullOccupy margin beyond playerRadius — same constant as the neighbor window. */
export const FULL_OCCUPY_INFLATION_CLEARANCE = FULL_OCCUPY_NEIGHBOR_THRESHOLD;

/**
 * Chebyshev tile radius for dirty-region learned-block updates.
 * max(obstacle radius 0.5, fullOccupy radius 1.0) = 1.0 cells.
 */
export const INFLATION_DIRTY_REGION_RADIUS = Math.max(
  INFLATED_PLAYER_RADIUS,
  INFLATED_PLAYER_RADIUS + FULL_OCCUPY_INFLATION_CLEARANCE,
);

/**
 * Packed 32-bit tile-key for Set<number> membership queries.
 * Assumes integer tileX, tileY in [-0x8000, 0x8000). Matches dodge-collision-world.ts
 * + static-passability-store.ts's tileKey encoding so keys are interchangeable across
 * modules. P9 audit item tileKey-template-string-per-sample.
 */
export function formatTileKey(tileX: number, tileY: number): number {
  return ((tileX + 0x8000) << 16) | ((tileY + 0x8000) & 0xffff);
}

function parseTileKey(key: number): { x: number; y: number } {
  return {
    x: (key >>> 16) - 0x8000,
    y: (key & 0xffff) - 0x8000,
  };
}

/** Chebyshev distance from a world point to an axis-aligned unit tile square. */
export function chebyshevDistancePointToTile(
  px: number,
  py: number,
  tileX: number,
  tileY: number,
): number {
  const dx = Math.max(tileX - px, 0, px - (tileX + 1));
  const dy = Math.max(tileY - py, 0, py - (tileY + 1));
  return Math.max(dx, dy);
}

export function isBlockedByObstacleInflation(
  px: number,
  py: number,
  obstacleTiles: ReadonlySet<number>,
  radius = INFLATED_PLAYER_RADIUS,
): boolean {
  for (const key of obstacleTiles) {
    const { x, y } = parseTileKey(key);
    if (chebyshevDistancePointToTile(px, py, x, y) <= radius) return true;
  }
  return false;
}

/**
 * fullOccupy tiles remain occupiable when the player center lies on the same tile;
 * adjacent positions within playerRadius + clearance are rejected.
 */
export function isBlockedByFullOccupyInflation(
  px: number,
  py: number,
  fullOccupyTiles: ReadonlySet<number>,
  playerRadius = INFLATED_PLAYER_RADIUS,
  clearance = FULL_OCCUPY_INFLATION_CLEARANCE,
): boolean {
  const inflationRadius = playerRadius + clearance;
  for (const key of fullOccupyTiles) {
    const { x, y } = parseTileKey(key);
    if (px >= x && px < x + 1 && py >= y && py < y + 1) continue;
    if (chebyshevDistancePointToTile(px, py, x, y) <= inflationRadius) return true;
  }
  return false;
}

export function isBlockedByInflatedPassability(
  px: number,
  py: number,
  obstacleTiles: ReadonlySet<number>,
  fullOccupyTiles: ReadonlySet<number>,
): boolean {
  return isBlockedByObstacleInflation(px, py, obstacleTiles)
    || isBlockedByFullOccupyInflation(px, py, fullOccupyTiles);
}

function inGridBounds(
  tileX: number,
  tileY: number,
  width: number,
  height: number,
): boolean {
  return tileX >= 0 && tileY >= 0
    && (width === 0 || tileX < width)
    && (height === 0 || tileY < height);
}

/** Integer tiles whose centers are obstacle-inflated blocked (Step 5.2). */
export function buildDilatedObstacleTiles(
  obstacleSources: ReadonlySet<number>,
  width: number,
  height: number,
): Set<number> {
  const dilated = new Set<number>();
  if (width <= 0 || height <= 0) return dilated;
  for (let tileY = 0; tileY < height; tileY++) {
    for (let tileX = 0; tileX < width; tileX++) {
      if (isBlockedByObstacleInflation(tileX + 0.5, tileY + 0.5, obstacleSources)) {
        dilated.add(formatTileKey(tileX, tileY));
      }
    }
  }
  return dilated;
}

/** Integer tiles whose centers are fullOccupy-inflated blocked (Step 5.2). */
export function buildDilatedFullOccupyTiles(
  fullOccupySources: ReadonlySet<number>,
  width: number,
  height: number,
): Set<number> {
  const dilated = new Set<number>();
  if (width <= 0 || height <= 0) return dilated;
  for (let tileY = 0; tileY < height; tileY++) {
    for (let tileX = 0; tileX < width; tileX++) {
      if (isBlockedByFullOccupyInflation(tileX + 0.5, tileY + 0.5, fullOccupySources)) {
        dilated.add(formatTileKey(tileX, tileY));
      }
    }
  }
  return dilated;
}

/**
 * Recompute dilated obstacle cells in the dirty region around a newly learned block.
 * Only cells within INFLATION_DIRTY_REGION_RADIUS Chebyshev tiles are touched.
 */
export function updateDilatedObstacleDirtyRegion(
  dilated: Set<number>,
  obstacleSources: ReadonlySet<number>,
  originTileX: number,
  originTileY: number,
  width: number,
  height: number,
): void {
  const radius = Math.ceil(INFLATION_DIRTY_REGION_RADIUS);
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tileX = originTileX + dx;
      const tileY = originTileY + dy;
      if (!inGridBounds(tileX, tileY, width, height)) continue;
      const key = formatTileKey(tileX, tileY);
      if (isBlockedByObstacleInflation(tileX + 0.5, tileY + 0.5, obstacleSources)) {
        dilated.add(key);
      } else {
        dilated.delete(key);
      }
    }
  }
}
