import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AutoNexusMonitor,
  calculateAutoNexusDamage,
  isAutoNexusSafeMap,
  type AutoNexusTrigger,
} from '../src/auto-nexus';

test('autonexus defaults off and retains the ProdMafia five-percent threshold', () => {
  const triggers: AutoNexusTrigger[] = [];
  const monitor = new AutoNexusMonitor((trigger) => triggers.push(trigger));
  monitor.setSafeMap(false);
  monitor.reconcileServerHp(40, 1000, true);

  assert.equal(triggers.length, 0);
  assert.equal(monitor.getState().enabled, false);
  assert.equal(monitor.getState().thresholdPercent, 5);
});

test('authoritative HP at or below the configured percentage triggers once', () => {
  const triggers: AutoNexusTrigger[] = [];
  const monitor = new AutoNexusMonitor((trigger) => triggers.push(trigger));
  monitor.configure({ enabled: true, thresholdPercent: 25 });
  monitor.setSafeMap(false);
  monitor.reconcileServerHp(251, 1000, true);
  monitor.reconcileServerHp(250, 1000);
  monitor.reconcileServerHp(100, 1000);

  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]?.source, 'server');
  assert.equal(triggers[0]?.hp, 250);
});

test('predicted projectile damage triggers before the server HP update', () => {
  const triggers: AutoNexusTrigger[] = [];
  const monitor = new AutoNexusMonitor((trigger) => triggers.push(trigger));
  monitor.configure({ enabled: true, thresholdPercent: 30 });
  monitor.setSafeMap(false);
  monitor.reconcileServerHp(500, 1000, true);

  assert.equal(monitor.applyDamage(200, 'projectile'), true);
  assert.equal(triggers[0]?.hp, 300);
  assert.equal(triggers[0]?.source, 'projectile');
});

test('predicted ground damage uses the same pre-acknowledgement trigger', () => {
  const triggers: AutoNexusTrigger[] = [];
  const monitor = new AutoNexusMonitor((trigger) => triggers.push(trigger));
  monitor.configure({ enabled: true, thresholdPercent: 20 });
  monitor.setSafeMap(false);
  monitor.reconcileServerHp(250, 1000, true);

  assert.equal(monitor.applyDamage(50, 'ground'), true);
  assert.equal(triggers[0]?.source, 'ground');
  assert.equal(triggers[0]?.hp, 200);
});

test('safe maps suppress triggers and re-arm the monitor for the next dangerous map', () => {
  let count = 0;
  const monitor = new AutoNexusMonitor(() => { count++; });
  monitor.configure({ enabled: true, thresholdPercent: 50 });
  monitor.reconcileServerHp(100, 1000, true);
  assert.equal(count, 0);

  monitor.setSafeMap(false);
  assert.equal(count, 1);
  monitor.setSafeMap(true);
  monitor.reset(800, 1000);
  monitor.setSafeMap(false);
  monitor.applyDamage(400, 'aoe');
  assert.equal(count, 2);
});

test('damage calculation respects defense conditions and minimum damage', () => {
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40 }), 60);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 200 }), 15);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40, armored: true }), 40);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40, armorBroken: true }), 100);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40, invincible: true }), 0);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40, exposed: true }), 80);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40, petrified: true }), 54);
  assert.equal(calculateAutoNexusDamage({ baseDamage: 100, defense: 40, cursed: true }), 75);
});

test('thresholds outside one through one hundred are rejected', () => {
  const monitor = new AutoNexusMonitor(() => {});
  assert.throws(() => monitor.setThreshold(0), RangeError);
  assert.throws(() => monitor.setThreshold(101), RangeError);
});

test('ProdMafia safe maps suppress combat-map health checks', () => {
  assert.equal(isAutoNexusSafeMap('Nexus'), true);
  assert.equal(isAutoNexusSafeMap('Guild Hall 5'), true);
  assert.equal(isAutoNexusSafeMap('Daily Login Room'), true);
  assert.equal(isAutoNexusSafeMap('Pet Yard 3'), true);
  assert.equal(isAutoNexusSafeMap('Realm of the Mad God'), false);
});
