import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Classes, ConvertSeasonalCharacterPacket, CreatePacket, Packet, PacketType } from 'realmlib';
import { Client } from '../src/client';

test('Client.createCharacter sends configurable class and seasonal fields', () => {
  const client = makeClient();
  const sent: Packet[] = [];
  (client as unknown as { io: { send(packet: Packet): void } }).io = { send: (packet) => sent.push(packet) };

  client.createCharacter({ classType: Classes.Rogue, seasonal: true });

  assert.equal(sent.length, 1);
  assert.ok(sent[0] instanceof CreatePacket);
  assert.equal(sent[0].classType, Classes.Rogue);
  assert.equal(sent[0].skinType, 0);
  assert.equal(sent[0].isSeasonal, true);
  assert.equal(sent[0].isChallenger, false);
  assert.equal(sent[0].unknownByte, 1);
});

test('Client.createCharacter uses configured defaults and permits overrides', () => {
  const client = makeClient({
    createClassType: Classes.Archer,
    createSkin: 7,
    createSeasonal: true,
    createChallenger: true,
  });
  const sent: CreatePacket[] = [];
  (client as unknown as { io: { send(packet: Packet): void } }).io = {
    send: (packet) => sent.push(packet as CreatePacket),
  };

  client.createCharacter();
  client.createCharacter({ classType: Classes.Wizard, seasonal: false });

  assert.deepEqual(
    sent.map((packet) => [packet.classType, packet.skinType, packet.isSeasonal, packet.isChallenger]),
    [
      [Classes.Archer, 7, true, true],
      [Classes.Wizard, 7, false, true],
    ],
  );
});

test('Client supports positional creation and seasonal conversion helpers', () => {
  const client = makeClient();
  const sent: Packet[] = [];
  (client as unknown as { io: { send(packet: Packet): void } }).io = { send: (packet) => sent.push(packet) };

  client.createCharacter(Classes.Wizard, true);
  client.sendSeasonalConversion();

  assert.ok(sent[0] instanceof CreatePacket);
  assert.equal(sent[0].classType, Classes.Wizard);
  assert.equal(sent[0].isSeasonal, true);
  assert.ok(sent[1] instanceof ConvertSeasonalCharacterPacket);
  assert.equal(sent[1].type, PacketType.CONVERT_SEASONAL_CHARACTER);
});

function makeClient(overrides: Partial<ConstructorParameters<typeof Client>[0]> = {}): Client {
  return new Client({
    alias: 'character-test',
    accessToken: 'access-token',
    clientToken: 'client-token',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
    ...overrides,
  });
}
