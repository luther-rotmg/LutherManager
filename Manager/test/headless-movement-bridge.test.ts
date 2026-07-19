import assert from 'node:assert/strict';
import test from 'node:test';
import { Walking } from '@luthermanager/sdk';
import type { Client, CombatPathfindingRange } from 'headless-client';
import type { BridgeDeps } from '../src/scripts/bridge/BridgeDeps.js';
import { installHeadlessBridge } from '../src/scripts/bridge/headless/HeadlessBridge.js';

test('combat navigation forwards a canonical weapon-derived dodge range', () => {
  let captured: {
    target: { x: number; y: number };
    range: CombatPathfindingRange;
    options: Record<string, unknown>;
  } | undefined;
  const client = {
    getInventory: () => [100],
    getPlayer: () => ({ projSpeedMult: 1.2, projLifeMult: 1.25 }),
    getNavigationState: () => ({
      status: 'no_path' as const,
      target: { x: 20, y: 5, threshold: 1 },
      path: [],
      dodgeDecision: null,
    }),
    navigateToCombatTarget: (
      target: { x: number; y: number },
      range: CombatPathfindingRange,
      options: Record<string, unknown>,
    ) => {
      captured = { target, range, options };
      return true;
    },
  } as unknown as Client;
  const deps = {
    getHeadlessClient: () => client,
    gameData: {
      getObject: () => ({ projectiles: new Map() }),
      getProjectile: () => ({ speed: 100, lifetimeMs: 1000 }),
    },
  } as unknown as BridgeDeps;
  installHeadlessBridge(deps);

  assert.equal(Walking.navigateToCombatTarget(20, 5, {
    targetId: 42,
    hardMinimumRange: 1,
    preferredMinimumRange: 4,
    preferredMaximumRange: 8,
  }), true);

  assert.deepEqual(captured?.target, { x: 20, y: 5 });
  assert.deepEqual(captured?.range, {
    minimumDistance: 4,
    preferredDistance: 8,
    maximumDistance: 8,
  });
  assert.equal(captured?.options.targetId, 42);
  assert.equal(captured?.options.hardMinimumRange, 1);
  assert.equal(captured?.options.preferredMinimumRange, 4);
  assert.equal(captured?.options.preferredMaximumRange, 8);
  assert.deepEqual(Walking.getNavigationState(), {
    status: 'no_path',
    target: { x: 20, y: 5, threshold: 1 },
    path: [],
    dodgeDecision: null,
  });
});
