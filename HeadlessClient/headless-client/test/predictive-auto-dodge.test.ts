import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CombatDataProvider,
  CombatProjectileDefinition,
  CombatProjectileSnapshot,
} from '../src/combat-tracker';
import { DodgeCollisionWorld, ENEMY_AVOID_RADIUS } from '../src/dodge-collision-world';
import { MovementController } from '../src/movement-controller';
import {
  PredictiveAutoDodgeController,
  ThrownAoeTracker,
  type AutoDodgeEnvironment,
} from '../src/predictive-auto-dodge';

const definition: CombatProjectileDefinition = {
  speed: 100,
  lifetimeMs: 1000,
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

const openEnvironment: AutoDodgeEnvironment = {
  canOccupy: () => true,
  isProjectileSegmentOpen: () => true,
};

test('predictive auto-dodge escapes an imminent projectile from standstill', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.ok(state.threatCount > 0);
  assert.ok(state.earliestImpactMs !== null && state.earliestImpactMs <= 250);
  assert.ok(state.trajectory?.waypoints.some((waypoint) => waypoint.speed > 0));
});

test('a full-speed escape stops promptly after its danger has passed', () => {
  const controller = new PredictiveAutoDodgeController({ maxStatesPerLayer: 64 });
  controller.setEnabled(true);
  const shot = {
    ...hostileProjectile(),
    startX: 4,
    definition: { ...definition, lifetimeMs: 120 },
  };
  const base = {
    playerId: 10,
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 0,
    projectiles: [shot],
    aoes: [],
    environment: openEnvironment,
  };
  let position = { x: 5, y: 5 };
  let state = controller.evaluate({ ...base, time: 0, position });

  assert.ok(Math.abs(Math.hypot(state.velocity.x, state.velocity.y) - base.moveSpeed) < 1e-9);

  let stoppedAt: number | null = null;
  for (let time = 20; time <= 400; time += 20) {
    position = {
      x: position.x + state.velocity.x * 20,
      y: position.y + state.velocity.y * 20,
    };
    state = controller.evaluate({ ...base, time, position });
    if (Math.hypot(state.velocity.x, state.velocity.y) < 1e-9) {
      stoppedAt = time;
      break;
    }
  }

  assert.ok(stoppedAt !== null && stoppedAt <= 350, `escape continued until ${stoppedAt}`);
  assert.ok(state.trajectory?.waypoints.some((waypoint) => waypoint.speed === 0));
});

test('combat retreat enters evasive state and recovers without an immediate reversal', () => {
  const controller = new PredictiveAutoDodgeController({ maxStatesPerLayer: 64 });
  controller.setEnabled(true);
  const shot = {
    ...hostileProjectile(),
    startX: 6,
    angle: Math.PI,
    definition: { ...definition, lifetimeMs: 120 },
  };
  const movementIntent = {
    mode: 'combat_range' as const,
    targetId: 42,
    targetX: 8,
    targetY: 5,
    hardMinimumRange: 1.3,
    preferredMinimumRange: 2,
    preferredMaximumRange: 3,
  };
  const base = {
    playerId: 10,
    goal: { x: 8, y: 5 },
    movementIntent,
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 0,
    aoes: [],
    environment: openEnvironment,
  };
  let position = { x: 5, y: 5 };
  let state = controller.evaluate({ ...base, time: 0, position, projectiles: [shot] });
  const initialScale = state.retreatPenaltyScale;
  let maximumRange = 3;
  let lastEvasiveVelocity = { ...state.velocity };
  let firstRecoveryVelocity: { x: number; y: number } | null = null;
  let recoveryScale = 0;

  assert.equal(state.safetyState, 'evasive');
  assert.ok(initialScale < 1);

  for (let time = 20; time <= 500; time += 20) {
    position = {
      x: position.x + state.velocity.x * 20,
      y: position.y + state.velocity.y * 20,
    };
    maximumRange = Math.max(maximumRange, Math.hypot(position.x - 8, position.y - 5));
    state = controller.evaluate({
      ...base,
      time,
      position,
      projectiles: time < 120 ? [shot] : [],
    });
    if (state.safetyState === 'evasive') lastEvasiveVelocity = { ...state.velocity };
    if (state.safetyState === 'recovering' && firstRecoveryVelocity === null) {
      firstRecoveryVelocity = { ...state.velocity };
      recoveryScale = state.retreatPenaltyScale;
    }
  }

  assert.ok(maximumRange > movementIntent.preferredMaximumRange + 0.2);
  assert.ok(recoveryScale < 1 && recoveryScale < initialScale);
  assert.ok(firstRecoveryVelocity !== null);
  assert.ok(
    lastEvasiveVelocity.x * firstRecoveryVelocity.x
      + lastEvasiveVelocity.y * firstRecoveryVelocity.y >= -1e-9,
    'recovery immediately reversed the evasive command',
  );
  assert.equal(state.safetyState, 'normal');
  assert.equal(state.retreatPenaltyScale, 1);
  const finalRange = Math.hypot(position.x - 8, position.y - 5);
  assert.ok(finalRange >= movementIntent.preferredMinimumRange - 0.1);
  assert.ok(finalRange <= movementIntent.preferredMaximumRange + 0.1);
});

test('predictive auto-dodge uses an exact 0.5 projectile collision box', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const touching = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [{
      ...hostileProjectile(),
      startX: 5,
      startY: 5.5,
      definition: { ...definition, speed: 0 },
    }],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(touching.earliestImpactMs, 0);
  assert.equal(touching.overrideActive, true);

  const outside = controller.evaluate({
    time: 100,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [{
      ...hostileProjectile(),
      startTime: 100,
      startX: 5,
      startY: 5.5001,
      definition: { ...definition, speed: 0 },
    }],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(outside.earliestImpactMs, null);
});

test('projectile jump remains unused while a legal continuous trajectory survives', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true, { projectileJump: true });
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    jumpAllowance: 0.73,
    jumpStatus: 'ready',
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: {
      canOccupy: (_x, y) => y >= 5,
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.decision, 'goal_path');
  assert.equal(state.jumpTarget, null);
  assert.equal(state.jumpDistance, 0);
  assert.ok(Math.hypot(state.velocity.x, state.velocity.y) > 0);
  assert.ok(state.trajectory?.waypoints.length);
});

test('predictive auto-dodge preserves a movement intent that already clears the shot', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true, { projectileJump: true });
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0.0096, y: 0 },
    movementLeadMs: 16,
    jumpAllowance: 1,
    jumpStatus: 'ready',
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, false);
  assert.equal(state.jumpTarget, null);
  assert.equal(state.decision, 'preserve_safe_intent');
  assert.deepEqual(state.velocity, { x: 0.0096, y: 0 });
});

test('enabled auto-dodge owns safe movement and derives velocity from the goal', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5, threshold: 0.1 },
    moveSpeed: 0.004,
    intentVelocity: { x: -0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.equal(state.decision, 'goal_path');
  assert.ok(Math.abs(state.velocity.x - 0.004) < 1e-12);
  assert.equal(state.velocity.y, 0);
  assert.deepEqual(state.target, state.path[0]);
  assert.ok(state.path.at(-1)!.x > state.path[0]!.x);
  assert.ok(state.path.every((point) => point.y === 5));
  assert.equal(state.path.length, 2, 'straight time samples should collapse into one route vector');
});

test('rolling local goals reuse a plan when the global goal identity is stable', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const movementIntent = {
    mode: 'goal' as const,
    goalX: 50,
    goalY: 5,
    goalId: 'realm-center',
    arriveThreshold: 0.5,
  };
  let position = { x: 5, y: 5 };
  let state = controller.evaluate({
    time: 0,
    playerId: 10,
    position,
    goal: { x: 10, y: 5 },
    movementIntent,
    routeRevision: 1,
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  });

  for (let frame = 1; frame <= 10; frame++) {
    position = {
      x: position.x + state.velocity.x * 112,
      y: position.y + state.velocity.y * 112,
    };
    state = controller.evaluate({
      time: frame * 112,
      playerId: 10,
      position,
      goal: { x: position.x + 5, y: 5 },
      movementIntent,
      routeRevision: 1,
      moveSpeed: 0.004,
      intentVelocity: { x: 0.004, y: 0 },
      movementLeadMs: 16,
      projectiles: [],
      aoes: [],
      environment: openEnvironment,
    });
  }

  assert.equal(state.planRevision, 2, 'only the horizon refresh should replace the original plan');
});

test('telemetry separates commit, rolling lookahead, and search-only updates', () => {
  const controller = new PredictiveAutoDodgeController({ maxStatesPerLayer: 64 });
  controller.setEnabled(true);
  const movementIntent = {
    mode: 'goal' as const,
    goalX: 20,
    goalY: 5,
    goalId: 'stable-goal',
  };
  const base = {
    playerId: 10,
    goal: { x: 10, y: 5 },
    movementIntent,
    routeRevision: 1,
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 0,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  };
  let position = { x: 5, y: 5 };
  const committed = controller.evaluate({ ...base, time: 0, position });

  assert.equal(committed.searchRevision, 1);
  assert.equal(committed.planRevision, 1);
  assert.equal(committed.searchPerformed, true);
  assert.equal(committed.planCommitted, true);
  assert.equal(committed.replanCause, 'initial');
  assert.equal(committed.movementIntentMode, 'goal');
  assert.ok(Math.abs(committed.commandedSpeed - 0.004) < 1e-9);
  assert.ok(Math.abs(committed.progressSpeed - 0.004) < 1e-9);
  assert.equal(committed.firstControlHeading, 0);
  assert.equal(committed.headingChange, null);
  assert.equal(committed.timeSinceLastMovementCommandMs, 0);

  position = {
    x: position.x + committed.velocity.x * 16,
    y: position.y + committed.velocity.y * 16,
  };
  const lookahead = controller.evaluate({ ...base, time: 16, position });
  assert.equal(lookahead.searchRevision, 1);
  assert.equal(lookahead.planRevision, 1);
  assert.equal(lookahead.searchPerformed, false);
  assert.equal(lookahead.planCommitted, false);
  assert.equal(lookahead.planReused, true);
  assert.equal(lookahead.lookaheadChanged, true);
  assert.ok(lookahead.lookaheadRevision > committed.lookaheadRevision);

  position = {
    x: position.x + lookahead.velocity.x * 84,
    y: position.y + lookahead.velocity.y * 84,
  };
  const searched = controller.evaluate({ ...base, time: 100, position });
  assert.equal(searched.searchRevision, 2);
  assert.equal(searched.planRevision, 1);
  assert.equal(searched.searchPerformed, true);
  assert.equal(searched.planCommitted, false);
  assert.equal(searched.planReused, true);
  assert.equal(searched.replanCause, 'periodic_refresh');
  assert.ok(Number.isFinite(searched.committedScore));
  assert.ok(Number.isFinite(searched.proposedScore));
  assert.equal(searched.comparisonHorizonMs, 350);
});

test('a logical goal id change immediately replaces the committed plan', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const base = {
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    routeRevision: 1,
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  };
  const initial = controller.evaluate({
    ...base,
    time: 0,
    movementIntent: { mode: 'goal', goalX: 20, goalY: 5, goalId: 'one' },
  });
  const changed = controller.evaluate({
    ...base,
    time: 16,
    movementIntent: { mode: 'goal', goalX: 20, goalY: 5, goalId: 'two' },
  });

  assert.equal(initial.planRevision, 1);
  assert.equal(changed.planRevision, 2);
  assert.equal(changed.planReused, false);
});

test('switching between goal and combat-range modes takes effect immediately', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const base = {
    playerId: 10,
    position: { x: 5, y: 5 },
    routeRevision: 1,
    moveSpeed: 0.004,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  };
  const goal = controller.evaluate({
    ...base,
    time: 0,
    goal: { x: 10, y: 5 },
    movementIntent: { mode: 'goal', goalX: 20, goalY: 5, goalId: 'goal' },
  });
  const combat = controller.evaluate({
    ...base,
    time: 16,
    movementIntent: {
      mode: 'combat_range',
      targetId: 42,
      targetX: 7.5,
      targetY: 5,
      hardMinimumRange: 1.3,
      preferredMinimumRange: 2,
      preferredMaximumRange: 3,
    },
  });
  const resumedGoal = controller.evaluate({
    ...base,
    time: 32,
    goal: { x: 10, y: 5 },
    movementIntent: { mode: 'goal', goalX: 20, goalY: 5, goalId: 'goal' },
  });

  assert.equal(goal.planRevision, 1);
  assert.equal(combat.planRevision, 2);
  assert.deepEqual(combat.velocity, { x: 0, y: 0 });
  assert.equal(combat.commandedSpeed, 0);
  assert.equal(combat.progressSpeed, 0);
  assert.equal(resumedGoal.planRevision, 3);
  assert.ok(resumedGoal.velocity.x > 0);
});

test('rolling planner replans only when a danger update invalidates the timed trajectory', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const goal = { x: 10, y: 5 };
  const base = {
    playerId: 10,
    goal,
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    aoes: [],
    environment: openEnvironment,
  };
  const initial = controller.evaluate({
    ...base,
    time: 0,
    position: { x: 5, y: 5 },
    projectiles: [],
  });
  assert.equal(initial.planRevision, 1);
  assert.equal(initial.planReused, false);

  const harmless = {
    ...hostileProjectile(),
    bulletId: 8,
    startY: 6.5,
  };
  const secondPosition = {
    x: 5 + initial.velocity.x * 16,
    y: 5 + initial.velocity.y * 16,
  };
  const harmlessUpdate = controller.evaluate({
    ...base,
    time: 16,
    position: secondPosition,
    projectiles: [harmless],
  });
  assert.equal(harmlessUpdate.planRevision, 1);
  assert.equal(harmlessUpdate.planReused, true);
  assert.ok(harmlessUpdate.dangerRevision > initial.dangerRevision);

  const futureAoe = { x: 6.6, y: 5, radius: 0.65, landingTime: 400 };
  const thirdPosition = {
    x: secondPosition.x + harmlessUpdate.velocity.x * 16,
    y: secondPosition.y + harmlessUpdate.velocity.y * 16,
  };
  const invalidated = controller.evaluate({
    ...base,
    time: 32,
    position: thirdPosition,
    projectiles: [],
    aoes: [futureAoe],
  });
  assert.equal(invalidated.planRevision, 2);
  assert.equal(invalidated.planReused, false);

  const fourthPosition = {
    x: thirdPosition.x + invalidated.velocity.x * 16,
    y: thirdPosition.y + invalidated.velocity.y * 16,
  };
  const stable = controller.evaluate({
    ...base,
    time: 48,
    position: fourthPosition,
    projectiles: [],
    aoes: [futureAoe],
  });
  assert.equal(stable.planRevision, 2);
  assert.equal(stable.planReused, true);
});

test('frequent harmless projectile updates do not thrash the active timed trajectory', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const base = {
    playerId: 10,
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    aoes: [],
    environment: openEnvironment,
  };
  let position = { x: 5, y: 5 };
  let state = controller.evaluate({ ...base, time: 0, position, projectiles: [] });
  const shots: CombatProjectileSnapshot[] = [];

  for (let frame = 1; frame <= 20; frame++) {
    position = {
      x: position.x + state.velocity.x * 16,
      y: position.y + state.velocity.y * 16,
    };
    const time = frame * 16;
    shots.push({
      ...hostileProjectile(),
      bulletId: 100 + frame,
      ownerId: 1000 + frame,
      startX: position.x - 1,
      startY: 6.5,
      startTime: time,
    });
    state = controller.evaluate({
      ...base,
      time,
      position,
      projectiles: shots,
    });
    assert.equal(state.planRevision, 1, `unexpected replan on frame ${frame}`);
    assert.equal(state.planReused, true);
    assert.ok(Math.abs(state.commandedSpeed - base.moveSpeed) < 1e-9);
    assert.ok(Math.abs(state.progressSpeed - base.moveSpeed) < 1e-9);
    assert.equal(state.firstControlHeading, 0);
    assert.equal(state.headingChange, null);
    assert.equal(state.timeSinceLastMovementCommandMs, 0);
  }

  assert.ok(state.dangerRevision >= 20);
  assert.equal(state.lastReplanAt, 0);
  assert.ok(state.searchRevision >= 3);
  assert.equal(state.planRevision, 1);
});

test('repeated combat target refreshes search without rotating the committed trajectory', () => {
  const controller = new PredictiveAutoDodgeController({ maxStatesPerLayer: 64 });
  controller.setEnabled(true);
  let position = { x: 5, y: 5 };
  let state = controller.evaluate({
    time: 0,
    playerId: 10,
    position,
    goal: { x: 9, y: 5 },
    movementIntent: {
      mode: 'combat_range',
      targetId: 42,
      targetX: 12,
      targetY: 5,
      hardMinimumRange: 1.3,
      preferredMinimumRange: 2,
      preferredMaximumRange: 3,
    },
    routeRevision: 0,
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 0,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  });

  for (let time = 50; time <= 500; time += 50) {
    position = {
      x: position.x + state.velocity.x * 50,
      y: position.y + state.velocity.y * 50,
    };
    const refresh = Math.floor(time / 250);
    state = controller.evaluate({
      time,
      playerId: 10,
      position,
      goal: { x: 9 + refresh * 0.4, y: 5 },
      movementIntent: {
        mode: 'combat_range',
        targetId: 42,
        targetX: 12 + refresh * 0.4,
        targetY: 5,
        hardMinimumRange: 1.3,
        preferredMinimumRange: 2,
        preferredMaximumRange: 3,
      },
      routeRevision: refresh,
      moveSpeed: 0.004,
      intentVelocity: { x: 0.004, y: 0 },
      movementLeadMs: 0,
      projectiles: [],
      aoes: [],
      environment: openEnvironment,
    });
    assert.equal(state.planRevision, 1, `target refresh committed at ${time} ms`);
  }

  assert.ok(state.plannerMetrics.totalPlans >= 6);
  assert.equal(state.planReused, true);
});

test('goal-owned dodge stops instead of bypassing local collision when no route exists', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 8, y: 5, threshold: 0.1 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: {
      canOccupy: () => false,
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.overrideActive, true);
  assert.equal(state.decision, 'goal_blocked');
  assert.deepEqual(state.velocity, { x: 0, y: 0 });
});

test('goal-blocked dodge throttles repeated searches while the collision snapshot is unchanged', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const snapshot = (time: number) => ({
    time,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 8, y: 5, threshold: 0.1 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: {
      canOccupy: () => false,
      isProjectileSegmentOpen: () => true,
    },
  });

  let state = controller.evaluate(snapshot(0));
  assert.equal(state.decision, 'goal_blocked');
  assert.equal(state.plannerMetrics.totalPlans, 1);

  for (const time of [16, 32, 64, 99]) state = controller.evaluate(snapshot(time));
  assert.equal(state.decision, 'goal_blocked');
  assert.equal(state.plannerMetrics.totalPlans, 1);
  assert.equal(state.searchPerformed, false);

  state = controller.evaluate(snapshot(100));
  assert.equal(state.decision, 'goal_blocked');
  assert.equal(state.plannerMetrics.totalPlans, 2);
  assert.equal(state.searchPerformed, true);
});

test('goal-owned dodge can leave an occupied starting tile accepted by global pathfinding', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5.2, y: 5.5 },
    goal: { x: 7.5, y: 5.5, threshold: 0.1 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: {
      canOccupy: (x, y) => Math.floor(x) !== 5 || Math.floor(y) !== 5,
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.decision, 'goal_path');
  assert.ok(state.velocity.x > 0, `expected egress toward the route, got ${state.velocity.x}`);
  assert.equal(state.velocity.y, 0);
});

test('goal-aware auto-dodge takes a lateral detour and resumes toward the waypoint', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [{ x: 6.25, y: 5, radius: 0.6, landingTime: 300 }],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.equal(state.decision, 'goal_path');
  assert.ok(state.velocity.x > 0, `expected forward progress, got ${state.velocity.x}`);
  assert.ok(Math.abs(state.commandedSpeed - 0.004) < 1e-9);
  assert.ok(state.progressSpeed > 0 && state.progressSpeed < state.commandedSpeed);
  assert.deepEqual(state.goal, { x: 10, y: 5 });
  assert.ok(state.path.length >= 2);
  assert.ok(state.path.some((point) => Math.abs(point.y - 5) > 0.2));
  assert.ok(state.path.at(-1)!.x > state.path[0]!.x, 'route should turn back toward the waypoint');
  assert.ok(routeTurnCount({ x: 5, y: 5 }, state.path) >= 1, 'route should contain a real turn');
});

test('goal-aware auto-dodge plans around a moving projectile crossing the route', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const projectile: CombatProjectileSnapshot = {
    ...hostileProjectile(),
    startX: 6.25,
    startY: 0,
    angle: Math.PI / 2,
  };
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [projectile],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.equal(state.decision, 'goal_path');
  assert.ok(state.path.length >= 2);
  assert.ok(state.path.some((point) => Math.abs(point.y - 5) > 0.2));
  assert.ok(state.path.at(-1)!.x > state.path[0]!.x, 'route should recover forward progress');
});

test('time-layered danger search uses non-cardinal vectors in a narrow angular route', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const slope = Math.tan(Math.PI / 8);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: {
      canOccupy: (x, y) => x >= 6.5
        || x >= 5 && Math.abs(y - (5 + (x - 5) * slope)) <= 0.03,
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.decision, 'goal_path');
  const angle = Math.atan2(state.velocity.y, state.velocity.x);
  assert.ok(angle > 0.2 && angle < 0.5, `expected a shallow angular vector, got ${angle}`);
  assert.ok(Math.abs(angle / (Math.PI / 4) - Math.round(angle / (Math.PI / 4))) > 0.1);
  assert.ok(state.path.at(-1)!.x > state.path[0]!.x);
});

test('imminent goal collision produces a finite swept-safe timed trajectory', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 225,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0.0096, y: 0 },
    movementLeadMs: 16,
    projectiles: [{
      ...hostileProjectile(),
      definition: { ...definition, speed: 200 },
    }],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.ok(state.earliestImpactMs !== null && state.earliestImpactMs <= 120);
  assert.ok(state.trajectory?.waypoints.length);
  assert.ok(state.trajectory!.waypoints.every((waypoint) => (
    Number.isFinite(waypoint.x) && Number.isFinite(waypoint.y) && Number.isFinite(waypoint.speed)
  )));
  assert.ok(state.plannerMetrics.candidatesRejectedByProjectiles > 0);
});

test('goal path searches around threats without crossing static collision', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  let rejectedStaticCandidates = 0;
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [{ x: 6.25, y: 5, radius: 0.6, landingTime: 300 }],
    environment: {
      canOccupy: (_x, y, safeWalk) => {
        assert.equal(safeWalk, true);
        if (y < 5) rejectedStaticCandidates++;
        return y >= 5;
      },
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.decision, 'goal_path');
  assert.ok(rejectedStaticCandidates > 0);
  assert.ok(state.path.every((point) => point.y >= 5));
  assert.ok(state.path.some((point) => point.y > 5.2));
});

test('goal path arcs around an enemy exclusion circle while advancing', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const enemy = { x: 6.5, y: 5 };
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    goal: { x: 10, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: {
      canOccupy: () => true,
      enemyClearance: (x, y) => Math.hypot(x - enemy.x, y - enemy.y),
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.decision, 'goal_path');
  assert.ok(state.path.some((point) => Math.abs(point.y - enemy.y) > 0.3));
  assert.ok(state.path.every((point) => (
    Math.hypot(point.x - enemy.x, point.y - enemy.y) >= ENEMY_AVOID_RADIUS - 1e-9
  )));
  assert.ok(state.path.at(-1)!.x > state.path[0]!.x, 'route should recover forward progress');
});

test('predictive auto-dodge moves out of a thrown AOE before landing', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [{ x: 5, y: 5, radius: 1, landingTime: 200 }],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.equal(state.earliestImpactMs, 200);
  assert.ok(Math.hypot(state.velocity.x, state.velocity.y) > 0);
});

test('predictive auto-dodge starts moving as soon as a future impact is known', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [{ x: 5, y: 5, radius: 1, landingTime: 500 }],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, true);
  assert.equal(state.earliestImpactMs, 500);
  assert.notEqual(state.decision, 'impact_not_imminent');
});

test('predictive auto-dodge may cross an enemy buffer when it is the safe escape', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  let requestedWithoutEnemyAvoidance = false;
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: {
      canOccupy: (_x, _y, _safeWalk, avoidEnemies = true) => {
        if (!avoidEnemies) requestedWithoutEnemyAvoidance = true;
        return !avoidEnemies;
      },
      enemyClearance: () => 0.5,
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(requestedWithoutEnemyAvoidance, true);
  assert.equal(state.overrideActive, true);
});

test('predictive auto-dodge prefers a broad safe corridor over an isolated direction', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.004,
    intentVelocity: { x: 0.004, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [{ x: 5, y: 5, radius: 1.2, landingTime: 100 }],
    environment: {
      canOccupy: (x, y) => x <= 5 || Math.abs(y - 5) < 1e-8,
      isProjectileSegmentOpen: () => true,
    },
  });

  assert.equal(state.overrideActive, true);
  assert.ok(
    state.trajectory?.waypoints.some((waypoint) => waypoint.x < 5),
    'expected the timed trajectory to preserve the broad western corridor',
  );
});

test('dodge velocity overrides the active pathfinding waypoint velocity', () => {
  const movement = new MovementController();
  movement.setTarget({ x: 10, y: 5 }, 0.1);
  const snapshot = {
    playerSpeed: 75,
    playerSpeedBoost: 0,
    localPos: { x: 5, y: 5 },
    serverPos: { x: 5, y: 5 },
  };
  const intended = movement.getIntendedVelocity(snapshot);
  assert.ok(intended.x > 0);
  assert.equal(intended.y, 0);

  const update = movement.update(snapshot, 100, {
    velocityOverride: { x: 0, y: 0.0096 },
  });
  assert.equal(update.pos.x, 5);
  assert.ok(update.pos.y > 5);
  assert.equal(movement.hasTarget(), true);
});

test('thrown AOE tracker learns a radius for later matching effects', () => {
  const tracker = new ThrownAoeTracker();
  tracker.track(123, { x: 5, y: 5 }, 0.2, 0);
  tracker.recordAoe({ x: 5.25, y: 5 }, 3, 200);
  tracker.track(123, { x: 8, y: 8 }, 0.2, 300);

  const active = tracker.getActive(350);
  assert.equal(active.length, 1);
  assert.equal(active[0]?.radius, 3);
  assert.equal(active[0]?.landingTime, 500);
});

test('AutoDodgeState.plannerMetrics excludes wall-clock fields for replay determinism', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: openEnvironment,
  });
  const metrics = state.plannerMetrics as Record<string, unknown>;
  assert.equal(metrics.planningDurationMs, undefined,
    'planningDurationMs is wall-clock; must not appear on AutoDodgeState');
  assert.equal(metrics.averagePlanningDurationMs, undefined,
    'averagePlanningDurationMs is wall-clock-derived; must not appear on AutoDodgeState');
  assert.equal(metrics.worstPlanningDurationMs, undefined,
    'worstPlanningDurationMs is wall-clock-derived; must not appear on AutoDodgeState');
  assert.ok(typeof state.plannerMetrics.candidatesRejectedByProjectiles === 'number',
    'deterministic counter fields must still be present');
  assert.ok(typeof state.plannerMetrics.totalPlans === 'number');
});

test('two independent controllers produce byte-identical AutoDodgeState on identical input', () => {
  const buildEval = () => {
    const controller = new PredictiveAutoDodgeController();
    controller.setEnabled(true);
    return controller.evaluate({
      time: 300,
      playerId: 10,
      position: { x: 5, y: 5 },
      moveSpeed: 0.0096,
      intentVelocity: { x: 0, y: 0 },
      movementLeadMs: 16,
      projectiles: [hostileProjectile()],
      aoes: [],
      environment: openEnvironment,
    });
  };
  const stateA = buildEval();
  const stateB = buildEval();
  // Byte-identical replay across two independent controller instances. Pre-
  // P5 this failed on `planningDurationMs` differing between runs even for
  // byte-identical inputs. The `getDeterministicMetrics` split makes it pass.
  assert.deepStrictEqual(stateB, stateA);
});

test('dodge collision world rejects damaging and occupied tiles', () => {
  const data: CombatDataProvider = {
    getObject: (type) => type === 1
      ? { isEnemy: false, occupySquare: true }
      : type === 2
        ? { isEnemy: false, occupySquare: false, fullOccupy: true }
        : undefined,
    getProjectile: () => undefined,
    getTileDamage: (type) => type === 9 ? 100 : 0,
    tileIsBlockingWalk: (type) => type === 8,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(10, 10);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) world.observeTile(x, y, 0);
  }

  assert.equal(world.canOccupy(5.5, 5.5, true), true);
  world.observeTile(5, 5, 9);
  assert.equal(world.canOccupy(5.5, 5.5, true), false);
  assert.equal(world.canOccupy(5.5, 5.5, false), true);
  world.observeTile(5, 5, 0);
  world.upsertObject(20, 1, 5.5, 5.5);
  assert.equal(world.canOccupy(5.5, 5.5, true), false);
  world.removeObject(20);
  world.upsertObject(21, 2, 4.5, 5.5);
  assert.equal(world.canOccupy(5.25, 5.5, true), false);
});

test('dodge collision world treats unknown cells as open only for exploratory paths', () => {
  const data: CombatDataProvider = {
    getObject: () => undefined,
    getProjectile: () => undefined,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(10, 10);

  assert.equal(world.canOccupy(5.5, 5.5, true), false);
  world.setExplorativeUnknown(true);
  assert.equal(world.canOccupy(5.5, 5.5, true), true);
  assert.equal(world.canOccupy(-0.5, 5.5, true), false);

  world.observeTile(5, 5, 0xffff);
  assert.equal(world.canOccupy(5.5, 5.5, true), false);
  world.observeTile(5, 5, 0);
  world.markBlocked(6, 5);
  assert.equal(world.canOccupy(5.75, 5.5, true), false);

  world.setExplorativeUnknown(false);
  assert.equal(world.canOccupy(4.5, 4.5, true), false);
});

test('dodge collision world keeps candidates one tile from projectile-capable enemies', () => {
  const data: CombatDataProvider = {
    getObject: (type) => {
      if (type === 3) return { isEnemy: true, hasProjectiles: true, occupySquare: false };
      if (type === 4) return { isEnemy: true, invincible: true, occupySquare: false };
      if (type === 5) return { isEnemy: true, occupySquare: false };
      if (type === 6) return { isEnemy: true, occupySquare: true };
      return undefined;
    },
    getProjectile: () => undefined,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(10, 10);
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) world.observeTile(x, y, 0);
  }

  world.upsertObject(30, 3, 5.5, 5.5);
  assert.equal(world.canOccupy(5.5 + ENEMY_AVOID_RADIUS - 0.01, 5.5, true), false);
  assert.equal(world.canOccupy(5.5 + ENEMY_AVOID_RADIUS, 5.5, true), true);

  world.removeObject(30);
  assert.equal(world.canOccupy(5.5, 5.5, true), true);
  world.upsertObject(31, 4, 5.5, 5.5);
  assert.equal(world.canOccupy(5.5, 5.5, true), true);

  world.removeObject(31);
  world.upsertObject(32, 5, 5.5, 5.5);
  assert.equal(world.canOccupy(5.5, 5.5, true), true);
  world.markEnemyThreat(32);
  assert.equal(world.canOccupy(5.5, 5.5, true), false);
  world.upsertObject(32, 5, 6.5, 5.5);
  assert.equal(world.canOccupy(6.5, 5.5, true), false);

  world.removeObject(32);
  world.upsertObject(33, 6, 5.5, 5.5);
  // Damageable enemy occupySquare walls do not block movement.
  assert.equal(world.canOccupy(5.5, 5.5, true), true);
  assert.equal(world.canOccupy(6.25, 5.5, true), true);
});

test('damageable enemy walls still block projectiles but not movement', () => {
  const data: CombatDataProvider = {
    getObject: (type) => type === 6
      ? { isEnemy: true, occupySquare: true }
      : type === 7
        ? { isEnemy: true, invincible: true, occupySquare: true }
        : undefined,
    getProjectile: () => undefined,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(10, 10);
  for (let x = 0; x < 10; x++) world.observeTile(x, 5, 0);

  world.upsertObject(33, 6, 4.5, 5.5);
  assert.equal(world.canOccupy(4.5, 5.5, true), true);
  const projectile = hostileProjectile();
  assert.equal(world.isProjectileSegmentOpen(3.5, 5.5, 5.5, 5.5, projectile), false);

  world.removeObject(33);
  world.upsertObject(34, 7, 4.5, 5.5);
  assert.equal(world.canOccupy(4.5, 5.5, true), false);
});

test('dodge collision world stops non-passing projectiles at cover', () => {
  const data: CombatDataProvider = {
    getObject: (type) => type === 1 ? { isEnemy: false, occupySquare: true } : undefined,
    getProjectile: () => undefined,
  };
  const world = new DodgeCollisionWorld(data);
  world.setMapBounds(10, 10);
  for (let x = 0; x < 10; x++) world.observeTile(x, 5, 0);
  world.upsertObject(20, 1, 4.5, 5.5);
  const projectile = hostileProjectile();

  assert.equal(world.isProjectileSegmentOpen(3.5, 5.5, 5.5, 5.5, projectile), false);
  const passing = { ...projectile, definition: { ...definition, passesCover: true } };
  assert.equal(world.isProjectileSegmentOpen(3.5, 5.5, 5.5, 5.5, passing), true);
});

function hostileProjectile(): CombatProjectileSnapshot {
  return {
    side: 'enemy',
    bulletId: 7,
    bulletType: 0,
    ownerId: 20,
    containerType: 100,
    startX: 0,
    startY: 5,
    angle: 0,
    startTime: 0,
    definition,
    damage: 100,
    hitObjects: new Set(),
  };
}

function routeTurnCount(
  start: { x: number; y: number },
  path: Array<{ x: number; y: number }>,
): number {
  let previousPoint = start;
  let previousDirection: { x: number; y: number } | undefined;
  let turns = 0;
  for (const point of path) {
    const dx = point.x - previousPoint.x;
    const dy = point.y - previousPoint.y;
    const length = Math.hypot(dx, dy);
    previousPoint = point;
    if (length <= 0.000001) continue;
    const direction = { x: dx / length, y: dy / length };
    if (previousDirection
      && direction.x * previousDirection.x + direction.y * previousDirection.y < 0.995) {
      turns++;
    }
    previousDirection = direction;
  }
  return turns;
}
