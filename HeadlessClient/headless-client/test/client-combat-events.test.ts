import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DamagePacket, Packet, PlayerData } from 'realmlib';
import {
  Client,
  type ClientDamageTakenEvent,
  type ClientShotFiredEvent,
} from '../src/client';
import { ClientEvent } from '../src/events';

test('local shots emit their projectile details', () => {
  const client = harness();
  const events: ClientShotFiredEvent[] = [];
  client.on(ClientEvent.ShotFired, (event) => events.push(event));

  assert.equal(client.shootAt({ x: 5, y: 4 }, 0), true);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    bulletId: 1,
    weaponType: 0x1234,
    attackIndex: 0,
    angle: 0,
  });
});

test('predicted damage emits once when the server confirms the same projectile', () => {
  const client = harness();
  const events: ClientDamageTakenEvent[] = [];
  client.on(ClientEvent.DamageTaken, (event) => events.push(event));

  invoke(client, 'recordDamageTaken', 25, 'projectile', { ownerId: 20, bulletId: 7 });

  const confirmation = new DamagePacket();
  confirmation.targetId = 10;
  confirmation.objectId = 20;
  confirmation.bulletId = 7;
  confirmation.damageAmount = 25;
  invoke(client, 'handleDamage', confirmation);
  invoke(client, 'reconcilePlayerHealth', player(75));

  assert.deepEqual(events, [{
    amount: 25,
    source: 'projectile',
    hp: 75,
    maxHp: 100,
    ownerId: 20,
    bulletId: 7,
  }]);
});

test('an unpredicted authoritative HP drop emits server damage', () => {
  const client = harness();
  const events: ClientDamageTakenEvent[] = [];
  client.on(ClientEvent.DamageTaken, (event) => events.push(event));

  invoke(client, 'reconcilePlayerHealth', player(70));

  assert.deepEqual(events, [{
    amount: 30,
    source: 'server',
    hp: 70,
    maxHp: 100,
  }]);
});

function harness(): Client {
  const client = new Client({
    alias: 'test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
  });
  const initialPlayer = player(100);
  Object.assign(client as unknown as Record<string, unknown>, {
    io: { send: (_packet: Packet) => undefined },
    objectId: 10,
    posKnown: true,
    pos: { x: 4, y: 4 },
    player: initialPlayer,
  });
  invoke(client, 'reconcilePlayerHealth', initialPlayer, true);
  return client;
}

function player(hp: number): PlayerData {
  return {
    hp,
    maxHP: 100,
    inventory: [0x1234],
    condition: 0,
    condition2: 0,
  } as PlayerData;
}

function invoke(client: Client, method: string, ...args: unknown[]): void {
  (client as unknown as Record<string, (...values: unknown[]) => void>)[method](...args);
}
