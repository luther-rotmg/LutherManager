# Writing plugins

Plugins add behaviour to a client by hooking **packets** and **game events**.
A plugin is a class instantiated **once per client**, so each client gets its
own plugin instances and state. Hooks are declared with decorators — no
boilerplate, no edits to `client.ts`.

## Quick start

```ts
// src/plugins/hello.ts
import { TextPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { PluginRuntime } from '../plugin-runtime';
import { Plugin, PacketHook, EventHook } from './decorators';

@Plugin({ name: 'Hello', description: 'Greets on entry and echoes chat.' })
export class Hello {
  @EventHook(ClientEvent.Ready)
  onReady(client: Client): void {
    console.log(`${client.alias} is in-world`);
  }

  @PacketHook()
  onText(client: Client, text: TextPacket): void {
    console.log(`<${text.name}> ${text.text}`);
  }

  onUnload(_client: Client, runtime: PluginRuntime): void {
    runtime.clearAllTimers();
  }
}
```

Then:

1. Register it — add `import './hello';` to `src/plugins/index.ts`.
2. Load it — list it on an account in `accounts.json`
   (`"plugins": ["Hello"]`), or at runtime with `plugin <alias> load Hello`.

## Decorators

### `@Plugin({ ... })`
Class decorator. Registers the plugin under `name` and attaches its metadata.

| field | required | meaning |
|-------|----------|---------|
| `name` | yes | unique id used to load the plugin |
| `description` | yes | shown in the console `plugins` table |
| `author` | no | |
| `version` | no | |
| `enabled` | no | metadata flag (defaults to true) |

### `@PacketHook()`
Method decorator for an incoming packet. The packet type is **inferred from the
method's second parameter type** — no need to name it. The method signature is
usually `(client: Client, packet: SomePacket)`. A hook can also accept a third
`PacketContext` argument and call `ctx.cancel()` to stop lower-priority hooks
for that packet:

```ts
@PacketHook()
onUpdate(client: Client, update: UpdatePacket): void { ... }   // hooks UPDATE

@PacketHook({ priority: 100 })
onText(client: Client, text: TextPacket, ctx: PacketContext): void {
  if (isSpam(text.text)) {
    ctx.cancel('spam');
  }
}
```

Subscribing is what makes realmlib start parsing that packet type for the
client, and the hook survives reconnects automatically. Higher priority hooks
run first; hooks with the same priority run in load order. Cancelling a packet
only stops later plugin hooks for that packet type; it does not undo network
receipt or skip the client's required protocol acknowledgements.

### `@EventHook(ClientEvent.X)`
Method decorator for a higher-level game event. The method receives the client
followed by the event payload:

```ts
@EventHook(ClientEvent.VaultContents)
onVault(client: Client, vault: VaultContentPacket): void { ... }
```

The plugin runtime is passed as the final argument to decorated hooks, so hooks
can opt into managed timers without changing their event payload order:

```ts
@EventHook(ClientEvent.ReachedTarget)
onReachedTarget(client: Client, target: { x: number; y: number }, runtime: PluginRuntime): void {
  runtime.setTimeout(() => client.usePortal(123), 0);
}
```

## Lifecycle and runtime

Plugins may implement optional lifecycle methods:

```ts
import { PluginRuntime } from '../plugin-runtime';

onLoad(client: Client, runtime: PluginRuntime): void { ... }
onUnload(client: Client, runtime: PluginRuntime): void { ... }
onError(client: Client, runtime: PluginRuntime, error: unknown, context: string): void { ... }
```

Use `PluginRuntime` for timers and sleeps:

- `runtime.setTimeout(fn, ms)`
- `runtime.setInterval(fn, ms)`
- `runtime.clearTimer(handle)`
- `runtime.clearAllTimers()`
- `await runtime.sleep(ms)`
- `await runtime.waitUntil(predicate, timeoutMs?, pollMs?)`
- `runtime.isDisposed`

The plugin manager clears runtime-owned timers on unload and wraps both sync and
async hook failures. One plugin throwing no longer prevents later hooks from
running. Prefer runtime timers over raw `setTimeout` / `setInterval` for any
work that should stop when the plugin unloads.

## Game events (`ClientEvent`)

| event | payload |
|-------|---------|
| `Connected` | — |
| `Ready` | `objectId: number` (in-world) |
| `MapChange` | `name: string` |
| `EnterVault` / `EnterNexus` / `EnterPetYard` | — |
| `VaultContents` | `VaultContentPacket` |
| `InventoryResult` | `InvResultPacket` (local slots already reconciled) |
| `RealmPortal` | `RealmPortal` |
| `Tick` | `PlayerData \| undefined` |
| `Death` | `DeathPacket` |
| `Failure` | `FailurePacket` |
| `Disconnect` | — |
| `ReachedTarget` | `{ x, y }` |

## What a plugin can do with the client

The full method-by-method reference and recipes live in
[PLUGIN_API.md](PLUGIN_API.md). The most common high-level workflow now uses
protocol-native slot objects:

```ts
import { ClassType } from '../client';

client.createCharacter(ClassType.Wizard, true);
client.sendSeasonalConversion();

const inventory = client.getInventorySlot(4);
const pet = client.getPetBagSlot();
if (inventory && pet) client.swapInventoryWithPetBag(inventory, pet);

const vault = client.getVaultSlot();
const potion = client.getPotionVaultSlot();
if (vault && potion) await client.swapVaultWithPotionVault(vault, potion);
```

Commands:

- `client.send(packet)` — send any packet
- `client.moveTo({ x, y })` — walk to a position (emits `ReachedTarget`)
- `client.enterVault()` / `client.escape()` — vault / nexus
- `client.createCharacter({ classType, seasonal, ... })` — create a configured character
- `await client.deleteCharacter(charId)` — permanently delete an exact character via `/char/delete`
- `client.connectToServer(host)` — switch servers
- `client.connectToGameId(gameId, host?)` — reconnect to a specific Hello game id
- `client.usePortal(objectId)` — use a tracked portal object
- `client.swapInventorySlots(fromSlotId, toSlotId)` — send `INVSWAP` for player slots
- `client.swapContainerItems(from, to)` — generic inventory/pet-bag/vault/potion-vault `INVSWAP`
- `client.swapInventoryWithPetBag(...)`, `swapInventoryWithVault(...)`,
  `swapInventoryWithPotionVault(...)` — player/container convenience swaps
- Slot-object `swapPetBagWithVault(...)`, `swapPetBagWithPotionVault(...)`, and
  `swapVaultWithPotionVault(...)` route through inventory and await `INVRESULT`
- `client.shootAt({ x, y })` — aim and send `PLAYERSHOOT` at a world position

Queries:

- `client.alias`
- `client.getPlayer()` — parsed `PlayerData`
- `client.getPetInstanceId()` / `client.getPetBagContainerId()` — active pet identifiers
- `client.getContainerObjectId(kind)` — live object id for a logical item container
- `client.getPosition()` / `client.getObjectId()` / `client.isInVault()`
- `client.getLifecycleState()` — coarse socket/client lifecycle state
- `client.getServerHost()` / `client.knownServers()` / `client.differentServer()`
- `client.visibleObjects()` — tracked non-player objects from updates
- `client.realmPortals()` — tracked realm portals

You can also subscribe directly with `client.on(ClientEvent.X, fn)` /
`client.onPacket(PacketType.X, fn)` if you need to outside of decorators.

## Loading / unloading

- **Config:** add the plugin name to an account's `plugins` array in
  `accounts.json`. It loads when that client connects.
- **Runtime console:**
  - `plugins <alias>` — list loaded plugins + all available (name + description)
  - `hosts <alias>` — print `RealmHostMapper`'s portal -> hostname table
  - `plugin <alias> load <name>`
  - `plugin <alias> unload <name>` — removes all its hooks cleanly

## Quality gates

- `npm run build` — compile the client
- `npm test` — run offline regression tests for command building, packet hooks,
  plugin runtime timers/errors, movement, and portal parsing
- `npm run check` — run build and tests together

## Bundled examples

| plugin | shows |
|--------|-------|
| `ChatLogger` | a single `@PacketHook` (TEXT) |
| `AntiSpam` | high-priority cancellable `@PacketHook` before chat logging |
| `AutoQuest` | realm entry, `QUESTOBJID` tracking, movement, and basic auto-shooting |
| `PacketLogger` | several `@PacketHook`s + an `@EventHook` (Death) |
| `AutoVault` | `@EventHook`s driving a command (`enterVault`) |
| `SeasonalVaultWithdraw` | seasonal-stat gating, chunked vault parsing, container `INVSWAP`, and a one-shot escape workflow |
| `RealmFinder` | reading `realmPortals()` from an event hook; pure selection logic |
| `RealmHostMapper` | multi-step event/packet workflow: visit portals, record Reconnect hosts, escape back |
| `InventoryTracker` | passive inventory diffs plus typed `InventoryResult` events |
| `PetBagRoundTrip` | reversible inventory↔pet-bag transfers with protocol-native slots |
| `PetToVault` | inventory→pet-bag→inventory→vault workflow using semantic helpers |
| `VaultStorage` | confirmed asynchronous inventory↔vault cycles |
| `LiveContainerSwapTest` | guarded integration matrix across all supported item containers |

Socket stalling is built into `Client`; call `client.stall(ms?)`,
`client.unstall()`, and `client.getStallInfo()` from any plugin.

### `AutoQuest`

`AutoQuest` waits for Nexus realm portals, walks to the least-populated open
portal, enters it, listens for `QUESTOBJID`, and repeatedly walks toward the
visible quest object. While questing it aims at nearby tracked objects that are
not known player classes or portal types.

Optional environment variables:

| var | meaning |
|-----|---------|
| `AUTO_QUEST_SHOOT_RANGE=6` | max tile distance for auto-shoot targets |
| `AUTO_QUEST_SHOOT_INTERVAL_MS=450` | delay between shooting bursts |
| `AUTO_QUEST_MAX_SHOTS=3` | max nearby targets aimed at per burst |
| `AUTO_QUEST_REFRESH_MS=1200` | delay between quest movement target refreshes |
| `AUTO_QUEST_PORTAL_RETRY_MS=1200` | delay between repeated `USE_PORTAL` attempts |
| `AUTO_QUEST_PORTAL_MAX_ATTEMPTS=6` | attempts before abandoning that portal and trying another |
| `AUTO_QUEST_PORTAL_ARRIVE_THRESHOLD=0.05` | distance considered close enough before using a realm portal |

Current limitation: enemy detection is packet-state based until object metadata
is loaded into the client. The plugin filters out known player classes and
portals, then treats the remaining nearby tracked objects as shootable.
