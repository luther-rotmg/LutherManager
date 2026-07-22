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

test('rejects Bearer tokens that are wrong (same length AND different length)', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-badtoken-'));
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

  try {
    const started = await server.start();
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoint: string; token: string };

    // Same-length wrong token exercises timingSafeEqual — the constant-time branch that
    // matters for defense against timing side-channels. Build by rotating the last char.
    const sameLenWrong = config.token.slice(0, -1)
      + (config.token.endsWith('A') ? 'B' : 'A');
    assert.equal(sameLenWrong.length, config.token.length);
    assert.notEqual(sameLenWrong, config.token);
    const sameLen = await fetch(started.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sameLenWrong}` },
      body: '{}',
    });
    assert.equal(sameLen.status, 401, 'same-length wrong Bearer should 401');
    assert.ok(sameLen.headers.get('www-authenticate')?.includes('Bearer'),
      'WWW-Authenticate header should advertise Bearer scheme');

    // Different-length wrong token exercises the length-check short-circuit —
    // timingSafeEqual would throw on mismatched buffer lengths, so the guard is required.
    const diffLenWrong = 'x'.repeat(4);
    const diffLen = await fetch(started.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${diffLenWrong}` },
      body: '{}',
    });
    assert.equal(diffLen.status, 401, 'different-length wrong Bearer should 401 without throwing');

    // Non-Bearer scheme (Basic, etc.) must also 401 — the auth guard only recognises Bearer.
    const basic = await fetch(started.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${config.token}` },
      body: '{}',
    });
    assert.equal(basic.status, 401, 'non-Bearer scheme should 401 even with the right token value');
  } finally {
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('canonical luther_* names work and do NOT emit a deprecation warning', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-canonical-'));
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

    client = new McpClient({ name: 'hive-mcp-canonical-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    });
    await client.connect(transport);

    // Call two canonical tool names.
    const accountResult = await client.callTool({ name: 'luther_list_accounts', arguments: {} });
    const accountsFirst = accountResult.content[0];
    assert.equal(accountsFirst?.type, 'text');
    const accounts = JSON.parse(accountsFirst.type === 'text' ? accountsFirst.text : '[]') as Array<Record<string, unknown>>;
    assert.equal(accounts[0]?.accountId, 'account-1');
    // Confirm redaction still applies on the canonical path — regression guard against
    // the alias path being the only place we redact.
    assert.equal(accounts[0]?.email, undefined);
    assert.equal(accounts[0]?.proxy, undefined);

    await client.callTool({ name: 'luther_list_methods', arguments: {} });

    // Read the diagnostic ring; assert NO deprecation warnings were emitted for these calls.
    const logsResult = await client.callTool({ name: 'luther_get_logs', arguments: { limit: 200 } });
    const first = logsResult.content[0];
    assert.equal(first?.type, 'text');
    const raw = first.type === 'text' ? first.text : '[]';
    const entries = JSON.parse(raw) as Array<{ message?: string }>;
    const deprecationWarnings = entries.filter((entry) => entry.message?.includes('Deprecated MCP name'));
    assert.equal(deprecationWarnings.length, 0,
      `canonical names must not emit deprecation warnings; got ${deprecationWarnings.length}: `
        + deprecationWarnings.map((w) => w.message).join(' | '));
  } finally {
    await client?.close().catch(() => {});
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('rejects request bodies larger than 1 MiB (readJsonBody size guard)', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-bigbody-'));
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

  try {
    const started = await server.start();
    const config = JSON.parse(readFileSync(join(configDir, 'mcp.json'), 'utf8')) as { endpoint: string; token: string };

    // 1.5 MiB body — well past the 1 MiB guard. Uses fetch with an auth header so
    // auth passes and the request reaches readJsonBody. The guard should reject
    // BEFORE the body is fully buffered/parsed.
    const oversized = 'x'.repeat(1024 * 1024 + 512 * 1024);
    const response = await fetch(started.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: oversized,
    });
    // The server surfaces the guard as a JSON-RPC or HTTP error, not a 200. Accept either 4xx or 5xx —
    // the important assertion is that the server didn't silently accept a 1.5 MiB body.
    assert.ok(response.status >= 400 && response.status < 600,
      `oversized body should be rejected with a 4xx/5xx; got ${response.status}`);
  } finally {
    await server.stop();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('luther_list_methods returns luther+hive dual keys and filters by query', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-mcp-listmethods-'));
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

    client = new McpClient({ name: 'hive-mcp-listmethods-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(started.endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${config.token}` } },
    });
    await client.connect(transport);

    // Unfiltered: full method list. hive[] and luther[] MUST be equal (same array of paths).
    // Existing MCP clients key on `hive` for backward-compat — silently dropping it would break them.
    const unfilteredResult = await client.callTool({ name: 'luther_list_methods', arguments: {} });
    const rawFirst = unfilteredResult.content[0];
    assert.equal(rawFirst?.type, 'text');
    const raw = rawFirst.type === 'text' ? rawFirst.text : '{}';
    const parsed = JSON.parse(raw) as { luther?: string[]; hive?: string[]; client?: string[] | null };
    assert.ok(Array.isArray(parsed.luther) && parsed.luther.length > 0, 'luther[] must be non-empty');
    assert.ok(Array.isArray(parsed.hive), 'hive[] must be present for backwards-compat');
    assert.deepEqual(parsed.hive, parsed.luther,
      'hive[] must equal luther[] — same discovered methods, dual key names for BC');
    // The handler returns `client: undefined` but normalizeForJson (LutherMcpServer.ts:95)
    // coerces undefined -> null before serialization, so the wire shape is `client: null`.
    assert.equal(parsed.client, null, 'client-methods opt-in defaults to off (undefined -> null on wire)');

    // Filter narrows the result. Use a substring likely to hit at least one path.
    const filteredResult = await client.callTool({
      name: 'luther_list_methods',
      arguments: { query: 'walk' },
    });
    const filteredFirst = filteredResult.content[0];
    assert.equal(filteredFirst?.type, 'text');
    const filteredParsed = JSON.parse(filteredFirst.type === 'text' ? filteredFirst.text : '{}') as { luther?: string[] };
    assert.ok(Array.isArray(filteredParsed.luther), 'filtered luther[] must exist');
    assert.ok(filteredParsed.luther.length < parsed.luther.length,
      'filter must return fewer entries than unfiltered');
    for (const method of filteredParsed.luther) {
      assert.ok(method.toLowerCase().includes('walk'),
        `every filtered entry must include the query substring; ${method} did not`);
    }
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
