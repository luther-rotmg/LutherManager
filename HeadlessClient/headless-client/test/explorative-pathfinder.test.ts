import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '../src/client';
import { ExplorativePathfinder, PathfindingDataProvider } from '../src/explorative-pathfinder';
import { MovementController } from '../src/movement-controller';

const BLOCKING_GROUND = 9;
const DAMAGING_GROUND = 10;
const BLOCKING_OBJECT = 100;
const NON_BLOCKING_ENEMY = 101;

const data: PathfindingDataProvider = {
  getObject: (type) => type === BLOCKING_OBJECT
    ? { occupySquare: true }
    : type === NON_BLOCKING_ENEMY ? { occupySquare: false } : undefined,
  tileIsBlockingWalk: (type) => type === BLOCKING_GROUND,
  getTileDamage: (type) => type === DAMAGING_GROUND ? 100 : undefined,
};

test('unknown cells are traversable at the same cost as observed walkable cells', () => {
  const pathfinder = createPathfinder(30, 30);
  assert.equal(pathfinder.setTarget({ x: 20.5, y: 20.5 }, 0.2), true);

  const initial = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(initial.replanned, true);
  assert.equal(initial.noPath, undefined);
  assert.deepEqual(initial.waypoint, { x: 20.5, y: 20.5 });

  pathfinder.observeTile(1, 1, 1);
  const knownWalkable = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(knownWalkable.replanned, false);
  assert.deepEqual(knownWalkable.waypoint, initial.waypoint);

  pathfinder.observeTile(5, 5, BLOCKING_GROUND);
  const newlyBlocked = pathfinder.next({ x: 0.5, y: 0.5 });
  assert.equal(newlyBlocked.replanned, true);
  assert.equal(hasTile(pathfinder, 5, 5), false);
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

test('observed damaging ground is treated as blocked pathfinding terrain', () => {
  const pathfinder = createPathfinder(10, 5);
  pathfinder.observeTile(4, 2, DAMAGING_GROUND);
  pathfinder.setTarget({ x: 8.5, y: 2.5 }, 0.2);

  const step = pathfinder.next({ x: 1.5, y: 2.5 });
  assert.equal(step.noPath, undefined);
  assert.equal(hasTile(pathfinder, 4, 2), false);
  assert.ok(pathfinder.getPlannedTiles().some((tile) => tile.y !== 2));
});

test('OccupySquare objects block one cell and removing them permits a shorter route', () => {
  const pathfinder = createPathfinder(10, 5);
  pathfinder.upsertObject(50, BLOCKING_OBJECT, 3.5, 2.5);
  pathfinder.upsertObject(51, NON_BLOCKING_ENEMY, 4.5, 2.5);
  pathfinder.setTarget({ x: 7.5, y: 2.5 }, 0.2);

  pathfinder.next({ x: 1.5, y: 2.5 });
  assert.equal(hasTile(pathfinder, 3, 2), false);

  pathfinder.removeObject(50);
  const replanned = pathfinder.next({ x: 1.5, y: 2.5 });
  assert.equal(replanned.replanned, true);
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

  pathfinder.reportStall({ x: 0.5, y: 1.5 });
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

  client.stopMoving();
  assert.equal(client.isMoving(), false);
});

function createPathfinder(width: number, height: number): ExplorativePathfinder {
  const pathfinder = new ExplorativePathfinder(data);
  pathfinder.setMapBounds(width, height);
  return pathfinder;
}

function hasTile(pathfinder: ExplorativePathfinder, x: number, y: number): boolean {
  return pathfinder.getPlannedTiles().some((tile) => tile.x === x && tile.y === y);
}
