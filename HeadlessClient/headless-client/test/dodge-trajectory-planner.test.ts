import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CombatDataProvider,
  CombatProjectileDefinition,
  CombatProjectileSnapshot,
} from '../src/combat-tracker';
import { predictProjectilePosition } from '../src/combat-tracker';
import {
  DodgeCollisionWorld,
  ENEMY_AVOID_RADIUS,
} from '../src/dodge-collision-world';
import { DodgeJumpLimiter, type DodgeJumpStatus } from '../src/dodge-jump-limiter';
import {
  SpaceTimeDodgePlanner,
  type DodgePlanningEnvironment,
  type DodgePlanningInput,
  type DodgePlanningResult,
} from '../src/dodge-trajectory-planner';
import { PredictiveAutoDodgeController } from '../src/predictive-auto-dodge';

const PROJECTILE_DEFINITION: CombatProjectileDefinition = {
  speed: 100,
  lifetimeMs: 1000,
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
  getRevision: () => 0,
};

test('1. projectile-free planning follows the global pathfinding intent', () => {
  const result = plan(planningInput());

  assert.equal(result.reachesHorizon, true);
  assert.equal(result.fallback, 'none');
  assert.ok(result.trajectory.waypoints.every((waypoint) => waypoint.y === 5));
  assert.equal(result.trajectory.waypoints[0]!.speed, 6);
  assert.ok(result.trajectory.waypoints.every((waypoint) => waypoint.speed <= 6 + 1e-9));
  assert.ok(result.trajectory.waypoints.at(-1)!.x > 9.9);
});

test('goal mode follows its route waypoint toward the global destination', () => {
  const result = plan(planningInput({
    intent: {
      mode: 'goal',
      goalX: 20,
      goalY: 5,
      goalId: 'ordinary-destination',
      arriveThreshold: 0.5,
    },
    routeWaypoint: { x: 10, y: 5, threshold: 0.2 },
  }));

  assert.equal(result.reachesHorizon, true);
  assert.ok(result.trajectory.waypoints.at(-1)!.x > 9.8);
  assert.ok(result.trajectory.waypoints.every((waypoint) => Math.abs(waypoint.y - 5) < 1e-9));
});

test('goal mode passes a combat enemy without combat-range attraction', () => {
  const enemy = { x: 7, y: 5 };
  const result = plan(planningInput({
    intent: {
      mode: 'goal',
      goalX: 12,
      goalY: 5,
      goalId: 'run-past',
      arriveThreshold: 0.2,
    },
    routeWaypoint: { x: 10, y: 5, threshold: 0.2 },
    environment: {
      canOccupy: () => true,
      enemyClearance: (x, y) => Math.hypot(x - enemy.x, y - enemy.y),
      isProjectileSegmentOpen: () => true,
      getRevision: () => 0,
    },
  }));

  assert.ok(result.trajectory.waypoints.at(-1)!.x > enemy.x);
  assert.ok(result.minimumEnemyClearance >= ENEMY_AVOID_RADIUS - 1e-6);
});

test('combat-range mode approaches from beyond the preferred maximum', () => {
  const result = plan(planningInput({
    goal: undefined,
    intent: combatIntent({ targetX: 10, preferredMinimumRange: 2, preferredMaximumRange: 3 }),
    routeWaypoint: undefined,
    intentVelocity: { x: 0, y: 0 },
  }));

  assert.ok(result.trajectory.waypoints[0]!.x > 5);
  const terminalDistance = Math.hypot(result.trajectory.waypoints.at(-1)!.x - 10,
    result.trajectory.waypoints.at(-1)!.y - 5);
  assert.ok(terminalDistance >= 2 - 1e-6 && terminalDistance <= 3 + 1e-6);
});

test('combat-range mode retreats from below the preferred minimum', () => {
  const result = plan(planningInput({
    goal: undefined,
    intent: combatIntent({
      targetX: 6.5,
      hardMinimumRange: 1.3,
      preferredMinimumRange: 2.5,
      preferredMaximumRange: 3.5,
    }),
    routeWaypoint: undefined,
    intentVelocity: { x: 0, y: 0 },
  }));

  assert.ok(result.trajectory.waypoints[0]!.x < 5);
  assert.ok(Math.hypot(
    result.trajectory.waypoints.at(-1)!.x - 6.5,
    result.trajectory.waypoints.at(-1)!.y - 5,
  ) >= 2.5 - 1e-6);
});

test('combat-range mode waits when already inside the preferred band', () => {
  const result = plan(planningInput({
    goal: undefined,
    intent: combatIntent({ targetX: 7.5, preferredMinimumRange: 2, preferredMaximumRange: 3 }),
    routeWaypoint: undefined,
    intentVelocity: { x: 0, y: 0 },
    previousVelocity: { x: 0, y: 0 },
  }));

  assert.ok(result.trajectory.waypoints.every((waypoint) => waypoint.speed === 0));
  assert.ok(result.trajectory.waypoints.every((waypoint) => waypoint.x === 5 && waypoint.y === 5));
});

test('retreat pressure scales only the combat too-far preference', () => {
  const intent = combatIntent({ targetX: 9, preferredMinimumRange: 2, preferredMaximumRange: 3 });
  const pressured = plan(planningInput({
    intent,
    goal: undefined,
    intentVelocity: { x: 0, y: 0 },
    retreatPenaltyScale: 1,
  }));
  const relaxed = plan(planningInput({
    intent,
    goal: undefined,
    intentVelocity: { x: 0, y: 0 },
    retreatPenaltyScale: 0,
  }));

  assert.ok(pressured.trajectory.waypoints[0]!.x > 5);
  assert.ok(relaxed.trajectory.waypoints.every((waypoint) => waypoint.speed === 0));
});

test('combat hard range clamps to 1.0 and starting inside can only escape', () => {
  const target = { x: 5.8, y: 5 };
  const result = plan(planningInput({
    goal: undefined,
    intent: combatIntent({
      targetX: target.x,
      hardMinimumRange: 1,
      preferredMinimumRange: 1.4,
      preferredMaximumRange: 2.5,
    }),
    routeWaypoint: undefined,
    intentVelocity: { x: 0, y: 0 },
  }));
  const distances = result.trajectory.waypoints.map((waypoint) => (
    Math.hypot(waypoint.x - target.x, waypoint.y - target.y)
  ));

  assert.ok(distances[0]! >= 0.8 - 1e-6);
  assert.ok(distances.every((value, index) => index === 0 || value + 1e-6 >= distances[index - 1]!));
  assert.ok(distances.at(-1)! >= ENEMY_AVOID_RADIUS);
});

test('combat range scoring samples predicted target movement by time layer', () => {
  let samples = 0;
  const result = plan(planningInput({
    goal: undefined,
    intent: combatIntent({ targetX: 10, preferredMinimumRange: 2, preferredMaximumRange: 3 }),
    routeWaypoint: undefined,
    intentVelocity: { x: 0, y: 0 },
    combatTargetPositionAt: (timeOffsetMs) => {
      samples++;
      return { x: 10 + timeOffsetMs * 0.002, y: 5 };
    },
  }));

  assert.ok(samples >= 13);
  assert.ok(result.trajectory.waypoints.at(-1)!.x > 8);
});

test('2. a direct incoming projectile produces a swept-safe route around it', () => {
  const input = planningInput({ projectiles: [projectile()] });
  const planner = testPlanner();
  const result = planner.plan(input, 'normal');

  assert.ok(result.earliestIntentCollisionMs !== null);
  assert.equal(result.reachesHorizon, true);
  assert.ok(result.trajectory.waypoints.some((waypoint) => Math.abs(waypoint.y - 5) > 0.4));
  assert.equal(planner.assessTrajectory(input, result.trajectory).safe, true);
});

test('3. two crossing projectiles are rejected by continuous swept collision', () => {
  const input = planningInput({
    moveSpeed: 0.008,
    intentVelocity: { x: 0.008, y: 0 },
    projectiles: [
      projectile({
        startX: 7,
        startY: 0,
        angle: Math.PI / 2,
        definition: { speed: 200 },
      }),
      projectile({
        bulletId: 2,
        startX: 9,
        startY: 5,
        angle: Math.PI,
        definition: { speed: 80 },
      }),
    ],
  });
  const planner = testPlanner();
  const result = planner.plan(input, 'normal');

  assert.equal(result.reachesHorizon, true);
  assert.ok(result.metrics.candidatesRejectedByProjectiles > 0);
  assert.equal(planner.assessTrajectory(input, result.trajectory).safe, true);
});

test('4. a projectile crossing wholly between layer endpoints is still detected', () => {
  const input = planningInput({
    goal: undefined,
    intentVelocity: { x: 0, y: 0 },
    projectiles: [projectile({
      startX: 4,
      startY: 5,
      angle: 0,
      definition: { speed: 200 },
    })],
  });
  const result = plan(input, { timeLayersMs: [0, 100, 200, 400, 700, 1000] });

  assert.ok(Math.abs((result.earliestIntentCollisionMs ?? Infinity) - 50) < 1e-6);
  assert.ok(result.metrics.candidatesRejectedByProjectiles > 0);
  assert.notDeepEqual(result.trajectory.waypoints[0], {
    timeOffsetMs: 100,
    x: 5,
    y: 5,
    speed: 0,
  });
});

test('5. waiting lets a crossing projectile clear a narrow corridor', () => {
  const result = plan(timedCorridorInput());

  assert.equal(result.reachesHorizon, true);
  assert.ok(result.trajectory.waypoints.some((waypoint) => waypoint.speed === 0));
  assert.ok(result.trajectory.waypoints.at(-1)!.x > 8.5);
});

test('6. moving controls use the computed maximum speed rather than fractions', () => {
  const input = timedCorridorInput();
  const planner = testPlanner();
  const result = planner.plan(input, 'normal');
  const maximumSpeed = input.moveSpeed * 1000;

  assert.ok(result.trajectory.waypoints.some((waypoint) => waypoint.speed > 0));
  assert.ok(result.trajectory.waypoints.every((waypoint) => (
    waypoint.speed === 0 || Math.abs(waypoint.speed - maximumSpeed) < 1e-9
  )));
  assert.equal(planner.assessTrajectory(input, result.trajectory).safe, true);
});

test('current and proposed trajectories use the same clipped score breakdown', () => {
  const planner = testPlanner();
  const input = planningInput({
    time: 100,
    position: { x: 5.4, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    previousVelocity: { x: 0.004, y: 0 },
  });
  const current = {
    createdAt: 0,
    waypoints: [
      { timeOffsetMs: 100, x: 5.4, y: 5, speed: 4 },
      { timeOffsetMs: 450, x: 6.8, y: 5, speed: 4 },
    ],
  };
  const proposed = {
    createdAt: 100,
    waypoints: [
      { timeOffsetMs: 350, x: 6.8, y: 5, speed: 4 },
    ],
  };

  const currentScore = planner.assessTrajectory(input, current, 350);
  const proposedScore = planner.assessTrajectory(input, proposed, 350);

  assert.equal(currentScore.safe, true);
  assert.equal(proposedScore.safe, true);
  assert.equal(currentScore.comparisonHorizonMs, 350);
  assert.equal(proposedScore.comparisonHorizonMs, 350);
  assert.ok(Math.abs(currentScore.score - proposedScore.score) < 1e-9);
  assert.ok(Math.abs(currentScore.cumulativeCost - proposedScore.cumulativeCost) < 1e-9);
  assert.ok(Math.abs(currentScore.terminalCost - proposedScore.terminalCost) < 1e-9);
  assert.ok(Math.abs(currentScore.intentCost - proposedScore.intentCost) < 1e-9);
});

test('a harmless projectile does not make safe waiting artificially expensive', () => {
  const result = plan(planningInput({
    goal: undefined,
    intent: null,
    intentVelocity: { x: 0, y: 0 },
    previousVelocity: { x: 0, y: 0 },
    projectiles: [projectile({
      startX: 5,
      startY: 8,
      angle: 0,
    })],
  }));

  assert.equal(result.activeProjectileCount, 1);
  assert.equal(result.reachesHorizon, true);
  assert.ok(result.trajectory.waypoints.every((waypoint) => waypoint.speed === 0));
});

test('7. the planner temporarily retreats when forward movement is lethal', () => {
  const result = plan(retreatInput());

  assert.equal(result.reachesHorizon, true);
  assert.ok(Math.min(...result.trajectory.waypoints.map((waypoint) => waypoint.x)) < 4.5);
  assert.ok(result.earliestIntentCollisionMs !== null);
});

test('8. the trajectory returns toward the global path after danger clears', () => {
  const result = plan(retreatInput());
  const positions = result.trajectory.waypoints.map((waypoint) => waypoint.x);
  const minimumIndex = positions.indexOf(Math.min(...positions));

  assert.ok(minimumIndex > 0 && minimumIndex < positions.length - 1);
  assert.ok(positions.at(-1)! > positions[minimumIndex]! + 3);
});

test('9. enemy hard-radius exclusion invalidates otherwise direct movement', () => {
  const enemy = { x: 7, y: 5 };
  const result = plan(planningInput({
    environment: {
      canOccupy: () => true,
      enemyClearance: (x, y) => Math.hypot(x - enemy.x, y - enemy.y),
      isProjectileSegmentOpen: () => true,
      getRevision: () => 0,
    },
  }));

  assert.ok(result.minimumEnemyClearance >= ENEMY_AVOID_RADIUS - 1e-6);
  assert.ok(result.trajectory.waypoints.some((waypoint) => Math.abs(waypoint.y - 5) > 0.5));
});

test('10. nonlinear enemy soft cost keeps the route off the hard boundary', () => {
  const enemy = { x: 7, y: 5 };
  const result = plan(planningInput({
    environment: {
      canOccupy: () => true,
      enemyClearance: (x, y) => Math.hypot(x - enemy.x, y - enemy.y),
      isProjectileSegmentOpen: () => true,
      getRevision: () => 0,
    },
  }));

  assert.ok(
    result.minimumEnemyClearance > ENEMY_AVOID_RADIUS + 0.35,
    `route hugged the hard boundary at ${result.minimumEnemyClearance}`,
  );
});

test('11. blocking tiles and occupying objects remain authoritative in snapshots', () => {
  const world = collisionWorld();
  world.observeTile(6, 5, 8);
  world.upsertObject(30, 1, 6.5, 6.5);
  const snapshot = world.createLocalSnapshot({ x: 4.5, y: 5.5 }, 7, 0.1);
  const input = planningInput({
    position: { x: 4.5, y: 5.5 },
    goal: { x: 9.5, y: 5.5 },
    environment: world,
  });
  const result = plan(input);

  assert.ok(snapshot.blocked.some((value) => value === 1));
  assert.ok(result.metrics.candidatesRejectedByGeometry > 0);
  assertTrajectoryOccupies(world, input.position, result);
});

test('local snapshots reuse static arrays while refreshing moving enemy distances', () => {
  const data: CombatDataProvider = {
    getObject: (type) => type === 2
      ? { isEnemy: true, hasProjectiles: true, occupySquare: false }
      : undefined,
    getProjectile: () => undefined,
    tileIsBlockingWalk: (type) => type === 8,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(12, 12);
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) world.observeTile(x, y, 0);
  }
  world.upsertObject(50, 2, 8, 5);
  const first = world.createLocalSnapshot({ x: 5, y: 5 }, 5, 0.1);
  world.upsertObject(50, 2, 8.2, 5);
  const enemyRefresh = world.createLocalSnapshot({ x: 5, y: 5 }, 5, 0.1);

  assert.strictEqual(enemyRefresh.blocked, first.blocked);
  assert.strictEqual(enemyRefresh.damagingFloor, first.damagingFloor);
  assert.notStrictEqual(enemyRefresh.enemyDistance, first.enemyDistance);
  assert.ok(enemyRefresh.revision > first.revision);

  world.observeTile(6, 5, 8);
  const staticRefresh = world.createLocalSnapshot({ x: 5, y: 5 }, 5, 0.1);
  assert.notStrictEqual(staticRefresh.blocked, enemyRefresh.blocked);
});

test('12. projectile prediction stops at cover unless passesCover is set', () => {
  const world = collisionWorld();
  world.upsertObject(40, 1, 4.5, 5.5);
  const baseShot = projectile({ startX: 3.5, startY: 5.5, angle: 0 });
  const baseInput = planningInput({
    position: { x: 5.5, y: 5.5 },
    goal: { x: 9.5, y: 5.5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    environment: world,
  });
  const blocked = plan({ ...baseInput, projectiles: [baseShot] });
  const passing = plan({
    ...baseInput,
    projectiles: [projectile({
      ...baseShot,
      definition: { passesCover: true },
    })],
  });

  assert.equal(blocked.earliestIntentCollisionMs, null);
  assert.ok(passing.earliestIntentCollisionMs !== null);
  assert.ok(passing.metrics.candidatesRejectedByProjectiles > 0);
});

test('13. several shot observations in one planning interval are coalesced', () => {
  const controller = testController();
  const initial = controller.evaluate(controllerSnapshot());
  controller.noteProjectileUpdate();
  controller.noteProjectileUpdate();
  controller.noteProjectileUpdate();
  const state = controller.evaluate(controllerSnapshot({
    time: 20,
    position: advance({ x: 5, y: 5 }, initial.velocity, 20),
    projectiles: [projectile({ startY: 9 })],
  }));

  assert.equal(state.planRevision, 1);
  assert.equal(state.plannerMetrics.totalPlans, 1);
  assert.ok(state.plannerMetrics.coalescedProjectileUpdates >= 2);
});

test('14. a harmless new shot does not request an unnecessary urgent replan', () => {
  const controller = testController();
  const initial = controller.evaluate(controllerSnapshot());
  const state = controller.evaluate(controllerSnapshot({
    time: 20,
    position: advance({ x: 5, y: 5 }, initial.velocity, 20),
    projectiles: [projectile({ startY: 9 })],
  }));

  assert.equal(state.planRevision, 1);
  assert.equal(state.replanReason, null);
  assert.equal(state.plannerMetrics.urgentReplans, 0);
});

test('moving bounded path goals are coalesced behind the normal replan cadence', () => {
  const controller = testController();
  const initial = controller.evaluate(controllerSnapshot());
  const beforeCadence = controller.evaluate(controllerSnapshot({
    time: 40,
    position: advance({ x: 5, y: 5 }, initial.velocity, 40),
    goal: { x: 10.25, y: 5 },
  }));
  assert.equal(beforeCadence.planRevision, 1);
  assert.equal(beforeCadence.replanReason, null);

  const onCadence = controller.evaluate(controllerSnapshot({
    time: 100,
    position: advance({ x: 5, y: 5 }, initial.velocity, 100),
    goal: { x: 10.5, y: 5 },
  }));
  assert.equal(onCadence.replanReason, 'normal');
  assert.equal(onCadence.planRevision, 2);
});

test('15. a new shot threatening the committed segment forces an urgent replan', () => {
  const controller = testController();
  const initial = controller.evaluate(controllerSnapshot());
  const position = advance({ x: 5, y: 5 }, initial.velocity, 50);
  controller.noteProjectileUpdate();
  const state = controller.evaluate(controllerSnapshot({
    time: 50,
    position,
    projectiles: [projectile({
      startX: position.x,
      startY: position.y,
      startTime: 50,
      definition: { speed: 0 },
    })],
  }));

  assert.equal(state.replanReason, 'urgent');
  assert.equal(state.planRevision, 2);
  assert.equal(state.plannerMetrics.urgentReplans, 1);
  assert.ok(state.plannerMetrics.trajectoryInvalidations > 0);
});

test('an unsafe update during urgent cooldown stays pending until the throttle opens', () => {
  const controller = testController();
  const harmless = projectile({ startY: 9 });
  const initial = controller.evaluate(controllerSnapshot({ projectiles: [harmless] }));
  const atTwenty = advance({ x: 5, y: 5 }, initial.velocity, 20);
  const threatening = projectile({
    bulletId: 2,
    startX: atTwenty.x,
    startY: atTwenty.y,
    startTime: 20,
    definition: { speed: 0 },
  });
  controller.noteProjectileUpdate();
  const throttled = controller.evaluate(controllerSnapshot({
    time: 20,
    position: atTwenty,
    projectiles: [harmless, threatening],
  }));
  assert.equal(throttled.replanReason, null);
  assert.equal(throttled.plannerMetrics.urgentReplans, 1);

  const atForty = advance(atTwenty, throttled.velocity, 20);
  const replanned = controller.evaluate(controllerSnapshot({
    time: 40,
    position: atForty,
    projectiles: [harmless, threatening],
  }));
  assert.equal(replanned.replanReason, 'urgent');
  assert.equal(replanned.plannerMetrics.urgentReplans, 2);
});

test('16. symmetric alternatives do not cause repeated left-right oscillation', () => {
  const controller = testController();
  let position = { x: 5, y: 5 };
  const shot = projectile();
  let state = controller.evaluate(controllerSnapshot({ projectiles: [shot] }));
  const lateralSigns: number[] = [];

  for (let time = 20; time <= 240; time += 20) {
    position = advance(position, state.velocity, 20);
    if (Math.abs(state.velocity.y) > 1e-6) lateralSigns.push(Math.sign(state.velocity.y));
    state = controller.evaluate(controllerSnapshot({ time, position, projectiles: [shot] }));
  }

  assert.ok(lateralSigns.length > 3);
  assert.equal(new Set(lateralSigns).size, 1);
});

test('17. bounded beam pruning preserves the retreat route away from the goal', () => {
  const result = plan(retreatInput(), { maxStatesPerLayer: 64 });

  assert.ok(result.metrics.statesPrunedByBeam > 0);
  assert.equal(result.reachesHorizon, true);
  assert.ok(result.trajectory.waypoints.some((waypoint) => waypoint.x < 4.5));
  assert.ok(result.trajectory.waypoints.at(-1)!.x > 7);
});

test('18. an authoritative correction discards and rebases the trajectory', () => {
  const controller = testController();
  const initial = controller.evaluate(controllerSnapshot());
  assert.equal(initial.trajectory?.createdAt, 0);

  controller.rebase({ x: 2, y: 2 }, 50);
  const rebased = controller.getState();
  assert.equal(rebased.trajectory, null);
  assert.equal(rebased.replanCause, 'correction');
  assert.equal(rebased.searchRevision, 1);
  assert.equal(rebased.planCommitted, false);
  const corrected = controller.evaluate(controllerSnapshot({
    time: 50,
    position: { x: 2, y: 2 },
    goal: { x: 4, y: 2 },
  }));

  assert.equal(corrected.trajectory?.createdAt, 50);
  assert.equal(corrected.searchRevision, 2);
  assert.ok(corrected.trajectory!.waypoints[0]!.x < 3);
  assert.ok(corrected.plannerMetrics.trajectoryInvalidations > 0);
});

test('19. jump candidates stay unavailable in recovering, pending, and backoff states', () => {
  const input = emergencyJumpInput();
  const statuses: DodgeJumpStatus[] = [
    'recovering',
    'awaiting_move',
    'awaiting_confirmation',
    'backoff',
  ];

  for (const jumpStatus of statuses) {
    const controller = testController();
    controller.setEnabled(true, { projectileJump: true, maxJumpDistance: 1 });
    const state = controller.evaluate({
      ...input,
      jumpAllowance: 1,
      jumpStatus,
    });
    assert.equal(state.jumpTarget, null, `generated a jump while ${jumpStatus}`);
    assert.notEqual(state.decision, 'danger_jump');
  }
});

test('20. an emergency jump is committed once and handles confirmation or rejection', () => {
  const input = emergencyJumpInput();
  const controller = testController();
  controller.setEnabled(true, { projectileJump: true, maxJumpDistance: 1 });
  const proposed = controller.evaluate({
    ...input,
    jumpAllowance: 1,
    jumpStatus: 'ready',
  });
  assert.equal(proposed.decision, 'danger_jump');
  assert.ok(proposed.jumpTarget);

  const limiter = new DodgeJumpLimiter();
  assert.equal(limiter.commit(1000, input.position, proposed.jumpTarget!), true);
  assert.equal(limiter.commit(1000, input.position, proposed.jumpTarget!), false);
  controller.resolveJumpAttempt(true, 1000);
  limiter.markSent(1020, proposed.jumpTarget!);
  limiter.observeAuthoritative(1200, proposed.jumpTarget!);
  assert.equal(limiter.getState(1200).lastOutcome, 'confirmed');

  const rejected = new DodgeJumpLimiter();
  assert.equal(rejected.commit(2000, input.position, proposed.jumpTarget!), true);
  rejected.markSent(2020, proposed.jumpTarget!);
  rejected.observeAuthoritative(2400, input.position);
  assert.equal(rejected.getState(2400).status, 'backoff');
  assert.equal(rejected.consumeCorrectionRebase(), true);
  controller.resolveJumpAttempt(false, 2400);
  controller.rebase(input.position, 2400);
  assert.equal(controller.getState().trajectory, null);
});

test('21. no valid trajectory produces a finite controlled stop', () => {
  const result = plan(planningInput({
    environment: {
      canOccupy: () => false,
      isProjectileSegmentOpen: () => true,
      enemyClearance: () => Infinity,
      getRevision: () => 0,
    },
  }));

  assert.equal(result.fallback, 'stop');
  assert.equal(result.reachesHorizon, false);
  assert.ok(result.trajectory.waypoints.length > 0);
  for (const waypoint of result.trajectory.waypoints) {
    assert.ok(Number.isFinite(waypoint.x));
    assert.ok(Number.isFinite(waypoint.y));
    assert.ok(Number.isFinite(waypoint.speed));
    assert.deepEqual({ x: waypoint.x, y: waypoint.y }, { x: 5, y: 5 });
  }
});

test('22. identical world state and inputs produce deterministic search results', () => {
  const input = planningInput({ projectiles: [projectile()] });
  const first = plan(input);
  const second = plan(input);

  assert.deepEqual(trajectorySignature(first), trajectorySignature(second));
});

test('planner metrics expose layer, rejection, merge, beam, and duration data', () => {
  const result = plan(planningInput({ projectiles: [projectile()] }));

  assert.ok(result.metrics.planningDurationMs >= 0);
  assert.ok(result.metrics.layerCount > 0);
  assert.equal(result.metrics.statesEnteringLayers.length, result.metrics.layerCount + 1);
  assert.ok(result.metrics.candidatesGenerated > 0);
  assert.ok(result.metrics.candidatesRejectedByProjectiles > 0);
  assert.ok(result.metrics.statesMerged > 0);
  assert.ok(result.metrics.statesPrunedByBeam > 0);
  assert.equal(result.metrics.activeProjectilesConsidered, 1);
});

// Walks a projectile's actual trajectory (via predictProjectilePosition) at
// 15 ms steps from t=0 to t=horizonMs, returning the first time the sample
// enters the player's collision radius. Used as ground truth for the four
// nonlinear-projectile coverage tests below.
function analyticalFirstImpact(
  playerX: number,
  playerY: number,
  hitRadius: number,
  proj: CombatProjectileSnapshot,
  horizonMs: number,
  stepMs = 15,
): number | null {
  for (let t = 0; t <= horizonMs; t += stepMs) {
    const pos = predictProjectilePosition(proj, t);
    const distance = Math.hypot(pos.x - playerX, pos.y - playerY);
    if (distance <= hitRadius) return t;
  }
  return null;
}

test('wavy projectile is classified as nonlinear and its swing catches a stationary player', () => {
  // wavy definition: angular jitter ± π/64 * sin(6π t/lifetime). At speed=100,
  // amplitude=1, frequency=2 the trajectory swings ~1 tile above/below y=5
  // mid-flight. A linear-classified fallback would collapse to segment along
  // y=5 and treat the player at (5,5) as safe from a shot fired at (0,5).
  const proj: CombatProjectileSnapshot = {
    ...projectile({
      startX: 0, startY: 5, angle: 0,
      definition: {
        speed: 100, lifetimeMs: 1000,
        amplitude: 1, frequency: 2, magnitude: 3, wavy: true,
      },
    }),
  };
  const input = planningInput({
    projectiles: [proj],
    intentVelocity: { x: 0, y: 0 },
    moveSpeed: 0.0001, // hold player nearly still
  });
  const result = plan(input);

  assert.ok(result.earliestIntentCollisionMs !== null,
    'wavy projectile must be seen as a threat when classified nonlinear');
  assert.ok(result.metrics.candidatesRejectedByProjectiles > 0,
    'wavy projectile must reject some candidates');
  const golden = analyticalFirstImpact(5, 5, 0.5, proj, 1000);
  assert.ok(golden !== null,
    'sanity: analytical walk must confirm the shot actually hits');
  assert.ok(
    Math.abs((result.earliestIntentCollisionMs ?? Infinity) - golden) < 30,
    `earliestIntentCollisionMs=${result.earliestIntentCollisionMs} within 30 ms of golden=${golden}`,
  );
});

test('parametric projectile is classified as nonlinear and its swing catches a stationary player', () => {
  // parametric traces a sin(t) x sin(2t) figure-eight scaled by magnitude.
  // Player at (0.5, 5), projectile origin (5, 5): the parametric envelope
  // reaches into (~0.5, 5) neighborhood mid-flight. Linear fallback (speed=0)
  // would collapse to the origin point, missing every impact.
  const proj: CombatProjectileSnapshot = {
    ...projectile({
      startX: 5, startY: 5, angle: 0,
      definition: {
        speed: 0, lifetimeMs: 1000,
        parametric: true, magnitude: 3,
      },
    }),
  };
  const input = planningInput({
    position: { x: 0.5, y: 5 },
    goal: { x: -3, y: 5 },
    intentVelocity: { x: 0, y: 0 },
    moveSpeed: 0.0001,
    projectiles: [proj],
  });
  const result = plan(input);
  const golden = analyticalFirstImpact(0.5, 5, 0.5, proj, 1000);

  if (golden === null) {
    // Parametric geometry may sweep just outside 0.5 hit-radius depending on
    // magnitude and phase — accept an "unhit" analytical outcome as long as
    // the planner also reports no impact. What we're pinning is planner /
    // analytical agreement, not a specific numeric.
    assert.equal(result.earliestIntentCollisionMs, null,
      'planner must agree with analytical: no impact');
    return;
  }
  assert.ok(result.earliestIntentCollisionMs !== null);
  assert.ok(
    Math.abs((result.earliestIntentCollisionMs ?? Infinity) - golden) < 30,
    `earliestIntentCollisionMs=${result.earliestIntentCollisionMs} within 30 ms of golden=${golden}`,
  );
});

test('boomerang projectile is classified as nonlinear and its return-leg catches the player', () => {
  // Boomerang: linear out to halfway then reverses. Halfway = lifetime *
  // baseSpeed / 2 = 5 tiles at speed=100. Player at (3, 5), origin (0, 5):
  // outbound catches at t≈300, return sweeps back through x=3 at t≈700.
  // Linear-fallback collapses to a straight segment past x=5 by t=500,
  // missing the return leg entirely.
  const proj: CombatProjectileSnapshot = {
    ...projectile({
      startX: 0, startY: 5, angle: 0,
      definition: {
        speed: 100, lifetimeMs: 1000, trajectoryLifetimeMs: 1000,
        boomerang: true,
      },
    }),
  };
  const input = planningInput({
    position: { x: 3, y: 5 },
    goal: { x: 3, y: 5 },
    intentVelocity: { x: 0, y: 0 },
    moveSpeed: 0.0001,
    projectiles: [proj],
  });
  const result = plan(input);

  assert.ok(result.earliestIntentCollisionMs !== null,
    'boomerang must be classified nonlinear and caught in the outbound sweep');
  const golden = analyticalFirstImpact(3, 5, 0.5, proj, 1000);
  assert.ok(golden !== null,
    'sanity: analytical walk must confirm boomerang crosses the player');
  assert.ok(
    Math.abs((result.earliestIntentCollisionMs ?? Infinity) - golden) < 30,
    `earliestIntentCollisionMs=${result.earliestIntentCollisionMs} within 30 ms of golden=${golden}`,
  );
});

test('accelerating projectile is classified as nonlinear and caught at its quadratic-integrated arrival time (P0 regression belt)', () => {
  // acceleration=200, speedClamp=-1: quadratic motion. Player at (5, 5),
  // projectile from (0, 5) angle=0. Linear-fallback classifies as straight
  // line with constant speed=0.01 tile/ms; would predict arrival at t=500.
  // Actual quadratic arrival: solve 5 = 0.01 t + 0.5 * (200/10000) * t²/1000
  //  -> t ≈ 386 ms (positive root of 5 = 0.01 t + 1e-5 t²).
  //
  // Also doubles as regression belt for the P0 `positionAt` freeze fix in
  // combat-tracker.ts:600 — if that fix were reverted, predictProjectileSegments
  // would emit zero-length segments 55 tiles away and this test would fail
  // both on the sanity "analytical walk confirms" and on the earliest-impact
  // comparison.
  const proj: CombatProjectileSnapshot = {
    ...projectile({
      startX: 0, startY: 5, angle: 0,
      definition: {
        speed: 100, lifetimeMs: 2000,
        acceleration: 200, accelerationDelay: 0, speedClamp: -1,
      },
    }),
  };
  const input = planningInput({
    projectiles: [proj],
    intentVelocity: { x: 0, y: 0 },
    moveSpeed: 0.0001,
  });
  const result = plan(input);

  assert.ok(result.earliestIntentCollisionMs !== null,
    'accelerating projectile must be classified nonlinear and caught');
  const golden = analyticalFirstImpact(5, 5, 0.5, proj, 1000);
  assert.ok(golden !== null,
    'sanity: analytical walk MUST confirm accelerated impact — if this fails, ' +
    'the P0 positionAt fix has regressed');
  assert.ok(
    Math.abs((result.earliestIntentCollisionMs ?? Infinity) - golden) < 30,
    `earliestIntentCollisionMs=${result.earliestIntentCollisionMs} within 30 ms of golden=${golden}`,
  );
});

test('combat-range findEmergencyJump respects hardMinimumRange and retreatPenaltyScale', () => {
  const planner = testPlanner();
  // Combat target at (7.5, 5). Player at (5, 5) with combat_range intent.
  // hardMinimumRange=1.3 defines the "must not enter" ring around the target.
  const combatInput: DodgePlanningInput = {
    ...emergencyJumpInput(),
    intent: combatIntent({
      targetId: 42,
      targetX: 7.5,
      targetY: 5,
      hardMinimumRange: 1.3,
      preferredMinimumRange: 2,
      preferredMaximumRange: 3,
    }),
    // Open environment on the plane so many directions are landable.
    environment: OPEN_ENVIRONMENT,
    retreatPenaltyScale: 1,
  };

  const pressured = planner.findEmergencyJump(combatInput, 1.5);
  assert.ok(pressured !== undefined,
    'expected findEmergencyJump to return a landing under retreatPenaltyScale=1');
  assert.ok(
    Math.hypot(pressured.target.x - 7.5, pressured.target.y - 5) >= 1.3 - 1e-6,
    `landing must respect hardMinimumRange (>=1.3), got distance ${Math.hypot(pressured.target.x - 7.5, pressured.target.y - 5)}`,
  );

  // Sub-case (b): retreatPenaltyScale=0 zeroes the terminalCombatTooFar
  // contribution to the score. Regardless of that, hardMinimumRange must
  // still hold — pinning the invariant against a regression that ties
  // hardMinimumRange enforcement to the retreat-scale multiplier.
  const relaxed = planner.findEmergencyJump({
    ...combatInput,
    retreatPenaltyScale: 0,
  }, 1.5);
  assert.ok(relaxed !== undefined);
  assert.ok(
    Math.hypot(relaxed.target.x - 7.5, relaxed.target.y - 5) >= 1.3 - 1e-6,
    'hardMinimumRange must hold regardless of retreatPenaltyScale',
  );
});

test('evaluateEdge rejects candidates moving toward an enemy already inside the hard zone', () => {
  // Player starts inside ENEMY_AVOID_RADIUS of the enemy: monotonic escape
  // is the only legal move. Any candidate that steps closer must be rejected
  // (candidatesRejectedByGeometry increments); any that steps away must be
  // acceptable (some trajectory ending with monotonic distances survives).
  const enemy = { x: 5.5, y: 5 };
  const result = plan(planningInput({
    position: { x: 5, y: 5 },
    goal: undefined,
    intentVelocity: { x: -0.006, y: 0 },
    environment: {
      getRevision: () => 0,
      canOccupy: () => true,
      enemyClearance: (x, y) => Math.hypot(x - enemy.x, y - enemy.y),
      isProjectileSegmentOpen: () => true,
    },
  }));
  assert.ok(result.metrics.candidatesRejectedByGeometry > 0,
    'some inward candidates must have been rejected by the monotonic-escape guard');
  const distances = result.trajectory.waypoints.map((waypoint) => (
    Math.hypot(waypoint.x - enemy.x, waypoint.y - enemy.y)
  ));
  let prior = Math.hypot(5 - enemy.x, 5 - enemy.y);
  for (const distance of distances) {
    if (prior >= ENEMY_AVOID_RADIUS - 1e-6) break;
    assert.ok(distance + 1e-6 >= prior,
      `trajectory must monotonically escape while inside hard zone; ${prior} -> ${distance}`);
    prior = distance;
  }
  assert.ok(result.minimumEnemyClearance >= 0,
    'no waypoint may be closer to the enemy than the enemy centre');
});

test('predictProjectileSegments skips non-enemy, hit, future, and expired projectiles', () => {
  // Baseline: one live enemy projectile that WILL be considered.
  const live = projectile({
    startX: 4, startY: 5, angle: 0,
    definition: { speed: 100, lifetimeMs: 1000 },
  });
  const nonEnemy: CombatProjectileSnapshot = {
    ...projectile({ startX: 4, startY: 5, angle: 0, bulletId: 2 }),
    side: 'own',
  };
  const alreadyHit: CombatProjectileSnapshot = {
    ...projectile({ startX: 4, startY: 5, angle: 0, bulletId: 3 }),
    hitObjects: new Set<number>([10]),
  };
  const horizonMs = 1000;
  // startTime = input.time + horizonMs + 1 clears the strict `>` inequality
  // that gates the "future" case in predictProjectileSegments.
  const future: CombatProjectileSnapshot = projectile({
    startX: 4, startY: 5, angle: 0, bulletId: 4,
    startTime: 0 + horizonMs + 1,
  });
  const expired: CombatProjectileSnapshot = projectile({
    startX: 4, startY: 5, angle: 0, bulletId: 5,
    // startTime + lifetimeMs < input.time (0). lifetimeMs default is 1000,
    // so startTime = -1001 puts startTime+lifetimeMs = -1 < 0.
    startTime: -1001,
  });

  const skippedOnly = plan(planningInput({
    projectiles: [nonEnemy, alreadyHit, future, expired],
  }));
  assert.equal(skippedOnly.metrics.activeProjectilesConsidered, 0,
    'projectiles matching any of the four skip guards must not be counted');

  const withLive = plan(planningInput({
    projectiles: [nonEnemy, alreadyHit, future, expired, live],
  }));
  assert.equal(withLive.metrics.activeProjectilesConsidered, 1,
    'only the single live enemy projectile survives all four guards');
});

test('dwelling AoE catches a player transiting through the blast during dwell', () => {
  // Player at (3, 5) moving east at 0.006 tile/ms toward goal (10, 5).
  // AoE lands at t=100ms centered at (5, 5) with radius=1 and dwells 400 ms.
  // Player positions along the intent line: t=100 -> 3.6 (clearance 1.4, safe),
  // t=250 -> 4.5 (clearance 0.5, INSIDE the blast), t=500 -> 6.0 (exit).
  // Pre-fix: sampled only at t=100 (landing), single-clearance 1.4, safe.
  // Post-fix: sweeps the [100, 500] window and catches the impact around t=250.
  const result = plan(planningInput({
    position: { x: 3, y: 5 },
    goal: { x: 10, y: 5 },
    aoes: [{ x: 5, y: 5, radius: 1, landingTime: 100, blastDurationMs: 400 }],
  }));
  assert.ok(result.earliestIntentCollisionMs !== null,
    'expected the dwelling AoE to be detected as a first-impact');
  assert.ok((result.earliestIntentCollisionMs ?? Infinity) <= 300,
    `expected first-impact <= 300ms (mid-dwell transit), got ${result.earliestIntentCollisionMs}`);
});

test('single-frame AoE (no blastDurationMs) preserves pre-P3 semantics', () => {
  // Explicit blastDurationMs === 0 and blastDurationMs === undefined must both
  // produce identical planner output — the P3 windowed loop's fast-path for
  // dwellMs=0 is single-sample-at-landing, byte-for-byte matching the old
  // single-frame behavior.
  const undefinedDwell = plan(planningInput({
    aoes: [{ x: 6, y: 5, radius: 0.6, landingTime: 200 }],
  }));
  const zeroDwell = plan(planningInput({
    aoes: [{ x: 6, y: 5, radius: 0.6, landingTime: 200, blastDurationMs: 0 }],
  }));
  assert.deepStrictEqual(trajectorySignature(zeroDwell), trajectorySignature(undefinedDwell));
});

test('normalizeCostWeights sanitises NaN, Infinity, and negative overrides', () => {
  // Pollute every documented cost knob with a non-finite / negative override.
  // If the sanitiser drops the isFinite guard or the < 0 guard, cumulativeCost
  // / terminalScore / firstControl / earliestIntentCollisionMs would diverge
  // from a clean planner on the same deterministic input.
  const clean = plan(planningInput({
    projectiles: [projectile({ startX: 4, startY: 5, angle: 0, definition: { speed: 100 } })],
  }));
  const polluted = plan(planningInput({
    projectiles: [projectile({ startX: 4, startY: 5, angle: 0, definition: { speed: 100 } })],
  }), {
    costWeights: {
      basePerSecond: NaN,
      projectileRiskPerSecond: -5,
      incompleteHorizonPerSecond: Infinity,
      terminalGoalDistance: -0.001,
    },
  });
  assert.deepStrictEqual(trajectorySignature(polluted), trajectorySignature(clean));
});

test('normalizeTimeLayers falls back to DEFAULT_TIME_LAYERS_MS on pathological inputs', () => {
  const baseline = plan(planningInput({
    projectiles: [projectile({ startX: 4, startY: 5, angle: 0, definition: { speed: 100 } })],
  }));
  // Case (a): first layer != 0.
  const nonZeroStart = plan(planningInput({
    projectiles: [projectile({ startX: 4, startY: 5, angle: 0, definition: { speed: 100 } })],
  }), { timeLayersMs: [100, 200, 300] });
  assert.deepStrictEqual(trajectorySignature(nonZeroStart), trajectorySignature(baseline));
  // Case (b): fewer than 3 layers.
  const tooShort = plan(planningInput({
    projectiles: [projectile({ startX: 4, startY: 5, angle: 0, definition: { speed: 100 } })],
  }), { timeLayersMs: [0, 100] });
  assert.deepStrictEqual(trajectorySignature(tooShort), trajectorySignature(baseline));
  // Case (c): non-monotonic (duplicate) layers.
  const duplicate = plan(planningInput({
    projectiles: [projectile({ startX: 4, startY: 5, angle: 0, definition: { speed: 100 } })],
  }), { timeLayersMs: [0, 200, 200, 400] });
  assert.deepStrictEqual(trajectorySignature(duplicate), trajectorySignature(baseline));
});

test('projectile iteration order does not affect plan result (determinism)', () => {
  const a = projectile({
    ownerId: 100, bulletId: 1, startX: 4, startY: 5, angle: 0,
    definition: { speed: 100 },
  });
  const b = projectile({
    ownerId: 200, bulletId: 2, startX: 4, startY: 4.5, angle: 0,
    definition: { speed: 100 },
  });
  const forward = plan(planningInput({ projectiles: [a, b] }));
  const reversed = plan(planningInput({ projectiles: [b, a] }));
  assert.deepStrictEqual(trajectorySignature(reversed), trajectorySignature(forward));
});

test('aoe iteration order does not affect plan result (determinism)', () => {
  const a = { x: 6, y: 4.8, radius: 0.7, landingTime: 150 };
  const b = { x: 6.5, y: 5.1, radius: 0.6, landingTime: 250 };
  const forward = plan(planningInput({ aoes: [a, b] }));
  const reversed = plan(planningInput({ aoes: [b, a] }));
  assert.deepStrictEqual(trajectorySignature(reversed), trajectorySignature(forward));
});

function testPlanner(options: ConstructorParameters<typeof SpaceTimeDodgePlanner>[0] = {}) {
  return new SpaceTimeDodgePlanner({ maxStatesPerLayer: 64, ...options });
}

function plan(
  input: DodgePlanningInput,
  options: ConstructorParameters<typeof SpaceTimeDodgePlanner>[0] = {},
): DodgePlanningResult {
  return testPlanner(options).plan(input, 'normal');
}

function planningInput(overrides: Partial<DodgePlanningInput> = {}): DodgePlanningInput {
  return {
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.006,
    intentVelocity: { x: 0.006, y: 0 },
    movementLeadMs: 0,
    projectiles: [],
    aoes: [],
    environment: OPEN_ENVIRONMENT,
    safeWalk: true,
    ...overrides,
  };
}

function combatIntent(overrides: Partial<{
  targetId: number;
  targetX: number;
  targetY: number;
  hardMinimumRange: number;
  preferredMinimumRange: number;
  preferredMaximumRange: number;
}> = {}) {
  return {
    mode: 'combat_range' as const,
    targetId: 42,
    targetX: 10,
    targetY: 5,
    hardMinimumRange: 1.3,
    preferredMinimumRange: 2,
    preferredMaximumRange: 3,
    ...overrides,
  };
}

function timedCorridorInput(): DodgePlanningInput {
  return planningInput({
    projectiles: [projectile({
      startX: 6,
      startY: 0,
      angle: Math.PI / 2,
      definition: { speed: 200 },
    })],
    environment: {
      canOccupy: (_x, y) => Math.abs(y - 5) < 0.03,
      isProjectileSegmentOpen: () => true,
      enemyClearance: () => Infinity,
      getRevision: () => 0,
    },
  });
}

function retreatInput(): DodgePlanningInput {
  return planningInput({
    projectiles: [projectile({
      startX: 7,
      startY: 5,
      angle: Math.PI,
      definition: { lifetimeMs: 250 },
    })],
    environment: {
      canOccupy: (x, y) => x >= 0 && x <= 12 && Math.abs(y - 5) < 0.03,
      isProjectileSegmentOpen: () => true,
      enemyClearance: () => Infinity,
      getRevision: () => 0,
    },
  });
}

function emergencyJumpInput(): DodgePlanningInput & {
  jumpAllowance?: number;
  jumpStatus?: DodgeJumpStatus;
} {
  return planningInput({
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    projectiles: [projectile({
      startX: 4,
      startY: 5,
      angle: 0,
      definition: { lifetimeMs: 120 },
    })],
    environment: {
      canOccupy: (x, y) => x >= 0 && x <= 12 && Math.abs(y - 5) < 0.03,
      isProjectileSegmentOpen: () => true,
      enemyClearance: () => Infinity,
      getRevision: () => 0,
    },
  });
}

type ProjectileOverrides = Partial<Omit<CombatProjectileSnapshot, 'definition' | 'hitObjects'>> & {
  definition?: Partial<CombatProjectileDefinition>;
  hitObjects?: ReadonlySet<number>;
};

function projectile(overrides: ProjectileOverrides = {}): CombatProjectileSnapshot {
  const { definition, hitObjects, ...values } = overrides;
  return {
    side: 'enemy',
    bulletId: 1,
    bulletType: 0,
    ownerId: 20,
    containerType: 100,
    startX: 10,
    startY: 5,
    angle: Math.PI,
    startTime: 0,
    damage: 100,
    ...values,
    definition: { ...PROJECTILE_DEFINITION, ...definition },
    hitObjects: hitObjects ?? new Set<number>(),
  };
}

function testController(): PredictiveAutoDodgeController {
  const controller = new PredictiveAutoDodgeController({ maxStatesPerLayer: 64 });
  controller.setEnabled(true);
  return controller;
}

function controllerSnapshot(overrides: Partial<DodgePlanningInput> = {}) {
  return planningInput(overrides);
}

function advance(
  position: { x: number; y: number },
  velocity: { x: number; y: number },
  durationMs: number,
) {
  return {
    x: position.x + velocity.x * durationMs,
    y: position.y + velocity.y * durationMs,
  };
}

function collisionWorld(): DodgeCollisionWorld {
  const data: CombatDataProvider = {
    getObject: (type) => type === 1
      ? { isEnemy: false, occupySquare: true }
      : undefined,
    getProjectile: () => undefined,
    getTileDamage: (type) => type === 9 ? 100 : 0,
    tileIsBlockingWalk: (type) => type === 8,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(12, 12);
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) world.observeTile(x, y, 0);
  }
  return world;
}

function assertTrajectoryOccupies(
  world: DodgeCollisionWorld,
  start: { x: number; y: number },
  result: DodgePlanningResult,
): void {
  let previous = start;
  for (const waypoint of result.trajectory.waypoints) {
    const distance = Math.hypot(waypoint.x - previous.x, waypoint.y - previous.y);
    const samples = Math.max(1, Math.ceil(distance / 0.05));
    for (let sample = 1; sample <= samples; sample++) {
      const ratio = sample / samples;
      const x = previous.x + (waypoint.x - previous.x) * ratio;
      const y = previous.y + (waypoint.y - previous.y) * ratio;
      assert.equal(world.canOccupy(x, y, true), true, `trajectory entered (${x}, ${y})`);
    }
    previous = waypoint;
  }
}

function trajectorySignature(result: DodgePlanningResult) {
  return {
    trajectory: result.trajectory,
    cumulativeCost: result.cumulativeCost,
    terminalScore: result.terminalScore,
    safeThroughMs: result.safeThroughMs,
    reachesHorizon: result.reachesHorizon,
    fallback: result.fallback,
    firstControl: result.firstControl,
    minimumProjectileClearance: result.minimumProjectileClearance,
    minimumEnemyClearance: result.minimumEnemyClearance,
    activeProjectileCount: result.activeProjectileCount,
    earliestIntentCollisionMs: result.earliestIntentCollisionMs,
  };
}
