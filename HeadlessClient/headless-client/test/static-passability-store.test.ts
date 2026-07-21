import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DodgeCollisionWorld } from '../src/dodge-collision-world';
import { ExplorativePathfinder } from '../src/explorative-pathfinder';
import { createStaticPassabilityStore, StaticPassabilityStoreImpl } from '../src/static-passability-store';
import {
  formatTileKey,
  FULL_OCCUPY_INFLATION_CLEARANCE,
  INFLATED_PLAYER_RADIUS,
} from '../src/inflated-passability';
import type { StaticPassabilityDataProvider } from '../src/static-passability-model';
import { GOLDEN_PATHFINDING_CASES } from './fixtures/golden-pathfinding-cases';
import {
  applyPathfindingMapFixture,
  createPathfindingTestData,
  PATHFINDING_MAP_OBJECTS,
  PATHFINDING_MAP_TERRAIN,
  type PathfindingMapFixture,
} from './helpers/pathfinding-map-generator';

const testData: StaticPassabilityDataProvider = createPathfindingTestData();

type PathfinderBlockedProbe = {
  isBlocked(x: number, y: number, start?: { x: number; y: number }): boolean;
};

function pathfinderIsBlocked(
  pathfinder: ExplorativePathfinder,
  x: number,
  y: number,
  start?: { x: number; y: number },
): boolean {
  return (pathfinder as unknown as PathfinderBlockedProbe).isBlocked(x, y, start);
}

function applyFixtureToStore(
  store: ReturnType<typeof createStaticPassabilityStore>,
  fixture: PathfindingMapFixture,
): void {
  store.setMapBounds(fixture.width, fixture.height);
  for (const tile of fixture.tiles) {
    store.observeTile(tile.x, tile.y, tile.type);
  }
  for (const object of fixture.objects) {
    const profile = testData.getObject?.(object.type);
    if (!profile?.occupySquare && !profile?.fullOccupy) continue;
    store.upsertObject(object.id, object.type, object.x, object.y, profile);
  }
}

function assertPathfindingBlockedEquivalent(
  pathfinder: ExplorativePathfinder,
  store: ReturnType<typeof createStaticPassabilityStore>,
  start?: { x: number; y: number },
  label = 'tile grid',
): void {
  const width = store.getWidth();
  const height = store.getHeight();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const expected = pathfinderIsBlocked(pathfinder, x, y, start);
      const actual = store.isTileStaticallyBlocked(x, y, {
        consumer: 'pathfinding',
        exemptTile: start,
      });
      assert.equal(
        actual,
        expected,
        `${label} (${x},${y}) start=${start ? `${start.x},${start.y}` : 'none'}`,
      );
    }
  }
}

test('pathfinding tile blockage matches ExplorativePathfinder.isBlocked on golden fixtures', () => {
  for (const testCase of GOLDEN_PATHFINDING_CASES) {
    const pathfinder = new ExplorativePathfinder(createPathfindingTestData());
    const store = createStaticPassabilityStore(testData);
    applyPathfindingMapFixture(pathfinder, testCase.fixture);
    applyFixtureToStore(store, testCase.fixture);

    const start = {
      x: Math.floor(testCase.fixture.start.x),
      y: Math.floor(testCase.fixture.start.y),
    };
    assertPathfindingBlockedEquivalent(pathfinder, store, start, testCase.id);
    assertPathfindingBlockedEquivalent(pathfinder, store, undefined, `${testCase.id}-no-start`);
  }
});

test('pathfinding tile blockage tracks terrain, damaging floors, objects, and learned blocks', () => {
  const pathfinder = new ExplorativePathfinder(createPathfindingTestData());
  const store = createStaticPassabilityStore(testData);
  const start = { x: 2, y: 2 };

  pathfinder.setMapBounds(8, 8);
  store.setMapBounds(8, 8);

  pathfinder.observeTile(3, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  store.observeTile(3, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  assertPathfindingBlockedEquivalent(pathfinder, store, start, 'blocking terrain');

  pathfinder.observeTile(4, 2, PATHFINDING_MAP_TERRAIN.DAMAGING);
  store.observeTile(4, 2, PATHFINDING_MAP_TERRAIN.DAMAGING);
  assertPathfindingBlockedEquivalent(pathfinder, store, start, 'damaging terrain');

  pathfinder.upsertObject(1, PATHFINDING_MAP_OBJECTS.BLOCKING, 5.5, 2.5);
  store.upsertObject(1, PATHFINDING_MAP_OBJECTS.BLOCKING, 5.5, 2.5, { occupySquare: true });
  assertPathfindingBlockedEquivalent(pathfinder, store, start, 'blocking object');

  store.markLearnedBlocked(6, 2);
  pathfinder.getStaticPassabilityStore().markLearnedBlocked(6, 2);
  assert.equal(store.isTileStaticallyBlocked(6, 2, { consumer: 'pathfinding' }), true);
  assert.equal(pathfinderIsBlocked(pathfinder, 6, 2, start), true);

  assert.equal(store.isTileStaticallyBlocked(2, 2, { consumer: 'pathfinding', exemptTile: start }), false);
  assert.equal(pathfinderIsBlocked(pathfinder, 2, 2, start), false);
  assert.equal(store.isTileStaticallyBlocked(-1, 0, { consumer: 'pathfinding' }), true);
  assert.equal(pathfinderIsBlocked(pathfinder, -1, 0), true);
});

test('mutators bump revision when static geometry changes', () => {
  const store = createStaticPassabilityStore(testData);
  assert.equal(store.getRevision(), 0);

  store.reset();
  assert.equal(store.getRevision(), 1);

  store.setMapBounds(10, 10);
  assert.equal(store.getRevision(), 2);

  store.setMapBounds(10, 10);
  assert.equal(store.getRevision(), 2);

  store.observeTile(1, 1, PATHFINDING_MAP_TERRAIN.WALKABLE);
  assert.equal(store.getRevision(), 3);

  store.observeTile(1, 1, PATHFINDING_MAP_TERRAIN.WALKABLE);
  assert.equal(store.getRevision(), 3);

  store.observeTile(2, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  assert.equal(store.getRevision(), 4);

  assert.equal(store.markLearnedBlocked(3, 3), true);
  assert.equal(store.getRevision(), 5);
  assert.equal(store.markLearnedBlocked(3, 3), false);
  assert.equal(store.getRevision(), 5);

  store.setExplorativeUnknown(true);
  assert.equal(store.getRevision(), 6);
  store.setExplorativeUnknown(true);
  assert.equal(store.getRevision(), 6);

  store.upsertObject(1, PATHFINDING_MAP_OBJECTS.BLOCKING, 4.5, 4.5, { occupySquare: true });
  assert.equal(store.getRevision(), 7);

  store.upsertObject(1, PATHFINDING_MAP_OBJECTS.BLOCKING, 4.5, 4.5, { occupySquare: true });
  assert.equal(store.getRevision(), 7);

  store.removeObject(1);
  assert.equal(store.getRevision(), 8);
});

test('canOccupyAt matches DodgeCollisionWorld static occupancy for representative samples', () => {
  const dodgeData = {
    getObject: (type: number) => type === PATHFINDING_MAP_OBJECTS.BLOCKING
      ? { isEnemy: false, occupySquare: true }
      : undefined,
    getProjectile: () => undefined,
    tileIsBlockingWalk: (type: number) => type === PATHFINDING_MAP_TERRAIN.BLOCKING,
    getTileDamage: (type: number) => type === PATHFINDING_MAP_TERRAIN.DAMAGING ? 100 : 0,
  };
  const store = createStaticPassabilityStore(testData);
  const dodge = new DodgeCollisionWorld(dodgeData, store);

  dodge.setMapBounds(12, 12);
  dodge.observeTile(4, 4, PATHFINDING_MAP_TERRAIN.BLOCKING);
  dodge.observeTile(5, 5, PATHFINDING_MAP_TERRAIN.DAMAGING);
  dodge.upsertObject(1, PATHFINDING_MAP_OBJECTS.BLOCKING, 6.5, 6.5);
  dodge.markBlocked(7, 7);

  for (const safeWalk of [true, false]) {
    for (let y = 0; y < 12; y += 0.5) {
      for (let x = 0; x < 12; x += 0.5) {
        const expected = dodge.canOccupy(x, y, safeWalk, false);
        const actual = store.canOccupyAt(x, y, {
          consumer: 'dodge',
          safeWalk,
        });
        assert.equal(actual, expected, `(${x},${y}) safeWalk=${safeWalk}`);
      }
    }
  }
});

test('fullOccupy neighbors block fractional occupancy without blocking integer pathfinding tiles', () => {
  const store = createStaticPassabilityStore(testData);
  store.setMapBounds(8, 8);
  store.upsertObject(1, 999, 4.5, 4.5, { occupySquare: false, fullOccupy: true });

  assert.equal(
    store.isTileStaticallyBlocked(4, 4, { consumer: 'pathfinding' }),
    false,
    'fullOccupy alone does not block A* tiles',
  );
  assert.equal(
    store.canOccupyAt(4.25, 4.5, { consumer: 'dodge', safeWalk: true }),
    false,
    'fullOccupy neighbor rejects fractional positions',
  );
});

// TEMPORARY SCAFFOLDING FOR COMMIT 5 — to be deleted with dual-predicate interfaces.
test('dual tile predicates delegate to existing consumer-specific blockage rules', () => {
  const store = createStaticPassabilityStore(testData);
  const start = { x: 2, y: 2 };
  store.setMapBounds(8, 8);
  store.observeTile(3, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  store.observeTile(4, 2, PATHFINDING_MAP_TERRAIN.DAMAGING);
  store.upsertObject(1, PATHFINDING_MAP_OBJECTS.BLOCKING, 5.5, 2.5, { occupySquare: true });
  store.markLearnedBlocked(6, 2);

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      assert.equal(
        store.isTileBlockedForPathfinding(x, y, start),
        store.isTileStaticallyBlocked(x, y, { consumer: 'pathfinding', exemptTile: start }),
        `pathfinding dual (${x},${y})`,
      );
      for (const safeWalk of [true, false]) {
        assert.equal(
          store.isTileBlockedForDodge(x, y, { exemptTile: start, safeWalk }),
          store.isTileStaticallyBlocked(x, y, { consumer: 'dodge', exemptTile: start, safeWalk }),
          `dodge dual (${x},${y}) safeWalk=${safeWalk}`,
        );
      }
    }
  }
});

test('dual occupancy predicates delegate to pathfinding integer vs dodge fractional rules', () => {
  const store = createStaticPassabilityStore(testData);
  store.setMapBounds(8, 8);
  store.upsertObject(1, 999, 4.5, 4.5, { occupySquare: false, fullOccupy: true });

  for (const safeWalk of [true, false]) {
    for (let y = 0; y < 8; y += 0.5) {
      for (let x = 0; x < 8; x += 0.5) {
        assert.equal(
          store.canOccupyForDodgeAt(x, y, { safeWalk }),
          store.canOccupyAt(x, y, { consumer: 'dodge', safeWalk, checkFullOccupyNeighbors: true }),
          `dodge occupancy dual (${x},${y}) safeWalk=${safeWalk}`,
        );
        assert.equal(
          store.canOccupyForPathfindingAt(x, y),
          !store.isTileStaticallyBlocked(Math.floor(x), Math.floor(y), { consumer: 'pathfinding' }),
          `pathfinding occupancy dual (${x},${y})`,
        );
      }
    }
  }
});

test('dual predicates expose known A* vs dodge disagreements for Commit 5', () => {
  const store = createStaticPassabilityStore(testData);
  store.setMapBounds(8, 8);

  // Unknown tile: pathfinding walkable, dodge blocked.
  assert.equal(store.isTileBlockedForPathfinding(5, 5), false);
  assert.equal(store.isTileBlockedForDodge(5, 5, { safeWalk: true }), true);
  store.setExplorativeUnknown(true);
  assert.equal(store.isTileBlockedForDodge(5, 5, { safeWalk: true }), false);
  store.setExplorativeUnknown(false);

  // Damaging floor: pathfinding always blocks; dodge allows when safeWalk is false.
  store.observeTile(4, 4, PATHFINDING_MAP_TERRAIN.DAMAGING);
  assert.equal(store.isTileBlockedForPathfinding(4, 4), true);
  assert.equal(store.isTileBlockedForDodge(4, 4, { safeWalk: true }), true);
  assert.equal(store.isTileBlockedForDodge(4, 4, { safeWalk: false }), false);

  // Start-cell exemption: both predicates honor exemptTile.
  store.observeTile(2, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  const start = { x: 2, y: 2 };
  assert.equal(store.isTileBlockedForPathfinding(2, 2, start), false);
  assert.equal(store.isTileBlockedForDodge(2, 2, { exemptTile: start, safeWalk: true }), false);

  // Geometry: fullOccupy blocks dodge fractional occupancy but not pathfinding tiles.
  store.upsertObject(1, 999, 3.5, 3.5, { occupySquare: false, fullOccupy: true });
  assert.equal(store.isTileBlockedForPathfinding(3, 3), false);
  assert.equal(store.canOccupyForPathfindingAt(3.25, 3.5), true);
  assert.equal(store.canOccupyForDodgeAt(3.25, 3.5, { safeWalk: true }), false);
});

test('inflated passability blocks cells within playerRadius of obstacles when flag is on', () => {
  const store = createStaticPassabilityStore(testData, { useInflatedPassability: true });
  store.setMapBounds(8, 8);
  store.observeTile(3, 2, PATHFINDING_MAP_TERRAIN.WALKABLE);
  store.observeTile(4, 2, PATHFINDING_MAP_TERRAIN.WALKABLE);
  store.observeTile(5, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);

  assert.equal(
    store.isTileStaticallyBlocked(4, 2, { consumer: 'pathfinding' }),
    true,
    'tile adjacent to blocking terrain is inflated-blocked',
  );
  assert.equal(
    store.isTileStaticallyBlocked(3, 2, { consumer: 'pathfinding' }),
    false,
    'tile two steps from wall remains passable',
  );
  assert.equal(
    store.canOccupyAt(4.5, 2.5, { consumer: 'dodge', safeWalk: true }),
    false,
    'dodge center on inflated tile is rejected',
  );
  assert.equal(
    store.canOccupyAt(3.5, 2.5, { consumer: 'dodge', safeWalk: true }),
    true,
    'dodge center two tiles from wall remains open',
  );
});

test('inflated passability blocks fullOccupy neighbors with playerRadius + clearance when flag is on', () => {
  const store = createStaticPassabilityStore(testData, { useInflatedPassability: true });
  store.setMapBounds(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      store.observeTile(x, y, PATHFINDING_MAP_TERRAIN.WALKABLE);
    }
  }
  store.upsertObject(1, 999, 4.5, 4.5, { occupySquare: false, fullOccupy: true });

  assert.equal(
    store.isTileStaticallyBlocked(4, 4, { consumer: 'pathfinding' }),
    false,
    'fullOccupy source tile stays base-walkable',
  );
  assert.equal(
    store.isTileStaticallyBlocked(3, 4, { consumer: 'pathfinding' }),
    true,
    'tile west of fullOccupy is inflated-blocked',
  );
  assert.equal(
    store.canOccupyAt(4.5, 4.5, { consumer: 'dodge', safeWalk: true }),
    true,
    'player center on fullOccupy tile remains allowed',
  );
  assert.equal(
    store.canOccupyAt(3.75, 4.5, { consumer: 'dodge', safeWalk: true }),
    false,
    'fractional position toward fullOccupy neighbor is rejected',
  );
  assert.equal(INFLATED_PLAYER_RADIUS + FULL_OCCUPY_INFLATION_CLEARANCE, 1.0);
});

function asInflatedStoreImpl(
  store: ReturnType<typeof createStaticPassabilityStore>,
): StaticPassabilityStoreImpl {
  return store as unknown as StaticPassabilityStoreImpl;
}

function collectInflatedTileBlockage(
  store: ReturnType<typeof createStaticPassabilityStore>,
): boolean[][] {
  const width = store.getWidth();
  const height = store.getHeight();
  const grid: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    grid[y] = [];
    for (let x = 0; x < width; x++) {
      grid[y][x] = store.isTileStaticallyBlocked(x, y, { consumer: 'pathfinding' });
    }
  }
  return grid;
}

function gridsEqual(a: boolean[][], b: boolean[][]): boolean {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    if (a[y].length !== b[y].length) return false;
    for (let x = 0; x < a[y].length; x++) {
      if (a[y][x] !== b[y][x]) return false;
    }
  }
  return true;
}

test('incremental learned-block dilation matches full recompute when inflated flag is on', () => {
  const incremental = createStaticPassabilityStore(testData, { useInflatedPassability: true });
  incremental.setMapBounds(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      incremental.observeTile(x, y, PATHFINDING_MAP_TERRAIN.WALKABLE);
    }
  }
  incremental.observeTile(5, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  incremental.upsertObject(1, 999, 4.5, 4.5, { occupySquare: false, fullOccupy: true });

  const learnedBlocks = [
    { x: 6, y: 2 },
    { x: 1, y: 7 },
    { x: 3, y: 3 },
  ];
  for (const block of learnedBlocks) {
    incremental.markLearnedBlocked(block.x, block.y);
    assert.equal(
      asInflatedStoreImpl(incremental).getInflatedCacheRevisionForTest(),
      incremental.getRevision(),
      `cache revision after learned block (${block.x},${block.y})`,
    );
  }

  const full = createStaticPassabilityStore(testData, { useInflatedPassability: true });
  full.setMapBounds(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      full.observeTile(x, y, PATHFINDING_MAP_TERRAIN.WALKABLE);
    }
  }
  full.observeTile(5, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  full.upsertObject(1, 999, 4.5, 4.5, { occupySquare: false, fullOccupy: true });
  for (const block of learnedBlocks) {
    full.markLearnedBlocked(block.x, block.y);
  }

  assert.ok(
    gridsEqual(collectInflatedTileBlockage(incremental), collectInflatedTileBlockage(full)),
    'incremental learned-block updates match full rebuild',
  );
});

test('terrain and object mutators fully rebuild inflated cache for new revision', () => {
  const store = createStaticPassabilityStore(testData, { useInflatedPassability: true });
  store.setMapBounds(8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      store.observeTile(x, y, PATHFINDING_MAP_TERRAIN.WALKABLE);
    }
  }

  const impl = asInflatedStoreImpl(store);
  const revisionAfterTerrain = store.getRevision();
  assert.equal(impl.getInflatedCacheRevisionForTest(), revisionAfterTerrain);

  store.observeTile(5, 2, PATHFINDING_MAP_TERRAIN.BLOCKING);
  assert.equal(store.getRevision(), revisionAfterTerrain + 1);
  assert.equal(impl.getInflatedCacheRevisionForTest(), store.getRevision());
  assert.equal(impl.getDilatedObstacleTilesForTest().has(formatTileKey(4, 2)), true);

  store.upsertObject(1, 999, 4.5, 4.5, { occupySquare: false, fullOccupy: true });
  assert.equal(impl.getInflatedCacheRevisionForTest(), store.getRevision());
  assert.equal(impl.getDilatedFullOccupyTilesForTest().has(formatTileKey(3, 4)), true);

  store.setExplorativeUnknown(true);
  assert.equal(impl.getInflatedCacheRevisionForTest(), store.getRevision());
  assert.equal(impl.getDilatedFullOccupyTilesForTest().has(formatTileKey(3, 4)), true);
});
