import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvSwapPacket, Packet, PacketType, PlayerData, PlayerShootPacket, PlayerTextPacket, UseItemPacket, UsePortalPacket } from 'realmlib';
import { CommandSender } from '../src/command-sender';

test('CommandSender builds outgoing portal and chat packets', () => {
  const sent: Packet[] = [];
  const commands = new CommandSender(() => ({
    io: { send: (packet: Packet) => sent.push(packet) },
    time: 123,
    pos: { x: 10, y: 20 },
    objectId: 99,
    player: undefined,
    nextBulletId: () => 1,
    weapon: () => ({ rateOfFire: 1, numProjectiles: 1, arcGap: 11.25 }),
    ability: () => ({ usable: true, mpCost: 0, cooldownMs: 550, activateEffects: [] }),
    trackShot: () => undefined,
  }));

  commands.say('/tell test hello');
  commands.usePortal(456);

  assert.equal(sent[0].type, PacketType.PLAYERTEXT);
  assert.ok(sent[0] instanceof PlayerTextPacket);
  assert.equal(sent[0].text, '/tell test hello');
  assert.equal(sent[1].type, PacketType.USEPORTAL);
  assert.ok(sent[1] instanceof UsePortalPacket);
  assert.equal(sent[1].objectId, 456);
});

test('CommandSender validates player state before inventory swaps and shooting', () => {
  const sent: Packet[] = [];
  let bullet = 0;
  const commands = new CommandSender(() => ({
    io: { send: (packet: Packet) => sent.push(packet) },
    time: 321,
    pos: { x: 1, y: 2 },
    objectId: 77,
    player: player([100, -1, -1, -1, 200, -1]),
    nextBulletId: () => bullet++,
    weapon: () => ({ rateOfFire: 1, numProjectiles: 1, arcGap: 11.25 }),
    ability: () => ({ usable: true, mpCost: 0, cooldownMs: 550, activateEffects: [] }),
    trackShot: () => undefined,
  }));

  assert.equal(commands.swapInventorySlots(4, 5), true);
  assert.equal(sent[0].type, PacketType.INVSWAP);
  assert.ok(sent[0] instanceof InvSwapPacket);
  assert.equal(sent[0].time, 321);

  assert.equal(commands.shootAt({ x: 2, y: 2 }, 0), true);
  assert.equal(sent[1].type, PacketType.PLAYERSHOOT);
  assert.ok(sent[1] instanceof PlayerShootPacket);
  assert.equal(sent[1].bulletId, 0);
  assert.equal(sent[1].attackIndex, 0);
  assert.equal(sent[1].attackType, 0);
  assert.equal(sent[1].patternIndex, -1);
  assert.equal(sent[1].burstIndex, 0);
});

test('CommandSender builds USEITEM for the equipped ability and respects cooldown', () => {
  const sent: Packet[] = [];
  let time = 1_000;
  const commands = new CommandSender(() => ({
    io: { send: (packet: Packet) => sent.push(packet) },
    time,
    pos: { x: 1, y: 2 },
    objectId: 77,
    player: player([100, 600]),
    nextBulletId: () => 0,
    weapon: () => ({ rateOfFire: 1, numProjectiles: 1, arcGap: 11.25 }),
    ability: () => ({ usable: true, mpCost: 50, cooldownMs: 550, activateEffects: ['Shoot'] }),
    trackShot: () => undefined,
  }));

  assert.equal(commands.useAbilityAt({ x: 5, y: 6 }), true);
  assert.ok(sent[0] instanceof UseItemPacket);
  assert.equal(sent[0].slotObject.objectId, 77);
  assert.equal(sent[0].slotObject.slotId, 1);
  assert.equal(sent[0].slotObject.objectType, 600);
  assert.deepEqual({ x: sent[0].itemUsePos.x, y: sent[0].itemUsePos.y }, { x: 5, y: 6 });
  assert.equal(sent[0].useType, 1);
  assert.equal(commands.useAbilityAt({ x: 5, y: 6 }), false);
  time += 550;
  assert.equal(commands.useAbilityAt({ x: 5, y: 6 }), true);
});

function player(inventory: number[]): PlayerData {
  return {
    inventory,
    mp: 100,
    maxMP: 100,
    condition: 0,
    condition2: 0,
  } as PlayerData;
}
