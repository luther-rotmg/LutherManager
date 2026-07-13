import * as http from 'http';
import { timingSafeEqual } from 'crypto';
import { format } from 'util';
import { PortalType } from 'realmlib';
import { Account, ServerInfo } from './account-service';
import { Client, type SlotRef } from './client';
import { config, setConfig } from './config';
import { GameId } from './constants';
import { ItemCatalog, loadItemCatalog } from './item-metadata';
import { PetBagRoundTrip } from './plugins/pet-bag-round-trip';
import { PetToVault } from './plugins/pet-to-vault';
import { RealmHostMapper } from './plugins/realm-host-mapper';
import { PluginManager } from './plugin-manager';

interface WebPanelContext {
  clients: Map<string, Client>;
  getServers(): ServerInfo[];
  plugins: PluginManager;
  accountsFile?: string;
  readAccountsText?(): string;
  saveAccounts?(accounts: Account[]): void;
  addClient?(account: Account): Promise<string>;
}

export interface WebPanelHandle {
  close(): void;
}

type LogLevel = 'log' | 'warn' | 'error';

interface LogEntry {
  id: number;
  at: string;
  level: LogLevel;
  message: string;
}

interface ActionResponse {
  ok: boolean;
  message: string;
  data?: unknown;
}

const DEFAULT_PORT = 8787;
const LOG_LIMIT = 500;
const MAX_BODY_BYTES = 64 * 1024;
/** Placeholder returned instead of real passwords in /api/accounts. */
const REDACTED_PASSWORD = '********';

/**
 * Security posture for the control panel, set once at startup. The panel holds
 * game credentials and can drive every bot, so it is locked to loopback by
 * default and gated behind Host/Origin checks (anti DNS-rebinding / CSRF) plus
 * an optional shared-secret token.
 */
let security: { token?: string; host: string } = { host: '127.0.0.1' };

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function headerHostname(value: string | undefined): string {
  if (!value) return '';
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** True if the request's Host header names loopback or the configured bind host. */
function hostHeaderOk(req: http.IncomingMessage): boolean {
  const name = headerHostname(req.headers.host);
  return isLoopbackHost(name) || name === security.host.toLowerCase();
}

/** True if there's no Origin, or the Origin names loopback / the configured host. */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let name = '';
  try {
    name = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return isLoopbackHost(name) || name === security.host.toLowerCase();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function readCookie(req: http.IncomingMessage, name: string): string {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

/** Token gate for /api/*. Accepts the token via Bearer header, ?token=, or cookie. */
function authOk(req: http.IncomingMessage, url: URL): boolean {
  if (!security.token) return true;
  const auth = req.headers.authorization ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const candidates = [bearer, url.searchParams.get('token') ?? '', readCookie(req, 'wp_token')];
  return candidates.some((value) => value && timingSafeEqualStr(value, security.token as string));
}

/** Replaces passwords with a placeholder so the panel never serves them in the clear. */
function redactAccountsText(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return text;
    const redacted = parsed.map((account) =>
      account && typeof account === 'object' && 'password' in account
        ? { ...account, password: REDACTED_PASSWORD }
        : account,
    );
    return JSON.stringify(redacted, null, 2);
  } catch {
    return '[]';
  }
}

/** Restores redacted passwords from the on-disk accounts before saving an edited list. */
function restoreRedactedPasswords(accounts: Account[], existingText: string): Account[] {
  let existing: Account[] = [];
  try {
    const parsed = JSON.parse(existingText);
    if (Array.isArray(parsed)) existing = parsed as Account[];
  } catch {
    existing = [];
  }
  const passwordByKey = new Map<string, string>();
  for (const account of existing) {
    if (account && typeof account.guid === 'string' && typeof account.password === 'string') {
      passwordByKey.set(`guid:${account.guid}`, account.password);
      if (account.alias) passwordByKey.set(`alias:${account.alias}`, account.password);
    }
  }
  return accounts.map((account) => {
    if (account.password !== REDACTED_PASSWORD) return account;
    const restored =
      (account.alias ? passwordByKey.get(`alias:${account.alias}`) : undefined) ??
      passwordByKey.get(`guid:${account.guid}`);
    if (!restored) {
      throw new Error(`password for ${account.alias ?? account.guid} is redacted and no stored password was found`);
    }
    return { ...account, password: restored };
  });
}
const KNOWN_PORTAL_TYPES = new Set<number>(
  Object.values(PortalType).filter((value): value is number => typeof value === 'number'),
);
const logBuffer: LogEntry[] = [];
const streams = new Set<http.ServerResponse>();
let nextLogId = 1;
let consoleCaptured = false;

export function startWebPanel(ctx: WebPanelContext): WebPanelHandle {
  installConsoleCapture();
  const itemCatalog = loadItemCatalog();
  const requestedHost = process.env.WEB_HOST ?? '127.0.0.1';
  const token = process.env.WEB_PANEL_TOKEN?.trim() || undefined;
  let host = requestedHost;
  if (!isLoopbackHost(requestedHost) && !token) {
    console.error(
      `web panel: refusing to bind non-loopback host ${requestedHost} without WEB_PANEL_TOKEN set ` +
        `(would expose credentials + full bot control) — falling back to 127.0.0.1`,
    );
    host = '127.0.0.1';
  }
  security = { token, host };
  if (token) {
    console.log('web panel: token auth enabled — open the panel with ?token=<WEB_PANEL_TOKEN> once to set the cookie');
  }
  const requestedPort = readPort(process.env.WEB_PORT, DEFAULT_PORT);
  const server = http.createServer((req, res) => {
    void route(ctx, itemCatalog, req, res);
  });
  const stateTimer = setInterval(() => {
    broadcast('state', snapshot(ctx, itemCatalog));
  }, 1000);

  listenWithFallback(server, host, requestedPort, 20);

  return {
    close(): void {
      clearInterval(stateTimer);
      for (const res of streams) {
        res.end();
      }
      streams.clear();
      server.close();
    },
  };
}

function listenWithFallback(server: http.Server, host: string, port: number, attemptsLeft: number): void {
  const onError = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      listenWithFallback(server, host, port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`web panel failed to listen on ${host}:${port}: ${err.message}`);
  };
  server.once('error', onError);
  server.listen(port, host, () => {
    server.off('error', onError);
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`web panel ready - http://${host}:${actualPort}`);
  });
}

async function route(ctx: WebPanelContext, itemCatalog: ItemCatalog, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    // Anti DNS-rebinding: a request whose Host header isn't loopback / our bind
    // host is an attacker's domain resolving to us — reject before anything else.
    if (!hostHeaderOk(req)) {
      sendJson(res, 403, { ok: false, message: 'forbidden host' });
      return;
    }
    // /api/* holds credentials and control; require the token (if configured),
    // and reject cross-origin state changes (CSRF) on POST.
    const isApi = url.pathname.startsWith('/api/');
    if (isApi && !authOk(req, url)) {
      sendJson(res, 401, { ok: false, message: 'unauthorized — append ?token=<WEB_PANEL_TOKEN> or send a Bearer token' });
      return;
    }
    if (isApi && req.method === 'POST' && !originOk(req)) {
      sendJson(res, 403, { ok: false, message: 'forbidden origin' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      // If the token is supplied via ?token=, drop it in an HttpOnly cookie so
      // subsequent same-origin fetch/SSE authenticate automatically.
      const headers: Record<string, string> = {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      };
      if (security.token && timingSafeEqualStr(url.searchParams.get('token') ?? '', security.token)) {
        headers['Set-Cookie'] = `wp_token=${encodeURIComponent(security.token)}; HttpOnly; SameSite=Strict; Path=/`;
      }
      res.writeHead(200, headers);
      res.end(HTML);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app.css') {
      send(res, 200, CSS, 'text/css; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      send(res, 200, JS, 'application/javascript; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, snapshot(ctx, itemCatalog));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      sendJson(res, 200, logBuffer);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      sendJson(res, 200, {
        path: ctx.accountsFile ?? 'accounts.json',
        text: redactAccountsText(ctx.readAccountsText?.() ?? '[]'),
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      openEventStream(ctx, itemCatalog, res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await readJson(req);
      const result = await runAction(ctx, body as Record<string, unknown>);
      const actionName = typeof (body as Record<string, unknown>).action === 'string' ? (body as Record<string, unknown>).action : 'unknown';
      if (actionName !== 'consoleCommand') {
        console.log(`[web] action ${actionName}: ${result.ok ? 'ok' : 'error'} - ${result.message}`);
      }
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    sendJson(res, 404, { ok: false, message: 'not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, message: (err as Error).message });
  }
}

function openEventStream(ctx: WebPanelContext, itemCatalog: ItemCatalog, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  streams.add(res);
  writeEvent(res, 'state', snapshot(ctx, itemCatalog));
  writeEvent(res, 'logs', logBuffer.slice(-200));
}

function snapshot(ctx: WebPanelContext, itemCatalog: ItemCatalog): Record<string, unknown> {
  const clients = [...ctx.clients.values()].map((client) => {
    const debug = client.debugInfo();
    const player = client.getPlayer();
    const inventory = client.getInventory() ?? [];
    const visibleObjects = client.visibleObjects();
    const origin = client.getServerPosition() ?? client.getPosition();
    const visibleObjectRows = visibleObjects
      .map((object) => ({
        ...enrichObject(object, itemCatalog),
        distance: Math.hypot(object.x - origin.x, object.y - origin.y),
      }))
      .sort((a, b) => Number(a.distance) - Number(b.distance))
      .slice(0, 240);
    return {
      alias: client.alias,
      lifecycle: client.getLifecycleState(),
      mapName: client.getMapName(),
      host: client.getServerHost(),
      inVault: client.isInVault(),
      position: client.getPosition(),
      serverPosition: client.getServerPosition(),
      tick: client.getTickInfo(),
      inventory,
      itemSlots: inventory.map((id) => (id === -1 ? { id } : itemCatalog.ref(id))),
      lastInvResult: client.getLastInvResult(),
      vaultContent: enrichVaultContent(client.getVaultContent(), itemCatalog),
      reconnectTickets: client.getReconnectTickets(),
      player: player
        ? {
            class: debug.class,
            level: debug.level,
            hp: debug.hp,
            mp: debug.mp,
            hasBackpack: player.hasBackpack,
          }
        : undefined,
      debug,
      portals: buildPortalRows(client, visibleObjects, itemCatalog),
      visibleObjects: visibleObjectRows,
      loadedPlugins: ctx.plugins.loaded(client),
      pluginData: pluginData(ctx.plugins, client),
    };
  });
  return {
    now: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    config,
    servers: ctx.getServers(),
    itemMetadata: { count: itemCatalog.size },
    availablePlugins: ctx.plugins.available(),
    clients,
    logs: logBuffer.slice(-200),
  };
}

function enrichObject(object: ReturnType<Client['visibleObjects']>[number], itemCatalog: ItemCatalog): Record<string, unknown> {
  const type = itemCatalog.ref(object.type);
  return {
    ...object,
    typeName: type.name,
    typeClass: type.className,
  };
}

function enrichVaultContent(
  vault: ReturnType<Client['getVaultContent']>,
  itemCatalog: ItemCatalog,
): Record<string, unknown> | undefined {
  if (!vault) {
    return undefined;
  }
  return {
    ...vault,
    sections: vault.sections.map((section) => ({
      ...section,
      itemSlots: section.contents.map((id) => (id === -1 ? { id } : itemCatalog.ref(id))),
      itemCount: section.contents.filter((id) => id !== -1).length,
    })),
  };
}

function buildPortalRows(
  client: Client,
  visibleObjects: ReturnType<Client['visibleObjects']>,
  itemCatalog: ItemCatalog,
): Record<string, unknown>[] {
  const realms = new Map(client.realmPortals().map((portal) => [portal.objectId, portal]));
  return visibleObjects
    .filter((object) => realms.has(object.objectId) || isPortalObject(object, itemCatalog))
    .map((object) => {
      const type = itemCatalog.ref(object.type);
      const realm = realms.get(object.objectId);
      return {
        ...object,
        name: realm?.name ?? object.name ?? type.name ?? `#${object.type}`,
        typeName: type.name,
        typeClass: type.className,
        players: realm?.players,
        maxPlayers: realm?.maxPlayers,
        openedAt: realm?.openedAt,
        connectId: realm?.connectId,
        connectValueTwo: realm?.connectValueTwo,
      };
    });
}

function isPortalObject(object: { type: number; name?: string }, itemCatalog: ItemCatalog): boolean {
  const type = itemCatalog.ref(object.type);
  return (
    KNOWN_PORTAL_TYPES.has(object.type) ||
    /portal/i.test(object.name ?? '') ||
    /portal/i.test(type.name ?? '') ||
    /portal/i.test(type.className ?? '')
  );
}

function pluginData(plugins: PluginManager, client: Client): Record<string, unknown> {
  return {
    realmHosts: plugins.get<RealmHostMapper>(client, 'RealmHostMapper')?.portals() ?? [],
    petToVault: plugins.get<PetToVault>(client, 'PetToVault')?.status(),
  };
}

async function runAction(ctx: WebPanelContext, raw: Record<string, unknown>): Promise<ActionResponse> {
  const action = String(raw.action ?? '');
  const alias = typeof raw.alias === 'string' ? raw.alias : '';
  const client = alias ? ctx.clients.get(alias) : undefined;
  const requireClient = (): Client | undefined => {
    if (!client) {
      return undefined;
    }
    return client;
  };

  switch (action) {
    case 'setConfig': {
      const key = String(raw.key ?? '');
      const value = String(raw.value ?? '');
      return setConfig(key, value)
        ? ok(`set ${key} = ${value}`)
        : fail(`invalid config value for ${key}`);
    }
    case 'clearLogs': {
      logBuffer.length = 0;
      broadcast('logs', []);
      return ok('console cleared');
    }
    case 'consoleCommand': {
      const command = String(raw.command ?? '').trim();
      if (!command) return fail('command is required');
      console.log(`[web] $ ${command}`);
      const result = await runConsoleCommand(ctx, alias, command);
      console.log(`[web] ${result.ok ? 'ok' : 'error'}: ${result.message}`);
      return result;
    }
    case 'sayAll': {
      const message = String(raw.message ?? '').trim();
      if (!message) return fail('message is required');
      for (const c of ctx.clients.values()) {
        c.say(message);
      }
      return ok(`sent chat from ${ctx.clients.size} client(s)`);
    }
    case 'addClient': {
      if (!ctx.addClient) return fail('adding clients is not available');
      try {
        const account = normalizeAccount(raw.account);
        const addedAlias = await ctx.addClient(account);
        return ok(`[${addedAlias}] account added and client starting`);
      } catch (err) {
        return fail(`add client failed: ${(err as Error).message}`);
      }
    }
    case 'saveAccounts': {
      if (!ctx.saveAccounts) return fail('editing accounts.json is not available');
      try {
        const parsed = parseAccountsJson(String(raw.json ?? ''));
        // The panel serves passwords redacted; restore any untouched ones from
        // disk so saving an edited list doesn't overwrite real passwords.
        const accounts = restoreRedactedPasswords(parsed, ctx.readAccountsText?.() ?? '[]');
        ctx.saveAccounts(accounts);
        return ok(`accounts.json saved (${accounts.length} account${accounts.length === 1 ? '' : 's'})`);
      } catch (err) {
        return fail(`accounts.json not saved: ${(err as Error).message}`);
      }
    }
    case 'enterVault': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      c.enterVault();
      return ok(`[${c.alias}] entering vault`);
    }
    case 'escape': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      c.escape();
      return ok(`[${c.alias}] escaping to Nexus`);
    }
    case 'stall': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      return c.stall() ? ok(`[${c.alias}] socket stalled`) : fail(`[${c.alias}] could not stall socket`);
    }
    case 'resume': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const held = c.unstall();
      return held >= 0 ? ok(`[${c.alias}] resumed after ${held}ms`) : fail(`[${c.alias}] socket is not stalled`);
    }
    case 'disconnect': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      c.stop('web panel disconnect');
      return ok(`[${c.alias}] disconnected`);
    }
    case 'startConnection': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      c.connect();
      return ok(`[${c.alias}] connection started`);
    }
    case 'say': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const message = String(raw.message ?? '').trim();
      if (!message) return fail('message is required');
      c.say(message);
      return ok(`[${c.alias}] chat sent`);
    }
    case 'swapSlots': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const from = toInt(raw.from);
      const to = toInt(raw.to);
      if (from === undefined || to === undefined) return fail('from and to slots must be integers');
      const sent = c.swapInventorySlots(from, to);
      if (!sent) return fail(`[${c.alias}] invswap failed`);
      const queued = typeof c.isStalled === 'function' && c.isStalled();
      return ok(`[${c.alias}] invswap ${from} -> ${to}${queued ? ' queued' : ' sent'}`);
    }
    case 'swapSlotRefs': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      try {
        const from = parseSlotRef(raw.from);
        const to = parseSlotRef(raw.to);
        const sent = typeof c.invSwapNear === 'function' ? c.invSwapNear(from, to) : c.invSwap(from, to);
        if (!sent) return fail(`[${c.alias}] invswap failed`);
        const queued = typeof c.isStalled === 'function' && c.isStalled();
        return ok(
          `[${c.alias}] invswap obj ${from.objectId}:${from.slotId} -> obj ${to.objectId}:${to.slotId}` +
            `${queued ? ' queued' : ' sent'}`,
        );
      } catch (err) {
        return fail(`invalid slot swap: ${(err as Error).message}`);
      }
    }
    case 'connectServer': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const target = String(raw.target ?? '').trim();
      if (!target) return fail('server name or host is required');
      const server = [...ctx.getServers(), ...c.knownServers()]
        .find((s) => s.name.toLowerCase() === target.toLowerCase() || s.address === target);
      c.connectToServer(server?.address ?? target);
      return ok(`[${c.alias}] connecting to ${server?.name ?? target}`);
    }
    case 'connectGameId': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const gameId = toInt(raw.gameId);
      if (gameId === undefined) return fail('game id must be an integer');
      const host = String(raw.host ?? '').trim() || c.getServerHost();
      if (!canConnectUnkeyed(gameId) && !c.hasReconnectTicket(gameId, host)) {
        return fail(`[${c.alias}] no reconnect ticket captured for gameId ${gameId} on ${host}`);
      }
      const mode = c.connectToGameId(gameId, host);
      return ok(`[${c.alias}] connecting to gameId ${gameId}${mode === 'ticket' ? ' with reconnect ticket' : ' without key'}`);
    }
    case 'connectTicket': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const ticketId = toInt(raw.ticketId);
      if (ticketId === undefined) return fail('ticket id must be an integer');
      return c.connectToReconnectTicket(ticketId)
        ? ok(`[${c.alias}] connecting with reconnect ticket #${ticketId}`)
        : fail(`[${c.alias}] reconnect ticket #${ticketId} not found`);
    }
    case 'usePortal': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const objectId = toInt(raw.objectId);
      if (objectId === undefined) return fail('portal object id is required');
      return c.enterPortal(objectId)
        ? ok(`[${c.alias}] walking to portal ${objectId}`)
        : fail(`[${c.alias}] portal ${objectId} is not visible`);
    }
    case 'moveTo': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const x = toNumber(raw.x);
      const y = toNumber(raw.y);
      if (x === undefined || y === undefined) return fail('x and y are required');
      c.moveTo({ x, y });
      return ok(`[${c.alias}] moving to ${x}, ${y}`);
    }
    case 'shootAt': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const x = toNumber(raw.x);
      const y = toNumber(raw.y);
      if (x === undefined || y === undefined) return fail('x and y are required');
      return c.shootAt({ x, y }) ? ok(`[${c.alias}] shot at ${x}, ${y}`) : fail(`[${c.alias}] could not shoot`);
    }
    case 'loadPlugin': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const name = String(raw.name ?? '').trim();
      if (!name) return fail('plugin name is required');
      return ctx.plugins.load(c, name) ? ok(`[${c.alias}] plugin loaded: ${name}`) : fail(`[${c.alias}] plugin not found: ${name}`);
    }
    case 'unloadPlugin': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const name = String(raw.name ?? '').trim();
      if (!name) return fail('plugin name is required');
      return ctx.plugins.unload(c, name) ? ok(`[${c.alias}] plugin unloaded: ${name}`) : fail(`[${c.alias}] plugin was not loaded: ${name}`);
    }
    case 'runInvTest': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const trip = ctx.plugins.get<PetBagRoundTrip>(c, 'PetBagRoundTrip');
      if (!trip) return fail(`[${c.alias}] PetBagRoundTrip is not loaded`);
      void trip.run(c);
      return ok(`[${c.alias}] PetBagRoundTrip started`);
    }
    case 'runPetToVault': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const flow = ctx.plugins.get<PetToVault>(c, 'PetToVault');
      if (!flow) return fail(`[${c.alias}] PetToVault is not loaded`);
      void flow.run(c);
      return ok(`[${c.alias}] PetToVault started`);
    }
    case 'runStallTest': {
      const c = requireClient();
      if (!c) return fail(`no client: ${alias}`);
      const ms = toInt(raw.ms);
      if (!ms || ms <= 0) return fail('stall duration must be a positive number of milliseconds');
      return c.stall(ms)
        ? ok(`[${c.alias}] timed stall started for ${ms}ms`)
        : fail(`[${c.alias}] could not stall socket`);
    }
    default:
      return fail(`unknown action: ${action}`);
  }
}

async function runConsoleCommand(ctx: WebPanelContext, selectedAlias: string, command: string): Promise<ActionResponse> {
  const parts = splitCommand(command);
  const verb = (parts.shift() ?? '').toLowerCase();
  let alias = selectedAlias;
  if (parts.length && ctx.clients.has(parts[0])) {
    alias = parts.shift() ?? alias;
  }
  const rest = parts.join(' ');
  switch (verb) {
    case 'help':
      return ok('commands: show, set, pos, say, sayall, tick, debug, vault, escape, stall, unstall, resume, disconnect, start, connect, gameid, portal, invswap, move, shoot, realms, hosts, plugins, plugin, load, unload, invtest, pettovault, stalltest, clear');
    case 'clear':
      return runAction(ctx, { action: 'clearLogs' });
    case 'show':
      return ok(JSON.stringify(config, null, 2));
    case 'say':
      return runAction(ctx, { action: 'say', alias, message: rest });
    case 'sayall':
      return runAction(ctx, { action: 'sayAll', message: rest });
    case 'vault':
      return runAction(ctx, { action: 'enterVault', alias });
    case 'escape':
      return runAction(ctx, { action: 'escape', alias });
    case 'stall':
      return runAction(ctx, { action: 'stall', alias });
    case 'unstall':
    case 'resume':
      return runAction(ctx, { action: 'resume', alias });
    case 'disconnect':
      return runAction(ctx, { action: 'disconnect', alias });
    case 'start':
    case 'connect-client':
      return runAction(ctx, { action: 'startConnection', alias });
    case 'connect':
      return runAction(ctx, { action: 'connectServer', alias, target: rest });
    case 'gameid':
      return runAction(ctx, { action: 'connectGameId', alias, gameId: parts[0], host: parts[1] });
    case 'portal':
    case 'useportal':
      return runAction(ctx, { action: 'usePortal', alias, objectId: parts[0] });
    case 'invswap':
    case 'swap':
      return runAction(ctx, { action: 'swapSlots', alias, from: parts[0], to: parts[1] });
    case 'move':
      return runAction(ctx, { action: 'moveTo', alias, x: parts[0], y: parts[1] });
    case 'shoot':
      return runAction(ctx, { action: 'shootAt', alias, x: parts[0], y: parts[1] });
    case 'set':
      return runAction(ctx, { action: 'setConfig', key: parts[0], value: parts.slice(1).join(' ') });
    case 'pos': {
      const client = ctx.clients.get(alias);
      if (!client) return fail(`no client: ${alias}`);
      const local = client.getPosition();
      const server = client.getServerPosition();
      return ok(
        `[${client.alias}] pos local (${local.x.toFixed(2)}, ${local.y.toFixed(2)}) ` +
          (server ? `server (${server.x.toFixed(2)}, ${server.y.toFixed(2)})` : 'server unknown'),
      );
    }
    case 'tick': {
      const client = ctx.clients.get(alias);
      if (!client) return fail(`no client: ${alias}`);
      const tick = client.getTickInfo();
      return ok(
        `[${client.alias}] tick ${tick.tickId} (count ${tick.tickCount}), server interval ${tick.tickTimeMs}ms, ` +
          (tick.msSinceTick < 0 ? 'no tick yet' : `${tick.msSinceTick}ms since last tick`),
      );
    }
    case 'debug': {
      const client = ctx.clients.get(alias);
      if (!client) return fail(`no client: ${alias}`);
      return ok(JSON.stringify(client.debugInfo(), null, 2));
    }
    case 'realms': {
      const client = ctx.clients.get(alias);
      if (!client) return fail(`no client: ${alias}`);
      return ok(JSON.stringify(client.realmPortals(), null, 2));
    }
    case 'hosts': {
      const client = ctx.clients.get(alias);
      if (!client) return fail(`no client: ${alias}`);
      const mapper = ctx.plugins.get<RealmHostMapper>(client, 'RealmHostMapper');
      if (!mapper) return fail(`[${client.alias}] RealmHostMapper is not loaded`);
      return ok(JSON.stringify(mapper.portals(), null, 2));
    }
    case 'plugins': {
      const client = ctx.clients.get(alias);
      if (!client) return fail(`no client: ${alias}`);
      return ok(
        `[${client.alias}] loaded: [${ctx.plugins.loaded(client).join(', ') || 'none'}]\n` +
          JSON.stringify(ctx.plugins.available(), null, 2),
      );
    }
    case 'load':
      return runAction(ctx, { action: 'loadPlugin', alias, name: rest });
    case 'unload':
      return runAction(ctx, { action: 'unloadPlugin', alias, name: rest });
    case 'plugin': {
      const op = (parts.shift() ?? '').toLowerCase();
      const name = parts.join(' ');
      if (op === 'load') return runAction(ctx, { action: 'loadPlugin', alias, name });
      if (op === 'unload') return runAction(ctx, { action: 'unloadPlugin', alias, name });
      return fail('usage: plugin load|unload <name>');
    }
    case 'invtest':
      return runAction(ctx, { action: 'runInvTest', alias });
    case 'pettovault':
      return runAction(ctx, { action: 'runPetToVault', alias });
    case 'stalltest':
      return runAction(ctx, { action: 'runStallTest', alias, ms: parts[0] });
    default:
      return fail(`unknown console command: ${verb || command}`);
  }
}

function ok(message: string, data?: unknown): ActionResponse {
  return { ok: true, message, data };
}

function fail(message: string): ActionResponse {
  return { ok: false, message };
}

function toInt(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function toNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseSlotRef(value: unknown): SlotRef {
  if (!value || typeof value !== 'object') {
    throw new Error('slot ref must be an object');
  }
  const raw = value as Record<string, unknown>;
  const objectId = toInt(raw.objectId);
  const slotId = toInt(raw.slotId);
  const itemType = toInt(raw.itemType);
  if (objectId === undefined) throw new Error('objectId must be an integer');
  if (slotId === undefined) throw new Error('slotId must be an integer');
  if (itemType === undefined) throw new Error('itemType must be an integer');
  return { objectId, slotId, itemType };
}

function canConnectUnkeyed(gameId: number): boolean {
  return gameId === GameId.Nexus || gameId === GameId.Tutorial;
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command))) {
    parts.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["'\\])/g, '$1'));
  }
  return parts;
}

function parseAccountsJson(text: string): Account[] {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('root value must be an array');
  }
  return parsed.map((entry, index) => normalizeAccount(entry, index));
}

function normalizeAccount(value: unknown, index = 0): Account {
  if (!value || typeof value !== 'object') {
    throw new Error(`account ${index + 1} must be an object`);
  }
  const raw = value as Record<string, unknown>;
  const guid = String(raw.guid ?? '').trim();
  const password = String(raw.password ?? '').trim();
  const alias = String(raw.alias ?? '').trim();
  if (!guid) throw new Error(`account ${index + 1} is missing guid`);
  if (!password) throw new Error(`account ${index + 1} is missing password`);

  const account: Account = { guid, password };
  if (alias) account.alias = alias;
  if (raw.enterVault !== undefined) account.enterVault = raw.enterVault === true || raw.enterVault === 'true';
  if (Array.isArray(raw.plugins)) {
    account.plugins = raw.plugins.map((name) => String(name).trim()).filter(Boolean);
  } else if (typeof raw.plugins === 'string') {
    account.plugins = raw.plugins.split(',').map((name) => name.trim()).filter(Boolean);
  }
  return account;
}

function readPort(raw: string | undefined, fallback: number): number {
  const port = Number(raw ?? '');
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function send(res: http.ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text ? JSON.parse(text) : {});
    });
    req.on('error', reject);
  });
}

function installConsoleCapture(): void {
  if (consoleCaptured) {
    return;
  }
  consoleCaptured = true;
  for (const level of ['log', 'warn', 'error'] as LogLevel[]) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]): void => {
      original(...args);
      captureLog(level, args);
    };
  }
}

function captureLog(level: LogLevel, args: unknown[]): void {
  const entry = {
    id: nextLogId++,
    at: new Date().toISOString(),
    level,
    message: format(...args),
  };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_LIMIT) {
    logBuffer.shift();
  }
  broadcast('log', entry);
}

function broadcast(event: string, data: unknown): void {
  for (const res of streams) {
    writeEvent(res, event, data);
  }
}

function writeEvent(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Headless Control</title>
  <link rel="stylesheet" href="/app.css">
</head>
<body>
  <div id="app">
    <div class="boot">Opening control panel</div>
  </div>
  <script src="/app.js"></script>
</body>
</html>`;

const CSS = `
:root {
  color-scheme: dark;
  --bg: #151512;
  --panel: #20201c;
  --panel-2: #292821;
  --line: #3a382f;
  --line-soft: #2f2d27;
  --text: #f3f0e8;
  --muted: #a9a396;
  --faint: #777165;
  --green: #39c27f;
  --cyan: #48bfd2;
  --amber: #dba33a;
  --red: #e65b66;
  --violet: #9b7bea;
  --black: #0c0c0a;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  background: var(--bg);
  color: var(--text);
}

button,
input,
select,
textarea {
  font: inherit;
}

button {
  border: 1px solid var(--line);
  color: var(--text);
  background: #26251f;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
}

button:hover {
  border-color: #69624d;
  background: #302f27;
}

button.primary {
  border-color: #2d6f5e;
  background: #1f4f46;
}

button.danger {
  border-color: #85414a;
  background: #51252b;
}

button.ghost {
  background: transparent;
}

button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

input,
select,
textarea {
  width: 100%;
  min-height: 34px;
  color: var(--text);
  background: #11110f;
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 0 10px;
  outline: none;
}

input:focus,
select:focus,
textarea:focus {
  border-color: var(--cyan);
}

textarea {
  min-height: 260px;
  padding: 10px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  line-height: 1.45;
}

.boot {
  display: grid;
  min-height: 100vh;
  place-items: center;
  color: var(--muted);
}

.shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
}

.rail {
  border-right: 1px solid var(--line);
  background: #11110f;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.brand {
  height: 76px;
  padding: 18px 18px 14px;
  border-bottom: 1px solid var(--line);
}

.brand h1 {
  margin: 0;
  font-size: 18px;
  line-height: 1.1;
  letter-spacing: 0;
}

.brand .sub {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}

.client-list {
  padding: 14px;
  display: grid;
  gap: 10px;
  overflow-y: auto;
}

.client-button {
  width: 100%;
  min-height: 74px;
  padding: 10px;
  text-align: left;
  border-color: var(--line-soft);
  display: grid;
  gap: 8px;
  background: #181815;
}

.client-button.active {
  border-color: var(--cyan);
  background: #202521;
}

.client-button .row,
.top-row,
.metric-head,
.table-row,
.plugin-row,
.config-row,
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.client-name,
.truncate {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.client-name {
  font-weight: 700;
}

.status-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--faint);
  box-shadow: 0 0 0 2px #000;
}

.status-dot.inWorld,
.status-dot.connected {
  background: var(--green);
}

.status-dot.connecting,
.status-dot.reconnecting {
  background: var(--amber);
}

.status-dot.disconnected,
.status-dot.stopped {
  background: var(--red);
}

.mini {
  font-size: 12px;
  color: var(--muted);
}

.rail-footer {
  margin-top: auto;
  border-top: 1px solid var(--line);
  padding: 14px;
  display: grid;
  gap: 10px;
}

.sidebar-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.workspace {
  min-width: 0;
  display: grid;
  grid-template-rows: auto 1fr;
}

.topbar {
  height: 76px;
  border-bottom: 1px solid var(--line);
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: #191915;
}

.topbar-left {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 14px;
}

.connection-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
}

.title {
  min-width: 0;
}

.title h2 {
  margin: 0;
  font-size: 20px;
  line-height: 1.2;
  letter-spacing: 0;
}

.title .meta {
  margin-top: 5px;
  color: var(--muted);
  font-size: 12px;
}

.top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.content {
  min-width: 0;
  padding: 18px 20px 22px;
  display: grid;
  gap: 16px;
  overflow: auto;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(120px, 1fr));
  gap: 10px;
}

.metric {
  min-width: 0;
  min-height: 92px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px;
  display: grid;
  align-content: space-between;
  gap: 8px;
}

.metric label,
.section-title label {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.metric strong {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 19px;
  letter-spacing: 0;
}

.bar {
  height: 6px;
  border-radius: 999px;
  background: #11110f;
  overflow: hidden;
  border: 1px solid #333027;
}

.bar span {
  display: block;
  height: 100%;
  width: 0;
  background: var(--green);
}

.grid {
  display: grid;
  grid-template-columns: minmax(340px, 1.15fr) minmax(320px, 0.85fr);
  gap: 16px;
  min-width: 0;
}

.full-row {
  min-width: 0;
}

.panel {
  min-width: 0;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.panel-head {
  min-height: 48px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: #24231e;
}

.panel-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.panel-head h3 {
  margin: 0;
  font-size: 14px;
  letter-spacing: 0;
}

.panel-body {
  padding: 14px;
}

.commands {
  display: grid;
  grid-template-columns: repeat(4, minmax(180px, 1fr));
  gap: 10px;
}

.command-block {
  min-width: 0;
  border: 1px solid var(--line-soft);
  border-radius: 8px;
  padding: 10px;
  display: grid;
  gap: 8px;
  background: #1b1b17;
}

.command-block label {
  font-size: 12px;
  color: var(--muted);
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.field-row.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.inventory-grid,
.vault-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 8px;
}

.vault-sections {
  display: grid;
  gap: 14px;
}

.vault-section {
  display: grid;
  gap: 8px;
}

.vault-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.vault-section-head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slot {
  min-width: 0;
  aspect-ratio: 1.15;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 7px;
  display: grid;
  align-content: space-between;
  background: #171713;
}

.slot[draggable="true"] {
  cursor: grab;
}

.slot[data-slot-ref] {
  cursor: default;
}

.slot[data-slot-ref][draggable="true"] {
  cursor: grab;
}

.slot.dragging {
  opacity: 0.55;
}

.slot.drop-target {
  border-color: var(--cyan);
  box-shadow: inset 0 0 0 1px var(--cyan);
}

.slot.filled {
  border-color: #756234;
  background: #211d13;
}

.slot .slot-id {
  color: var(--faint);
  font-size: 11px;
}

.slot .item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
  font-size: 12px;
}

.slot .item-id {
  color: var(--faint);
  font-size: 10px;
}

.slot .kind {
  color: var(--muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.table {
  display: grid;
  gap: 6px;
  max-height: 360px;
  overflow: auto;
}

.table-row {
  min-height: 36px;
  padding: 7px 8px;
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  background: #191914;
}

.table-row.header {
  color: var(--muted);
  background: transparent;
  border-color: transparent;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.table-row > * {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.portal-table .table-row {
  grid-template-columns: minmax(110px, 1.1fr) minmax(90px, 0.9fr) 92px minmax(96px, 0.8fr) 74px;
  display: grid;
}

.object-table .table-row {
  grid-template-columns: 68px 72px minmax(140px, 1.1fr) minmax(100px, 0.8fr) minmax(140px, 1fr) 108px 62px;
  display: grid;
}

.object-tools {
  margin-bottom: 10px;
  display: grid;
  grid-template-columns: minmax(180px, 420px) auto;
  align-items: center;
  gap: 8px;
}

.gameid-table .table-row {
  grid-template-columns: 72px 1fr 92px 1.2fr;
  display: grid;
}

.host-table .table-row {
  grid-template-columns: 1fr 80px 1.1fr 76px;
  display: grid;
}

.ticket-table .table-row {
  grid-template-columns: 46px minmax(110px, 1fr) 78px minmax(160px, 1.4fr) 112px 82px;
  display: grid;
}

.plugin-list,
.config-list {
  display: grid;
  gap: 8px;
}

.plugin-row,
.config-row {
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 8px;
  background: #191914;
}

.plugin-row .grow,
.config-row .grow,
.toolbar .grow {
  flex: 1 1 auto;
  min-width: 0;
}

.chip {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 0 8px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  background: #151512;
  font-size: 12px;
}

.chip.green {
  color: var(--green);
  border-color: #27583f;
}

.chip.amber {
  color: var(--amber);
  border-color: #6b5425;
}

.chip.red {
  color: var(--red);
  border-color: #73333a;
}

.terminal {
  display: grid;
  grid-template-rows: minmax(220px, 38vh) auto;
  background: var(--black);
}

.log {
  height: 420px;
  overflow: auto;
  background: var(--black);
  padding: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.45;
}

.terminal .log {
  height: auto;
}

.log-line {
  display: flex;
  gap: 8px;
  align-items: start;
  min-height: 0;
  height: auto;
  padding: 1px 0;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}

.log-line .time {
  flex: 0 0 118px;
  white-space: nowrap;
}

.log-line .level {
  flex: 0 0 58px;
  white-space: nowrap;
}

.log-line .message {
  flex: 1 1 auto;
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.log-line.warn .level {
  color: var(--amber);
}

.log-line.error .level {
  color: var(--red);
}

.time,
.level {
  color: var(--faint);
}

.terminal-command {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border-top: 1px solid var(--line);
  background: #10100e;
}

.terminal-prompt {
  color: var(--green);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 700;
}

.terminal-command input {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: #121210;
  box-shadow: 0 18px 44px rgba(0,0,0,0.35);
  color: var(--text);
  z-index: 20;
}

.toast.bad {
  border-color: #7c333b;
}

.toast.good {
  border-color: #27583f;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.58);
  z-index: 30;
}

.modal {
  width: min(720px, 100%);
  max-height: min(760px, calc(100vh - 40px));
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: #181815;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}

.modal-head,
.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}

.modal-foot {
  border-top: 1px solid var(--line);
  border-bottom: 0;
  justify-content: flex-end;
}

.modal-body {
  padding: 16px;
  overflow: auto;
  display: grid;
  gap: 12px;
}

.modal h3 {
  margin: 0;
  font-size: 16px;
}

.modal label {
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  font-size: 13px;
}

.check-row input {
  width: auto;
  min-height: auto;
}

.empty {
  color: var(--muted);
  padding: 14px;
  border: 1px dashed var(--line);
  border-radius: 8px;
  text-align: center;
}

.overview-grid {
  display: grid;
  grid-template-columns: minmax(420px, 1.45fr) minmax(320px, .75fr);
  gap: 16px;
  min-width: 0;
}

.world-map-wrap {
  padding: 12px;
  background: #111511;
}

.world-map {
  display: block;
  width: 100%;
  height: clamp(320px, 42vw, 540px);
  border: 1px solid var(--line);
  border-radius: 6px;
  background: radial-gradient(circle at center, #1d2922 0, #111511 72%);
  cursor: crosshair;
  overflow: hidden;
}

.map-grid {
  fill-opacity: .7;
}

.map-grid + * {
  vector-effect: non-scaling-stroke;
}

.world-map pattern path {
  fill: none;
  stroke: #34443a;
  stroke-width: .08;
}

.map-dot,
.map-player,
.map-local {
  vector-effect: non-scaling-stroke;
}

.map-dot.object { fill: #737d75; opacity: .7; }
.map-dot.named { fill: var(--amber); stroke: #171713; stroke-width: 1px; }
.map-dot.portal { fill: var(--violet); stroke: #e2d9ff; stroke-width: 1px; }
.map-local { fill: none; stroke: var(--cyan); stroke-width: 2px; }
.map-player { fill: var(--green); stroke: #e7fff3; stroke-width: 2px; }
.drift-line { stroke: var(--cyan); stroke-width: 1px; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.target-line { stroke: var(--amber); stroke-width: 1px; stroke-dasharray: 5 4; vector-effect: non-scaling-stroke; }
.map-target { fill: none; stroke: var(--amber); stroke-width: 2px; vector-effect: non-scaling-stroke; }

.map-legend {
  min-height: 32px;
  padding-top: 10px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--muted);
  font-size: 11px;
}

.map-legend span { display: inline-flex; align-items: center; gap: 5px; }
.map-legend .grow { flex: 1 1 auto; }
.map-legend i { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
.map-legend i.player { background: var(--green); }
.map-legend i.local { background: transparent; border: 1px solid var(--cyan); }
.map-legend i.portal { background: var(--violet); }
.map-legend i.named { background: var(--amber); }

.map-radius {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11px;
}

.map-radius input { width: 52px; min-height: 26px; height: 26px; padding: 0 6px; }

.diagnostic-list {
  padding: 8px 14px;
  display: grid;
}

.diagnostic-list > div {
  min-width: 0;
  padding: 9px 0;
  display: grid;
  grid-template-columns: 125px minmax(0, 1fr);
  gap: 10px;
  border-bottom: 1px solid var(--line-soft);
}

.diagnostic-list span { color: var(--muted); font-size: 12px; }
.diagnostic-list strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; font-size: 12px; }
.raw-debug { margin: 4px 14px 14px; border: 1px solid var(--line-soft); border-radius: 6px; }
.raw-debug summary { padding: 9px 10px; cursor: pointer; color: var(--muted); font-size: 12px; }
.raw-debug pre { max-height: 280px; margin: 0; padding: 10px; overflow: auto; border-top: 1px solid var(--line-soft); background: var(--black); font-size: 11px; white-space: pre-wrap; }

@media (max-width: 1180px) {
  .shell {
    grid-template-columns: 240px minmax(0, 1fr);
  }
  .metrics {
    grid-template-columns: repeat(3, minmax(120px, 1fr));
  }
  .commands {
    grid-template-columns: repeat(2, minmax(180px, 1fr));
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .overview-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .shell {
    grid-template-columns: 1fr;
  }
  .rail {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
  .client-list {
    grid-auto-flow: column;
    grid-auto-columns: minmax(210px, 1fr);
    overflow-x: auto;
  }
  .rail-footer {
    display: none;
  }
  .topbar {
    height: auto;
    align-items: flex-start;
    flex-direction: column;
  }
  .topbar-left {
    width: 100%;
    align-items: flex-start;
    flex-direction: column;
  }
  .connection-actions {
    width: 100%;
  }
  .connection-actions button {
    flex: 1 1 0;
  }
  .top-actions {
    width: 100%;
    justify-content: flex-start;
  }
  .metrics,
  .commands {
    grid-template-columns: 1fr;
  }
  .inventory-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .world-map {
    height: 340px;
  }
}
`;

const JS = `
const app = document.getElementById('app');
let state = { clients: [], servers: [], config: {}, availablePlugins: [], logs: [] };
let selectedAlias = localStorage.getItem('selectedAlias') || '';
let connected = false;
let toastTimer = 0;
const drafts = Object.create(null);
let pendingRender = false;
let terminalFollow = true;
const commandHistory = [];
let commandHistoryIndex = 0;
const pointerHandled = new WeakSet();
let logPointerDown = false;
let pendingLogRefresh = false;
let streamRetryTimer = 0;
let events = null;
let dragSlot = null;
let modal = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function selectedClient() {
  return state.clients.find(c => c.alias === selectedAlias) || state.clients[0];
}

function ensureSelection() {
  if (!state.clients.length) {
    selectedAlias = '';
    return;
  }
  if (!state.clients.some(c => c.alias === selectedAlias)) {
    selectedAlias = state.clients[0].alias;
    localStorage.setItem('selectedAlias', selectedAlias);
  }
}

function statusClass(client) {
  return esc(client?.lifecycle || 'idle');
}

function chipClass(client) {
  const life = client?.lifecycle || 'idle';
  if (life === 'inWorld' || life === 'connected') return 'green';
  if (life === 'connecting' || life === 'reconnecting') return 'amber';
  if (life === 'disconnected' || life === 'stopped') return 'red';
  return '';
}

function draft(name, fallback = '') {
  return Object.prototype.hasOwnProperty.call(drafts, name) ? drafts[name] : fallback;
}

function field(name, fallback = '') {
  const input = Array.from(document.querySelectorAll('[data-draft]')).find(el => el.dataset.draft === name);
  return input ? input.value : draft(name, fallback);
}

function isEditing() {
  const el = document.activeElement;
  return (
    isLogFrozen() ||
    (!!el && el !== document.body && (el.matches('input, select, textarea') || el.closest('[data-freeze-render]')))
  );
}

function isLogFrozen() {
  if (logPointerDown) return true;
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed || !selection.toString()) return false;
  const box = document.getElementById('logBox');
  if (!box) return false;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  return !!((anchor && box.contains(anchor)) || (focus && box.contains(focus)));
}

function captureScroll() {
  const memory = Object.create(null);
  document.querySelectorAll('[data-scroll-key]').forEach(el => {
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    memory[el.dataset.scrollKey] = { top: el.scrollTop, left: el.scrollLeft, atBottom: remaining < 48 };
  });
  return memory;
}

function restoreScroll(memory) {
  document.querySelectorAll('[data-scroll-key]').forEach(el => {
    const saved = memory[el.dataset.scrollKey];
    if (!saved) return;
    el.scrollTop = saved.top;
    el.scrollLeft = saved.left;
  });
}

function restoreTerminalFollow(saved) {
  const box = document.getElementById('logBox');
  if (!box) return;
  if (!saved || saved.atBottom || terminalFollow) {
    scrollTerminalToBottom();
  }
}

function scrollTerminalToBottom() {
  const box = document.getElementById('logBox');
  if (!box) return;
  box.scrollTop = box.scrollHeight;
}

function updateLogCount() {
  const count = document.getElementById('logCount');
  if (count) count.textContent = String(state.logs.length);
}

function renderDeferred() {
  if (!pendingRender || isEditing()) return;
  render(true);
}

function flushDeferredLog() {
  if (isLogFrozen()) return;
  if (pendingLogRefresh) {
    pendingLogRefresh = false;
    replaceLogs();
  }
  renderDeferred();
}

function render(force = false) {
  if (!force && isEditing()) {
    pendingRender = true;
    return;
  }
  ensureSelection();
  const client = selectedClient();
  const scroll = captureScroll();
  const reusableTerminal = document.getElementById('terminalPanel');
  if (reusableTerminal) reusableTerminal.remove();
  app.innerHTML = \`
    <div class="shell">
      <aside class="rail">
        <div class="brand">
          <h1>Headless Control</h1>
          <div class="sub">\${connected ? 'stream connected' : 'stream offline'} - \${state.clients.length} client(s)</div>
        </div>
        <div class="client-list" data-scroll-key="clients">
          \${state.clients.length ? state.clients.map(renderClientButton).join('') : '<div class="empty">No clients connected</div>'}
        </div>
        <div class="rail-footer">
          <div class="toolbar"><span class="chip \${connected ? 'green' : 'red'}">\${connected ? 'live' : 'offline'}</span><span class="mini truncate">\${esc(state.now || '')}</span></div>
          <div class="sidebar-actions">
            <button class="primary" data-panel-action="addClient">Add client</button>
            <button data-panel-action="editAccounts">Edit accounts.json</button>
          </div>
          <button class="ghost" data-action="sayAllPrompt">Say all</button>
        </div>
      </aside>
      <main class="workspace">
        \${client ? renderWorkspace(client) : renderNoClient()}
      </main>
    </div>
  \`;
  const terminalMount = document.getElementById('terminalMount');
  if (terminalMount && reusableTerminal) {
    terminalMount.replaceChildren(reusableTerminal);
    updateLogCount();
  }
  restoreScroll(scroll);
  restoreTerminalFollow(scroll.log);
  pendingRender = false;
}

function renderClientButton(client) {
  const active = client.alias === selectedAlias ? ' active' : '';
  const hp = client.player?.hp || 'unknown';
  return \`
    <button class="client-button\${active}" data-select="\${esc(client.alias)}">
      <div class="row">
        <span class="status-dot \${statusClass(client)}"></span>
        <span class="client-name">\${esc(client.alias)}</span>
        <span class="chip \${chipClass(client)}">\${esc(client.lifecycle)}</span>
      </div>
      <div class="mini truncate">\${esc(client.mapName)} - \${esc(client.host)}</div>
      <div class="mini truncate">HP \${esc(hp)} - tick \${esc(client.tick?.tickId ?? 'none')}</div>
    </button>
  \`;
}

function renderNoClient() {
  return \`
    <div class="topbar">
      <div class="title"><h2>No active clients</h2><div class="meta">Waiting for accounts to finish login</div></div>
    </div>
    <div class="content" data-scroll-key="content"><div class="panel"><div class="panel-body"><div class="empty">Start the client process with accounts.json configured.</div></div></div></div>
  \`;
}

function renderWorkspace(client) {
  const canDisconnect = client.lifecycle !== 'stopped';
  const canStart = client.lifecycle === 'stopped' || client.lifecycle === 'disconnected';
  return \`
    <div class="topbar">
      <div class="topbar-left">
        <div class="connection-actions">
          <button class="danger" data-action="disconnect" \${canDisconnect ? '' : 'disabled'}>Disconnect</button>
          <button class="primary" data-action="startConnection" \${canStart ? '' : 'disabled'}>Start</button>
        </div>
        <div class="title">
          <h2>\${esc(client.alias)}</h2>
          <div class="meta">\${esc(client.mapName)} - \${esc(client.host)} - object \${esc(client.debug?.objectId ?? -1)}</div>
        </div>
      </div>
      <div class="top-actions">
        <button class="primary" data-action="enterVault">Vault</button>
        <button data-action="escape">Escape</button>
        <button data-action="\${client.debug?.stalled ? 'resume' : 'stall'}">\${client.debug?.stalled ? 'Resume' : 'Stall'}</button>
        <button class="danger" data-action="runStallTest">Stall test</button>
      </div>
    </div>
    <div class="content" data-scroll-key="content">
      <div id="terminalMount">\${renderTerminal(client)}</div>
      \${renderMetrics(client)}
      <div class="overview-grid">
        \${renderWorldMap(client)}
        \${renderDiagnostics(client)}
      </div>
      <section class="panel">
        <div class="panel-head"><h3>Commands</h3><span class="chip">selected: \${esc(client.alias)}</span></div>
        <div class="panel-body commands">
          \${renderCommandBlocks(client)}
        </div>
      </section>
      <div class="grid">
        <section class="panel">
          <div class="panel-head"><h3>Inventory</h3><div class="panel-head-actions">\${renderInvResultChip(client)}<span class="chip">\${client.inventory.filter(id => id !== -1).length}/\${client.inventory.length || 20}</span></div></div>
          <div class="panel-body">\${renderInventory(client)}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>Vault Contents</h3><div class="panel-head-actions">\${renderInvResultChip(client)}<span class="chip">\${vaultItemCount(client, ['vault'])} item(s)</span></div></div>
          <div class="panel-body">\${renderVaultContents(client)}</div>
        </section>
      </div>
      <div class="grid">
        <section class="panel">
          <div class="panel-head"><h3>Storage Chests</h3><div class="panel-head-actions">\${renderInvResultChip(client)}<span class="chip">\${vaultItemCount(client, ['material', 'gift', 'potion', 'spoils'])} item(s)</span></div></div>
          <div class="panel-body">\${renderStorageChests(client)}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h3>Plugins</h3><span class="chip">\${client.loadedPlugins.length} loaded</span></div>
          <div class="panel-body">\${renderPlugins(client)}</div>
        </section>
      </div>
      <section class="panel full-row">
        <div class="panel-head"><h3>Plugin Data</h3><span class="chip">live</span></div>
        <div class="panel-body">\${renderPluginData(client)}</div>
      </section>
      <section class="panel full-row">
        <div class="panel-head"><h3>Visible Objects</h3><span class="chip">\${client.visibleObjects.length}</span></div>
        <div class="panel-body">\${renderObjects(client)}</div>
      </section>
      <section class="panel full-row">
        <div class="panel-head"><h3>Portals</h3><span class="chip">\${client.portals.length}</span></div>
        <div class="panel-body">\${renderPortals(client)}</div>
      </section>
    </div>
  \`;
}

function renderTerminal(client) {
  return \`
    <section class="panel terminal-panel" id="terminalPanel" data-freeze-render>
      <div class="panel-head">
        <h3>Live Log</h3>
        <div class="panel-head-actions">
          <button data-copy-console>Copy all</button>
          <span class="chip" id="logCount">\${state.logs.length}</span>
        </div>
      </div>
      <div class="terminal">
        <div class="log" id="logBox" data-scroll-key="log">\${renderLogs()}</div>
        <form class="terminal-command" data-console-form>
          <span class="terminal-prompt">\${esc(client.alias)} $</span>
          <input data-draft="consoleCommand" data-console-input value="\${esc(draft('consoleCommand'))}" autocomplete="off" spellcheck="false" placeholder="command">
          <button type="submit" class="primary">Run</button>
        </form>
      </div>
    </section>
  \`;
}

function renderMetrics(client) {
  const tickAge = client.tick?.msSinceTick >= 0 ? client.tick.msSinceTick + 'ms' : 'none';
  const pos = client.serverPosition || client.position || { x: 0, y: 0 };
  return \`
    <section class="metrics">
      \${metric('Lifecycle', client.lifecycle, client.debug?.connected ? 'connected' : 'socket closed')}
      \${metric('Map', client.mapName, client.inVault ? 'vault' : 'field')}
      \${metric('HP', client.player?.hp || 'unknown', barFromPair(client.player?.hp))}
      \${metric('MP', client.player?.mp || 'unknown', barFromPair(client.player?.mp))}
      \${metric('Position', Number(pos.x).toFixed(2) + ', ' + Number(pos.y).toFixed(2), 'server')}
      \${metric('Tick', client.tick?.tickId ?? 'none', tickAge)}
    </section>
  \`;
}

function renderWorldMap(client) {
  const player = client.serverPosition || client.position || { x: 0, y: 0 };
  const local = client.position || player;
  const target = client.debug?.movementTarget;
  const objects = client.visibleObjects || [];
  const radius = Math.max(12, Math.min(55, Number(draft('mapRadius', '26')) || 26));
  const minX = Number(player.x) - radius;
  const minY = Number(player.y) - radius;
  const size = radius * 2;
  const visible = objects.filter(o => Math.abs(Number(o.x) - player.x) <= radius && Math.abs(Number(o.y) - player.y) <= radius);
  const portalIds = new Set((client.portals || []).map(p => Number(p.objectId)));
  const dots = visible.map(o => {
    const portal = portalIds.has(Number(o.objectId)) || /portal/i.test(String(o.typeClass || '') + String(o.typeName || '') + String(o.name || ''));
    const named = !!o.name;
    const kind = portal ? 'portal' : named ? 'named' : 'object';
    const label = (o.name || o.typeName || ('Object ' + o.objectId)) + ' · ' + Number(o.distance || 0).toFixed(1) + ' tiles';
    return \`<circle class="map-dot \${kind}" cx="\${Number(o.x)}" cy="\${Number(o.y)}" r="\${portal ? 0.65 : named ? 0.42 : 0.25}"><title>\${esc(label)}</title></circle>\`;
  }).join('');
  const targetMark = target ? \`
    <line class="target-line" x1="\${player.x}" y1="\${player.y}" x2="\${target.x}" y2="\${target.y}" />
    <path class="map-target" d="M \${target.x - .7} \${target.y} H \${target.x + .7} M \${target.x} \${target.y - .7} V \${target.y + .7}" />\` : '';
  const drift = Math.hypot(Number(local.x) - Number(player.x), Number(local.y) - Number(player.y));
  return \`
    <section class="panel map-panel">
      <div class="panel-head">
        <h3>Live World Radar</h3>
        <div class="panel-head-actions"><span class="chip green">\${visible.length} nearby</span><label class="map-radius">radius <input data-draft="mapRadius" inputmode="numeric" value="\${esc(radius)}"></label></div>
      </div>
      <div class="world-map-wrap">
        <svg class="world-map" data-world-map data-min-x="\${minX}" data-min-y="\${minY}" data-size="\${size}" viewBox="\${minX} \${minY} \${size} \${size}" role="img" aria-label="Live map centered on \${esc(client.alias)}">
          <defs><pattern id="grid-\${safeId(client.alias)}" width="5" height="5" patternUnits="userSpaceOnUse"><path d="M 5 0 L 0 0 0 5" /></pattern></defs>
          <rect class="map-grid" x="\${minX}" y="\${minY}" width="\${size}" height="\${size}" fill="url(#grid-\${safeId(client.alias)})" />
          \${dots}\${targetMark}
          \${drift > .05 ? \`<line class="drift-line" x1="\${local.x}" y1="\${local.y}" x2="\${player.x}" y2="\${player.y}" />\` : ''}
          <circle class="map-local" cx="\${local.x}" cy="\${local.y}" r="0.62"><title>Local estimate</title></circle>
          <circle class="map-player" cx="\${player.x}" cy="\${player.y}" r="0.48"><title>Server position: \${Number(player.x).toFixed(2)}, \${Number(player.y).toFixed(2)}</title></circle>
        </svg>
        <div class="map-legend"><span><i class="player"></i>server</span><span><i class="local"></i>local</span><span><i class="portal"></i>portal</span><span><i class="named"></i>named</span><span class="grow"></span><span>Click map to move</span></div>
      </div>
    </section>\`;
}

function safeId(value) {
  return String(value || 'client').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function renderDiagnostics(client) {
  const d = client.debug || {};
  const tickAge = Number(client.tick?.msSinceTick ?? -1);
  const activityAge = Number(d.activityAgeMs ?? -1);
  const drift = Number(d.positionDrift ?? 0);
  const health = !d.connected ? ['red', 'Disconnected']
    : d.stalled ? ['amber', 'Intentionally stalled']
    : tickAge > 5000 || activityAge > 5000 ? ['amber', 'Traffic delayed']
    : ['green', 'Healthy'];
  const socket = d.socket || {};
  const rows = [
    ['Connection', d.host || client.host],
    ['Game / object', (d.gameId ?? '—') + ' / ' + (d.objectId ?? '—')],
    ['Last traffic', activityAge >= 0 ? formatDuration(activityAge) + ' ago' : 'none'],
    ['Tick cadence', (client.tick?.tickTimeMs ?? '—') + 'ms · age ' + (tickAge >= 0 ? formatDuration(tickAge) : '—')],
    ['Position drift', drift.toFixed(3) + ' tiles'],
    ['Movement', d.movementTarget ? Number(d.movementDistance || 0).toFixed(2) + ' tiles remaining' : 'idle'],
    ['Network I/O', formatBytes(socket.bytesRead) + ' down · ' + formatBytes(socket.bytesWritten) + ' up'],
    ['Reconnects', d.reconnectAttempts ?? 0],
    ['Stall queue', (d.stalledQueuedPackets ?? 0) + ' queued · ' + (d.stalledDroppedPackets ?? 0) + ' dropped'],
    ['Runtime', formatDuration((state.uptimeSec || 0) * 1000)],
  ];
  return \`
    <section class="panel diagnostics-panel">
      <div class="panel-head"><h3>Connection Diagnostics</h3><span class="chip \${health[0]}">\${health[1]}</span></div>
      <div class="diagnostic-list">\${rows.map(([key, value]) => \`<div><span>\${esc(key)}</span><strong title="\${esc(value)}">\${esc(value)}</strong></div>\`).join('')}</div>
      <details class="raw-debug"><summary>Raw debug snapshot</summary><pre>\${esc(JSON.stringify(d, null, 2))}</pre></details>
    </section>\`;
}

function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KiB';
  return (n / 1048576).toFixed(1) + ' MiB';
}

function formatDuration(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  if (n < 3600000) return Math.floor(n / 60000) + 'm ' + Math.floor((n % 60000) / 1000) + 's';
  return Math.floor(n / 3600000) + 'h ' + Math.floor((n % 3600000) / 60000) + 'm';
}

function metric(label, value, foot) {
  const bar = typeof foot === 'object' ? \`<div class="bar"><span style="width:\${foot.pct}%"></span></div><span class="mini">\${esc(foot.text)}</span>\` : \`<span class="mini truncate">\${esc(foot)}</span>\`;
  return \`<div class="metric"><label>\${esc(label)}</label><strong>\${esc(value)}</strong>\${bar}</div>\`;
}

function barFromPair(pair) {
  const match = String(pair || '').match(/^(\\d+)\\/(\\d+)$/);
  if (!match) return { pct: 0, text: 'unknown' };
  const current = Number(match[1]);
  const max = Number(match[2]);
  return { pct: max > 0 ? Math.max(0, Math.min(100, Math.round((current / max) * 100))) : 0, text: pair };
}

function renderCommandBlocks(client) {
  return \`
    <div class="command-block">
      <label>Chat</label>
      <input data-draft="say" value="\${esc(draft('say'))}" placeholder="Message">
      <div class="toolbar"><button class="primary" data-action="say">Send</button><button data-action="sayAll">Send all</button></div>
    </div>
    <div class="command-block">
      <label>Inventory swap</label>
      <div class="field-row"><input data-draft="swapFrom" value="\${esc(draft('swapFrom', '4'))}" inputmode="numeric"><input data-draft="swapTo" value="\${esc(draft('swapTo', '12'))}" inputmode="numeric"></div>
      <button data-action="swapSlots">Swap slots</button>
    </div>
    <div class="command-block">
      <label>Connect</label>
      <input list="servers" data-draft="serverTarget" value="\${esc(draft('serverTarget', client.host))}">
      <datalist id="servers">\${state.servers.map(s => \`<option value="\${esc(s.name)}">\${esc(s.address)}</option>\`).join('')}</datalist>
      <button data-action="connectServer">Connect server</button>
    </div>
    <div class="command-block">
      <label>Hello game id</label>
      <div class="field-row"><input data-draft="gameId" value="\${esc(draft('gameId', '-2'))}" inputmode="numeric"><input data-draft="gameHost" value="\${esc(draft('gameHost', client.host))}"></div>
      <select data-draft="ticketId">
        <option value="">Captured reconnect ticket</option>
        \${(client.reconnectTickets || []).map(t => \`<option value="\${esc(t.id)}" \${String(draft('ticketId')) === String(t.id) ? 'selected' : ''}>#\${esc(t.id)} \${esc(t.name || 'unnamed')} gameId \${esc(t.gameId)}</option>\`).join('')}
      </select>
      <div class="toolbar"><button data-action="connectGameId">Connect gameId</button><button data-action="connectTicket">Use ticket</button></div>
    </div>
    <div class="command-block">
      <label>World target</label>
      <div class="field-row"><input data-draft="moveX" value="\${esc(draft('moveX', Number(client.position?.x || 0).toFixed(1)))}"><input data-draft="moveY" value="\${esc(draft('moveY', Number(client.position?.y || 0).toFixed(1)))}"></div>
      <div class="toolbar"><button data-action="moveTo">Move</button><button data-action="shootAt">Shoot</button></div>
    </div>
    <div class="command-block">
      <label>Plugin runs</label>
      <div class="field-row"><button data-action="runInvTest">Inv test</button><button data-action="runPetToVault">Pet to vault</button></div>
      <div class="field-row"><input data-draft="stallMs" value="\${esc(draft('stallMs', '5000'))}" inputmode="numeric"><button data-action="runStallTest">Stall test</button></div>
    </div>
    <div class="command-block">
      <label>Plugin load</label>
      <select data-draft="pluginName">\${state.availablePlugins.map(p => \`<option value="\${esc(p.name)}" \${draft('pluginName') === p.name ? 'selected' : ''}>\${esc(p.name)}</option>\`).join('')}</select>
      <div class="toolbar"><button data-action="loadPlugin">Load</button><button data-action="unloadPlugin">Unload</button></div>
    </div>
    <div class="command-block">
      <label>Socket</label>
      <div class="field-row"><button data-action="stall">Stall</button><button data-action="resume">Resume</button></div>
      <div class="field-row"><button data-action="enterVault">Vault</button><button data-action="escape">Escape</button></div>
    </div>
  \`;
}

function renderInventory(client) {
  const inv = client.inventory.length ? client.inventory : Array(20).fill(-1);
  const itemSlots = client.itemSlots || inv.map(id => ({ id }));
  const objectId = Number(client.debug?.objectId ?? -1);
  const slots = inv.slice(0, 20).map((id, slot) => ({
    id,
    slot,
    item: itemSlots[slot] || { id },
    kind: slot < 4 ? 'equip' : slot < 12 ? 'inv' : 'pack',
    objectId,
    interactive: objectId !== -1,
  }));
  return renderItemGrid(slots, 'inventory-grid');
}

function renderVaultContents(client) {
  const vault = client.vaultContent;
  if (!vault) {
    return '<div class="empty">Vault contents not available yet. Enter the vault to load storage.</div>';
  }
  return renderVaultSections(client, ['vault'], 'vault-contents');
}

function renderStorageChests(client) {
  const vault = client.vaultContent;
  if (!vault) {
    return '<div class="empty">Storage contents not available yet. Enter the vault to load storage.</div>';
  }
  return renderVaultSections(client, ['material', 'gift', 'potion', 'spoils'], 'storage-chests');
}

function renderVaultSections(client, keys, scrollKey) {
  const vault = client.vaultContent;
  const sections = (vault?.sections || []).filter(section => keys.includes(section.key));
  if (!sections.length) return '<div class="empty">No storage sections reported</div>';
  return \`
    <div class="vault-sections" data-scroll-key="\${esc(scrollKey)}">
      \${sections.map(section => {
        const contents = section.contents || [];
        const itemSlots = section.itemSlots || contents.map(id => ({ id }));
        const slots = contents.map((id, slot) => ({
          id,
          slot,
          item: itemSlots[slot] || { id },
          kind: section.key,
          objectId: section.objectId,
          interactive: client.inVault && section.objectId !== -1,
        }));
        return \`
          <div class="vault-section">
            <div class="vault-section-head">
              <strong>\${esc(section.label)}</strong>
              <span class="chip">obj \${esc(section.objectId)} - \${esc(section.itemCount || 0)}/\${esc(contents.length)}</span>
            </div>
            \${contents.length ? renderItemGrid(slots, 'vault-grid') : '<div class="empty">No slots reported</div>'}
          </div>
        \`;
      }).join('')}
    </div>
  \`;
}

function renderItemGrid(slots, className) {
  return \`<div class="\${esc(className)}">\${slots.map(slot => renderItemSlot(slot)).join('')}</div>\`;
}

function renderItemSlot(slot) {
  const id = Number(slot.id ?? -1);
  const item = slot.item || { id };
  const label = id === -1 ? 'empty' : (item.name || id);
  const title = id === -1 ? 'empty' : \`\${item.name || 'Unknown item'} (#\${id}) - \${item.className || 'Item'}\`;
  const ref = slot.interactive ? slotRefAttr({ objectId: slot.objectId, slotId: slot.slot, itemType: id }) : '';
  return \`<div class="slot \${id === -1 ? '' : 'filled'}" title="\${esc(title)}" draggable="\${slot.interactive && id !== -1}" \${ref}><div class="slot-id">slot \${esc(slot.slot)}</div><div class="item">\${esc(label)}</div><div class="item-id">\${id === -1 ? '' : '#' + esc(id)}</div><div class="kind">\${esc(slot.kind)}</div></div>\`;
}

function slotRefAttr(ref) {
  return \`data-slot-ref="\${esc(JSON.stringify(ref))}"\`;
}

function renderInvResultChip(client) {
  const result = client.lastInvResult;
  if (!result) return '';
  return \`<span class="chip \${result.ok ? 'green' : 'red'}">INV \${result.ok ? 'ok' : 'fail'} \${esc(result.from.slotId)}->\${esc(result.to.slotId)}</span>\`;
}

function vaultItemCount(client, keys) {
  const vault = client.vaultContent;
  if (!vault) return 0;
  return vault.sections
    .filter(section => !keys || keys.includes(section.key))
    .reduce((sum, section) => sum + Number(section.itemCount || 0), 0);
}

function renderPortals(client) {
  if (!client.portals.length) return '<div class="empty">No portals tracked</div>';
  return \`
    <div class="table portal-table" data-scroll-key="portals">
      <div class="table-row header"><span>Name</span><span>Type</span><span>Pos</span><span>Detail</span><span></span></div>
      \${client.portals.map(p => \`
        <div class="table-row">
          <span title="\${esc(p.name)}">\${esc(p.name)}</span>
          <span title="#\${esc(p.type)}">\${esc(p.typeName || p.typeClass || p.type)}</span>
          <span>\${Number(p.x).toFixed(1)}, \${Number(p.y).toFixed(1)}</span>
          <span>\${portalDetail(p)}</span>
          <button data-action="usePortal" data-id="\${esc(p.objectId)}">Enter</button>
        </div>\`).join('')}
    </div>
  \`;
}

function portalDetail(portal) {
  if (portal.players !== undefined && portal.maxPlayers !== undefined) {
    const opened = portal.openedAt ? ' - ' + portal.openedAt : '';
    return esc(portal.players) + '/' + esc(portal.maxPlayers) + opened;
  }
  return esc(portal.typeClass || 'portal');
}

function renderPlugins(client) {
  const loaded = client.loadedPlugins.length
    ? client.loadedPlugins.map(name => \`<div class="plugin-row"><div class="grow truncate">\${esc(name)}</div><button data-action="unloadPlugin" data-name="\${esc(name)}">Unload</button></div>\`).join('')
    : '<div class="empty">No plugins loaded</div>';
  return \`<div class="plugin-list" data-scroll-key="plugins-loaded">\${loaded}</div>\`;
}

function renderConfig() {
  return \`
    <div class="config-list" data-scroll-key="config">
      \${Object.entries(state.config || {}).map(([key, value]) => \`
        <div class="config-row">
          <div class="grow truncate"><strong>\${esc(key)}</strong><div class="mini">\${esc(typeof value)}</div></div>
          <input data-config-input="\${esc(key)}" data-draft="config:\${esc(key)}" value="\${esc(draft('config:' + key, value))}">
          <button data-action="setConfig" data-key="\${esc(key)}">Apply</button>
        </div>\`).join('')}
    </div>
  \`;
}

function renderPluginData(client) {
  const pet = client.pluginData?.petToVault;
  const petHtml = pet ? \`<div class="toolbar"><span class="chip">PetToVault</span><span class="mini">state \${esc(pet.state)} - item \${esc(pet.itemType)} - slot \${esc(pet.inventorySlot)}</span></div>\` : '<div class="mini">PetToVault not loaded</div>';
  const hosts = client.pluginData?.realmHosts || [];
  const tickets = client.reconnectTickets || [];
  return \`
    <div class="plugin-list">
      \${petHtml}
      <div class="table ticket-table" data-scroll-key="reconnect-tickets">
        <div class="table-row header"><span>#</span><span>Name</span><span>Game</span><span>Host</span><span>Key</span><span></span></div>
        \${tickets.slice(-80).reverse().map(ticket => \`
          <div class="table-row">
            <span>\${esc(ticket.id)}</span>
            <span title="\${esc(ticket.name || '')}">\${esc(ticket.name || 'unnamed')}</span>
            <span>\${esc(ticket.gameId)}</span>
            <span title="\${esc(ticket.host)}:\${esc(ticket.port)}">\${esc(ticket.host)}:\${esc(ticket.port)}</span>
            <span title="keyTime \${esc(ticket.keyTime)}">t\${esc(ticket.keyTime)} / \${esc(ticket.keyLength)}b</span>
            <button data-action="connectTicket" data-ticket-id="\${esc(ticket.id)}">Connect</button>
          </div>\`).join('') || '<div class="empty">No reconnect tickets captured yet</div>'}
      </div>
      <div class="table host-table" data-scroll-key="hosts">
        <div class="table-row header"><span>Realm</span><span>Players</span><span>Host</span><span>Game</span></div>
        \${hosts.slice(0, 80).map(row => \`<div class="table-row"><span>\${esc(row.name)}</span><span>\${esc(row.players)}/\${esc(row.maxPlayers)}</span><span>\${esc(row.hostname || '')}</span><span>\${esc(row.gameId || '')}</span></div>\`).join('') || '<div class="empty">RealmHostMapper not loaded</div>'}
      </div>
    </div>
  \`;
}

function renderObjects(client) {
  if (!client.visibleObjects.length) return '<div class="empty">No visible objects tracked</div>';
  const query = String(draft('objectFilter')).trim().toLowerCase();
  const objects = query ? client.visibleObjects.filter(o => [o.objectId, o.type, o.typeName, o.typeClass, o.name].some(value => String(value || '').toLowerCase().includes(query))) : client.visibleObjects;
  return \`
    <div class="object-tools"><input data-draft="objectFilter" value="\${esc(draft('objectFilter'))}" placeholder="Filter by id, name, type, or class"><span class="chip object-shown">\${objects.length} shown</span></div>
    <div class="table object-table" data-scroll-key="objects">
      <div class="table-row header"><span>ID</span><span>Type ID</span><span>Type Name</span><span>Class</span><span>Name</span><span>Position</span><span>Range</span></div>
      \${objects.map(o => \`<div class="table-row" data-object-search="\${esc([o.objectId, o.type, o.typeName, o.typeClass, o.name].join(' ').toLowerCase())}"><span>\${esc(o.objectId)}</span><span>\${esc(o.type)}</span><span title="\${esc(o.typeName || '')}">\${esc(o.typeName || o.type)}</span><span>\${esc(o.typeClass || '')}</span><span>\${esc(o.name || '')}</span><span>\${Number(o.x).toFixed(1)}, \${Number(o.y).toFixed(1)}</span><span>\${Number(o.distance || 0).toFixed(1)}</span></div>\`).join('') || '<div class="empty">No objects match this filter</div>'}
    </div>
  \`;
}

function renderLogs() {
  return state.logs.slice(-180).map(renderLogLine).join('');
}

function replaceLogs() {
  const box = document.getElementById('logBox');
  if (!box) {
    render();
    return;
  }
  if (isLogFrozen()) {
    pendingLogRefresh = true;
    updateLogCount();
    return;
  }
  const remaining = box.scrollHeight - box.scrollTop - box.clientHeight;
  const shouldFollow = terminalFollow || remaining < 48;
  box.innerHTML = renderLogs();
  updateLogCount();
  if (shouldFollow) {
    scrollTerminalToBottom();
  }
}

function renderLogLine(line) {
  const t = new Date(line.at);
  const time = isNaN(t.getTime()) ? '' : t.toLocaleTimeString();
  return \`<div class="log-line \${esc(line.level)}" data-log-id="\${esc(line.id)}"><span class="time">\${esc(time)}</span><span class="level">\${esc(line.level)}</span><span class="message" title="\${esc(line.message)}">\${esc(line.message)}</span></div>\`;
}

function appendLog(line) {
  const box = document.getElementById('logBox');
  if (!box) {
    render();
    return;
  }
  if (isLogFrozen()) {
    pendingLogRefresh = true;
    updateLogCount();
    return;
  }
  const nearBottom = terminalFollow || box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  box.insertAdjacentHTML('beforeend', renderLogLine(line));
  while (box.children.length > 180) {
    box.removeChild(box.firstElementChild);
  }
  updateLogCount();
  if (nearBottom) {
    scrollTerminalToBottom();
  }
}

async function submitConsoleCommand() {
  const input = document.querySelector('[data-console-input]');
  const command = input ? input.value.trim() : draft('consoleCommand').trim();
  if (!command) return;
  commandHistory.push(command);
  commandHistoryIndex = commandHistory.length;
  drafts.consoleCommand = '';
  if (input) input.value = '';
  terminalFollow = true;
  await action('consoleCommand', { command });
  scrollTerminalToBottom();
}

async function action(name, payload = {}) {
  if (selectedAlias && !payload.alias) payload.alias = selectedAlias;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let res;
  try {
    res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ action: name, ...payload }),
    });
  } catch (error) {
    throw new Error(error?.name === 'AbortError' ? 'action timed out after 12 seconds' : 'panel request failed: ' + (error?.message || error));
  } finally {
    clearTimeout(timeout);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('panel returned an invalid response (' + res.status + ')'); }
  showToast(body.message || (body.ok ? 'ok' : 'failed'), !body.ok);
  if (!body.ok) throw new Error(body.message);
  return body;
}

async function copyConsole() {
  const res = await fetch('/api/logs');
  const logs = await res.json();
  const text = logs.map(line => line.message).join('\\n');
  await copyText(text);
  showToast('console copied', false, true);
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function payloadForAction(a, button) {
  const payload = {};
  if (a === 'say') payload.message = field('say');
  if (a === 'sayAll') payload.message = field('say');
  if (a === 'sayAllPrompt') payload.message = prompt('Message for all clients') || '';
  if (a === 'swapSlots') { payload.from = field('swapFrom'); payload.to = field('swapTo'); }
  if (a === 'connectServer') payload.target = field('serverTarget');
  if (a === 'connectGameId') { payload.gameId = field('gameId'); payload.host = field('gameHost'); }
  if (a === 'connectTicket') payload.ticketId = button.dataset.ticketId || field('ticketId');
  if (a === 'moveTo' || a === 'shootAt') { payload.x = field('moveX'); payload.y = field('moveY'); }
  if (a === 'runStallTest') payload.ms = field('stallMs');
  if (a === 'loadPlugin' || a === 'unloadPlugin') payload.name = button.dataset.name || field('pluginName');
  if (a === 'usePortal') payload.objectId = button.dataset.id;
  if (a === 'setConfig') { payload.key = button.dataset.key; payload.value = document.querySelector('[data-config-input="' + CSS.escape(button.dataset.key) + '"]')?.value; }
  return payload;
}

function runActionButton(button) {
  if (button.disabled) return;
  pendingRender = false;
  const a = button.dataset.action;
  action(a, payloadForAction(a, button)).catch(err => showToast(err.message || 'action failed', true));
}

function showToast(message, bad = false, good = false) {
  clearTimeout(toastTimer);
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    document.body.appendChild(toast);
  }
  toast.className = 'toast' + (bad ? ' bad' : good ? ' good' : '');
  toast.textContent = message;
  toastTimer = setTimeout(() => toast.remove(), 3200);
}

function closeModal() {
  modal?.remove();
  modal = null;
}

function openModal(title, body, footer) {
  closeModal();
  modal = document.createElement('div');
  modal.className = 'modal-backdrop';
  modal.dataset.freezeRender = 'true';
  modal.innerHTML = \`
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>\${esc(title)}</h3><button type="button" data-close-modal>Close</button></div>
      <div class="modal-body">\${body}</div>
      <div class="modal-foot">\${footer}</div>
    </div>
  \`;
  document.body.appendChild(modal);
  modal.querySelector('input, textarea, select')?.focus();
}

function showAddClientModal() {
  const pluginHint = state.availablePlugins.slice(0, 3).map(p => p.name).join(', ');
  openModal(
    'Add Client',
    \`
      <label>Alias<input data-new-account="alias" placeholder="main-2"></label>
      <label>Email / guid<input data-new-account="guid" autocomplete="username"></label>
      <label>Password<input data-new-account="password" type="password" autocomplete="current-password"></label>
      <label>Plugins<input data-new-account="plugins" placeholder="\${esc(pluginHint || 'AntiSpam, InventoryTracker')}"></label>
      <label class="check-row"><input data-new-account="enterVault" type="checkbox"> Auto-enter vault</label>
      <div class="mini">The account is appended to accounts.json and started immediately.</div>
    \`,
    '<button type="button" data-close-modal>Cancel</button><button type="button" class="primary" data-submit-new-client>Add client</button>',
  );
}

async function submitNewClient() {
  const read = name => modal?.querySelector('[data-new-account="' + name + '"]');
  const account = {
    alias: read('alias')?.value.trim() || undefined,
    guid: read('guid')?.value.trim() || '',
    password: read('password')?.value || '',
    plugins: (read('plugins')?.value || '').split(',').map(name => name.trim()).filter(Boolean),
    enterVault: !!read('enterVault')?.checked,
  };
  await action('addClient', { account });
  selectedAlias = account.alias || account.guid;
  localStorage.setItem('selectedAlias', selectedAlias);
  closeModal();
}

async function showAccountsEditor() {
  const res = await fetch('/api/accounts');
  const body = await res.json();
  openModal(
    'Edit accounts.json',
    \`
      <div class="mini truncate">\${esc(body.path || 'accounts.json')}</div>
      <textarea data-accounts-json spellcheck="false">\${esc(body.text || '[]')}</textarea>
      <div class="mini">Saving validates the JSON and writes it to disk. Existing live clients keep running until restarted.</div>
    \`,
    '<button type="button" data-close-modal>Cancel</button><button type="button" class="primary" data-save-accounts>Save</button>',
  );
}

async function saveAccountsEditor() {
  const json = modal?.querySelector('[data-accounts-json]')?.value || '[]';
  await action('saveAccounts', { json });
  closeModal();
}

app.addEventListener('pointerdown', event => {
  if (event.target.closest('#logBox')) {
    logPointerDown = true;
    terminalFollow = false;
    return;
  }
  const panelButton = event.target.closest('[data-panel-action]');
  if (panelButton) {
    event.preventDefault();
    if (panelButton.dataset.panelAction === 'addClient') showAddClientModal();
    if (panelButton.dataset.panelAction === 'editAccounts') {
      showAccountsEditor().catch(err => showToast(err.message || 'could not open accounts.json', true));
    }
    return;
  }
  const select = event.target.closest('[data-select]');
  if (select) {
    event.preventDefault();
    selectedAlias = select.dataset.select;
    localStorage.setItem('selectedAlias', selectedAlias);
    render();
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  event.preventDefault();
  pointerHandled.add(button);
  runActionButton(button);
});

document.addEventListener('pointerdown', event => {
  if (!modal) return;
  if (event.target === modal || event.target.closest('[data-close-modal]')) {
    event.preventDefault();
    closeModal();
    return;
  }
  if (event.target.closest('[data-submit-new-client]')) {
    event.preventDefault();
    submitNewClient().catch(err => showToast(err.message || 'add client failed', true));
    return;
  }
  if (event.target.closest('[data-save-accounts]')) {
    event.preventDefault();
    saveAccountsEditor().catch(err => showToast(err.message || 'save failed', true));
  }
});

app.addEventListener('pointerup', () => {
  if (!logPointerDown) return;
  logPointerDown = false;
  setTimeout(flushDeferredLog, 250);
});

document.addEventListener('selectionchange', () => {
  if (!pendingLogRefresh && !pendingRender) return;
  setTimeout(flushDeferredLog, 250);
});

app.addEventListener('click', event => {
  const map = event.target.closest('[data-world-map]');
  if (map) {
    const matrix = map.getScreenCTM();
    if (!matrix) return;
    const point = map.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const world = point.matrixTransform(matrix.inverse());
    const x = Number(world.x.toFixed(2));
    const y = Number(world.y.toFixed(2));
    drafts.moveX = String(x);
    drafts.moveY = String(y);
    action('moveTo', { x, y }).catch(err => showToast(err.message || 'move failed', true));
    return;
  }
  const copy = event.target.closest('[data-copy-console]');
  if (copy) {
    copyConsole().catch(err => showToast(err.message || 'copy failed', true));
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (pointerHandled.has(button)) {
    pointerHandled.delete(button);
    return;
  }
  runActionButton(button);
});

app.addEventListener('submit', event => {
  const form = event.target.closest('[data-console-form]');
  if (!form) return;
  event.preventDefault();
  submitConsoleCommand().catch(err => showToast(err.message || 'command failed', true));
});

app.addEventListener('keydown', event => {
  const input = event.target.closest('[data-console-input]');
  if (!input) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    submitConsoleCommand().catch(err => showToast(err.message || 'command failed', true));
    return;
  }
  if (event.key === 'ArrowUp' && commandHistory.length) {
    event.preventDefault();
    commandHistoryIndex = Math.max(0, commandHistoryIndex - 1);
    input.value = commandHistory[commandHistoryIndex] || '';
    drafts.consoleCommand = input.value;
  }
  if (event.key === 'ArrowDown' && commandHistory.length) {
    event.preventDefault();
    commandHistoryIndex = Math.min(commandHistory.length, commandHistoryIndex + 1);
    input.value = commandHistory[commandHistoryIndex] || '';
    drafts.consoleCommand = input.value;
  }
});

app.addEventListener('dragstart', event => {
  const slot = event.target.closest('[data-slot-ref]');
  if (!slot || slot.getAttribute('draggable') !== 'true') {
    event.preventDefault();
    return;
  }
  dragSlot = parseSlotRefData(slot.dataset.slotRef);
  if (!dragSlot) {
    event.preventDefault();
    return;
  }
  slot.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/json', JSON.stringify(dragSlot));
  event.dataTransfer.setData('text/plain', JSON.stringify(dragSlot));
});

app.addEventListener('dragover', event => {
  const slot = event.target.closest('[data-slot-ref]');
  if (!slot || dragSlot === null) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  slot.classList.add('drop-target');
});

app.addEventListener('dragleave', event => {
  const slot = event.target.closest('[data-slot-ref]');
  if (slot) slot.classList.remove('drop-target');
});

app.addEventListener('drop', event => {
  const slot = event.target.closest('[data-slot-ref]');
  if (!slot || dragSlot === null) return;
  event.preventDefault();
  document.querySelectorAll('.slot.drop-target').forEach(el => el.classList.remove('drop-target'));
  const payload = event.dataTransfer.getData('application/json') || event.dataTransfer.getData('text/plain');
  const from = parseSlotRefData(payload) || dragSlot;
  const to = parseSlotRefData(slot.dataset.slotRef);
  dragSlot = null;
  if (!from || !to || sameSlotRef(from, to)) return;
  terminalFollow = true;
  action('swapSlotRefs', { from, to }).catch(err => showToast(err.message || 'swap failed', true));
});

app.addEventListener('dragend', () => {
  dragSlot = null;
  document.querySelectorAll('.slot.dragging, .slot.drop-target').forEach(el => el.classList.remove('dragging', 'drop-target'));
});

function parseSlotRefData(raw) {
  if (!raw) return null;
  try {
    const ref = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const objectId = Number(ref.objectId);
    const slotId = Number(ref.slotId);
    const itemType = Number(ref.itemType);
    if (!Number.isInteger(objectId) || !Number.isInteger(slotId) || !Number.isInteger(itemType)) return null;
    return { objectId, slotId, itemType };
  } catch {
    return null;
  }
}

function sameSlotRef(a, b) {
  return a.objectId === b.objectId && a.slotId === b.slotId;
}

app.addEventListener('scroll', event => {
  const box = event.target.closest?.('#logBox');
  if (!box) return;
  terminalFollow = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
}, true);

app.addEventListener('input', event => {
  const input = event.target.closest('[data-draft]');
  if (!input) return;
  drafts[input.dataset.draft] = input.value;
  if (input.dataset.draft === 'objectFilter') applyObjectFilter(input.value);
});

function applyObjectFilter(value) {
  const query = String(value || '').trim().toLowerCase();
  const rows = document.querySelectorAll('[data-object-search]');
  let shown = 0;
  rows.forEach(row => {
    const visible = !query || (row.dataset.objectSearch || '').includes(query);
    row.hidden = !visible;
    if (visible) shown++;
  });
  const count = document.querySelector('.object-shown');
  if (count) count.textContent = shown + ' shown';
}

app.addEventListener('change', event => {
  const input = event.target.closest('[data-draft]');
  if (!input) return;
  drafts[input.dataset.draft] = input.value;
});

app.addEventListener('focusout', () => {
  setTimeout(renderDeferred, 0);
});

function connectStream() {
  if (events) {
    events.close();
  }
  events = new EventSource('/api/events');
  events.addEventListener('open', () => {
    clearTimeout(streamRetryTimer);
    connected = true;
    render();
  });
  events.addEventListener('state', event => {
    const previousLogs = state.logs || [];
    state = JSON.parse(event.data);
    if (previousLogs.length) {
      state.logs = previousLogs;
    }
    render();
  });
  events.addEventListener('logs', event => {
    state.logs = JSON.parse(event.data);
    replaceLogs();
  });
  events.addEventListener('log', event => {
    const line = JSON.parse(event.data);
    state.logs = [...(state.logs || []), line].slice(-200);
    appendLog(line);
  });
  events.addEventListener('error', () => {
    connected = false;
    render();
    events.close();
    clearTimeout(streamRetryTimer);
    streamRetryTimer = setTimeout(connectStream, 1500);
  });
}

fetch('/api/state')
  .then(res => res.json())
  .then(data => {
    state = data;
    render();
    connectStream();
  })
  .catch(err => {
    app.innerHTML = '<div class="boot">Panel failed: ' + esc(err.message) + '</div>';
  });
`;
