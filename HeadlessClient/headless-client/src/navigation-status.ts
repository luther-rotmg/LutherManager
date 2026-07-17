import type { PathSearchStatus } from './explorative-pathfinder';

/**
 * High-level navigation lifecycle status for Hive AIO and
 * {@link Client.getNavigationState}.
 *
 * Derived from three layers:
 * - {@link PathSearchStatus} — incremental raw-tile search (`searching` / `found` / `no_path`)
 * - {@link ExplorativePathfinder.next} — waypoint emission, `{ noPath }`, and `{ reached }`
 * - Client dodge evaluation — `dodge_blocked` when auto-dodge refuses movement
 */
export type NavigationStatus =
  /** No navigation target is active (`stopMoving`, post-arrival cleanup, lost combat target, map reset). */
  | 'idle'
  /**
   * A route is being computed or refreshed.
   * Triggered when a new pathfinding request starts, {@link PathSearchStatus} is
   * `searching`, {@link ExplorativePathfinder.next} returns no waypoint and no
   * `{ noPath }` (search budget exhausted mid-plan), or movement stalls and the
   * pathfinder replans.
   */
  | 'planning'
  /**
   * Actively pursuing a waypoint or direct-move target.
   * Triggered when {@link ExplorativePathfinder.next} returns a waypoint,
   * {@link Client.moveTo} is used, or dodge evaluation allows goal following
   * (`follow_goal` / unblocked `goal_path`).
   */
  | 'moving'
  /**
   * The navigation goal was satisfied.
   * Triggered when {@link ExplorativePathfinder.next} returns `{ reached }`
   * (player within arrive threshold, or combat band satisfied).
   */
  | 'arrived'
  /**
   * No reachable route exists with current map knowledge.
   * Triggered when {@link PathSearchStatus} is `no_path` with no retained plan, or
   * {@link ExplorativePathfinder.next} returns `{ noPath: true }`.
   */
  | 'no_path'
  /**
   * Pathfinding has a target but auto-dodge blocked movement this tick.
   * Triggered when dodge `decision` ends with `_blocked` (e.g. `goal_blocked`) while
   * the pathfinder still holds a target.
   */
  | 'dodge_blocked'
  /**
   * Navigation was explicitly cancelled before arrival.
   * Triggered by {@link Client.stopMoving}, {@link PathSearchHandle.cancel}, or
   * {@link ExplorativePathfinder.clearTarget} without a `{ reached }` signal.
   */
  | 'cancelled';

/** Navigation facets implied solely by {@link PathSearchStatus}. `found` is intentionally omitted. */
export type PathSearchDerivedNavigationStatus = 'planning' | 'no_path';

/**
 * Maps incremental search status to the navigation facet it alone determines.
 *
 * | PathSearchStatus | Result              |
 * |------------------|---------------------|
 * | `searching`      | `planning`          |
 * | `no_path`        | `no_path`           |
 * | `found`          | `undefined` — caller must inspect waypoints / `next()` |
 */
export function pathSearchStatusToNavigationStatus(
  status: PathSearchStatus,
): PathSearchDerivedNavigationStatus | undefined {
  switch (status) {
    case 'searching':
      return 'planning';
    case 'no_path':
      return 'no_path';
    case 'found':
      return undefined;
  }
}
