import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AoeAckPacket,
  AoePacket,
  ChangeAllyShootPacket,
  ConditionEffectBits,
  ConditionEffectBits2,
  CreateSuccessPacket,
  EnemyShootPacket,
  Packet,
  PlayerData,
  ServerPlayerShootPacket,
  ShootAckPacket,
} from 'realmlib';
import { Client } from '../src/client';
import { ClientEvent } from '../src/events';

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

test('AOE is acknowledged with the current client time and local player position', () => {
  const { client, sent } = harness();
  invoke(client, 'handleAoe', new AoePacket());

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof AoeAckPacket);
  assert.equal(sent[0].time, 456);
  assert.deepEqual({ x: sent[0].position.x, y: sent[0].position.y }, { x: 4, y: 6 });
});

test('AOE without a player is acknowledged at zero even if stale position state remains', () => {
  const { client, sent } = harness();
  Object.assign(client as unknown as Record<string, unknown>, {
    player: undefined,
    pos: { x: 99, y: 100 },
  });

  invoke(client, 'handleAoe', new AoePacket());

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof AoeAckPacket);
  assert.deepEqual({ x: sent[0].position.x, y: sent[0].position.y }, { x: 0, y: 0 });
});

test('AOE collision and acknowledgement use the same local position', () => {
  const { client, sent, player } = harness();
  const damage: number[] = [];
  client.on(ClientEvent.DamageTaken, (event) => damage.push(event.amount));
  Object.assign(client as unknown as Record<string, unknown>, {
    serverPos: { x: 100, y: 100 },
  });
  const aoe = new AoePacket();
  aoe.pos.x = 4;
  aoe.pos.y = 6;
  aoe.radius = 1;
  aoe.damage = 25;
  aoe.effect = 38; // Curse

  invoke(client, 'handleAoe', aoe);

  assert.deepEqual(damage, [25]);
  assert.equal(player.condition2 & ConditionEffectBits2.CURSE, ConditionEffectBits2.CURSE);
  assert.ok(sent[0] instanceof AoeAckPacket);
  assert.deepEqual({ x: sent[0].position.x, y: sent[0].position.y }, { x: 4, y: 6 });
});

test('AOE local conditions respect ProdMafia immunity and invincible guards', () => {
  const petrified = harness();
  petrified.player.condition2 = ConditionEffectBits2.PETRIFIED_IMMUNE;
  const petrifyAoe = aoeAtPlayer(35); // Petrified
  invoke(petrified.client, 'handleAoe', petrifyAoe);
  assert.equal(petrified.player.condition2 & ConditionEffectBits2.PETRIFIED, 0);
  assert.equal(petrified.sent.length, 1);

  const invincible = harness();
  invincible.player.condition = ConditionEffectBits.INVINCIBLE;
  invoke(invincible.client, 'handleAoe', aoeAtPlayer(38)); // Curse
  assert.equal(invincible.player.condition2 & ConditionEffectBits2.CURSE, 0);
  assert.equal(invincible.sent.length, 1);
});

test('map entry sends Exalt-compatible ally-shoot preference', () => {
  const { client, sent } = harness();
  const created = new CreateSuccessPacket();
  created.objectId = 42;

  invoke(client, 'handleCreateSuccess', created);

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof ChangeAllyShootPacket);
  assert.equal(sent[0].toggle, 0);
});

test('AOE autonexus returns before acknowledgement and local condition application', () => {
  const { client, sent, player } = harness();
  const monitor = (client as unknown as { autoNexus: {
    reset(hp: number, maxHp: number): void;
    setSafeMap(safe: boolean): void;
  } }).autoNexus;
  monitor.reset(100, 100);
  monitor.setSafeMap(false);
  client.configureAutoNexus({ enabled: true, thresholdPercent: 50 });
  const aoe = aoeAtPlayer(38); // Curse
  aoe.damage = 60;

  invoke(client, 'handleAoe', aoe);

  assert.equal(sent.some((packet) => packet instanceof AoeAckPacket), false);
  assert.equal(player.condition2 & ConditionEffectBits2.CURSE, 0);
  assert.equal(client.getAutoNexusState().lastTriggerSource, 'aoe');
});

function harness(): { client: Client; sent: Packet[]; player: PlayerData } {
  const client = new Client({
    alias: 'test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
  });
  const sent: Packet[] = [];
  const player = {
    hp: 100,
    maxHP: 100,
    mp: 100,
    def: 0,
    condition: 0,
    condition2: 0,
  } as PlayerData;
  Object.assign(client as unknown as Record<string, unknown>, {
    io: { send: (packet: Packet) => sent.push(packet) },
    objectId: 10,
    lastFrameTime: 123,
    time: () => 456,
    posKnown: true,
    pos: { x: 4, y: 6 },
    player,
  });
  return { client, sent, player };
}

function aoeAtPlayer(effect: number): AoePacket {
  const aoe = new AoePacket();
  aoe.pos.x = 4;
  aoe.pos.y = 6;
  aoe.radius = 1;
  aoe.damage = 25;
  aoe.effect = effect;
  return aoe;
}

function invoke(client: Client, method: string, packet: Packet): void {
  (client as unknown as Record<string, (value: Packet) => void>)[method](packet);
}
