/**
 * Standalone test: load ONE account onto TWO different game servers at once.
 *
 *   1. Client A connects to the Nexus on server A, walks to the Pet Yard portal
 *      and sends UsePortal to enter it.
 *   2. Only once A has entered the Pet Yard, Client B connects to the Nexus on a
 *      *different* server using the same account/token.
 *
 * The point is to observe what the server does with two simultaneous sessions of
 * the same account on different game servers (does it allow it, kick the first
 * session, or refuse the second with an account-in-use failure?). It only
 * connects and navigates — it does not touch items or storage.
 *
 * This script changes no client code; it drives the public Client API.
 *
 * Run:  npx ts-node scripts/dual-server-login.ts
 *
 * Env:
 *   ACCOUNT=<alias|guid>   which account from accounts.json (default: first)
 *   SERVER_A=<name>        server for client A (default: first in the list)
 *   SERVER_B=<name>        server for client B (default: first that differs)
 *   FORCE_B=1              connect B even if A never enters the Pet Yard
 *   HOLD_SECONDS=60        how long to keep both clients alive at the end
 */
import * as fs from 'fs';
import * as path from 'path';
import { FailurePacket, PortalType } from 'realmlib';
import { Account, AppEngineError, getCharAndServers, login, ServerInfo } from '../src/account-service';
import { Client } from '../src/client';
import { ClientEvent } from '../src/events';
import { TrackedObject } from '../src/models';

const PORTAL_FIND_TIMEOUT_MS = 20000;
const ARRIVE_TIMEOUT_MS = 30000;
const USE_PORTAL_ATTEMPTS = 8;
const USE_PORTAL_INTERVAL_MS = 1200;
const ENTER_CONFIRM_TIMEOUT_MS = 8000;
const HOLD_SECONDS = Number(process.env.HOLD_SECONDS ?? '120');
const activeClients = new Set<Client>();

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function track(client: Client): Client {
  activeClients.add(client);
  return client;
}

function stopAll(reason: string): void {
  for (const client of activeClients) {
    client.stop(reason);
  }
  activeClients.clear();
}

/** Reads accounts.json and picks the requested account (by alias or guid), or the first. */
function loadAccount(): Account {
  const file = path.resolve(process.cwd(), 'accounts.json');
  if (!fs.existsSync(file)) {
    throw new Error('accounts.json not found — copy accounts.example.json and fill in credentials.');
  }
  const accounts: Account[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wanted = process.env.ACCOUNT;
  const acc = wanted
    ? accounts.find((a) => a.alias === wanted || a.guid === wanted)
    : accounts[0];
  if (!acc) {
    throw new Error(wanted ? `no account matching "${wanted}" in accounts.json` : 'accounts.json is empty');
  }
  return acc;
}

/** Picks the two distinct servers for A and B from the account's server list. */
function pickServers(servers: ServerInfo[]): { a: ServerInfo; b: ServerInfo } {
  if (servers.length < 2) {
    throw new Error(`need at least 2 servers, got ${servers.length}`);
  }
  const byName = (name?: string): ServerInfo | undefined =>
    name ? servers.find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined;
  const a = byName(process.env.SERVER_A) ?? servers[0];
  const b = byName(process.env.SERVER_B) ?? servers.find((s) => s.address !== a.address);
  if (!b || b.address === a.address) {
    throw new Error('could not pick two distinct servers (check SERVER_A / SERVER_B)');
  }
  return { a, b };
}

/**
 * Resolves on the next emission of `event` that satisfies `predicate`, or
 * rejects on timeout / abort. An optional `signal` lets a caller cancel the
 * wait (e.g. the losers of a Promise.race) so its listener and timer are torn
 * down instead of lingering.
 */
function waitForEvent<T = unknown>(
  client: Client,
  event: ClientEvent,
  timeoutMs: number,
  predicate: (arg: T) => boolean = () => true,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      client.off(event, handler as (...a: unknown[]) => void);
      signal?.removeEventListener('abort', onAbort);
    };
    const handler = (arg: T): void => {
      if (!predicate(arg)) {
        return;
      }
      cleanup();
      resolve(arg);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new Error(`aborted waiting for ${event}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${event}`));
    }, timeoutMs);
    if (signal?.aborted) {
      cleanup();
      reject(new Error(`aborted waiting for ${event}`));
      return;
    }
    signal?.addEventListener('abort', onAbort);
    client.on(event, handler as (...a: unknown[]) => void);
  });
}

/** Polls `fn` until it returns a value or the timeout elapses. */
async function poll<T>(fn: () => T | undefined, intervalMs: number, timeoutMs: number): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() - start > timeoutMs) {
      return undefined;
    }
    await wait(intervalMs);
  }
}

/** Logs the lifecycle events that matter for this test on a client. */
function attachLogging(client: Client, tag: string): void {
  client.on(ClientEvent.Connected, () => console.log(`[${tag}] connected`));
  client.on(ClientEvent.Ready, (objectId: number) => console.log(`[${tag}] in-world (objectId ${objectId})`));
  client.on(ClientEvent.MapChange, (name: string) => console.log(`[${tag}] map → "${name}"`));
  client.on(ClientEvent.Failure, (p: FailurePacket) =>
    console.log(`[${tag}] FAILURE ${p.errorId}: ${p.errorDescription || '(no description)'}`),
  );
  client.on(ClientEvent.Disconnect, () => console.log(`[${tag}] disconnected`));
}

/** Walks client A to the Pet Yard portal and uses it. Returns true once the map changes away from Nexus. */
async function enterPetYard(client: Client, tag: string): Promise<boolean> {
  await waitForEvent<number>(client, ClientEvent.Ready, ARRIVE_TIMEOUT_MS).catch(() => undefined);

  const portal = await poll<TrackedObject>(
    () => client.visibleObjects().find((o) => o.type === PortalType.PetYard),
    500,
    PORTAL_FIND_TIMEOUT_MS,
  );
  if (!portal) {
    console.warn(`[${tag}] Pet Yard portal not found in view`);
    return false;
  }
  console.log(`[${tag}] found Pet Yard portal (id ${portal.objectId}) at (${portal.x.toFixed(1)}, ${portal.y.toFixed(1)}) → walking`);

  client.moveTo({ x: portal.x, y: portal.y }, 0.5);
  await waitForEvent(client, ClientEvent.ReachedTarget, ARRIVE_TIMEOUT_MS).catch(() =>
    console.warn(`[${tag}] did not confirm arrival; sending UsePortal anyway`),
  );

  // Send UsePortal and watch for the resulting map change off the Nexus.
  let entered = false;
  const onMap = (name: string): void => {
    if (name && name !== 'Nexus') {
      entered = true;
    }
  };
  client.on(ClientEvent.MapChange, onMap);
  for (let attempt = 1; attempt <= USE_PORTAL_ATTEMPTS && !entered; attempt++) {
    console.log(`[${tag}] UsePortal(${portal.objectId}) for Pet Yard (attempt ${attempt})`);
    client.usePortal(portal.objectId);
    await wait(USE_PORTAL_INTERVAL_MS);
  }
  // Give the reconnect → MapInfo a moment to land after the last attempt.
  if (!entered) {
    await wait(ENTER_CONFIRM_TIMEOUT_MS).then(() => undefined);
  }
  client.off(ClientEvent.MapChange, onMap);
  return entered;
}

async function main(): Promise<void> {
  const account = loadAccount();
  const baseAlias = account.alias ?? account.guid;
  console.log(`logging in as ${baseAlias}…`);
  const { accessToken, clientToken } = await login(account);
  const { char, servers } = await getCharAndServers(accessToken);
  const { a: serverA, b: serverB } = pickServers(servers);
  console.log(
    `account ${baseAlias}, char ${char.charId} — A→${serverA.name} (${serverA.address}), B→${serverB.name} (${serverB.address})`,
  );

  const common = {
    accessToken,
    clientToken,
    charId: char.charId,
    needsNewChar: char.needsNewChar,
    servers,
  };

  // ---- Client A: connect, walk to Pet Yard, enter ----
  const clientA = track(new Client({ ...common, alias: `${baseAlias}~A`, host: serverA.address }));
  attachLogging(clientA, 'A');
  console.log(`[A] connecting to ${serverA.name}…`);
  clientA.connect();

  const enteredPetYard = await enterPetYard(clientA, 'A');
  if (enteredPetYard) {
    console.log(`[A] ✓ entered the Pet Yard`);
  } else {
    console.warn(`[A] ✗ did not confirm Pet Yard entry`);
    if (process.env.FORCE_B !== '1') {
      console.warn('aborting before connecting B (set FORCE_B=1 to connect B anyway)');
      clientA.escape();
      stopAll('pet yard entry failed');
      process.exitCode = 1;
      return;
    }
  }

  // ---- Client B: only now connect the same account to the OTHER server ----
  console.log(`[B] connecting the same account to ${serverB.name}…`);
  const clientB = track(new Client({ ...common, alias: `${baseAlias}~B`, host: serverB.address }));
  attachLogging(clientB, 'B');
  clientB.connect();

  // Report B's immediate outcome (in-world vs. failure) and whether A survives.
  // Whichever settles first wins; abort tears down the other two waiters.
  const race = new AbortController();
  let outcome: string;
  try {
    outcome = await Promise.race([
      waitForEvent<number>(clientB, ClientEvent.Ready, 15000, () => true, race.signal).then(() => 'B reached in-world'),
      waitForEvent<FailurePacket>(clientB, ClientEvent.Failure, 15000, () => true, race.signal).then(
        (p) => `B failed: ${p.errorId} ${p.errorDescription}`,
      ),
      waitForEvent(clientA, ClientEvent.Disconnect, 15000, () => true, race.signal).then(
        () => 'A was disconnected (B kicked A)',
      ),
    ]);
  } catch {
    outcome = 'no decisive outcome within 15s';
  } finally {
    race.abort();
  }
  console.log(`=== result: ${outcome} ===`);

  console.log(`holding both clients for ${HOLD_SECONDS}s — watch the logs above…`);
  await wait(HOLD_SECONDS * 1000);
  console.log(clientA.debugInfo());
  console.log(clientB.debugInfo());
  console.log('done.');
  stopAll('dual-server-login complete');
}

main().catch((err) => {
  if (err instanceof AppEngineError) {
    console.error(`AppEngine error (${err.kind}): ${err.message}`);
  } else {
    console.error('fatal:', err instanceof Error ? err.message : err);
  }
  stopAll('dual-server-login failed');
  process.exitCode = 1;
});
