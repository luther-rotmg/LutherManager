#!/usr/bin/env node
/**
 * Synthetic benchmark for SpaceTimeDodgePlanner.plan().
 *
 * Sets up a representative scenario (player moving east with N enemy projectiles
 * on crossing trajectories), runs plan() N times, and reports per-plan wall-clock
 * distribution + a heap-usage delta if `node --expose-gc` is passed.
 *
 * Usage (from HeadlessClient/headless-client/):
 *   node -r ts-node/register scripts/planner-benchmark.ts [flags]
 *   node --expose-gc -r ts-node/register scripts/planner-benchmark.ts [flags]
 *
 * Flags:
 *   --iterations <N>       plan() call count (default 1000)
 *   --projectiles <N>      number of enemy projectiles (default 10)
 *   --warmup <N>           warmup iterations excluded from stats (default 50)
 *   --seed <N>             deterministic scenario seed (default 42)
 *   --json                 emit results as one JSON line for CI/regression tracking
 *
 * Intended use:
 *   - Establish a baseline before P8 full (typed-column restructure) or
 *     other larger perf refactors.
 *   - Track per-commit regressions by diffing --json output across commits.
 *   - Run under `node --cpu-prof` to feed a flamegraph.
 */

import { performance } from 'node:perf_hooks';
import { SpaceTimeDodgePlanner, type DodgePlanningInput, type DodgePlanningEnvironment } from '../src/dodge-trajectory-planner';
import type { CombatProjectileSnapshot } from '../src/combat-tracker';

// -- CLI --------------------------------------------------------------------

interface Args {
  iterations: number;
  projectiles: number;
  warmup: number;
  seed: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { iterations: 1000, projectiles: 10, warmup: 50, seed: 42, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--iterations' && i + 1 < argv.length) { args.iterations = Number(argv[++i]); continue; }
    if (a === '--projectiles' && i + 1 < argv.length) { args.projectiles = Number(argv[++i]); continue; }
    if (a === '--warmup' && i + 1 < argv.length) { args.warmup = Number(argv[++i]); continue; }
    if (a === '--seed' && i + 1 < argv.length) { args.seed = Number(argv[++i]); continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '-h' || a === '--help') {
      console.log('planner-benchmark.ts — measure SpaceTimeDodgePlanner.plan() throughput.');
      console.log('Flags: [--iterations N] [--projectiles N] [--warmup N] [--seed N] [--json]');
      process.exit(0);
    }
  }
  return args;
}

// -- Scenario ---------------------------------------------------------------

// Deterministic PRNG (mulberry32) so seed => identical scenario shape.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROJECTILE_DEFINITION = {
  speed: 100,
  lifetimeMs: 1500,
  hitRadius: 0.1,
  multiHit: false,
  passesCover: false,
  amplitude: 0,
  frequency: 1,
  magnitude: 3,
  wavy: false,
  parametric: false,
  boomerang: false,
  acceleration: 0,
  accelerationDelay: 0,
  speedClamp: -1,
};

const OPEN_ENVIRONMENT: DodgePlanningEnvironment = {
  canOccupy: () => true,
  enemyClearance: () => Infinity,
  isProjectileSegmentOpen: () => true,
};

function buildScenario(seed: number, projectileCount: number): DodgePlanningInput {
  const rand = rng(seed);
  const projectiles: CombatProjectileSnapshot[] = [];
  for (let i = 0; i < projectileCount; i++) {
    projectiles.push({
      side: 'enemy',
      bulletId: 1000 + i,
      bulletType: 0,
      ownerId: 500 + i,
      containerType: 100,
      startX: 5 + (rand() * 12 - 6), // -1..11 (surrounds the player)
      startY: 5 + (rand() * 12 - 6),
      angle: rand() * Math.PI * 2,
      startTime: rand() * 200, // stagger slightly so not all sample at t=0
      damage: 100,
      definition: PROJECTILE_DEFINITION,
      hitObjects: new Set<number>(),
    });
  }
  return {
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 12, y: 5 },
    moveSpeed: 0.006,
    intentVelocity: { x: 0.006, y: 0 },
    movementLeadMs: 0,
    projectiles,
    aoes: [],
    environment: OPEN_ENVIRONMENT,
    safeWalk: true,
  };
}

// -- Stats ------------------------------------------------------------------

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p));
  return sortedAsc[rank]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// -- Run --------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const planner = new SpaceTimeDodgePlanner({ maxStatesPerLayer: 64 });
  const input = buildScenario(args.seed, args.projectiles);

  // Warmup — lets V8 JIT-compile hot paths before measuring.
  for (let i = 0; i < args.warmup; i++) planner.plan(input, 'normal');

  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
  const heapBefore = process.memoryUsage().heapUsed;

  const samples: number[] = new Array(args.iterations);
  const totalStart = performance.now();
  for (let i = 0; i < args.iterations; i++) {
    const t0 = performance.now();
    planner.plan(input, 'normal');
    samples[i] = performance.now() - t0;
  }
  const totalMs = performance.now() - totalStart;

  if (gc) gc();
  const heapAfter = process.memoryUsage().heapUsed;

  const sorted = samples.slice().sort((a, b) => a - b);
  const results = {
    iterations: args.iterations,
    projectiles: args.projectiles,
    warmup: args.warmup,
    seed: args.seed,
    totalMs: Number(totalMs.toFixed(2)),
    meanMs: Number(mean(samples).toFixed(4)),
    medianMs: Number(percentile(sorted, 0.5).toFixed(4)),
    p90Ms: Number(percentile(sorted, 0.9).toFixed(4)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(4)),
    p99Ms: Number(percentile(sorted, 0.99).toFixed(4)),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(4)),
    plansPerSecond: Math.round(args.iterations / (totalMs / 1000)),
    heapDeltaBytes: gc ? heapAfter - heapBefore : null,
    heapDeltaPerPlanBytes: gc ? Math.round((heapAfter - heapBefore) / args.iterations) : null,
  };

  if (args.json) {
    console.log(JSON.stringify(results));
    return;
  }
  console.log('planner-benchmark');
  console.log('  iterations:              ', results.iterations);
  console.log('  projectiles:             ', results.projectiles);
  console.log('  warmup (excluded):       ', results.warmup);
  console.log('  total wall time (ms):    ', results.totalMs);
  console.log('  plans per second:        ', results.plansPerSecond);
  console.log('  per plan mean (ms):      ', results.meanMs);
  console.log('  per plan median (ms):    ', results.medianMs);
  console.log('  per plan p90 (ms):       ', results.p90Ms);
  console.log('  per plan p95 (ms):       ', results.p95Ms);
  console.log('  per plan p99 (ms):       ', results.p99Ms);
  console.log('  per plan max (ms):       ', results.maxMs);
  if (gc) {
    console.log('  heap delta (bytes):      ', results.heapDeltaBytes);
    console.log('  heap delta per plan (B): ', results.heapDeltaPerPlanBytes);
  } else {
    console.log('  heap delta:               (run with `node --expose-gc` for accurate value)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
