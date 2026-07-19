import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConditionEffectBits,
  EnemyHitPacket,
  EnemyShootPacket,
  OtherHitPacket,
  Packet,
  PlayerHitPacket,
  PlayerShootPacket,
  ServerPlayerShootPacket,
  StatType,
  SquareHitPacket,
} from 'realmlib';
import {
  CombatDataProvider,
  CombatObjectDefinition,
  CombatProjectileDefinition,
  CombatTracker,
  CombatWorldSnapshot,
} from '../src/combat-tracker';

const projectile: CombatProjectileDefinition = {
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

test('enemy projectile reports PLAYERHIT once when it reaches the local player', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  const shot = enemyShot();

  tracker.trackEnemyShoot(shot, 100, 0);
  tracker.update(600, world({ playerPos: { x: 5, y: 1 } }));
  tracker.update(800, world({ playerPos: { x: 5, y: 1 } }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof PlayerHitPacket);
  assert.equal(sent[0].bulletId, 7);
  assert.equal(sent[0].objectId, 20);
  assert.equal(tracker.size, 0);
});

test('enemy projectile interception suppresses PLAYERHIT before reconnecting', () => {
  const sent: Packet[] = [];
  const intercepted: number[] = [];
  const tracker = new CombatTracker(
    data(),
    (packet) => sent.push(packet),
    (hit) => {
      intercepted.push(hit.damage);
      return true;
    },
  );
  const shot = enemyShot();
  shot.damage = 275;

  tracker.trackEnemyShoot(shot, 100, 0);
  tracker.update(600, world({ playerPos: { x: 5, y: 1 } }));

  assert.deepEqual(intercepted, [275]);
  assert.equal(sent.length, 0);
  assert.equal(tracker.size, 0);
});

test('own projectile reports ENEMYHIT with kill false', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.trackOwnShoot(ownShot(), 0);

  tracker.update(600, world({
    entities: [{ objectId: 30, type: 100, x: 5, y: 1 }],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
  assert.equal(sent[0].kill, false);
  assert.equal(sent[0].shooterId, 10);
  assert.equal(sent[0].mainId, 10);
});

test('own projectile collision uses the interpolated entity position', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.trackOwnShoot(ownShot(), 0);

  tracker.update(600, world({
    entities: [{ objectId: 30, type: 100, x: 9, y: 1 }],
    resolveEntityPosition: () => ({ x: 5, y: 1 }),
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
});

test('own projectile ignores permanently invincible enemy-tagged objects', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.trackOwnShoot(ownShot(), 0);

  tracker.update(600, world({
    entities: [
      { objectId: 31, type: 101, x: 3, y: 1 },
      { objectId: 30, type: 100, x: 5, y: 1 },
    ],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
});

test('own projectile ignores dead, stasis, and runtime-invincible enemies', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.trackOwnShoot(ownShot(), 0);

  tracker.update(600, world({
    entities: [
      { objectId: 31, type: 100, x: 2, y: 1, rawStats: { [StatType.HP_STAT]: 0 } },
      { objectId: 32, type: 100, x: 3, y: 1, rawStats: { [StatType.CONDITION_STAT]: ConditionEffectBits.STASIS } },
      { objectId: 33, type: 100, x: 4, y: 1, rawStats: { [StatType.CONDITION_STAT]: ConditionEffectBits.INVINCIBLE } },
      { objectId: 30, type: 100, x: 5, y: 1, rawStats: { [StatType.HP_STAT]: 100 } },
    ],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
});

test('server shot echo does not replace the locally tracked subattack projectile', () => {
  const sent: Packet[] = [];
  const localProjectile = { ...projectile, speed: 100 };
  const echoedProjectile = { ...projectile, speed: 10 };
  const base = data();
  const tracker = new CombatTracker({
    getObject: base.getObject,
    getProjectile: (type, id) => type === 500
      ? id === 1 ? localProjectile : id === 0 ? echoedProjectile : undefined
      : undefined,
  }, (packet) => sent.push(packet));
  const localShot = new PlayerShootPacket();
  localShot.bulletId = 8;
  localShot.containerType = 500;
  localShot.startingPos.x = 0;
  localShot.startingPos.y = 1;
  localShot.angle = 0;

  tracker.trackPlayerShoot(10, localShot, 0, 1);
  tracker.trackOwnShoot(ownShot(), 0);
  tracker.update(600, world({
    entities: [{ objectId: 30, type: 100, x: 5, y: 1 }],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
});

test('lifetime multipliers do not stretch a parametric projectile path', () => {
  const sent: Packet[] = [];
  const parametricProjectile = {
    ...projectile,
    speed: 0,
    parametric: true,
    magnitude: 3,
  };
  const base = data();
  const tracker = new CombatTracker({
    getObject: base.getObject,
    getProjectile: (type, id) => type === 500 && id === 0 ? parametricProjectile : undefined,
  }, (packet) => sent.push(packet));
  const shot = new PlayerShootPacket();
  shot.bulletId = 8;
  shot.containerType = 500;
  shot.startingPos.x = 10;
  shot.startingPos.y = 10;
  shot.angle = 0;

  tracker.trackPlayerShoot(10, shot, 0, 0, 1, 2);
  tracker.update(300, world({
    entities: [{ objectId: 30, type: 100, x: 7, y: 10 }],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
});

test('cover resolves an own projectile with OTHERHIT before an enemy target', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.trackOwnShoot(ownShot(), 0);

  tracker.update(600, world({
    entities: [
      { objectId: 40, type: 200, x: 3, y: 1 },
      { objectId: 30, type: 100, x: 5, y: 1 },
    ],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof OtherHitPacket);
  assert.equal(sent[0].targetId, 40);
});

test('projectile noclip lets a local projectile pass cover and hit an enemy', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  assert.equal(tracker.isProjectileNoclipEnabled(), false);
  tracker.setProjectileNoclip(true);
  tracker.clear();
  assert.equal(tracker.isProjectileNoclipEnabled(), true);
  const shot = new PlayerShootPacket();
  shot.bulletId = 8;
  shot.containerType = 500;
  shot.startingPos.x = 0;
  shot.startingPos.y = 1;
  shot.angle = 0;
  tracker.trackPlayerShoot(10, shot, 0, 0);

  tracker.update(600, world({
    entities: [
      { objectId: 40, type: 200, x: 3, y: 1 },
      { objectId: 30, type: 100, x: 5, y: 1 },
    ],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof EnemyHitPacket);
  assert.equal(sent[0].targetId, 30);
});

test('projectile noclip does not let enemy projectiles pass cover', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.setProjectileNoclip(true);
  tracker.trackEnemyShoot(enemyShot(), 100, 0);

  tracker.update(600, world({
    playerPos: { x: 5, y: 1 },
    entities: [{ objectId: 40, type: 200, x: 3, y: 1 }],
  }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof OtherHitPacket);
  assert.equal(sent[0].targetId, 40);
});

test('projectile noclip does not bypass map bounds', () => {
  const sent: Packet[] = [];
  const tracker = new CombatTracker(data(), (packet) => sent.push(packet));
  tracker.setProjectileNoclip(true);
  const shot = ownShot();
  shot.startingPos.x = 9;
  tracker.trackOwnShoot(shot, 0);

  tracker.update(300, world({ mapWidth: 10 }));

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof SquareHitPacket);
  assert.equal(sent[0].objectId, 10);
});

test('combat tracker routes shot/hit history through the injected nowMs clock', () => {
  // Deterministic clock — advances only when the test calls `advance()`.
  let clockMs = 1_000_000;
  const clockA = new CombatTracker(data(), () => undefined, undefined, () => clockMs);
  const clockB = new CombatTracker(data(), () => undefined, undefined, () => clockMs);

  const shotA = enemyShot();
  const shotB = enemyShot();
  clockA.trackEnemyShoot(shotA, 100, 0);
  clockB.trackEnemyShoot(shotB, 100, 0);

  clockA.update(600, world({ playerPos: { x: 5, y: 1 } }));
  clockB.update(600, world({ playerPos: { x: 5, y: 1 } }));

  // Both trackers used the same injected clock; recentAccuracy() over the
  // same synthetic window returns the same fraction. With Date.now(),
  // separate constructions could see different wall-clock values and
  // recentAccuracy would drift.
  assert.equal(clockA.accuracy(), clockB.accuracy());
  clockMs += 30 * 60_000; // advance 30 minutes
  assert.equal(clockA.recentAccuracy(1), clockB.recentAccuracy(1));
});

test('combat tracker constructor defaults nowMs to Date.now for source compatibility', () => {
  // Backward compatibility — existing callers that omit the nowMs param must
  // still build a working tracker whose accuracy() semantics carry the
  // real-clock behavior. Just confirms the default works at construction.
  const tracker = new CombatTracker(data(), () => undefined);
  assert.equal(tracker.accuracy(), 0);
});

test('multi-hit projectiles keep accuracy within a 0-1 fraction', () => {
  const multiHit = { ...projectile, multiHit: true };
  const base = data();
  const tracker = new CombatTracker({
    getObject: base.getObject,
    getProjectile: (type, id) => type === 500 && id === 0 ? multiHit : undefined,
  }, () => undefined);
  const shot = new PlayerShootPacket();
  shot.bulletId = 9;
  shot.containerType = 500;
  shot.startingPos.x = 0;
  shot.startingPos.y = 1;
  shot.angle = 0;
  tracker.trackPlayerShoot(10, shot, 0);

  tracker.update(800, world({
    entities: [
      { objectId: 30, type: 100, x: 3, y: 1 },
      { objectId: 31, type: 100, x: 6, y: 1 },
    ],
  }));

  assert.equal(tracker.accuracy(), 1);
});

function data(): CombatDataProvider {
  const objects = new Map<number, CombatObjectDefinition>([
    [100, { isEnemy: true, occupySquare: false }],
    [101, { isEnemy: true, invincible: true, occupySquare: false }],
    [200, { isEnemy: false, occupySquare: true }],
    [300, { isEnemy: false, isPlayer: true, occupySquare: false }],
  ]);
  return {
    getObject: (type) => objects.get(type),
    getProjectile: (type, id) => (type === 100 || type === 500) && id === 0 ? projectile : undefined,
  };
}

function enemyShot(): EnemyShootPacket {
  const shot = new EnemyShootPacket();
  shot.bulletId = 7;
  shot.ownerId = 20;
  shot.bulletType = 0;
  shot.startingPos.x = 0;
  shot.startingPos.y = 1;
  shot.angle = 0;
  shot.numShots = 1;
  return shot;
}

function ownShot(): ServerPlayerShootPacket {
  const shot = new ServerPlayerShootPacket();
  shot.bulletId = 8;
  shot.ownerId = 10;
  shot.containerType = 500;
  shot.startingPos.x = 0;
  shot.startingPos.y = 1;
  shot.angle = 0;
  return shot;
}

function world(overrides: Partial<CombatWorldSnapshot> = {}): CombatWorldSnapshot {
  return {
    playerId: 10,
    playerPos: { x: 50, y: 50 },
    mapWidth: 100,
    mapHeight: 100,
    entities: [],
    tiles: [],
    ...overrides,
  };
}
