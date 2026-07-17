import assert from 'node:assert/strict';
import type { GoldenPathfindingCase } from '../fixtures/golden-pathfinding-cases';
import { GOLDEN_PATHFINDING_CASES } from '../fixtures/golden-pathfinding-cases';
import {
  runGoldenPathfindingCase,
  type GoldenPathResult,
} from './golden-pathfinding-runner';
import { createPathfinderFromFixture } from './pathfinding-map-generator';

/** Comparable output from sync baseline or incremental runToCompletion(). */
export type PathfindingEquivalenceResult = GoldenPathResult;

export interface IncrementalPathfinderRunOptions {
  /** Per-step expansion budget when driving incremental search (Commit 3). */
  budgetPerStep?: number;
}

/** Sync one-shot baseline: current aStar() via next() + getPlannedTiles(). */
export function runSyncBaseline(testCase: GoldenPathfindingCase): PathfindingEquivalenceResult {
  return runGoldenPathfindingCase(testCase);
}

/** Incremental PathSearch driver: loop step(budget) until found/no_path. */
export function runIncrementalToCompletion(
  testCase: GoldenPathfindingCase,
  options?: IncrementalPathfinderRunOptions,
): PathfindingEquivalenceResult {
  const pathfinder = createPathfinderFromFixture(testCase.fixture);

  if (testCase.mode === 'combat') {
    const combat = testCase.combat!;
    pathfinder.setCombatTarget(combat.target, combat.range, combat.primaryEnemyId);
  } else {
    pathfinder.setTarget(testCase.fixture.goal, 0.2);
  }

  if (testCase.setup === 'learned-blocked-at-start') {
    pathfinder.next(testCase.fixture.start);
    pathfinder.reportStall(testCase.fixture.start);
  }

  const budgetPerStep = options?.budgetPerStep ?? Number.POSITIVE_INFINITY;
  const rawTiles = pathfinder.runPathSearchToCompletion(testCase.fixture.start, budgetPerStep);
  return {
    rawPath: rawTiles ?? [],
    noPath: rawTiles === undefined,
    replanned: false,
  };
}

export function assertPathfindingResultsEqual(
  baseline: PathfindingEquivalenceResult,
  incremental: PathfindingEquivalenceResult,
  caseId: string,
): void {
  assert.equal(
    incremental.noPath,
    baseline.noPath,
    `${caseId}: noPath mismatch (sync=${baseline.noPath}, incremental=${incremental.noPath})`,
  );
  if (baseline.noPath) {
    return;
  }
  assert.deepEqual(
    incremental.rawPath,
    baseline.rawPath,
    `${caseId}: raw tile path mismatch between sync baseline and incremental runToCompletion`,
  );
}

export interface PathfindingEquivalenceRunResult {
  caseId: string;
  baseline: PathfindingEquivalenceResult;
  incremental?: PathfindingEquivalenceResult;
  incrementalSkipped: boolean;
  skipReason?: string;
}

export interface PathfindingEquivalenceHarnessOptions {
  /** When true (default), skip incremental and record skipReason instead of throwing. */
  skipIncremental?: boolean;
  incrementalOptions?: IncrementalPathfinderRunOptions;
}

/**
 * Given a golden fixture: run sync baseline, optionally run incremental driver, assert equal.
 * Default mode skips incremental for baseline-only harness callers.
 */
export function runPathfindingEquivalenceCase(
  testCase: GoldenPathfindingCase,
  options: PathfindingEquivalenceHarnessOptions = {},
): PathfindingEquivalenceRunResult {
  const { skipIncremental = true, incrementalOptions } = options;
  const baseline = runSyncBaseline(testCase);

  if (skipIncremental) {
    return {
      caseId: testCase.id,
      baseline,
      incrementalSkipped: true,
      skipReason: 'Incremental comparison skipped by caller',
    };
  }

  const incremental = runIncrementalToCompletion(testCase, incrementalOptions);
  assertPathfindingResultsEqual(baseline, incremental, testCase.id);
  return {
    caseId: testCase.id,
    baseline,
    incremental,
    incrementalSkipped: false,
  };
}

export function* iterateGoldenPathfindingEquivalenceCases(): Generator<GoldenPathfindingCase> {
  for (const testCase of GOLDEN_PATHFINDING_CASES) {
    yield testCase;
  }
}

export function runAllGoldenPathfindingEquivalenceCases(
  options?: PathfindingEquivalenceHarnessOptions,
): PathfindingEquivalenceRunResult[] {
  return GOLDEN_PATHFINDING_CASES.map((testCase) =>
    runPathfindingEquivalenceCase(testCase, options),
  );
}
