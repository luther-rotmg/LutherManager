import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ExplorativePathfinder,
  NAVIGATION_PATH_SEARCH_BUDGET,
  SYNC_PATH_SEARCH_BUDGET,
} from '../src/explorative-pathfinder';
import { runIncrementalPathSearch, runSyncPathSearch } from '../src/path-search-adapters';

const BLOCKING_GROUND = 9;

function createPathfinder(width: number, height: number): ExplorativePathfinder {
  const pathfinder = new ExplorativePathfinder({
    getObject: () => undefined,
    tileIsBlockingWalk: (type) => type === BLOCKING_GROUND,
  });
  pathfinder.setMapBounds(width, height);
  return pathfinder;
}

function activeExpansionCount(pathfinder: ExplorativePathfinder): number {
  const active = (pathfinder as unknown as {
    activePathSearch?: { search: { getExpansionCount(): number } };
  }).activePathSearch;
  return active?.search.getExpansionCount() ?? 0;
}

test('runIncrementalPathSearch begins with a live searching handle', () => {
  const pathfinder = createPathfinder(20, 20);
  const start = { x: 0, y: 0 };
  const goal = { x: 12, y: 0 };

  const handle = runIncrementalPathSearch(pathfinder, start, [goal]);

  assert.equal(handle.status(), 'searching');
  assert.equal(handle.getPath(), undefined);
  assert.ok(activeExpansionCount(pathfinder) >= 0);
});

test('runIncrementalPathSearch step with small budget yields searching', () => {
  const pathfinder = createPathfinder(20, 20);
  const start = { x: 0, y: 0 };
  const goal = { x: 12, y: 0 };
  const smallBudget = { maxNodes: 4, maxMs: Number.POSITIVE_INFINITY };

  const handle = runIncrementalPathSearch(pathfinder, start, [goal]);

  assert.equal(handle.step(smallBudget), 'searching');
  assert.equal(handle.status(), 'searching');
  assert.ok(activeExpansionCount(pathfinder) >= 4);
});

test('runIncrementalPathSearch steps to found when the goal is reachable', () => {
  const pathfinder = createPathfinder(20, 20);
  const start = { x: 0, y: 0 };
  const goal = { x: 8, y: 0 };

  const handle = runIncrementalPathSearch(pathfinder, start, [goal]);

  while (handle.status() === 'searching') {
    handle.step(SYNC_PATH_SEARCH_BUDGET);
  }

  assert.equal(handle.status(), 'found');
  assert.deepEqual(handle.getPath()?.at(-1), goal);
  assert.equal(activeExpansionCount(pathfinder), 0);
});

test('runIncrementalPathSearch steps to no_path when the goal is unreachable', () => {
  const pathfinder = createPathfinder(7, 5);
  const start = { x: 0, y: 2 };
  const goal = { x: 6, y: 2 };

  for (let y = 0; y < 5; y++) {
    pathfinder.observeTile(3, y, BLOCKING_GROUND);
  }

  const handle = runIncrementalPathSearch(pathfinder, start, [goal]);

  while (handle.status() === 'searching') {
    handle.step(SYNC_PATH_SEARCH_BUDGET);
  }

  assert.equal(handle.status(), 'no_path');
  assert.equal(handle.getPath(), undefined);
  assert.equal(activeExpansionCount(pathfinder), 0);
});

test('runIncrementalPathSearch resumes when goal and mapVersion are unchanged', () => {
  const pathfinder = createPathfinder(20, 20);
  const start = { x: 0, y: 0 };
  const goal = { x: 12, y: 0 };
  const smallBudget = { maxNodes: 4, maxMs: Number.POSITIVE_INFINITY };

  const first = runIncrementalPathSearch(pathfinder, start, [goal]);
  assert.equal(first.step(smallBudget), 'searching');
  const afterFirstSlice = activeExpansionCount(pathfinder);

  const resumed = runIncrementalPathSearch(pathfinder, start, [goal]);
  assert.equal(resumed.step(smallBudget), 'searching');
  assert.ok(activeExpansionCount(pathfinder) > afterFirstSlice);

  while (resumed.status() === 'searching') {
    resumed.step(NAVIGATION_PATH_SEARCH_BUDGET);
  }
  assert.equal(resumed.status(), 'found');
  assert.deepEqual(resumed.getPath()?.at(-1), goal);
});

test('runSyncPathSearch returns found with a terminal handle', () => {
  const pathfinder = createPathfinder(20, 20);
  const start = { x: 0, y: 0 };
  const goal = { x: 8, y: 0 };

  const handle = runSyncPathSearch(pathfinder, start, [goal]);

  assert.equal(handle.status(), 'found');
  assert.notEqual(handle.status(), 'searching');
  assert.deepEqual(handle.getPath()?.at(-1), goal);
  assert.equal(handle.step({ maxNodes: 1, maxMs: 1 }), 'found');
  assert.equal(activeExpansionCount(pathfinder), 0);
});

test('runSyncPathSearch returns no_path when the goal is unreachable', () => {
  const pathfinder = createPathfinder(7, 5);
  const start = { x: 0, y: 2 };
  const goal = { x: 6, y: 2 };

  for (let y = 0; y < 5; y++) {
    pathfinder.observeTile(3, y, BLOCKING_GROUND);
  }

  const handle = runSyncPathSearch(pathfinder, start, [goal]);

  assert.equal(handle.status(), 'no_path');
  assert.equal(handle.getPath(), undefined);
  assert.equal(handle.step({ maxNodes: 1, maxMs: 1 }), 'no_path');
  assert.equal(activeExpansionCount(pathfinder), 0);
});

test('runSyncPathSearch cancel is a no-op on a completed handle', () => {
  const pathfinder = createPathfinder(10, 10);
  const handle = runSyncPathSearch(pathfinder, { x: 0, y: 0 }, [{ x: 3, y: 0 }]);

  handle.cancel();
  assert.equal(handle.status(), 'found');
  assert.equal(activeExpansionCount(pathfinder), 0);
});
