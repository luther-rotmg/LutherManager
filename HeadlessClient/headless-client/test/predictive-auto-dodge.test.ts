import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CombatDataProvider,
  CombatProjectileDefinition,
  CombatProjectileSnapshot,
} from '../src/combat-tracker';
import { DodgeCollisionWorld, ENEMY_AVOID_RADIUS } from '../src/dodge-collision-world';
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

test('dodge collision world keeps candidates 1.3 tiles from combat enemies', () => {
  const data: CombatDataProvider = {
    getObject: (type) => type === 3
      ? { isEnemy: true, occupySquare: false }
      : type === 4
        ? { isEnemy: true, invincible: true, occupySquare: false }
        : undefined,
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
