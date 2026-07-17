import {
  ExplorativePathfinder,
  PathSearchHandle,
  PathSearchStatus,
  PathSearchStepBudget,
  SYNC_PATH_SEARCH_BUDGET,
} from './explorative-pathfinder';

interface GridPoint {
  x: number;
  y: number;
}

type TerminalPathSearchStatus = Exclude<PathSearchStatus, 'searching'>;

/**
 * Handle for a path search that already ran to completion via {@link runSyncPathSearch}.
 * `status()` is always terminal (`found` or `no_path`); `step()` is a no-op.
 */
class CompletedPathSearchHandle implements PathSearchHandle {
  constructor(
    private readonly terminalStatus: TerminalPathSearchStatus,
    private readonly path: ReadonlyArray<GridPoint> | undefined,
  ) {}

  status(): PathSearchStatus {
    return this.terminalStatus;
  }

  cancel(): void {}

  step(_budget: PathSearchStepBudget): PathSearchStatus {
    return this.terminalStatus;
  }

  getPath(): ReadonlyArray<GridPoint> | undefined {
    return this.path;
  }

  wasOpenSetExhausted(): boolean {
    return this.terminalStatus === 'no_path';
  }
}

/**
 * Incremental adapter: starts or resumes a raw-tile search via
 * {@link ExplorativePathfinder.beginPathSearch} and returns a live
 * {@link PathSearchHandle}. The caller drives progress with
 * {@link PathSearchHandle.step} using {@link NAVIGATION_PATH_SEARCH_BUDGET}
 * or a custom budget. Reuses the in-flight search when start, goals, and
 * mapVersion are unchanged.
 */
export function runIncrementalPathSearch(
  pathfinder: ExplorativePathfinder,
  start: GridPoint,
  goals: ReadonlyArray<GridPoint>,
): PathSearchHandle {
  return pathfinder.beginPathSearch(start, goals);
}

/**
 * Sync adapter: runs a raw-tile search to completion in one shot and returns a
 * terminal {@link PathSearchHandle} (`found` or `no_path`, never `searching`).
 */
export function runSyncPathSearch(
  pathfinder: ExplorativePathfinder,
  start: GridPoint,
  goals: ReadonlyArray<GridPoint>,
): PathSearchHandle {
  const handle = pathfinder.beginPathSearch(start, goals);
  while (handle.status() === 'searching') {
    handle.step(SYNC_PATH_SEARCH_BUDGET);
  }
  const status = handle.status();
  if (status === 'searching') {
    throw new Error('sync path search did not reach terminal status');
  }
  return new CompletedPathSearchHandle(status, handle.getPath());
}
