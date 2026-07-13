import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Packet, PacketType } from 'realmlib';
import { Client } from '../src/client';

test('Client packet hooks run by priority and stop after cancellation', () => {
  const client = makeClient();
  const calls: string[] = [];
  client.onPacket(PacketType.TEXT, (_packet, ctx) => {
    calls.push('low');
    ctx.cancel('too late');
  }, { priority: 0 });
  client.onPacket(PacketType.TEXT, (_packet, ctx) => {
    calls.push('high');
    ctx.cancel('spam');
  }, { priority: 10 });

  dispatch(client, PacketType.TEXT);

  assert.deepEqual(calls, ['high']);
});

test('Client packet hook failures do not stop later hooks', () => {
  const client = makeClient();
  const calls: string[] = [];
  const originalError = console.error;
  console.error = () => undefined;
  client.onPacket(PacketType.TEXT, () => {
    calls.push('bad');
    throw new Error('hook failed');
  }, { priority: 10 });
  client.onPacket(PacketType.TEXT, () => {
    calls.push('good');
  }, { priority: 0 });

  try {
    dispatch(client, PacketType.TEXT);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls, ['bad', 'good']);
});

test('Client packet hooks can be removed', () => {
  const client = makeClient();
  const calls: string[] = [];
  const handler = (): void => {
    calls.push('called');
  };

  client.onPacket(PacketType.TEXT, handler);
  client.offPacket(PacketType.TEXT, handler);
  dispatch(client, PacketType.TEXT);

  assert.deepEqual(calls, []);
});

function makeClient(): Client {
  return new Client({
    alias: 'test',
    accessToken: '',
    clientToken: '',
    charId: 1,
    needsNewChar: false,
    host: '127.0.0.1',
  });
}

function dispatch(client: Client, type: PacketType): void {
  (client as unknown as { dispatchPacket(type: PacketType, packet: Packet): void }).dispatchPacket(type, {
    type,
    read: () => undefined,
    write: () => undefined,
  } as Packet);
}
