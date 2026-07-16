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
  assert.ok(Math.hypot(state.velocity.x, state.velocity.y) > 0);
});

test('predictive auto-dodge preserves a movement intent that already clears the shot', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0.0096, y: 0 },
    movementLeadMs: 16,
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: openEnvironment,
  });

  assert.equal(state.overrideActive, false);
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
  assert.ok(Math.abs(state.velocity.y) > 0.001, `expected a lateral detour, got ${state.velocity.y}`);
  assert.deepEqual(state.goal, { x: 10, y: 5 });
  assert.ok(state.path.length >= 2);
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
  assert.ok(state.velocity.x > 0, `expected forward progress, got ${state.velocity.x}`);
  assert.ok(Math.abs(state.velocity.y) > 0.001, `expected a lateral detour, got ${state.velocity.y}`);
  assert.ok(state.path.length >= 2);
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
  assert.ok(state.velocity.x < 0, `expected broad western corridor, got ${state.velocity.x}`);
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
  assert.equal(world.canOccupy(6.25, 5.5, true), true);
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

test('predictive auto-dodge state includes a switches counter, initialised to 0', () => {
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
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(state.switches, 0);
});

test('predictive auto-dodge does not swap direction under tiny clearance noise', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const projectile = hostileProjectile();
  const first = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [projectile],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(first.overrideActive, true);
  const firstCandidate = first.selectedCandidate;
  const second = controller.evaluate({
    time: 316,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [projectile],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(second.selectedCandidate, firstCandidate);
  assert.equal(second.switches, 0);
});

test('smoothing does not delay reaction to a fresh projectile', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const idle = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(idle.overrideActive, false);
  const react = controller.evaluate({
    time: 16,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [{ ...hostileProjectile(), startTime: 16 }],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(react.overrideActive, true);
});

test('fast projectile at speed 400 is flagged as a threat', () => {
  const fastDef: CombatProjectileDefinition = {
    ...definition,
    speed: 400,
    lifetimeMs: 500,
  };
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const projectile: CombatProjectileSnapshot = {
    side: 'enemy',
    bulletId: 11,
    bulletType: 0,
    ownerId: 20,
    containerType: 100,
    startX: 0.5,
    startY: 5,
    angle: 0,
    startTime: 0,
    definition: fastDef,
    damage: 100,
    hitObjects: new Set(),
  };
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [projectile],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(state.overrideActive, true);
  assert.ok(state.threatCount > 0,
    `expected fast projectile to raise threatCount, got ${state.threatCount}`);
});

test('wavy projectile with amplitude is flagged even when its mean path misses', () => {
  const wavyDef: CombatProjectileDefinition = {
    ...definition,
    speed: 120,
    amplitude: 1.5,
    frequency: 3,
    wavy: true,
    lifetimeMs: 1500,
  };
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const projectile: CombatProjectileSnapshot = {
    side: 'enemy',
    bulletId: 12,
    bulletType: 0,
    ownerId: 20,
    containerType: 100,
    startX: 0,
    startY: 5.5,
    angle: 0,
    startTime: 0,
    definition: wavyDef,
    damage: 100,
    hitObjects: new Set(),
  };
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [projectile],
    aoes: [],
    environment: openEnvironment,
  });
  assert.ok(state.threatCount > 0,
    `expected wavy projectile to raise threatCount, got ${state.threatCount}`);
});

test('slow projectile still overrides correctly', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const slow: CombatProjectileSnapshot = {
    ...hostileProjectile(),
    definition: { ...definition, speed: 60 },
  };
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [slow],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(state.overrideActive, true);
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

test('predictive auto-dodge prefers the direction with the longer open lane', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  // Emergency AoE (landing < EMERGENCY_OVERRIDE_MS=100) with intent=(0,0) — in
  // this control flow applyChoice keeps proposedCandidate as-is instead of
  // re-selecting on intent-dot, so the ranking loop's openLane tiebreaker
  // reaches the output.
  //
  // Environment: narrow horizontal corridor at y ~= 5. Off-axis directions
  // y-drift into the wall inside HORIZON_MS and lose the impact tiebreaker;
  // only pure east and pure west stay open through the horizon. East is walled
  // at x=13 (openLane ~= 840ms); west is unbounded (openLane = LANE_HORIZON_MS
  // = 1200ms). Impact and corridor tie for east and west; openLane breaks the
  // tie toward west.
  const state = controller.evaluate({
    time: 0,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0, y: 0 },
    movementLeadMs: 16,
    projectiles: [],
    aoes: [{ x: 5, y: 5, radius: 0.3, landingTime: 50 }],
    environment: {
      canOccupy: (x, y) => Math.abs(y - 5) < 0.5 && x <= 13,
      isProjectileSegmentOpen: () => true,
    },
  });
  assert.equal(state.overrideActive, true);
  assert.ok(state.velocity.x < 0,
    `expected westward direction (longer lane), got velocity=(${state.velocity.x}, ${state.velocity.y})`);
});

test('does not veto the only short-lane escape when no alternative exists', () => {
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
    aoes: [{ x: 5, y: 5, radius: 1.2, landingTime: 200 }],
    environment: {
      canOccupy: (x, y) => x >= 3 && x <= 5 && Math.abs(y - 5) < 1e-8,
      isProjectileSegmentOpen: () => true,
    },
  });
  assert.equal(state.overrideActive, true);
  assert.ok(state.velocity.x < 0,
    `expected west (only available), got velocity.x=${state.velocity.x}`);
});

test('long-lane preference does not perturb selection in open environments', () => {
  const controller = new PredictiveAutoDodgeController();
  controller.setEnabled(true);
  const state = controller.evaluate({
    time: 300,
    playerId: 10,
    position: { x: 5, y: 5 },
    moveSpeed: 0.0096,
    intentVelocity: { x: 0.0096, y: 0 },
    movementLeadMs: 16,
    projectiles: [hostileProjectile()],
    aoes: [],
    environment: openEnvironment,
  });
  assert.equal(state.decision, 'preserve_safe_intent');
});
