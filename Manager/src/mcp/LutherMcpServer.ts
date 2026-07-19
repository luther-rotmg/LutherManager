import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { Luther } from '@luthermanager/sdk';
import type { Client } from 'headless-client';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { HeadlessFleet, HeadlessSessionSummary } from '../headless/HeadlessFleet.js';
import type { ScriptHost } from '../scripts/ScriptHost.js';
import { runWithScriptExecutionSession } from '../scripts/ScriptExecutionContext.js';
import { Logger } from '../util/Logger.js';
import {
  RuntimeDiagnostics,
  type PacketDiagnosticEntry,
  type RuntimeLogEntry,
} from './RuntimeDiagnostics.js';

const DEFAULT_PORT = 4451;
const PORT_FALLBACK_COUNT = 10;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 300_000;
const BLOCKED_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const BLOCKED_CLIENT_METHODS = new Set([
  'addListener',
  'emit',
  'listenerCount',
  'listeners',
  'off',
  'on',
  'once',
  'prependListener',
  'prependOnceListener',
  'rawListeners',
  'removeAllListeners',
  'removeListener',
  'setMaxListeners',
]);

interface LutherMcpServerDeps {
  fleet: HeadlessFleet;
  gameData: GameDataLoader;
  scriptHost: ScriptHost;
  preferredPort?: number;
  configDir?: string;
}

interface McpSession {
  id?: string;
  protocol: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface StoredMcpConfig {
  endpoint?: unknown;
  token?: unknown;
  port?: unknown;
  updatedAt?: unknown;
}

interface CallableTarget {
  receiver: unknown;
  fn: (...args: unknown[]) => unknown;
  normalizedPath: string;
}

type JsonRecord = Record<string, unknown>;

function validPort(value: number | undefined): number {
  return Number.isInteger(value) && value! > 0 && value! <= 65535 ? value! : DEFAULT_PORT;
}

function normalizeForJson(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value !== 'object') return String(value);
  if (Buffer.isBuffer(value)) return { type: 'Buffer', length: value.length, hex: value.toString('hex') };
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (depth >= 12) return '[max depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeForJson(item, seen, depth + 1));
    if (value instanceof Map) {
      return Array.from(value, ([key, item]) => [normalizeForJson(key, seen, depth + 1), normalizeForJson(item, seen, depth + 1)]);
    }
    if (value instanceof Set) return Array.from(value, (item) => normalizeForJson(item, seen, depth + 1));
    const output: JsonRecord = {};
    for (const [key, item] of Object.entries(value)) output[key] = normalizeForJson(item, seen, depth + 1);
    return output;
  } finally {
    seen.delete(value);
  }
}

function serializeToolValue(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(normalizeForJson(value), null, 2);
  } catch (error) {
    serialized = JSON.stringify({ error: `Could not serialize result: ${(error as Error).message}` }, null, 2);
  }
  if (serialized.length <= MAX_TOOL_OUTPUT_CHARS) return serialized;
  return JSON.stringify({
    truncated: true,
    originalCharacters: serialized.length,
    preview: serialized.slice(0, MAX_TOOL_OUTPUT_CHARS),
  }, null, 2);
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: serializeToolValue(value) }] };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

function publicSession(session: HeadlessSessionSummary): JsonRecord {
  return {
    accountId: session.accountId,
    alias: session.alias,
    serverName: session.serverName,
    lifecycle: session.lifecycle,
    connected: session.connected,
    inWorld: session.inWorld,
    mapName: session.mapName,
    objectId: session.objectId,
    playerName: session.playerName,
    position: session.position,
    connectedAt: session.connectedAt,
    characterId: session.characterId,
    gameId: session.gameId,
    proxied: !!session.proxy,
  };
}

function normalizeLutherPath(path: string): string[] {
  const trimmed = String(path || '').trim().replace(/^hive\./i, '');
  const segments = trimmed.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (!segments.length) throw new Error('A Luther method path is required, for example walking.walkTo.');
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) throw new Error('That method path is not allowed.');
  return segments;
}

function resolveCallable(root: unknown, path: string, rootName: string): CallableTarget {
  const segments = rootName === 'Luther' ? normalizeLutherPath(path) : [String(path || '').trim()];
  if (!segments[0] || segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    throw new Error(`A valid ${rootName} method is required.`);
  }
  let receiver: unknown = root;
  let current: unknown = root;
  for (const segment of segments) {
    receiver = current;
    if ((typeof current !== 'object' && typeof current !== 'function') || current === null) {
      throw new Error(`${rootName}.${segments.join('.')} does not exist.`);
    }
    current = Reflect.get(current, segment);
  }
  if (typeof current !== 'function') throw new Error(`${rootName}.${segments.join('.')} is not callable.`);
  return {
    receiver,
    fn: current as (...args: unknown[]) => unknown,
    normalizedPath: `${rootName}.${segments.join('.')}`,
  };
}

function discoverLutherMethods(): string[] {
  const methods = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown, path: string, depth: number): void => {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || depth > 6) return;
    if (visited.has(value)) return;
    visited.add(value);
    const names = new Set([...Object.keys(value), ...Object.getOwnPropertyNames(value)]);
    for (const name of names) {
      if (BLOCKED_PATH_SEGMENTS.has(name) || name === 'length' || name === 'name' || name === 'arguments' || name === 'caller') continue;
      let child: unknown;
      try { child = Reflect.get(value, name); } catch { continue; }
      const childPath = `${path}.${name}`;
      if (typeof child === 'function') {
        const isClassNamespace = /^class\s/.test(Function.prototype.toString.call(child));
        if (!isClassNamespace) methods.add(childPath);
        visit(child, childPath, depth + 1);
      } else {
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(Luther, 'Luther', 0);
  return Array.from(methods).sort((left, right) => left.localeCompare(right));
}

function discoverClientMethods(client: Client): string[] {
  const methods = new Set<string>();
  let current: object | null = client;
  while (current && current !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (name !== 'constructor' && !BLOCKED_CLIENT_METHODS.has(name) && typeof Reflect.get(client, name) === 'function') {
        methods.add(name);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return Array.from(methods).sort((left, right) => left.localeCompare(right));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('MCP request body exceeds 1 MiB.');
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : undefined;
}

export class LutherMcpServer {
  readonly diagnostics = new RuntimeDiagnostics();

  private readonly sessions = new Map<string, McpSession>();
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly lutherMethods = discoverLutherMethods();
  private readonly preferredPort: number;
  private token = '';
  private endpoint = '';
  private httpServer?: HttpServer;
  private stopLogSubscription?: () => void;
  private started = false;

  private readonly packetListener = (accountId: string, traffic: Parameters<RuntimeDiagnostics['appendPacket']>[1]): void => {
    this.diagnostics.appendPacket(accountId, traffic);
  };

  constructor(private readonly deps: LutherMcpServerDeps) {
    this.preferredPort = validPort(deps.preferredPort);
    this.configDir = deps.configDir ?? join(process.env.USERPROFILE || homedir(), 'Documents', 'Hive');
    this.configPath = join(this.configDir, 'mcp.json');
  }

  async start(): Promise<{ endpoint: string; configPath: string }> {
    if (this.started) return { endpoint: this.endpoint, configPath: this.configPath };
    this.token = this.loadOrCreateToken();
    this.diagnostics.installConsoleCapture((message) => this.inferAccountId(message));
    this.deps.fleet.on('packet', this.packetListener);
    this.stopLogSubscription = this.diagnostics.onLog((entry) => this.broadcastLog(entry));

    try {
      const { server, port } = await this.bindAvailablePort();
      this.httpServer = server;
      this.endpoint = `http://127.0.0.1:${port}/mcp`;
      this.writeConfig(port);
      this.started = true;
      Logger.log('MCP', `Luther MCP listening at ${this.endpoint}; credentials: ${this.configPath}`);
      return { endpoint: this.endpoint, configPath: this.configPath };
    } catch (error) {
      this.deps.fleet.off('packet', this.packetListener);
      this.stopLogSubscription?.();
      this.stopLogSubscription = undefined;
      this.diagnostics.stopConsoleCapture();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && !this.httpServer) return;
    this.started = false;
    this.deps.fleet.off('packet', this.packetListener);
    this.stopLogSubscription?.();
    this.stopLogSubscription = undefined;
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.protocol.close()));
    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.diagnostics.stopConsoleCapture();
  }

  captureScriptLog(scriptId: string, line: string, level: 'info' | 'warn' | 'error', accountId?: string): void {
    this.diagnostics.appendScriptLog(scriptId, line, level, accountId);
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  getConfigPath(): string {
    return this.configPath;
  }

  private async bindAvailablePort(): Promise<{ server: HttpServer; port: number }> {
    const configured = process.env.HIVE_MCP_PORT !== undefined;
    const attempts = configured ? 1 : PORT_FALLBACK_COUNT;
    let lastError: Error | undefined;
    for (let offset = 0; offset < attempts; offset++) {
      const port = this.preferredPort + offset;
      try {
        const server = createServer((req, res) => {
          void this.handleHttpRequest(req, res, port).catch((error) => {
            if (!res.headersSent) this.sendJson(res, 500, { error: 'Internal MCP server error.' });
            else res.end();
            Logger.error('MCP', 'Request failed', error as Error);
          });
        });
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once('error', onError);
          server.listen(port, '127.0.0.1', () => {
            server.off('error', onError);
            resolve();
          });
        });
        return { server, port };
      } catch (error) {
        lastError = error as Error;
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      }
    }
    throw lastError ?? new Error('No MCP port was available.');
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/health' && req.method === 'GET') {
      this.sendJson(res, 200, { ok: true, name: 'hive', endpoint: this.endpoint || `http://127.0.0.1:${port}/mcp` });
      return;
    }
    if (url.pathname !== '/mcp') {
      this.sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    if (!this.authorized(req)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="Luther MCP"');
      this.sendJson(res, 401, { error: 'Missing or invalid Luther MCP bearer token.' });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      await this.handlePost(req, res, body, port);
      return;
    }
    if (req.method === 'GET' || req.method === 'DELETE') {
      const session = this.getRequestSession(req);
      if (!session) {
        this.sendJson(res, 400, { error: 'Invalid or missing MCP session ID.' });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    this.sendJson(res, 405, { error: 'Method not allowed.' });
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse, body: unknown, port: number): Promise<void> {
    const existing = this.getRequestSession(req);
    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (req.headers['mcp-session-id'] || !isInitializeRequest(body)) {
      this.sendJson(res, 400, { error: 'A valid session ID or MCP initialize request is required.' });
      return;
    }

    let session: McpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
      allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        this.sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        this.sessions.delete(sessionId);
      },
    });
    const protocol = this.createProtocolServer();
    session = { protocol, transport };
    transport.onclose = () => {
      if (session.id) this.sessions.delete(session.id);
    };
    await protocol.connect(transport);
    try {
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (session.id) this.sessions.delete(session.id);
      await protocol.close();
      throw error;
    }
  }

  private createProtocolServer(): McpServer {
    const server = new McpServer(
      { name: 'hive-headless-debugger', version: '1.0.0' },
      {
        capabilities: { logging: {} },
        instructions: [
          'This server controls live Luther headless accounts. Call hive_list_accounts first and pass an explicit accountId to account-bound tools.',
          'Prefer read-only state, logs, and packet tools before mutating the client.',
          'Use hive_call for normal SDK operations such as walking.walkTo. Use hive_execute only when several Luther calls or temporary callbacks must be composed.',
          'Mutating tools act immediately on the selected live game account. Logs arrive as MCP logging notifications and are also retained by hive_get_logs.',
        ].join(' '),
      },
    );

    server.registerTool('hive_list_accounts', {
      title: 'List Luther accounts',
      description: 'List currently launched headless accounts and their connection/map state. Credentials are never returned.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async () => toolResult(this.deps.fleet.list().map(publicSession)));

    server.registerTool('hive_get_state', {
      title: 'Inspect a Luther account',
      description: 'Return a detailed engine snapshot for one launched account, including player, movement, combat, world-object, and damage state.',
      inputSchema: { accountId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ accountId }) => this.withToolErrors(() => this.buildAccountState(accountId)));

    server.registerTool('hive_list_methods', {
      title: 'List callable Luther methods',
      description: 'Discover method paths accepted by hive_call. Optionally include public headless Client methods for a selected account.',
      inputSchema: {
        query: z.string().optional(),
        accountId: z.string().optional(),
        includeClientMethods: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ query, accountId, includeClientMethods }) => this.withToolErrors(() => {
      const needle = query?.trim().toLowerCase();
      const hive = needle ? this.lutherMethods.filter((method) => method.toLowerCase().includes(needle)) : this.lutherMethods;
      const client = includeClientMethods
        ? discoverClientMethods(this.requireClient(accountId || '')).filter((method) => !needle || method.toLowerCase().includes(needle))
        : undefined;
      return { hive, client };
    }));

    server.registerTool('hive_call', {
      title: 'Call a Luther SDK method',
      description: 'Call any Luther SDK method on a selected account. Use paths such as walking.walkTo, enemies.getNearest, combat.enableAutoAim, or chat.say.',
      inputSchema: {
        accountId: z.string().min(1),
        method: z.string().min(1),
        args: z.array(z.unknown()).default([]),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    }, async ({ accountId, method, args }, extra) => this.withToolErrors(async () => {
      this.requireClient(accountId);
      const target = resolveCallable(Luther, method, 'Luther');
      const result = await runWithScriptExecutionSession(
        { scriptId: `mcp:${extra.sessionId || 'session'}`, accountId },
        () => Promise.resolve(target.fn.apply(target.receiver, args)),
      );
      return { method: target.normalizedPath, result };
    }));

    server.registerTool('hive_execute', {
      title: 'Execute Luther debugging code',
      description: 'Execute trusted JavaScript with Luther available on a selected account. Expression mode returns one expression; script mode supports statements and explicit return. Intended for temporary diagnostics and script prototyping.',
      inputSchema: {
        accountId: z.string().min(1),
        code: z.string().min(1).max(20_000),
        mode: z.enum(['expression', 'script']).default('expression'),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    }, async ({ accountId, code, mode }, extra) => this.withToolErrors(async () => {
      this.requireClient(accountId);
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
      const body = mode === 'expression'
        ? `"use strict"; return await (${code});\n//# sourceURL=hive-mcp-expression.js`
        : `"use strict"; ${code}\n//# sourceURL=hive-mcp-script.js`;
      const execute = new AsyncFunction('Luther', body);
      const result = await runWithScriptExecutionSession(
        { scriptId: `mcp:${extra.sessionId || 'session'}`, accountId },
        () => execute(Luther),
      );
      return { mode, result };
    }));

    server.registerTool('hive_client_call', {
      title: 'Call the headless Client API',
      description: 'Advanced engine-debugging escape hatch. Calls a public method directly on the selected headless Client. EventEmitter subscription methods are excluded; prefer hive_call for normal automation.',
      inputSchema: {
        accountId: z.string().min(1),
        method: z.string().min(1),
        args: z.array(z.unknown()).default([]),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    }, async ({ accountId, method, args }) => this.withToolErrors(async () => {
      if (BLOCKED_CLIENT_METHODS.has(method) || BLOCKED_PATH_SEGMENTS.has(method)) throw new Error(`Client.${method} is not exposed through MCP.`);
      const client = this.requireClient(accountId);
      const target = resolveCallable(client, method, 'Client');
      const result = await Promise.resolve(target.fn.apply(target.receiver, args));
      return { method: target.normalizedPath, result };
    }));

    server.registerTool('hive_scripts', {
      title: 'Manage Luther scripts',
      description: 'List installed scripts, or start/stop a script. Starting binds the script to the supplied launched account.',
      inputSchema: {
        action: z.enum(['list', 'start', 'stop']),
        scriptId: z.string().optional(),
        accountId: z.string().optional(),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    }, async ({ action, scriptId, accountId }) => this.withToolErrors(async () => {
      if (action === 'list') return this.deps.scriptHost.list();
      const id = scriptId?.trim();
      if (!id) throw new Error('scriptId is required for start and stop.');
      if (action === 'stop') return this.deps.scriptHost.stop(id);
      const selectedAccount = accountId?.trim();
      if (!selectedAccount) throw new Error('accountId is required when starting a script.');
      this.requireClient(selectedAccount);
      return this.deps.scriptHost.start(id, selectedAccount);
    }));

    server.registerTool('hive_get_logs', {
      title: 'Read Luther runtime logs',
      description: 'Read bounded recent Manager, headless engine, and script logs. Use afterSeq to poll without duplicates; new logs are also emitted as MCP logging notifications.',
      inputSchema: {
        accountId: z.string().optional(),
        afterSeq: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(1_000).default(200),
        levels: z.array(z.enum(['debug', 'info', 'warning', 'error'])).optional(),
        contains: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async (query) => toolResult(this.diagnostics.recentLogs(query)));

    server.registerTool('hive_get_packets', {
      title: 'Read Luther packet history',
      description: 'Read bounded raw packet history for disconnect and parser debugging. Payloads are returned as hex only when includePayload is true.',
      inputSchema: {
        accountId: z.string().optional(),
        afterSeq: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(500).default(100),
        direction: z.enum(['incoming', 'outgoing']).optional(),
        types: z.array(z.string()).optional(),
        includePayload: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ includePayload, ...query }) => toolResult(
      this.diagnostics.recentPackets(query).map((packet) => this.presentPacket(packet, includePayload)),
    ));

    server.registerTool('hive_clear_diagnostics', {
      title: 'Clear Luther diagnostic history',
      description: 'Clear retained in-memory log and packet history globally or for one account. Live logging continues.',
      inputSchema: { accountId: z.string().optional() },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ accountId }) => toolResult(this.diagnostics.clear(accountId)));

    server.registerResource('hive-accounts', 'hive://accounts', {
      title: 'Launched Luther accounts',
      description: 'Current headless account sessions without credentials.',
      mimeType: 'application/json',
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: serializeToolValue(this.deps.fleet.list().map(publicSession)) }],
    }));

    server.registerResource('hive-sdk-methods', 'hive://sdk/methods', {
      title: 'Luther SDK method paths',
      description: 'Callable paths accepted by the hive_call tool.',
      mimeType: 'application/json',
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: serializeToolValue(this.lutherMethods) }],
    }));

    server.registerResource('hive-recent-logs', 'hive://diagnostics/logs', {
      title: 'Recent Luther logs',
      description: 'The most recent retained runtime and script logs.',
      mimeType: 'application/json',
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: serializeToolValue(this.diagnostics.recentLogs({ limit: 200 })) }],
    }));

    server.registerPrompt('debug_hive_account', {
      title: 'Debug a Luther headless account',
      description: 'A disciplined workflow for diagnosing a live Luther account or script failure.',
      argsSchema: { accountId: z.string().optional(), symptom: z.string().optional() },
    }, ({ accountId, symptom }) => ({
      messages: [{
        role: 'user' as const,
        content: {
          type: 'text' as const,
          text: [
            'Debug the live Luther headless client carefully.',
            accountId ? `Target accountId: ${accountId}.` : 'Start by calling hive_list_accounts and select the intended account.',
            symptom ? `Reported symptom: ${symptom}.` : '',
            'Inspect hive_get_state, then relevant hive_get_logs and hive_get_packets before changing state.',
            'Use hive_call for the smallest reproducible SDK action. Use hive_client_call or hive_execute only when normal SDK inspection cannot answer the question.',
            'Report the evidence, likely engine layer, exact reproduction, and any code-level fix separately from live-client workarounds.',
          ].filter(Boolean).join(' '),
        },
      }],
    }));

    return server;
  }

  private buildAccountState(accountId: string): JsonRecord {
    const client = this.requireClient(accountId);
    const session = this.deps.fleet.list().find((candidate) => candidate.accountId === accountId);
    const objects = client.visibleObjects();
    const position = client.getPosition();
    const categories: Record<string, number> = {};
    for (const object of objects) {
      const category = this.deps.gameData.getObjectCategory(object.type);
      categories[category] = (categories[category] ?? 0) + 1;
    }
    const nearestEnemies = objects
      .filter((object) => this.deps.gameData.isCombatEnemy(object.type))
      .map((object) => ({
        objectId: object.objectId,
        objectType: object.type,
        name: object.name || this.deps.gameData.getObject(object.type)?.id || `0x${object.type.toString(16)}`,
        x: object.x,
        y: object.y,
        distance: Math.hypot(object.x - position.x, object.y - position.y),
        hp: object.rawStats?.['0'],
        maxHp: this.deps.gameData.getObject(object.type)?.maxHp,
      }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 25);
    return {
      session: session ? publicSession(session) : { accountId },
      engine: client.debugInfo(),
      tick: client.getTickInfo(),
      player: client.getPlayer(),
      localPosition: position,
      serverPosition: client.getServerPosition(),
      mapDimensions: client.getMapDimensions(),
      movement: {
        moving: client.isMoving(),
        navigationPath: client.getNavigationPath(),
        autoDodge: client.getAutoDodgeState(),
      },
      combat: client.getAutoCombatState(),
      autoNexus: client.getAutoNexusState(),
      reconnectTickets: client.getReconnectTickets(),
      realmPortals: client.realmPortals(),
      world: {
        visibleObjectCount: objects.length,
        visibleTileCount: client.visibleTiles().length,
        categories,
        nearestEnemies,
      },
      containers: {
        inventory: client.getInventorySlots(),
        vault: client.getVaultSlots(),
        petBag: client.getPetBagSlots(),
        potionVault: client.getPotionVaultSlots(),
      },
      damage: this.deps.fleet.damage(accountId),
      latestLogSeq: this.diagnostics.recentLogs({ accountId, limit: 1 })[0]?.seq ?? 0,
      latestPacketSeq: this.diagnostics.recentPackets({ accountId, limit: 1 })[0]?.seq ?? 0,
    };
  }

  private requireClient(accountId: string): Client {
    const normalized = String(accountId || '').trim();
    if (!normalized) throw new Error('accountId is required. Call hive_list_accounts first.');
    const client = this.deps.fleet.get(normalized);
    if (!client) throw new Error(`No launched headless account has accountId "${normalized}".`);
    return client;
  }

  private async withToolErrors(fn: () => unknown | Promise<unknown>) {
    try {
      return toolResult(await fn());
    } catch (error) {
      return toolError(error);
    }
  }

  private presentPacket(packet: PacketDiagnosticEntry, includePayload: boolean): JsonRecord {
    return {
      seq: packet.seq,
      timestamp: packet.timestamp,
      accountId: packet.accountId,
      direction: packet.direction,
      id: packet.id,
      type: packet.type,
      size: packet.size,
      payloadBytesRetained: packet.payload.length,
      payloadTruncated: packet.payloadTruncated,
      ...(includePayload ? { payloadHex: packet.payload.toString('hex') } : {}),
    };
  }

  private inferAccountId(message: string): string | undefined {
    const lower = message.toLowerCase();
    for (const session of this.deps.fleet.list()) {
      const aliases = [session.alias, session.playerName].map((value) => value.trim().toLowerCase()).filter(Boolean);
      if (aliases.some((alias) => lower.includes(`[${alias}]`))) return session.accountId;
    }
    return undefined;
  }

  private broadcastLog(entry: RuntimeLogEntry): void {
    for (const [sessionId, session] of this.sessions) {
      void session.protocol.sendLoggingMessage({
        level: entry.level,
        logger: entry.source === 'script' ? entry.scriptId || 'LutherScript' : 'LutherRuntime',
        data: entry,
      }, sessionId).catch(() => {});
    }
  }

  private getRequestSession(req: IncomingMessage): McpSession | undefined {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!supplied) return false;
    const expectedBuffer = Buffer.from(this.token);
    const suppliedBuffer = Buffer.from(supplied);
    return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
  }

  private loadOrCreateToken(): string {
    try {
      if (existsSync(this.configPath)) {
        const parsed = JSON.parse(readFileSync(this.configPath, 'utf8')) as StoredMcpConfig;
        const token = typeof parsed.token === 'string' ? parsed.token.trim() : '';
        if (token.length >= 32) return token;
      }
    } catch (error) {
      Logger.warn('MCP', `Could not read ${this.configPath}: ${(error as Error).message}`);
    }
    return randomBytes(32).toString('base64url');
  }

  private writeConfig(port: number): void {
    mkdirSync(this.configDir, { recursive: true });
    const record = {
      endpoint: `http://127.0.0.1:${port}/mcp`,
      token: this.token,
      port,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.configPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(this.configPath, 0o600); } catch { /* Windows ACLs govern access */ }
  }

  private sendJson(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
}
