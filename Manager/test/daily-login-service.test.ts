import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClientEvent, type Client, type ProxyConfig } from 'headless-client';
import {
  DailyLoginService,
  isDailyLoginWindowOpen,
  type DailyLoginFleet,
} from '../src/headless/DailyLoginService.js';
import type { FleetAccount } from '../src/headless/HeadlessFleet.js';

function readyClient(mapName = 'Nexus'): Client {
  const client = new EventEmitter() as EventEmitter & {
    isInWorld(): boolean;
    getMapName(): string;
  };
  client.isInWorld = () => false;
  client.getMapName = () => mapName;
  setTimeout(() => client.emit(ClientEvent.Ready), 10);
  return client as unknown as Client;
}

test('daily logins run two at a time, preserve proxies, and only run once per UTC day', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-daily-login-'));
  let active = 0;
  let maximumActive = 0;
  const connected: FleetAccount[] = [];
  const disconnected: string[] = [];
  const fleet: DailyLoginFleet = {
    isBusy: () => false,
    connect: async (account) => {
      connected.push(account);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return readyClient();
    },
    disconnect: (accountId) => {
      disconnected.push(accountId);
      active -= 1;
      return true;
    },
  };
  const proxy = { protocol: 'socks5', host: '127.0.0.1', port: 1080 } as ProxyConfig;
  const accounts: FleetAccount[] = [
    { id: 'one', email: 'one@example.com', password: 'a', proxy },
    { id: 'two', email: 'two@example.com', password: 'b' },
    { id: 'three', email: 'three@example.com', password: 'c' },
  ];

  try {
    const service = new DailyLoginService(fleet, {
      stateFile: join(stateDir, 'report.json'),
      concurrency: 2,
      gracePeriodMs: 0,
      readyTimeoutMs: 1_000,
      now: () => new Date('2026-07-22T00:06:00.000Z'),
    });
    const report = await service.runDue(accounts);

    assert.equal(maximumActive, 2);
    assert.strictEqual(connected[0].proxy, proxy);
    assert.deepEqual(disconnected.sort(), ['one', 'three', 'two']);
    assert.deepEqual(Object.values(report!.entries).map((entry) => entry.status), [
      'succeeded',
      'succeeded',
      'succeeded',
    ]);

    await service.runDue(accounts);
    assert.equal(connected.length, 3);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a manually running account is deferred without disconnecting it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-daily-login-'));
  let connectCalls = 0;
  let disconnectCalls = 0;
  const fleet: DailyLoginFleet = {
    isBusy: () => true,
    connect: async () => {
      connectCalls += 1;
      return readyClient();
    },
    disconnect: () => {
      disconnectCalls += 1;
      return true;
    },
  };

  try {
    const service = new DailyLoginService(fleet, {
      stateFile: join(stateDir, 'report.json'),
      gracePeriodMs: 0,
      now: () => new Date('2026-07-22T00:06:00.000Z'),
    });
    const report = await service.runDue([{ id: 'one', email: 'one@example.com', password: 'a' }]);
    assert.equal(report!.entries.one.status, 'deferred');
    assert.equal(connectCalls, 0);
    assert.equal(disconnectCalls, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daily login window opens five minutes after UTC reset', () => {
  assert.equal(isDailyLoginWindowOpen(new Date('2026-07-22T00:04:59.999Z')), false);
  assert.equal(isDailyLoginWindowOpen(new Date('2026-07-22T00:05:00.000Z')), true);
});
