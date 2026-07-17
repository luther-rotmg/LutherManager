import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client, ProxyConfig } from 'headless-client';
import { DevServer } from '../src/dev/server/DevServer.js';
import type { FleetAccount, HeadlessFleet } from '../src/headless/HeadlessFleet.js';

/**
 * Documents that the dashboard WS message `launchGameWithCredentials` is the
 * live headless-connect entry point (not an Exalt-only leftover). The method
 * body already preferred headlessFleet.connect before the Exalt path was cut.
 */
test('launchGameWithCredentials maps WS dashboard fields onto FleetAccount for headlessFleet.connect', async () => {
  const connected: FleetAccount[] = [];
  const expectedProxy: ProxyConfig = {
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
  };

  const server = Object.create(DevServer.prototype) as DevServer & {
    headlessFleet?: HeadlessFleet;
    readDashboardAccounts(): Array<{ id: string }>;
    normalizeDashboardAccountRecord(raw: Record<string, unknown>): {
      id: string;
      email: string;
      password: string;
      serverName: string;
      proxyId: string;
      proxyProtocol: string;
      proxy: string;
      proxyUsername: string;
      proxyPassword: string;
    };
    resolveDashboardAccountProxy(account: { proxy: string }): ProxyConfig | undefined;
    launchGameWithCredentials(
      email: string,
      password: string,
      serverName: string,
      opts?: {
        accountId?: string | null;
        accountLabel?: string | null;
        accountProxy?: {
          proxyId: string;
          proxyProtocol: string;
          proxy: string;
          proxyUsername: string;
          proxyPassword: string;
        } | null;
      },
    ): Promise<{ ok: boolean; error?: string }>;
  };

  server.headlessFleet = {
    connect: async (account: FleetAccount) => {
      connected.push(account);
      return {} as Client;
    },
  } as unknown as HeadlessFleet;

  server.readDashboardAccounts = () => [];
  server.normalizeDashboardAccountRecord = (raw) => ({
    id: String(raw.id || ''),
    email: String(raw.email || ''),
    password: String(raw.password || ''),
    serverName: String(raw.serverName || ''),
    proxyId: String(raw.proxyId || ''),
    proxyProtocol: String(raw.proxyProtocol || 'socks5'),
    proxy: String(raw.proxy || ''),
    proxyUsername: String(raw.proxyUsername || ''),
    proxyPassword: String(raw.proxyPassword || ''),
  });
  server.resolveDashboardAccountProxy = (account) => (
    account.proxy.trim() ? expectedProxy : undefined
  );

  const result = await server.launchGameWithCredentials(
    'player@example.com',
    'secret-pass',
    'USWest3',
    {
      accountId: 'acct-42',
      accountLabel: 'Main',
      accountProxy: {
        proxyId: '',
        proxyProtocol: 'socks5',
        proxy: '127.0.0.1:1080',
        proxyUsername: '',
        proxyPassword: '',
      },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(connected, [{
    id: 'acct-42',
    email: 'player@example.com',
    password: 'secret-pass',
    label: 'Main',
    serverName: 'USWest3',
    proxy: expectedProxy,
  }]);
});

test('launchGameWithCredentials fails closed when headless fleet is missing', async () => {
  const server = Object.create(DevServer.prototype) as DevServer & {
    headlessFleet?: HeadlessFleet;
    launchGameWithCredentials(
      email: string,
      password: string,
      serverName: string,
    ): Promise<{ ok: boolean; error?: string }>;
  };
  server.headlessFleet = undefined;

  const result = await server.launchGameWithCredentials('a@b.com', 'x', 'USWest');
  assert.equal(result.ok, false);
  assert.match(String(result.error), /Headless fleet/i);
});
