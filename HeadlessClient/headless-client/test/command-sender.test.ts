import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvSwapPacket, Packet, PacketType, PlayerData, PlayerShootPacket, PlayerTextPacket, UsePortalPacket } from 'realmlib';
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
  }));

  assert.equal(commands.swapInventorySlots(4, 5), true);
  assert.equal(sent[0].type, PacketType.INVSWAP);
  assert.ok(sent[0] instanceof InvSwapPacket);
  assert.equal(sent[0].time, 321);

  assert.equal(commands.shootAt({ x: 2, y: 2 }, 0), true);
  assert.equal(sent[1].type, PacketType.PLAYERSHOOT);
  assert.ok(sent[1] instanceof PlayerShootPacket);
  assert.equal(sent[1].bulletId, 0);
});

function player(inventory: number[]): PlayerData {
  return { inventory } as PlayerData;
}
