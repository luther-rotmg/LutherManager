import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDilatedFullOccupyTiles,
  buildDilatedObstacleTiles,
  chebyshevDistancePointToTile,
  formatTileKey,
  FULL_OCCUPY_INFLATION_CLEARANCE,
  FULL_OCCUPY_NEIGHBOR_THRESHOLD,
  INFLATED_PLAYER_RADIUS,
  INFLATION_DIRTY_REGION_RADIUS,
  isBlockedByFullOccupyInflation,
  isBlockedByObstacleInflation,
  updateDilatedObstacleDirtyRegion,
} from '../src/inflated-passability';

test('Chebyshev point-to-tile distance matches axis-aligned squares', () => {
  assert.equal(chebyshevDistancePointToTile(4.5, 2.5, 5, 2), 0.5);
  assert.equal(chebyshevDistancePointToTile(3.5, 2.5, 5, 2), 1.5);
  assert.equal(chebyshevDistancePointToTile(4.5, 4.5, 4, 4), 0);
});

test('clearance equals the canOccupyAt 0.5 neighbor window threshold', () => {
  assert.equal(FULL_OCCUPY_INFLATION_CLEARANCE, FULL_OCCUPY_NEIGHBOR_THRESHOLD);
  assert.equal(FULL_OCCUPY_NEIGHBOR_THRESHOLD, 0.5);
  assert.equal(INFLATED_PLAYER_RADIUS, 0.5);
});

test('obstacle inflation uses playerRadius Chebyshev margin', () => {
  const obstacles = new Set([formatTileKey(5, 2)]);
  assert.equal(isBlockedByObstacleInflation(4.5, 2.5, obstacles), true);
  assert.equal(isBlockedByObstacleInflation(3.5, 2.5, obstacles), false);
});

test('fullOccupy inflation allows the source tile but blocks neighbors within combined radius', () => {
  const fullOccupy = new Set([formatTileKey(4, 4)]);
  assert.equal(isBlockedByFullOccupyInflation(4.5, 4.5, fullOccupy), false);
  assert.equal(isBlockedByFullOccupyInflation(3.75, 4.5, fullOccupy), true);
  assert.equal(isBlockedByFullOccupyInflation(2.5, 4.5, fullOccupy), false);
});

test('dirty region radius equals max obstacle and fullOccupy inflation', () => {
  assert.equal(INFLATION_DIRTY_REGION_RADIUS, 1.0);
});

test('buildDilatedObstacleTiles matches per-point obstacle inflation at tile centers', () => {
  const obstacles = new Set([formatTileKey(5, 2), formatTileKey(6, 6)]);
  const dilated = buildDilatedObstacleTiles(obstacles, 8, 8);
  assert.equal(dilated.has(formatTileKey(4, 2)), true);
  assert.equal(dilated.has(formatTileKey(3, 2)), false);
  assert.equal(dilated.has(formatTileKey(5, 2)), true);
  assert.equal(dilated.has(formatTileKey(5, 5)), true);
  assert.equal(dilated.has(formatTileKey(4, 5)), false);
});

test('updateDilatedObstacleDirtyRegion matches full rebuild after learned block add', () => {
  const baseObstacles = new Set([formatTileKey(5, 2)]);
  const full = buildDilatedObstacleTiles(baseObstacles, 8, 8);

  const incrementalObstacles = new Set(baseObstacles);
  incrementalObstacles.add(formatTileKey(6, 6));
  const incremental = new Set(full);
  updateDilatedObstacleDirtyRegion(incremental, incrementalObstacles, 6, 6, 8, 8);

  const rebuilt = buildDilatedObstacleTiles(incrementalObstacles, 8, 8);
  assert.deepEqual(incremental, rebuilt);

  const secondBlock = new Set(incrementalObstacles);
  secondBlock.add(formatTileKey(1, 1));
  updateDilatedObstacleDirtyRegion(incremental, secondBlock, 1, 1, 8, 8);
  assert.deepEqual(incremental, buildDilatedObstacleTiles(secondBlock, 8, 8));
});

test('buildDilatedFullOccupyTiles matches per-point fullOccupy inflation at tile centers', () => {
  const fullOccupy = new Set([formatTileKey(4, 4)]);
  const dilated = buildDilatedFullOccupyTiles(fullOccupy, 8, 8);
  assert.equal(dilated.has(formatTileKey(4, 4)), false, 'source tile center stays open');
  assert.equal(dilated.has(formatTileKey(3, 4)), true);
  assert.equal(dilated.has(formatTileKey(2, 4)), false);
});
