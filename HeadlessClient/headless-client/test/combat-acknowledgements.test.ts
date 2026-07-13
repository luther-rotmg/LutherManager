import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AoeAckPacket, AoePacket, EnemyShootPacket, Packet, ServerPlayerShootPacket, ShootAckPacket } from 'realmlib';
import { Client } from '../src/client';

test('enemy and owned player shoots send a one-count SHOOTACK', () => {
  const { client, sent } = harness();
  const enemy = new EnemyShootPacket();
  enemy.ownerId = 20;
  invoke(client, 'handleEnemyShoot', enemy);

  const own = new ServerPlayerShootPacket();
  own.ownerId = 10;
  invoke(client, 'handleServerPlayerShoot', own);

  assert.equal(sent.length, 2);
  for (const packet of sent) {
    assert.ok(packet instanceof ShootAckPacket);
    assert.equal(packet.time, 123);
    assert.equal(packet.ackCount, 1);
  }
});

test('another player SERVERPLAYERSHOOT is not acknowledged', () => {
  const { client, sent } = harness();
  const other = new ServerPlayerShootPacket();
  other.ownerId = 99;

  invoke(client, 'handleServerPlayerShoot', other);

  assert.equal(sent.length, 0);
});

test('AOE is acknowledged with the current player position', () => {
  const { client, sent } = harness();
  invoke(client, 'handleAoe', new AoePacket());

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof AoeAckPacket);
  assert.equal(sent[0].time, 123);
  assert.deepEqual({ x: sent[0].position.x, y: sent[0].position.y }, { x: 4, y: 6 });
});

function harness(): { client: Client; sent: Packet[] } {
  const client = new Client({
    alias: 'test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
  });
  const sent: Packet[] = [];
  Object.assign(client as unknown as Record<string, unknown>, {
    io: { send: (packet: Packet) => sent.push(packet) },
    objectId: 10,
    lastFrameTime: 123,
    posKnown: true,
    pos: { x: 4, y: 6 },
  });
  return { client, sent };
}

function invoke(client: Client, method: string, packet: Packet): void {
  (client as unknown as Record<string, (value: Packet) => void>)[method](packet);
}
