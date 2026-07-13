import * as fs from 'fs';
import * as path from 'path';
import {
  Account,
  AppEngineError,
  deleteCharacter,
  getCharAndServers,
  login,
  resolveClassType,
  ServerInfo,
} from './account-service';
import { checkBuildDrift } from './build-info';
import { Client } from './client';
import { config, setConfig } from './config';
import { PluginManager } from './plugin-manager';
import { PetBagRoundTrip } from './plugins/pet-bag-round-trip';
import { PetToVault } from './plugins/pet-to-vault';
import { RealmHostMapper } from './plugins/realm-host-mapper';
import { startWebPanel, WebPanelHandle } from './web-panel';

/**
 * A tiny stdin console for altering the global config and issuing commands
 * while the program runs. Commands:
 *   show                      — print the current config
 *   set <key> <value>         — change a config field
 *   pos <alias>               — print the client's current map position
 *   say <alias> <message>     — send a chat message (PlayerText) from a client
 *   sayall <message>          — every client sends the chat message
 *   tick <alias>              — print the latest game-tick info
 *   debug <alias>             — print a full client state snapshot
 *   vault <alias>             — tell a client to enter the vault
 *   stall <alias> [ms]        — freeze the socket indefinitely, or for [ms]
 *   unstall <alias>           — resume a stalled socket, flushing queued outgoing
 *   invswap <a> <from> <to>   — swap two inventory slots (queued if stalled)
 *   escape <alias>            — send the client back to the nexus
 *   connect <alias> <server>  — connect a client to a server (name or host)
 *   realms <alias>            — list the realm portals a client can see
 *   hosts <alias>             — list RealmHostMapper's portal -> host table
 *   invtest <alias>           — run the PetBagRoundTrip inventory↔pet-bag test
 *   pettovault <alias>        — move an inventory item into the pet bag, then the vault
 */
function startConsole(clients: Map<string, Client>, servers: ServerInfo[], plugins: PluginManager): void {
  console.log(
    'console ready — show | set <k> <v> | pos <a> | say <a> <msg> | sayall <msg> | tick <a> | debug <a> | vault <a> | petyard <a> | escape <a> | create <a> [class] [seasonal] | delete <a> <charId> | convertseasonal <a> | stall <a> [ms] | unstall <a> | invswap <a> <from> <to> | connect <a> <server> | realms <a> | hosts <a> | invtest <a> | pettovault <a> | plugins <a> | plugin <a> load|unload <name>',
  );
  const withClient = (alias: string, fn: (client: Client) => void): void => {
    const client = clients.get(alias);
    if (client) {
      fn(client);
    } else {
      console.log(`no client: ${alias}`);
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const [cmd, ...args] = line.trim().split(/\s+/).filter(Boolean);
      if (!cmd) {
        continue;
      }
      switch (cmd) {
        case 'show':
          console.log(config);
          break;
        case 'set':
          console.log(setConfig(args[0], args[1]) ? `set ${args[0]} = ${args[1]}` : `invalid key/value: ${args[0]}`);
          break;
        case 'vault':
          withClient(args[0], (c) => c.enterVault());
          break;
        case 'petyard':
          withClient(args[0], (c) => c.enterPetYard());
          break;
        case 'guildhall':
          withClient(args[0], (c) => c.enterGuildHall());
          break;
        case 'dailyquest':
          withClient(args[0], (c) => c.enterDailyQuestRoom());
          break;
        case 'create':
          // create <alias> [class] [seasonal]
          withClient(args[0], (c) =>
            c.createCharacter({
              classType: args[1] ? resolveClassType(args[1]) : undefined,
              seasonal: args[2] === 'seasonal' || args[2] === 'true',
            }),
          );
          break;
        case 'delete': {
          // delete <alias> <charId>
          const charId = Number(args[1]);
          if (!args[0] || !Number.isInteger(charId)) {
            console.log('usage: delete <alias> <charId>  (permanent!)');
            break;
          }
          withClient(args[0], (c) => {
            c.deleteCharacter(charId)
              .then(() => console.log(`[${c.alias}] deleted character ${charId}`))
              .catch((err: Error) => console.log(`[${c.alias}] delete failed: ${err.message}`));
          });
          break;
        }
        case 'convertseasonal':
          withClient(args[0], (c) => c.sendSeasonalConversion());
          break;
        case 'escape':
          withClient(args[0], (c) => c.escape());
          break;
        case 'stall': {
          const ms = args[1] === undefined ? undefined : Number(args[1]);
          if (ms !== undefined && (!Number.isFinite(ms) || ms <= 0)) {
            console.log('usage: stall <alias> [positive-ms]');
            break;
          }
          withClient(args[0], (c) => c.stall(ms));
          break;
        }
        case 'unstall':
        case 'resume':
          withClient(args[0], (c) => c.unstall());
          break;
        case 'invswap': {
          const from = Number(args[1]);
          const to = Number(args[2]);
          if (!args[0] || !Number.isInteger(from) || !Number.isInteger(to)) {
            console.log('usage: invswap <alias> <fromSlot> <toSlot>  (slots: 0-3 equip, 4-11 inv, 12-19 backpack)');
            break;
          }
          withClient(args[0], (c) => {
            const ok = c.swapInventorySlots(from, to);
            const how = ok ? (c.isStalled() ? 'queued (stalled — flushes on resume)' : 'sent') : 'failed (not in-world)';
            console.log(`[${c.alias}] invswap slot ${from} → ${to}: ${how}`);
          });
          break;
        }
        case 'consume': {
          // consume <alias> <fromSlot> <consumableSlot: 1000000|1000001|1000003>
          const from = Number(args[1]);
          const dest = Number(args[2]);
          if (!args[0] || !Number.isInteger(from) || !Number.isInteger(dest)) {
            console.log('usage: consume <alias> <fromSlot> <consumableSlot>  (consumable slots: 1000000, 1000001, 1000003)');
            break;
          }
          withClient(args[0], (c) => {
            const ok = c.swapToConsumable(from, dest);
            console.log(`[${c.alias}] consume slot ${from} → ${dest}: ${ok ? 'sent' : 'failed (not in-world / invalid slot / empty)'}`);
          });
          break;
        }
        case 'pos':
          withClient(args[0], (c) => {
            const local = c.getPosition();
            const server = c.getServerPosition();
            console.log(
              `[${c.alias}] pos local (${local.x.toFixed(2)}, ${local.y.toFixed(2)}) ` +
                (server ? `server (${server.x.toFixed(2)}, ${server.y.toFixed(2)})` : 'server unknown'),
            );
          });
          break;
        case 'say': {
          const message = args.slice(1).join(' ');
          if (!args[0] || !message) {
            console.log('usage: say <alias> <message>');
            break;
          }
          withClient(args[0], (c) => {
            c.say(message);
            console.log(`[${c.alias}] say: ${message}`);
          });
          break;
        }
        case 'sayall': {
          const message = args.join(' ');
          if (!message) {
            console.log('usage: sayall <message>');
            break;
          }
          for (const c of clients.values()) {
            c.say(message);
          }
          console.log(`sayall → ${clients.size} client(s): ${message}`);
          break;
        }
        case 'tick':
          withClient(args[0], (c) => {
            const t = c.getTickInfo();
            console.log(
              `[${c.alias}] tick ${t.tickId} (count ${t.tickCount}), server interval ${t.tickTimeMs}ms, ` +
                (t.msSinceTick < 0 ? 'no tick yet' : `${t.msSinceTick}ms since last tick`),
            );
          });
          break;
        case 'debug':
          withClient(args[0], (c) => console.table(c.debugInfo()));
          break;
        case 'connect': {
          const target = args[1] ?? '';
          const server = servers.find((s) => s.name.toLowerCase() === target.toLowerCase());
          if (!server && !target) {
            console.log('usage: connect <alias> <server-name-or-host>');
            break;
          }
          withClient(args[0], (c) => c.connectToServer(server?.address ?? target));
          break;
        }
        case 'realms':
          withClient(args[0], (c) => console.table(c.realmPortals()));
          break;
        case 'hosts':
          withClient(args[0], (c) => {
            const mapper = plugins.get<RealmHostMapper>(c, 'RealmHostMapper');
            if (!mapper) {
              console.log(`[${c.alias}] RealmHostMapper is not loaded`);
              return;
            }
            console.table(mapper.portals());
          });
          break;
        case 'invtest':
          withClient(args[0], (c) => {
            const trip = plugins.get<PetBagRoundTrip>(c, 'PetBagRoundTrip');
            if (!trip) {
              console.log(`[${c.alias}] PetBagRoundTrip is not loaded`);
              return;
            }
            void trip.run(c);
          });
          break;
        case 'pettovault':
          withClient(args[0], (c) => {
            const flow = plugins.get<PetToVault>(c, 'PetToVault');
            if (!flow) {
              console.log(`[${c.alias}] PetToVault is not loaded`);
              return;
            }
            void flow.run(c);
          });
          break;
        case 'plugins':
          withClient(args[0], (c) => {
            console.log(`[${c.alias}] loaded: [${plugins.loaded(c).join(', ') || 'none'}]`);
            console.table(plugins.available());
          });
          break;
        case 'plugin': {
          // plugin <alias> load|unload <name>
          const [alias, action, name] = args;
          withClient(alias, (c) => {
            if (action === 'load') {
              plugins.load(c, name);
            } else if (action === 'unload') {
              plugins.unload(c, name);
            } else {
              console.log('usage: plugin <alias> load|unload <name>');
            }
          });
          break;
        }
        default:
          console.log(`unknown command: ${cmd}`);
      }
    }
  });
}

function pickServer(
  servers: { name: string; address: string }[],
  index: number,
): { name: string; address: string } | undefined {
  // Spread accounts across distinct servers to avoid per-server limits.
  return servers.length > 0 ? servers[index % servers.length] : undefined;
}

async function main(): Promise<void> {
  const file = path.resolve(process.cwd(), 'accounts.json');
  if (!fs.existsSync(file)) {
    console.error('accounts.json not found — copy accounts.example.json and fill in credentials.');
    process.exit(1);
  }
  let accounts: Account[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Warn once at startup if the live game build changed since last run — a
  // heads-up that BUILD_VERSION (constants.ts) may need bumping before Hello
  // fails with a version error. Advisory only; never blocks startup.
  await checkBuildDrift();
  // LOGIN_ONLY exercises the auth + char/list layer without connecting to a
  // game server (no socket, no account lock) — useful for testing error handling.
  const loginOnly = process.env.LOGIN_ONLY === '1';
  const clients = new Map<string, Client>();
  const plugins = new PluginManager();
  let serverList: ServerInfo[] = [];
  let liveSeasonalAssigned = false;
  let webPanel: WebPanelHandle | undefined;

  const writeAccounts = (nextAccounts: Account[]): void => {
    fs.writeFileSync(file, `${JSON.stringify(nextAccounts, null, 2)}\n`);
    accounts = nextAccounts;
  };

  const startAccountClient = async (acc: Account, index: number): Promise<string> => {
    const alias = acc.alias ?? acc.guid;
    if (clients.has(alias)) {
      throw new Error(`client already exists: ${alias}`);
    }
    console.log(`[${alias}] logging in...`);
    const { accessToken, clientToken } = await login(acc);
    const { char: defaultChar, characters, servers } = await getCharAndServers(accessToken);
    let char = defaultChar;
    if (process.env.LIVE_CONTAINER_SWAP_TEST === '1' && characters.length > 0) {
      const preferred = !liveSeasonalAssigned
        ? characters.find((candidate) => candidate.seasonal)
        : characters.find((candidate) => !candidate.seasonal);
      char = preferred ?? characters.find((candidate) => !candidate.seasonal) ?? defaultChar;
      liveSeasonalAssigned ||= char.seasonal === true;
      console.log(
        `[${alias}] live-test character selection: ${characters.length} available; ` +
          `using char ${char.charId} (${char.seasonal ? 'seasonal' : 'non-seasonal'})`,
      );
    }
    serverList = servers;
    const server = pickServer(servers, index);
    if (!server) {
      throw new Error('no servers returned');
    }
    console.log(
      `[${alias}] ready — char ${char.charId} (${char.needsNewChar ? 'new' : 'existing'}), ` +
        `${servers.length} servers, using ${server.name} (${server.address})`,
    );
    if (loginOnly) {
      return alias;
    }
    const client = new Client({
      alias,
      accessToken,
      clientToken,
      charId: char.charId,
      needsNewChar: char.needsNewChar,
      host: server.address,
      servers,
      autoEnterVault: acc.enterVault,
      createClassType: resolveClassType(acc.createChar?.class),
      createSkin: acc.createChar?.skin,
      createSeasonal: acc.createChar?.seasonal,
      createChallenger: acc.createChar?.challenger,
      // Re-authenticate (cache-backed) before each (re)connect so the client
      // never sends an expired access token during a 24/7 run.
      refreshCredentials: () => login(acc),
    });
    clients.set(alias, client);
    for (const name of acc.plugins ?? []) {
      if (process.env.LIVE_CONTAINER_SWAP_TEST === '1' && name === 'PacketLogger') {
        continue; // keep guarded live-test output focused; core still logs INVRESULT
      }
      plugins.load(client, name);
    }
    if (process.env.LIVE_CONTAINER_SWAP_TEST === '1') {
      plugins.load(client, 'LiveContainerSwapTest');
    }
    client.connect();
    return alias;
  };

  const shutdown = (reason: string, exitCode = 0): void => {
    console.log(`shutting down (${reason})`);
    webPanel?.close();
    for (const client of clients.values()) {
      plugins.unloadAll(client);
      client.stop(reason);
    }
    process.exit(exitCode);
  };

  if (!loginOnly) {
    webPanel = startWebPanel({
      clients,
      getServers: () => serverList,
      plugins,
      accountsFile: file,
      readAccountsText: () => fs.readFileSync(file, 'utf8'),
      saveAccounts: writeAccounts,
      addClient: async (account) => {
        const alias = account.alias ?? account.guid;
        if (clients.has(alias) || accounts.some((acc) => (acc.alias ?? acc.guid) === alias)) {
          throw new Error(`account alias already exists: ${alias}`);
        }
        const nextAccounts = [...accounts, account];
        writeAccounts(nextAccounts);
        return startAccountClient(account, nextAccounts.length - 1);
      },
    });
  }

  for (const [index, acc] of accounts.entries()) {
    const alias = acc.alias ?? acc.guid;
    try {
      await startAccountClient(acc, index);
    } catch (err) {
      if (err instanceof AppEngineError) {
        const retry = err.retryAfterSeconds ? ` retry in ${err.retryAfterSeconds}s` : '';
        console.error(`[${alias}] ✗ ${err.kind}: ${err.message}${retry}  [server: ${err.detail}]`);
      } else {
        console.error(`[${alias}] ✗ error: ${(err as Error).message}`);
      }
    }
  }

  if (loginOnly) {
    process.exit(0);
  }

  
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  // Interactive console for runtime config changes / commands. Active on a TTY,
  // or force it for piped/automated input with CONSOLE=1.
  if (process.stdin.isTTY || process.env.CONSOLE === '1') {
    startConsole(clients, serverList, plugins);
  }

  // Optional auto-exit so the spike terminates on its own when testing.
  const runSeconds = Number(process.env.RUN_SECONDS ?? '0');
  if (runSeconds > 0) {
    setTimeout(() => {
      shutdown(`RUN_SECONDS=${runSeconds}`);
    }, runSeconds * 1000);
  }
}

// A 24/7 process must not die because one stray promise rejected or one plugin
// threw off the event loop. Log loudly and keep the other clients running.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason instanceof Error ? reason.stack ?? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err instanceof Error ? err.stack ?? err.message : err);
});

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
