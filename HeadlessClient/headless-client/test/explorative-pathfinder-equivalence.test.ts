import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GOLDEN_PATHFINDING_CASES } from './fixtures/golden-pathfinding-cases';
import {
  assertPathfindingResultsEqual,
  iterateGoldenPathfindingEquivalenceCases,
  runAllGoldenPathfindingEquivalenceCases,
  runIncrementalToCompletion,
  runPathfindingEquivalenceCase,
  runSyncBaseline,
} from './helpers/pathfinding-equivalence-harness';

const INCREMENTAL_SKIPPED_BY_DEFAULT = 'Incremental comparison skipped by caller';

test('equivalence harness iterates every golden-path fixture', () => {
  const harnessIds = [...iterateGoldenPathfindingEquivalenceCases()].map((entry) => entry.id);
  const fixtureIds = GOLDEN_PATHFINDING_CASES.map((entry) => entry.id);
  assert.deepEqual(harnessIds, fixtureIds);
});

test('runAllGoldenPathfindingEquivalenceCases returns one baseline per fixture', () => {
  const results = runAllGoldenPathfindingEquivalenceCases();
  assert.equal(results.length, GOLDEN_PATHFINDING_CASES.length);
  for (const result of results) {
    assert.equal(result.incrementalSkipped, true);
    assert.equal(result.skipReason, INCREMENTAL_SKIPPED_BY_DEFAULT);
  }
});

for (const testCase of GOLDEN_PATHFINDING_CASES) {
  test(`equivalence harness baseline: ${testCase.id} (${testCase.specialCase})`, () => {
    const result = runPathfindingEquivalenceCase(testCase);

    assert.equal(result.caseId, testCase.id);
    assert.equal(result.incrementalSkipped, true);
    assert.equal(result.skipReason, INCREMENTAL_SKIPPED_BY_DEFAULT);
    assert.equal(result.incremental, undefined);

    if (testCase.expectedNoPath) {
      assert.equal(result.baseline.noPath, true, `${testCase.id} should report no path`);
      return;
    }

    assert.equal(result.baseline.noPath, false, `${testCase.id} should find a path`);
    assert.deepEqual(
      result.baseline.rawPath,
      testCase.expectedRawPath,
      `${testCase.id} sync baseline must match the golden fixture`,
    );
  });

  test(`equivalence incremental matches sync: ${testCase.id}`, () => {
    runPathfindingEquivalenceCase(testCase, { skipIncremental: false });
  });
}

test('runIncrementalToCompletion matches sync baseline for open-horizontal', () => {
  const testCase = GOLDEN_PATHFINDING_CASES.find((entry) => entry.id === 'open-horizontal')!;
  const baseline = runSyncBaseline(testCase);
  const incremental = runIncrementalToCompletion(testCase);
  assertPathfindingResultsEqual(baseline, incremental, testCase.id);
});

test('assertPathfindingResultsEqual accepts identical baseline copies', () => {
  const testCase = GOLDEN_PATHFINDING_CASES.find((entry) => entry.id === 'open-horizontal')!;
  const baseline = runSyncBaseline(testCase);
  assertPathfindingResultsEqual(baseline, { ...baseline, rawPath: [...baseline.rawPath] }, testCase.id);
});
