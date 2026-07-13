# headless-client

A **headless (clientless) Realm of the Mad God client** built on top of
[realmlib](../realmlib) for the wire protocol. It logs in through the official
AppEngine, completes the `Hello` handshake, and runs the keep-alive loop so an
account connects and stays in-world — **no game client required**.

On top of that base it adds a decorator-based **plugin system**, vault and realm
navigation, and a small runtime console for driving connected clients. It's
intended for protocol exploration, automation, and bot-framework groundwork.

## How it works

1. **Login** (`src/account-service.ts`) — `POST /account/verify` with a Unity
   user-agent to get an access token, then `POST /char/list` for the character
   and server list. Tokens are cached in `.token-cache.json` (gitignored) and
   reused until they expire, so `/account/verify` is only hit when needed.
2. **Connect** (`src/client.ts`) — open a TCP socket to the chosen server
   (port 2050) and hand it to realmlib's `PacketIO`, which handles the
   `[length][id][RC4 body]` framing and encryption.
3. **Handshake** — send `Hello` (build version + access token + client tokens).
4. **Keep-alive** — reply to `NewTick` with `Move`, `Ping` with `Pong`,
   `Update` with `UpdateAck`, and enemy/ally shoots with `ShootAck`. Balanced
   ack/move counts are what keep the connection from being dropped.

The numeric packet-id map and packet structures live in realmlib
(`DEFAULT_PACKET_MAP`); the client never redefines protocol details. realmlib is
reconciled to the current build (6.11) and round-trip tested.

## Setup

```bash
npm install
cp accounts.example.json accounts.json   # then fill in real credentials
npm start
```

`accounts.json` and `.token-cache.json` are **gitignored** — secrets never get
committed to the repo.

### `accounts.json` format

An array of account objects:

```json
[
  {
    "guid": "you@example.com",
    "password": "hunter2",
    "alias": "main",
    // connect to Vault automatically
    "enterVault": false,
    // list of plugins to load for this account
    "plugins": ["ChatLogger", "RealmFinder", "PacketLogger"],
    "createChar": { "class": "Wizard", "seasonal": true }
  }
]
```

| field | required | meaning |
|-------|----------|---------|
| `guid` | yes | account email |
| `password` | yes | account password |
| `alias` | no | short name used in logs and console commands (defaults to `guid`) |
| `enterVault` | no | enter the vault automatically after entering the nexus |
| `plugins` | no | plugin names to load for this account on connect |
| `createChar` | no | defaults used when creating a character: `class` name/id, `skin`, `seasonal`, and `challenger` |

Multiple accounts are spread across distinct servers automatically to avoid
per-server limits. **Note:** running several accounts from one IP trips RotMG's
abuse detection — multi-account needs per-account proxies (not yet implemented).

## Running

```bash
npm start            # connect every account in accounts.json
npm run build        # type-check / compile to JS
npm run panel:preview # synthetic web-panel demo; never logs into the game
npm run test:live-character # create, verify, delete, and re-verify one disposable character
```

### Web control panel

The panel is available at `http://127.0.0.1:8787` while the client is running.
It includes a live world radar with click-to-move, authoritative/local position
drift, nearby portals and objects, connection and socket diagnostics, searchable
object telemetry, inventory/vault inspection, plugins, commands, and streamed
logs. Use `npm run panel:preview` to explore it safely with synthetic data.

### Environment variables

| var | effect |
|-----|--------|
| `RUN_SECONDS=30` | auto-exit after N seconds (handy for short test runs) |
| `LOGIN_ONLY=1` | exercise auth + `/char/list` only — no socket, no account lock |
| `CONSOLE=1` | force the interactive console even when stdin isn't a TTY |
| `WEB_HOST=127.0.0.1` | host/interface for the local web control panel |
| `WEB_PORT=8787` | port for the local web control panel; falls forward if busy |
| `ROTMG_XML_DIR=/path/to/TextAsset` | optional extracted XML directory for item/object names in the web panel |
| `DEBUG_PACKETS=types` | log every incoming packet type |
| `DEBUG_PACKETS=hex` | log each type and hexdump its payload |
| `DEBUG_PACKETS=unknown` | log + hexdump only unmapped packet ids |

Unmapped packet ids are always reported once even without `DEBUG_PACKETS`.

### Interactive console

When attached to a TTY (or with `CONSOLE=1`), a stdin console is available:

| command | action |
|---------|--------|
| `show` | print the current runtime config |
| `set <key> <value>` | change a config field (e.g. `set rateLimitReconnectMs 60000`) |
| `vault <alias>` | tell a client to walk into the vault |
| `petyard <alias>` / `guildhall <alias>` / `dailyquest <alias>` | walk into the pet yard / guild hall / daily-quest room |
| `create <alias> [class] [seasonal]` | send `CREATE` with an optional class name/id and seasonal flag |
| `delete <alias> <charId>` | permanently delete the exact character ID through `/char/delete` |
| `convertseasonal <alias>` | send `CONVERT_SEASONAL_CHARACTER` |
| `consume <alias> <fromSlot> <consumableSlot>` | swap an item into a consumable slot (pet feed / gift / etc.) |
| `escape <alias>` | send the client back to the nexus |
| `pos <alias>` | print the client's local (dead-reckoned) and server-authoritative position |
| `say <alias> <msg>` / `sayall <msg>` | send a chat message (`PLAYERTEXT`) from one client / every client |
| `tick <alias>` | print the latest game-tick info |
| `debug <alias>` | print a full client-state snapshot |
| `stall <alias> [ms]` / `unstall <alias>` | freeze indefinitely or auto-resume after `ms`; manually resume with `unstall` |
| `invswap <alias> <from> <to>` | send `INVSWAP` between two inventory slots |
| `connect <alias> <server>` | connect a client to a server (name or host) |
| `realms <alias>` | list the realm portals a client can see |
| `hosts <alias>` | list RealmHostMapper portal details, including resolved hostnames |
| `invtest <alias>` | run `PetBagRoundTrip` against the real PET_INSTANCEID-backed pet bag |
| `pettovault <alias>` | run `PetToVault` (inventory → pet bag → vault) |
| `plugins <alias>` | list loaded + available plugins |
| `plugin <alias> load\|unload <name>` | load/unload a plugin at runtime |

## Plugins

Behaviour is added via decorator-based plugins that hook packets and game
events — no edits to `client.ts`. Set `"plugins": ["ChatLogger"]` on an account,
or load at runtime with `plugin <alias> load <name>`. See
[docs/PLUGINS.md](docs/PLUGINS.md) for the authoring guide.
See [docs/PLUGIN_API.md](docs/PLUGIN_API.md) for the complete client/runtime API.

Bundled examples:

| plugin | demonstrates |
|--------|--------------|
| `ChatLogger` | a single `@PacketHook` (TEXT) |
| `PacketLogger` | several `@PacketHook`s + an `@EventHook` (Death) |
| `AutoVault` | `@EventHook`s driving a command (`enterVault`) |
| `RealmFinder` | reading `realmPortals()`; pure, unit-testable selection logic |
| `RealmHostMapper` | walking each realm portal, capturing its Reconnect host, and returning to Nexus |
| `InventoryTracker` | logging parsed `INVRESULT` responses (success, ack type, flags, slots) |
| `PetBagRoundTrip` | timing reversible `INVSWAP` transfers between inventory and the real pet bag |
| `PetToVault` | moving an item across three containers: inventory → pet bag → vault |
| `VaultStorage` | looping deposit/withdraw of the whole inventory through the vault |
| `SeasonalVaultWithdraw` | seasonal-stat gating, chunked vault parsing, container `INVSWAP`, and a one-shot escape |

Socket stalling is a core client capability: plugins can call `client.stall(ms?)`
and `client.unstall()` without loading a helper plugin.

## Status

Working clientless client + plugin system, reconciled to build 6.11.
Next up: SOCKS proxy support for multi-account, fuller game-state/entity
tracking, and a client-side test suite.

## Credits

This project would not exist without these reference implementations:

- **[pyrelay](https://github.com/Maxi35/pyrelay)** — a current, working Python
  headless client. The authoritative source for the login flow, `Hello` field
  order, packet ids, and packet structures; realmlib's protocol layer was
  reconciled against it.
- **[nrelay](https://github.com/thomas-crane/nrelay)** — a TypeScript clientless
  framework. Architectural reference for the runtime, the plugin/hook system,
  account handling, and proxy support.
- **[RealmShark](https://github.com/X-com/RealmShark)** — a Java pcap sniffer,
  used to cross-check current packet structures and data types.
- **[realmlib](https://github.com/rotmg-network/realmlib)** — the wire-protocol library this client is built
  on (originally derived from the realmlib/nrelay lineage, hardened and
  reconciled here).

Realm of the Mad God is a trademark of its respective owners. This project is an
independent, educational protocol implementation and is not affiliated with or
endorsed by them.
