import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { HeadlessFleet, HeadlessSessionSummary } from '../src/headless/HeadlessFleet.js';
import type { GameDataLoader } from '../src/game-data/GameDataLoader.js';
import type { ScriptHost } from '../src/scripts/ScriptHost.js';
import { LutherMcpServer } from '../src/mcp/LutherMcpServer.js';

class FakeFleet extends EventEmitter {
  readonly session: HeadlessSessionSummary = {
    accountId: 'account-1',
    alias: 'Test Account',
    email: 'hidden@example.invalid',
    serverName: 'USWest',
    lifecycle: 'ready',
    connected: true,
    inWorld: true,
    mapName: 'Nexus',
    objectId: 100,
    playerName: 'Tester',
    position: { x: 108, y: 140 },
    connectedAt: Date.now(),
    characterId: 7,
    gameId: -2,
    proxy: 'socks5://secret.invalid',
  };

  list(): HeadlessSessionSummary[] { return [this.session]; }
  get(): undefined { return undefined; }
  damage(): null { return null; }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('Luther MCP authenticates, exposes tools, and streams logs', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-test-'));
  const fleet = new FakeFleet();
  const scriptHost = {
    list: () => [],
    start: async () => ({ ok: true }),
    stop: () => ({ ok: true }),
  } as unknown as ScriptHost;
  const gameData = {} as GameDataLoader;
  const server = new LutherMcpServer({
    fleet: fleet as unknown as HeadlessFleet,
    gameData,
    scriptHost,
    preferredPort: await availablePort(),
    configDir,
  });
  let client: McpClient | undefined;

  try {
    const started = await server.start();
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoint: string; token: string };
    assert.equal(config.endpoint, started.endpoint);
    assert.ok(config.token.length >= 32);

    const unauthorized = await fetch(started.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthorized.status, 401);

    client = new McpClient({ name: 'hive-mcp-test', version: '1.0.0' });
    const logReceived = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for MCP log notification')), 3_000);
      client!.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
        const data = notification.params.data as Record<string, unknown>;
        if (data.message === 'mcp-live-log-test') {
          clearTimeout(timeout);
          resolve(data);
        }
      });
    });
    const transport = new StreamableHTTPClientTransport(new URL(started.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    });
    await client.connect(transport);
    await client.setLoggingLevel('debug');

    const tools = await client.listTools();
    const toolNames = new Set(tools.tools.map((tool) => tool.name));
    for (const expected of [
      'hive_list_accounts',
      'hive_get_state',
      'hive_call',
      'hive_execute',
      'hive_client_call',
      'hive_scripts',
      'hive_get_logs',
      'hive_get_packets',
    ]) {
      assert.ok(toolNames.has(expected), `missing MCP tool ${expected}`);
    }

    const accountResult = await client.callTool({ name: 'hive_list_accounts', arguments: {} });
    const firstContent = accountResult.content[0];
    assert.equal(firstContent?.type, 'text');
    const accounts = JSON.parse(firstContent.type === 'text' ? firstContent.text : '[]') as Array<Record<string, unknown>>;
    assert.equal(accounts[0]?.accountId, 'account-1');
    assert.equal(accounts[0]?.email, undefined);
    assert.equal(accounts[0]?.proxy, undefined);
    assert.equal(accounts[0]?.proxied, true);

    server.captureScriptLog('test-script', 'mcp-live-log-test', 'info', 'account-1');
    const liveLog = await logReceived;
    assert.equal(liveLog.accountId, 'account-1');
    assert.equal(liveLog.scriptId, 'test-script');
  } finally {
    await client?.close().catch(() => {});
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('luther_execute rate-limits repeated calls per MCP session (6th call flips to rate-limit error)', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-rate-'));
  const fleet = new FakeFleet();
  const scriptHost = {
    list: () => [],
    start: async () => ({ ok: true }),
    stop: () => ({ ok: true }),
  } as unknown as ScriptHost;
  const gameData = {} as GameDataLoader;
  const server = new LutherMcpServer({
    fleet: fleet as unknown as HeadlessFleet,
    gameData,
    scriptHost,
    preferredPort: await availablePort(),
    configDir,
    allowExecuteTool: true, // gate open; testing the rate limit downstream of the gate
  });
  let client: McpClient | undefined;

  try {
    const started = await server.start();
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoint: string; token: string };

    client = new McpClient({ name: 'hive-mcp-rate-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    });
    await client.connect(transport);

    // First 5 calls consume the bucket. FakeFleet.get() returns undefined so requireClient
    // errors, but the rate-limit ticks first — every attempt costs a token.
    for (let index = 0; index < 5; index++) {
      const result = await client.callTool({
        name: 'luther_execute',
        arguments: { accountId: 'account-1', code: '1 + 1', mode: 'expression' },
      });
      assert.equal(result.isError, true, `call ${index + 1} should surface an error (fake fleet has no client)`);
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      assert.ok(!text.includes('rate limit'), `call ${index + 1} must NOT be rate-limited yet; got: ${text}`);
    }

    // 6th call flips to a rate-limit error and does NOT reach requireClient.
    const overLimit = await client.callTool({
      name: 'luther_execute',
      arguments: { accountId: 'account-1', code: '1 + 1', mode: 'expression' },
    });
    assert.equal(overLimit.isError, true);
    const text = overLimit.content[0]?.type === 'text' ? overLimit.content[0].text : '';
    assert.ok(text.includes('rate limit'), `6th call should be rate-limited; got: ${text}`);
    assert.ok(text.includes('Retry in'), `6th call should tell the caller how long to wait; got: ${text}`);
  } finally {
    await client?.close().catch(() => {});
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('hive_* deprecated aliases log a migration warning exactly once per session', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-deprecation-'));
  const fleet = new FakeFleet();
  const scriptHost = {
    list: () => [],
    start: async () => ({ ok: true }),
    stop: () => ({ ok: true }),
  } as unknown as ScriptHost;
  const gameData = {} as GameDataLoader;
  const server = new LutherMcpServer({
    fleet: fleet as unknown as HeadlessFleet,
    gameData,
    scriptHost,
    preferredPort: await availablePort(),
    configDir,
  });
  let client: McpClient | undefined;

  try {
    const started = await server.start();
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoint: string; token: string };

    client = new McpClient({ name: 'hive-mcp-deprecation-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    });
    await client.connect(transport);

    // Two calls to the SAME deprecated alias in one session — the warning should fire on the first
    // and be suppressed on the second (dedup via warnedAliases Set in createProtocolServer).
    await client.callTool({ name: 'hive_list_accounts', arguments: {} });
    await client.callTool({ name: 'hive_list_accounts', arguments: {} });
    // Different alias — should fire its own separate warning.
    await client.callTool({ name: 'hive_list_methods', arguments: {} });

    // Read the diagnostic ring via the canonical tool.
    const logsResult = await client.callTool({ name: 'luther_get_logs', arguments: { limit: 200 } });
    const first = logsResult.content[0];
    assert.equal(first?.type, 'text');
    const raw = first.type === 'text' ? first.text : '[]';
    const entries = JSON.parse(raw) as Array<{ message?: string }>;

    const listAccountsWarnings = entries.filter((entry) =>
      entry.message?.includes('hive_list_accounts')
      && entry.message?.includes('Deprecated MCP name')
    );
    const listMethodsWarnings = entries.filter((entry) =>
      entry.message?.includes('hive_list_methods')
      && entry.message?.includes('Deprecated MCP name')
    );
    assert.equal(listAccountsWarnings.length, 1, `expected exactly 1 dedup'd hive_list_accounts warning; got ${listAccountsWarnings.length}`);
    assert.equal(listMethodsWarnings.length, 1, `expected exactly 1 hive_list_methods warning; got ${listMethodsWarnings.length}`);
    // Migration hint should include the canonical target name.
    assert.ok(listAccountsWarnings[0]!.message!.includes('luther_list_accounts'), 'warning should name the canonical replacement');
  } finally {
    await client?.close().catch(() => {});
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('luther_execute is gate-refused when allowExecuteTool is explicitly false', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-gate-'));
  const fleet = new FakeFleet();
  const scriptHost = {
    list: () => [],
    start: async () => ({ ok: true }),
    stop: () => ({ ok: true }),
  } as unknown as ScriptHost;
  const gameData = {} as GameDataLoader;
  const server = new LutherMcpServer({
    fleet: fleet as unknown as HeadlessFleet,
    gameData,
    scriptHost,
    preferredPort: await availablePort(),
    configDir,
    allowExecuteTool: false,
  });
  let client: McpClient | undefined;

  try {
    const started = await server.start();
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoint: string; token: string };

    client = new McpClient({ name: 'hive-mcp-gate-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    });
    await client.connect(transport);

    // Gate check fires BEFORE the client-lookup, so a fake account id is fine.
    const result = await client.callTool({
      name: 'luther_execute',
      arguments: { accountId: 'account-1', code: '1 + 1', mode: 'expression' },
    });
    assert.equal(result.isError, true, 'gate-closed luther_execute must return an error');
    const first = result.content[0];
    assert.equal(first?.type, 'text');
    const text = first.type === 'text' ? first.text : '';
    assert.ok(
      text.includes('LUTHER_MCP_ALLOW_EXECUTE'),
      `error should mention the override env var; got: ${text}`,
    );
    assert.ok(
      text.includes('disabled'),
      `error should mention that the tool is disabled; got: ${text}`,
    );
  } finally {
    await client?.close().catch(() => {});
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});
