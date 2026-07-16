import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '../src/client';
import {
  ExplorativePathfinder,
  MAX_LOCAL_GOAL_DISTANCE,
  PathfindingDataProvider,
} from '../src/explorative-pathfinder';
import { MovementController } from '../src/movement-controller';

const BLOCKING_GROUND = 9;
const DAMAGING_GROUND = 10;
const BLOCKING_OBJECT = 100;
const NON_BLOCKING_ENEMY = 101;

const data: PathfindingDataProvider = {
  getObject: (type) => type === BLOCKING_OBJECT
    ? { occupySquare: true }
    : type === NON_BLOCKING_ENEMY
      ? { occupySquare: false, isEnemy: true, hasProjectiles: true }
      : undefined,
  tileIsBlockingWalk: (type) => type === BLOCKING_GROUND,
  getTileDamage: (type) => type === DAMAGING_GROUND ? 100 : undefined,
};

test('unknown cells are traversable at the same cost as observed walkable cells', () => {
  const pathfinder = createPathfinder(30, 30);
  assert.equal(pathfinder.setTarget({ x: 20.5, y: 20.5 }, 0.2), true);

  const initial = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(initial.replanned, true);
  assert.equal(initial.noPath, undefined);
  assert.ok(initial.waypoint);
  assert.ok(Math.hypot(initial.waypoint.x - 0.5, initial.waypoint.y - 0.5)
    <= MAX_LOCAL_GOAL_DISTANCE);
  assert.deepEqual(pathfinder.getRemainingPath().at(-1), { x: 20.5, y: 20.5 });

  pathfinder.observeTile(1, 1, 1);
  const knownWalkable = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(knownWalkable.replanned, false);
  assert.deepEqual(knownWalkable.waypoint, initial.waypoint);

  pathfinder.observeTile(5, 5, BLOCKING_GROUND);
  const newlyBlocked = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(newlyBlocked.replanned, true);
  assert.equal(hasTile(pathfinder, 5, 5), false);
});

test('open stair-step routes are vectorized into bounded direct movement segments', () => {
  const pathfinder = createPathfinder(12, 10);
  const target = { x: 8.5, y: 5.5 };
  pathfinder.setTarget(target, 0.2);

  const initial = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(initial.replanned, true);
  assert.ok(initial.waypoint);
  const waypoints = pathfinder.getRemainingPath();
  assert.ok(waypoints.length > 1);
  assert.deepEqual(waypoints.at(-1), target);
  assertBoundedSegments({ x: 0.5, y: 0.5 }, waypoints);
  assert.equal(hasTile(pathfinder, 1, 0), false);

  // The direct vector crosses this cell even though the original A* staircase does not.
  const continued = pathfinder.next({ x: 1.1, y: 0.9 });
  assert.equal(continued.replanned, false);
  assert.deepEqual(continued.waypoint, initial.waypoint);

  // A dodge onto the old staircase, but outside the vector corridor, must replan.
  assert.equal(hasTile(pathfinder, 3, 3), true);
  const deviated = pathfinder.next({ x: 3.5, y: 3.5 });
  assert.equal(deviated.replanned, true);
});

test('refreshing an unchanged target preserves the active plan', () => {
  const pathfinder = createPathfinder(30, 30);
  const target = { x: 20.5, y: 20.5 };
  pathfinder.setTarget(target, 0.2);

  const initial = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(initial.replanned, true);
  assert.equal(pathfinder.setTarget(target, 0.2), true);

  const refreshed = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(refreshed.replanned, false);
  assert.deepEqual(refreshed.waypoint, initial.waypoint);
});

test('known blocking ground is routed around without diagonal corner cutting', () => {
  const pathfinder = createPathfinder(8, 8);
  const blocked = new Set<string>();
  for (let y = 0; y <= 4; y++) {
    pathfinder.observeTile(3, y, BLOCKING_GROUND);
    blocked.add(`${3},${y}`);
  }
  pathfinder.setTarget({ x: 6.5, y: 1.5 }, 0.2);

  const step = pathfinder.next({ x: 1.5, y: 1.5 });
  assert.equal(step.noPath, undefined);
  const tiles = pathfinder.getPlannedTiles();
  assert.ok(tiles.some((tile) => tile.y >= 5));
  assert.ok(tiles.every((tile) => !blocked.has(`${tile.x},${tile.y}`)));
  const vectors = pathfinder.getRemainingPath();
  assert.ok(vectors.length > 1);
  assert.ok(vectors.length < tiles.length);
  assert.notDeepEqual(vectors[0], { x: 6.5, y: 1.5 });

  let previous = { x: 1, y: 1 };
  for (const tile of tiles) {
    const dx = tile.x - previous.x;
    const dy = tile.y - previous.y;
    if (dx !== 0 && dy !== 0) {
      assert.equal(blocked.has(`${previous.x + dx},${previous.y}`), false);
      assert.equal(blocked.has(`${previous.x},${previous.y + dy}`), false);
    }
    previous = tile;
  }
});

test('vectorization preserves the no-corner-cutting rule', () => {
  const pathfinder = createPathfinder(5, 5);
  pathfinder.observeTile(1, 0, BLOCKING_GROUND);
  const target = { x: 2.5, y: 2.5 };
  pathfinder.setTarget(target, 0.2);

  const step = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(step.noPath, undefined);
  assert.notDeepEqual(step.waypoint, target);
  assert.ok(pathfinder.getRemainingPath().length > 1);
});

test('stall learning follows vector cells instead of the original A* staircase', () => {
  const pathfinder = createPathfinder(12, 10);
  pathfinder.setTarget({ x: 8.5, y: 5.5 }, 0.2);
  pathfinder.next({ x: 0.5, y: 0.5 });

  assert.deepEqual(pathfinder.reportStall({ x: 0.5, y: 0.5 }), { x: 1, y: 0 });
  const replanned = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(replanned.replanned, true);
  assert.equal(hasTile(pathfinder, 1, 0), false);
});

test('pathfinder tracks logical intent separately from route rebuilds', () => {
  const pathfinder = createPathfinder(30, 30);
  assert.equal(pathfinder.setTarget({ x: 20.5, y: 20.5 }, 0.2, 'room:1'), true);
  assert.deepEqual(pathfinder.getIntentRevisions(), { logicalRevision: 1, routeRevision: 0 });

  pathfinder.next({ x: 0.5, y: 0.5 });
  assert.deepEqual(pathfinder.getIntentRevisions(), { logicalRevision: 1, routeRevision: 1 });

  assert.equal(pathfinder.setTarget({ x: 20.7, y: 20.5 }, 0.2, 'room:1'), true);
  pathfinder.next({ x: 0.5, y: 0.5 });
  assert.deepEqual(pathfinder.getIntentRevisions(), { logicalRevision: 1, routeRevision: 1 });

  assert.equal(pathfinder.setTarget({ x: 20.7, y: 20.5 }, 0.2, 'room:2'), true);
  pathfinder.next({ x: 0.5, y: 0.5 });
  assert.deepEqual(pathfinder.getIntentRevisions(), { logicalRevision: 2, routeRevision: 1 });
});

test('combat target observations do not change logical identity', () => {
  const pathfinder = createPathfinder(30, 30);
  const range = { minimumDistance: 2.5, preferredDistance: 3, maximumDistance: 3.5 };
  assert.equal(pathfinder.setCombatTarget({ x: 20, y: 20 }, range, 42), true);
  pathfinder.next({ x: 0.5, y: 0.5 });
  const initial = pathfinder.getIntentRevisions();

  assert.equal(pathfinder.setCombatTarget({ x: 21, y: 20 }, range, 42), true);
  pathfinder.next({ x: 0.5, y: 0.5 });
  const moved = pathfinder.getIntentRevisions();
  assert.equal(moved.logicalRevision, initial.logicalRevision);
  assert.equal(moved.routeRevision, initial.routeRevision + 1);

  assert.equal(pathfinder.setCombatTarget({ x: 21, y: 20 }, range, 43), true);
  assert.equal(pathfinder.getIntentRevisions().logicalRevision, initial.logicalRevision + 1);
});

test('navigation waits for finite map bounds instead of reporting a false no-path result', () => {
  const pathfinder = new ExplorativePathfinder(data);
  assert.equal(pathfinder.setTarget({ x: 8.5, y: 1.5 }, 0.2), true);

  const pending = pathfinder.next({ x: 0.5, y: 1.5 });
  assert.equal(pending.noPath, undefined);
  assert.equal(pending.waypoint, undefined);
  assert.equal(pathfinder.hasTarget(), true);

  pathfinder.setMapBounds(10, 3);
  const planned = pathfinder.next({ x: 0.5, y: 1.5 });
  assert.ok(planned.waypoint);
  assert.equal(planned.noPath, undefined);
});

test('no path is reported only after the bounded reachable graph is exhausted', () => {
  const pathfinder = createPathfinder(7, 5);
  for (let y = 0; y < 5; y++) pathfinder.observeTile(3, y, BLOCKING_GROUND);
  pathfinder.setTarget({ x: 5.5, y: 2.5 }, 0.2);

  const result = pathfinder.next({ x: 1.5, y: 2.5 });
  assert.equal(result.noPath, true);
  assert.equal(result.replanned, true);
  assert.equal(pathfinder.hasTarget(), true);
});

test('combat pathfinding stops in the preferred weapon-range band', () => {
  const pathfinder = createPathfinder(16, 10);
  const target = { x: 10.5, y: 5.5 };
  const range = { minimumDistance: 3.35, preferredDistance: 3.75, maximumDistance: 4.15 };
  pathfinder.upsertObject(70, NON_BLOCKING_ENEMY, target.x, target.y);
  assert.equal(pathfinder.setCombatTarget(target, range), true);

  const step = pathfinder.next({ x: 0.5, y: 5.5 });
  assert.equal(step.noPath, undefined);
  assert.notDeepEqual(step.waypoint, target);
  const endpoint = pathfinder.getRemainingPath().at(-1)!;
  const endpointDistance = Math.hypot(endpoint.x - target.x, endpoint.y - target.y);
  assert.ok(endpointDistance >= range.minimumDistance);
  assert.ok(endpointDistance <= range.maximumDistance);

  const holding = pathfinder.next(endpoint);
  assert.equal(holding.waypoint, undefined);
  assert.equal(holding.reached, undefined);
  assert.equal(pathfinder.hasTarget(), true);
});

test('combat pathfinding retreats out of the exclusion radius', () => {
  const pathfinder = createPathfinder(12, 8);
  const target = { x: 6.5, y: 3.5 };
  const range = { minimumDistance: 2.5, preferredDistance: 3, maximumDistance: 3.5 };
  pathfinder.upsertObject(70, NON_BLOCKING_ENEMY, target.x, target.y);
  pathfinder.setCombatTarget(target, range);

  const start = { x: 5.5, y: 3.5 };
  const step = pathfinder.next(start);
  assert.ok(step.waypoint);
  assert.ok(Math.hypot(step.waypoint.x - target.x, step.waypoint.y - target.y)
    > Math.hypot(start.x - target.x, start.y - target.y));
  let previousDistance = Math.hypot(start.x - target.x, start.y - target.y);
  for (const tile of pathfinder.getPlannedTiles()) {
    const tileDistance = Math.hypot(tile.x + 0.5 - target.x, tile.y + 0.5 - target.y);
    assert.ok(tileDistance > previousDistance);
    previousDistance = tileDistance;
  }
  assert.ok(previousDistance >= range.minimumDistance);
});

test('combat pathfinding routes and vectorizes around other nearby enemies', () => {
  const pathfinder = createPathfinder(16, 8);
  const target = { x: 11.5, y: 3.5 };
  const blockingEnemy = { x: 5.5, y: 3.5 };
  pathfinder.upsertObject(70, NON_BLOCKING_ENEMY, target.x, target.y);
  pathfinder.upsertObject(71, NON_BLOCKING_ENEMY, blockingEnemy.x, blockingEnemy.y);
  pathfinder.setCombatTarget(target, {
    minimumDistance: 3.25,
    preferredDistance: 3.75,
    maximumDistance: 4.25,
  });

  pathfinder.next({ x: 0.5, y: 3.5 });
  assert.ok(pathfinder.getPlannedTiles().some((tile) => tile.y !== 3));
  assert.ok(pathfinder.getPlannedTiles().every((tile) =>
    Math.hypot(tile.x + 0.5 - blockingEnemy.x, tile.y + 0.5 - blockingEnemy.y) >= 1));

  let previous = { x: 0.5, y: 3.5 };
  for (const waypoint of pathfinder.getRemainingPath()) {
    assert.ok(segmentDistance(blockingEnemy, previous, waypoint) >= 1 - 1e-9);
    previous = waypoint;
  }
});

test('observed damaging ground is treated as blocked pathfinding terrain', () => {
  const pathfinder = createPathfinder(10, 5);
  pathfinder.observeTile(4, 2, DAMAGING_GROUND);
  pathfinder.setTarget({ x: 8.5, y: 2.5 }, 0.2);

  const step = pathfinder.next({ x: 1.5, y: 2.5 });
  assert.equal(step.noPath, undefined);
  assert.notDeepEqual(step.waypoint, { x: 8.5, y: 2.5 });
  assert.equal(hasTile(pathfinder, 4, 2), false);
  assert.ok(pathfinder.getPlannedTiles().some((tile) => tile.y !== 2));
});

test('OccupySquare objects block one cell and removing them permits a shorter route', () => {
  const pathfinder = createPathfinder(10, 5);
  pathfinder.upsertObject(50, BLOCKING_OBJECT, 3.5, 2.5);
  pathfinder.upsertObject(51, NON_BLOCKING_ENEMY, 4.5, 2.5);
  pathfinder.setTarget({ x: 7.5, y: 2.5 }, 0.2);

  const blocked = pathfinder.next({ x: 1.5, y: 2.5 });
  assert.notDeepEqual(blocked.waypoint, { x: 7.5, y: 2.5 });
  assert.equal(hasTile(pathfinder, 3, 2), false);

  pathfinder.removeObject(50);
  const replanned = pathfinder.next({ x: 1.5, y: 2.5 });
  assert.equal(replanned.replanned, true);
  assert.ok(replanned.waypoint);
  assert.ok(Math.hypot(replanned.waypoint.x - 1.5, replanned.waypoint.y - 2.5)
    <= MAX_LOCAL_GOAL_DISTANCE);
  assert.deepEqual(pathfinder.getRemainingPath().at(-1), { x: 7.5, y: 2.5 });
  assert.equal(hasTile(pathfinder, 3, 2), true);
  assert.equal(hasTile(pathfinder, 4, 2), true);
});

test('a blocked destination stops at its nearest reachable neighboring cell', () => {
  const pathfinder = createPathfinder(10, 10);
  const target = { x: 5.5, y: 5.5 };
  pathfinder.upsertObject(50, BLOCKING_OBJECT, target.x, target.y);
  pathfinder.setTarget(target, 0.2);

  const first = pathfinder.next({ x: 1.5, y: 5.5 });
  assert.ok(first.waypoint);
  const tiles = pathfinder.getPlannedTiles();
  assert.equal(tiles.some((tile) => tile.x === 5 && tile.y === 5), false);
  const endpoint = pathfinder.getRemainingPath().at(-1)!;
  assert.equal(Math.max(Math.abs(endpoint.x - target.x), Math.abs(endpoint.y - target.y)), 1);

  const arrived = pathfinder.next(endpoint);
  assert.deepEqual(arrived.reached, target);
  assert.equal(pathfinder.hasTarget(), false);
});

test('an authoritative stall learns the next unknown route cell as blocked', () => {
  const pathfinder = createPathfinder(10, 3);
  pathfinder.setTarget({ x: 8.5, y: 1.5 }, 0.2);
  pathfinder.next({ x: 0.5, y: 1.5 });
  assert.equal(hasTile(pathfinder, 1, 1), true);

  assert.deepEqual(pathfinder.reportStall({ x: 0.5, y: 1.5 }), { x: 1, y: 1 });
  const replanned = pathfinder.next({ x: 0.5, y: 1.5 });
  assert.equal(replanned.replanned, true);
  assert.equal(hasTile(pathfinder, 1, 1), false);
});

test('map reset clears learned terrain, objects, and navigation state', () => {
  const pathfinder = createPathfinder(10, 3);
  pathfinder.observeTile(3, 1, BLOCKING_GROUND);
  pathfinder.upsertObject(50, BLOCKING_OBJECT, 4.5, 1.5);
  pathfinder.setTarget({ x: 8.5, y: 1.5 }, 0.2);
  pathfinder.next({ x: 0.5, y: 1.5 });
  assert.equal(hasTile(pathfinder, 3, 1), false);
  assert.equal(pathfinder.hasTarget(), true);

  pathfinder.resetMap();
  pathfinder.setMapBounds(10, 3);
  assert.equal(pathfinder.hasTarget(), false);
  pathfinder.setTarget({ x: 8.5, y: 1.5 }, 0.2);
  pathfinder.next({ x: 0.5, y: 1.5 });
  assert.equal(hasTile(pathfinder, 3, 1), true);
  assert.equal(hasTile(pathfinder, 4, 1), true);
});

test('Client keeps direct walking separate from pathfinding walking', () => {
  const client = new Client({
    alias: 'movement-mode-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
  });
  const state = client as unknown as {
    movement: MovementController;
    pathfinder: ExplorativePathfinder;
  };

  assert.equal(client.moveTo({ x: 8.5, y: 2.5 }), true);
  assert.equal(state.movement.hasTarget(), true);
  assert.equal(state.pathfinder.hasTarget(), false);

  assert.equal(client.pathfindingWalkTo({ x: 8.5, y: 2.5 }), true);
  assert.equal(state.movement.hasTarget(), false);
  assert.equal(state.pathfinder.hasTarget(), true);

  assert.equal(client.combatPathfindingWalkTo(
    { x: 8.5, y: 2.5 },
    { minimumDistance: 2.5, preferredDistance: 3, maximumDistance: 3.5 },
  ), true);
  assert.equal(state.pathfinder.hasTarget(), true);

  client.stopMoving();
  assert.equal(client.isMoving(), false);
});

test('Client combined navigation enables dodge and never gives it a goal farther than five tiles', () => {
  const client = new Client({
    alias: 'bounded-dodge-goal-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
    combatData: {
      getObject: () => undefined,
      getProjectile: () => undefined,
    },
  });
  const state = client as unknown as {
    pos: { x: number; y: number };
    serverPos: { x: number; y: number };
    player: { spd: number; spdBoost: number; condition: number; condition2: number };
    pathfinder: ExplorativePathfinder;
    updateTarget(dt: number, integrateFromLocal?: boolean, now?: number): void;
  };
  const start = { x: 0.5, y: 0.5 };
  Object.assign(state, {
    pos: { ...start },
    serverPos: { ...start },
    player: { spd: 75, spdBoost: 0, condition: 0, condition2: 0 },
  });
  state.pathfinder.setMapBounds(30, 3);

  assert.equal(client.navigateTo({ x: 20.5, y: 0.5 }), true);
  assert.equal(client.isAutoDodgeEnabled(), true);
  assert.deepEqual(client.getDodgeMovementIntent(), {
    mode: 'goal',
    goalX: 20.5,
    goalY: 0.5,
    arriveThreshold: 0.5,
  });
  state.updateTarget(16, false, 1000);

  const dodge = client.getAutoDodgeState();
  assert.equal(dodge?.decision, 'goal_path');
  assert.ok(dodge?.goal);
  assert.ok(Math.hypot(dodge.goal.x - start.x, dodge.goal.y - start.y)
    <= MAX_LOCAL_GOAL_DISTANCE + 1e-9);

  assert.equal(client.navigateToCombatTarget(
    { x: 20.5, y: 0.5 },
    { minimumDistance: 2.5, preferredDistance: 3, maximumDistance: 3.5 },
  ), true);
  assert.deepEqual(client.getDodgeMovementIntent(), {
    mode: 'combat_range',
    targetId: 0,
    targetX: 20.5,
    targetY: 0.5,
    hardMinimumRange: 1.3,
    preferredMinimumRange: 2.5,
    preferredMaximumRange: 3.5,
  });
});

test('Client clears a selected combat intent when its target disappears', () => {
  const client = new Client({
    alias: 'missing-combat-target-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
    combatData: {
      getObject: () => undefined,
      getProjectile: () => undefined,
    },
  });
  const state = client as unknown as {
    pos: { x: number; y: number };
    serverPos: { x: number; y: number };
    player: { spd: number; spdBoost: number; condition: number; condition2: number };
    pathfinder: ExplorativePathfinder;
    updateTarget(dt: number, integrateFromLocal?: boolean, now?: number): void;
  };
  Object.assign(state, {
    pos: { x: 0.5, y: 0.5 },
    serverPos: { x: 0.5, y: 0.5 },
    player: { spd: 75, spdBoost: 0, condition: 0, condition2: 0 },
  });
  state.pathfinder.setMapBounds(30, 3);

  assert.equal(client.navigateToCombatTarget(
    { x: 20.5, y: 0.5 },
    { minimumDistance: 2.5, preferredDistance: 3, maximumDistance: 3.5 },
    { targetId: 42 },
  ), true);
  state.updateTarget(16, false, 1000);

  assert.equal(client.getDodgeMovementIntent(), null);
  assert.equal(client.isMoving(), false);
  const dodge = client.getAutoDodgeState();
  assert.ok(Number.isFinite(dodge?.velocity.x));
  assert.ok(Number.isFinite(dodge?.velocity.y));
  assert.deepEqual(dodge?.velocity, { x: 0, y: 0 });
});

test('Client pathfinding refresh preserves the active waypoint stall state', () => {
  const client = new Client({
    alias: 'pathfinding-refresh-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
  });
  const state = client as unknown as {
    movement: MovementController;
    pathfinder: ExplorativePathfinder;
  };
  const target = { x: 8.5, y: 2.5 };
  const waypoint = { x: 4.5, y: 2.5 };

  assert.equal(client.pathfindingWalkTo(target), true);
  state.movement.setTarget(waypoint, 0.25);
  assert.equal(client.pathfindingWalkTo(target), true);
  assert.deepEqual(state.movement.getTarget(), { ...waypoint, threshold: 0.25 });

  assert.equal(client.pathfindingWalkTo({ x: 8.75, y: 2.5 }), true);
  assert.deepEqual(state.movement.getTarget(), { ...waypoint, threshold: 0.25 });
});

test('repeated script refreshes still allow an authoritative stall to replan', () => {
  const client = new Client({
    alias: 'pathfinding-stall-test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: 'localhost',
  });
  const state = client as unknown as {
    pos: { x: number; y: number };
    serverPos: { x: number; y: number };
    player: { spd: number; spdBoost: number; condition: number; condition2: number };
    pathfinder: ExplorativePathfinder;
    updateTarget(dt: number, integrateFromLocal?: boolean, now?: number): void;
  };
  const start = { x: 0.5, y: 1.5 };
  const target = { x: 8.5, y: 1.5 };
  Object.assign(state, {
    pos: { ...start },
    serverPos: { ...start },
    player: { spd: 75, spdBoost: 0, condition: 0, condition2: 0 },
  });
  state.pathfinder.setMapBounds(10, 3);

  for (let refresh = 0; refresh < 5; refresh++) {
    assert.equal(client.pathfindingWalkTo(target, 0.2), true);
    state.updateTarget(1000, false, 1000 + refresh * 1000);
  }

  const replanned = state.pathfinder.next(start);
  assert.equal(replanned.replanned, true);
  assert.equal(hasTile(state.pathfinder, 1, 1), false);
  assert.ok(state.pathfinder.getPlannedTiles().some((tile) => tile.y !== 1));
});

function createPathfinder(width: number, height: number): ExplorativePathfinder {
  const pathfinder = new ExplorativePathfinder(data);
  pathfinder.setMapBounds(width, height);
  return pathfinder;
}

function hasTile(pathfinder: ExplorativePathfinder, x: number, y: number): boolean {
  return pathfinder.getPlannedTiles().some((tile) => tile.x === x && tile.y === y);
}

function assertBoundedSegments(
  start: { x: number; y: number },
  waypoints: Array<{ x: number; y: number }>,
): void {
  let previous = start;
  for (const waypoint of waypoints) {
    assert.ok(
      Math.hypot(waypoint.x - previous.x, waypoint.y - previous.y)
        <= MAX_LOCAL_GOAL_DISTANCE + 1e-9,
    );
    previous = waypoint;
  }
}

function segmentDistance(point: { x: number; y: number }, from: { x: number; y: number }, to: { x: number; y: number }): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - from.x, point.y - from.y);
  const projection = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (from.x + dx * projection), point.y - (from.y + dy * projection));
}
