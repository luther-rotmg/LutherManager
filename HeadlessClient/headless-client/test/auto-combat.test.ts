import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PlayerData } from 'realmlib';
import { AutoCombatController, type AutoCombatSnapshot } from '../src/auto-combat';
import type {
  CombatDataProvider,
  CombatObjectDefinition,
  CombatProjectileDefinition,
} from '../src/combat-tracker';

const projectile: CombatProjectileDefinition = {
  speed: 100,
  lifetimeMs: 1_000,
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

test('auto aim prioritizes a visible boss and supports maxHp selection', () => {
  const controller = new AutoCombatController(data());
  const shots: Array<{ x: number; y: number }> = [];
  controller.enableAutoAim({ leadTargets: false });
  controller.update(1_000, snapshot(), {
    shootAt: (target) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  });
  assert.deepEqual(shots[0], { x: 7, y: 0 });
  assert.equal(controller.getState().targetObjectId, 3);

  controller.configureAutoAim({ mode: 'maxHp', bossPriority: false, leadTargets: false });
  controller.update(1_100, snapshot(), {
    shootAt: (target) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  });
  assert.deepEqual(shots[1], { x: 5, y: 0 });
  assert.equal(controller.getState().targetObjectId, 2);
});

test('fixed target overrides automatic selection until aiming stops', () => {
  const controller = new AutoCombatController(data());
  const shots: Array<{ x: number; y: number }> = [];
  assert.equal(controller.aimAt(1), true);
  controller.update(1_000, snapshot(), {
    shootAt: (target) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  });
  assert.deepEqual(shots[0], { x: 2, y: 0 });
  controller.stopAiming();
  controller.update(1_100, snapshot(), {
    shootAt: (target) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  });
  assert.equal(shots.length, 1);
});

test('target leading expires velocity after an enemy stops moving', () => {
  const controller = new AutoCombatController(data());
  const shots: Array<{ x: number; y: number }> = [];
  const state = snapshot();
  const enemy = { objectId: 1, type: 101, x: 2, y: 0, rawStats: { '0': 1_000, '1': 900 } };
  state.objects = [enemy];
  controller.enableAutoAim({ bossPriority: false, leadTargets: true });
  const actions = {
    shootAt: (target: { x: number; y: number }) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  };

  controller.update(1_000, state, actions);
  enemy.x = 3;
  controller.update(1_200, state, actions);
  controller.update(2_000, state, actions);

  assert.ok(shots[1]!.x > 3);
  assert.deepEqual(shots[2], { x: 3, y: 0 });
});

test('target leading uses the player projectile speed multiplier', () => {
  const normal = movingTargetShot(projectile, 1);
  const accelerated = movingTargetShot(projectile, 2);

  assert.ok(normal.y > accelerated.y);
  assert.ok(accelerated.y > 1);
});

test('target leading accounts for projectile acceleration', () => {
  const constant = movingTargetShot({ ...projectile, speed: 100, lifetimeMs: 1_500 }, 1);
  const accelerating = movingTargetShot({
    ...projectile,
    speed: 100,
    lifetimeMs: 1_500,
    acceleration: 200,
    accelerationDelay: 0,
  }, 1);

  assert.ok(constant.y > accelerating.y);
  assert.ok(accelerating.y > 1);
});

test('auto aim uses the next packet pattern and counter-aims its projectile offset', () => {
  const provider = data();
  const requestedProjectileIds: number[] = [];
  provider.getProjectile = (type, id) => {
    if (type !== 1_000) return undefined;
    requestedProjectileIds.push(id);
    return id === 0 || id === 2 ? projectile : undefined;
  };
  const controller = new AutoCombatController(provider);
  const state = snapshot();
  state.objects = [
    { objectId: 1, type: 101, x: 5, y: 0, rawStats: { '0': 1_000, '1': 900 } },
  ];
  const shots: Array<{ x: number; y: number }> = [];
  controller.enableAutoAim({ bossPriority: false, leadTargets: true });
  controller.update(1_000, state, {
    previewWeaponAim: () => ({
      projectileId: 2,
      bulletId: 6,
      angleOffset: Math.PI / 6,
      spawnDistance: 0.3,
      spawnOffsetX: 0.2,
    }),
    shootAt: (target) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  });

  assert.deepEqual(requestedProjectileIds, [0, 2]);
  const baseAngle = Math.atan2(shots[0]!.y, shots[0]!.x);
  assert.ok(baseAngle < -0.5 && baseAngle > -0.56);
});

test('auto ability skips teleport abilities unless explicitly allowed', () => {
  const controller = new AutoCombatController(data(true));
  let uses = 0;
  controller.enableAutoAbility({ minMpPercent: 50 });
  controller.update(1_000, snapshot(), {
    shootAt: () => false,
    useAbilityAt: () => { uses++; return true; },
  });
  assert.equal(uses, 0);

  controller.configureAutoAbility({ allowTeleport: true });
  controller.update(2_000, snapshot(), {
    shootAt: () => false,
    useAbilityAt: () => { uses++; return true; },
  });
  assert.equal(uses, 1);
});

function data(teleport = false): CombatDataProvider {
  const objects = new Map<number, CombatObjectDefinition>([
    [1_000, { isEnemy: false, occupySquare: false, rateOfFire: 1 }],
    [2_000, {
      isEnemy: false,
      occupySquare: false,
      usable: true,
      mpCost: 50,
      cooldownMs: 550,
      activateEffects: teleport ? ['Teleport'] : ['Shoot'],
    }],
    [101, { isEnemy: true, occupySquare: false, maxHp: 1_000 }],
    [102, { isEnemy: true, occupySquare: false, maxHp: 20_000 }],
    [103, { isEnemy: true, occupySquare: false, maxHp: 8_000, quest: true }],
  ]);
  return {
    getObject: (type) => objects.get(type),
    getProjectile: (type, id) => (type === 1_000 || type === 2_000) && id === 0 ? projectile : undefined,
  };
}

function snapshot(): AutoCombatSnapshot {
  const player = {
    inventory: [1_000, 2_000],
    mp: 100,
    maxMP: 100,
    condition: 0,
    condition2: 0,
  } as PlayerData;
  return {
    inWorld: true,
    safeMap: false,
    player,
    playerPos: { x: 0, y: 0 },
    objects: [
      { objectId: 1, type: 101, x: 2, y: 0, rawStats: { '0': 1_000, '1': 900 } },
      { objectId: 2, type: 102, x: 5, y: 0, rawStats: { '0': 20_000, '1': 10_000 } },
      { objectId: 3, type: 103, x: 7, y: 0, rawStats: { '0': 8_000, '1': 7_000 } },
    ],
  };
}

function movingTargetShot(
  shotProjectile: CombatProjectileDefinition,
  speedMultiplier: number,
): { x: number; y: number } {
  const provider = data();
  provider.getProjectile = (type, id) => type === 1_000 && id === 0 ? shotProjectile : undefined;
  const controller = new AutoCombatController(provider);
  const enemy = { objectId: 1, type: 101, x: 5, y: 0, rawStats: { '0': 1_000, '1': 900 } };
  const state = snapshot();
  state.player!.projSpeedMult = speedMultiplier;
  state.player!.projLifeMult = 1;
  state.objects = [enemy];
  const shots: Array<{ x: number; y: number }> = [];
  const actions = {
    shootAt: (target: { x: number; y: number }) => { shots.push(target); return true; },
    useAbilityAt: () => false,
  };
  controller.enableAutoAim({ bossPriority: false, leadTargets: true });
  controller.update(1_000, state, actions);
  enemy.y = 1;
  controller.update(1_200, state, actions);
  return shots[1]!;
}
