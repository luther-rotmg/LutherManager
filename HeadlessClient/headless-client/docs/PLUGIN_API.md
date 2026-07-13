# Plugin API reference

This is the complete plugin-facing API for `Client` and `PluginRuntime`. Start
with [PLUGINS.md](PLUGINS.md) if you have not written a plugin before.

## Imports

```ts
import { SlotObjectData, TextPacket } from 'realmlib';
import { ClassType, Client, ItemContainer } from '../client';
import { ClientEvent } from '../events';
import { PluginRuntime } from '../plugin-runtime';
import { EventHook, PacketHook, Plugin } from './decorators';
```

`ClassType` is a public alias of realmlib's `Classes` enum.

## Character operations

```ts
client.createCharacter(ClassType.Wizard, true);

client.createCharacter({
  classType: ClassType.Rogue,
  seasonal: true,
  skin: 0,
  challenger: false,
});

await client.deleteCharacter(164);
client.sendSeasonalConversion();
```

| method | result | notes |
|---|---|---|
| `createCharacter(classType, seasonal?)` | `void` | Sends `CREATE`; use in a character-select/Nexus load flow. |
| `createCharacter(options?)` | `void` | Full class, skin, seasonal, and challenger options. |
| `deleteCharacter(charId)` | `Promise<void>` | Calls `/char/delete` with the current access token. Permanent. |
| `sendSeasonalConversion()` | `void` | Sends `CONVERT_SEASONAL_CHARACTER`. |

Only delete a character ID you have deliberately selected. The repository's
`npm run test:live-character` harness demonstrates a guarded create/verify/
delete/verify lifecycle using a disposable character.

## Slot model

Slot methods return realmlib `SlotObjectData`:

```ts
interface SlotObjectData {
  objectId: number;   // live owner/container id
  slotId: number;     // index inside that owner
  objectType: number; // current item type, -1 means empty
}
```

Container IDs are map-scoped. Never hard-code a runtime vault object ID.
`VAULT_CONTENT` and visible objects are used to resolve them.

Supported logical containers:

```ts
type ItemContainer =
  | 'inventory'
  | 'petBag'
  | 'vault'
  | 'materialVault'
  | 'giftChest'
  | 'potionVault'
  | 'spoilsChest';
```

### Requested convenience lookups

```ts
const inventoryItem = client.getInventorySlot(4);
const firstInventoryItem = client.getInventorySlot();
const vaultItem = client.getVaultSlot();
const emptyPetSlot = client.getPetBagSlot();
const emptyPotionSlot = client.getPotionVaultSlot();
```

| method | selection rule |
|---|---|
| `getInventorySlot(index?)` | Requested non-empty player slot; without an index, first non-empty main inventory/backpack slot. |
| `getVaultSlot(index?)` | Requested non-empty main-vault slot; otherwise first non-empty. |
| `getPetBagSlot(index?)` | Requested known-empty pet slot; otherwise first known-empty. |
| `getPotionVaultSlot(index?)` | Requested empty potion slot; otherwise first empty. |
| `getPotionVaultItemSlot(index?)` | Requested/first non-empty potion slot. |
| `getGiftChestSlot(index?)` | Requested/first non-empty Gift Chest slot. |
| `getMaterialVaultSlot(index?)` | Requested/first non-empty material slot. |
| `getSpoilsChestSlot(index?)` | Requested/first non-empty spoils slot. |

Every method returns `null` when the requested state is unavailable, invalid,
or does not match the filled/empty rule. Pet slots are conservative: unknown
slots are not assumed empty. A pet slot becomes known from object status stats
or a successful `INVRESULT`.

### Generic slot queries

```ts
client.getContainerSlots('vault');
client.getContainerSlot('vault', 3);
client.getFirstFilledSlot('giftChest');
client.getFirstEmptySlot('potionVault');
client.getInventorySlots();
client.getVaultSlots();
client.getPetBagSlots();
client.getPotionVaultSlots();
client.getEmptyInventorySlot();
client.findInventoryItem(itemType);
client.getContainerItemCount('vault');
client.hasInventorySpace();
```

`getContainerSlot()` returns either filled or empty known slots. The more
specific helpers enforce their documented filled/empty rule.

## Inventory operations

### Protocol-native calls

```ts
const item = client.getInventorySlot(4);
const emptyPet = client.getPetBagSlot();
if (item && emptyPet) {
  client.swapInventoryWithPetBag(item, emptyPet);
}

const vault = client.getVaultSlot();
const potion = client.getPotionVaultSlot();
if (vault && potion) {
  await client.swapVaultWithPotionVault(vault, potion);
}
```

| method | behavior |
|---|---|
| `swapSlots(from, to)` | One low-level `INVSWAP`, walking into range first. |
| `swapInventoryWithPetBag(slot, slot)` | Direct player↔pet swap. |
| `swapInventoryWithVault(slot, slot)` | Direct player↔vault swap. |
| `swapInventoryWithPotionVault(slot, slot)` | Direct player↔potion swap. |
| `swapPetBagWithVault(slot, slot)` | Async transfer through player inventory buffers. |
| `swapPetBagWithPotionVault(slot, slot)` | Async transfer through player inventory buffers. |
| `swapVaultWithPotionVault(slot, slot)` | Async transfer/exchange through player inventory buffers. |
| `transferBetweenContainers(from, to, timeout?)` | Generic reliable non-player transfer. |

The async transfer uses one empty inventory buffer when the destination is
empty and two when both slots are occupied. Each leg waits for the matching
`INVRESULT`, and returns `false` when a leg fails, times out, changes maps, or
lacks enough buffers. If a later leg fails after staging an item, the client
performs a best-effort rollback to restore the original slots.

### Backwards-compatible numeric calls

Existing plugins may keep using numeric overloads:

```ts
client.swapInventoryWithVault(4, 0);
client.swapInventoryWithPetBag(4, 0, -1);
client.swapPetBagWithVault(0, petItemType, 0);
```

Numeric pet↔storage and vault↔potion forms are low-level direct probes. Live
servers reject direct non-player→non-player swaps; prefer `SlotObjectData`
overloads, which route through inventory.

`swapContainerItems({ container, slotId, itemType? }, ...)` is the generic
numeric-state API. `invSwap()` and `invSwapNear()` remain available when a
plugin already has raw `{ objectId, slotId, itemType }` references.

## State and lifecycle

| query | meaning |
|---|---|
| `alias` | Account/client alias. |
| `getPlayer()` | Latest parsed `PlayerData`. |
| `getObjectId()` | Current player object ID. |
| `getPosition()` / `getServerPosition()` | Local and authoritative positions. |
| `getMapName()` | Current map name. |
| `isInNexus()` / `isInVault()` / `isInPetYard()` | Map predicates. |
| `isSeasonal()` | `true`, `false`, or `undefined` until observed. |
| `isConnected()` / `isInWorld()` | Socket and CreateSuccess state. |
| `getLifecycleState()` | Full client lifecycle enum. |
| `getTickInfo()` | Tick ID/count/timing. |
| `getLastInvResult()` | Last parsed inventory acknowledgement snapshot. |
| `getVaultContent()` | Cloned storage snapshot. |
| `getPetInstanceId()` / `getPetObjectId()` | Raw reported pet identifiers. |
| `getPetBagContainerId()` / `hasPetBag()` | Usable pet-bag state. |

## Movement, portals, and world objects

```ts
client.moveTo({ x: 100, y: 100 });
client.moveToObject(objectId);
client.enterPortal(objectId);
client.enterVault();
client.enterPetYard();
client.escape();

const nearest = client.getNearestVisibleObject((object) => object.type === wantedType);
const portals = client.realmPortals();
const portal = client.getRealmPortal('Moonrise');
```

| method | notes |
|---|---|
| `visibleObjects()` | Cloned list of tracked non-player objects. |
| `getVisibleObject(id)` | One visible object. |
| `findVisibleObjects(predicate?)` | Filter visible objects. |
| `getNearestVisibleObject(predicate?)` | Nearest matching object. |
| `distanceTo({x,y})` | Distance from authoritative/local position. |
| `moveToObject(id, threshold?)` | Move to a visible object. |
| `realmPortals()` / `getRealmPortal(name)` | Realm portal queries. |
| `usePortal(id)` | Send immediately. |
| `enterPortal(id, threshold?)` | Walk into range, then use. |
| `enterVault()` / `enterPetYard()` | Locate, walk to, and use the Nexus portal. |
| `escape()` | Send `ESCAPE`. |

## Communication, combat, and connection

```ts
client.say('hello');
client.send(packet);
client.shootAt({ x, y });
client.connectToServer(host);
client.connectToGameId(gameId, host?);
client.connectToReconnectTicket(ticketId);
client.stall(5000); // automatically unstall after 5 seconds
client.stall();     // hold until client.unstall()
client.unstall();
client.stop('plugin finished');
```

Raw `send(packet)` is intentionally available for realmlib packet types not yet
wrapped by a semantic helper.

`stall(ms?)` pauses socket reads and queues outgoing packets in order. With no
duration it remains stalled until `unstall()`; with a positive duration it
resumes automatically. `unstall()` flushes the queue and returns the elapsed
milliseconds, or `-1` when the client was not stalled. `getStallInfo()` exposes
elapsed/remaining time plus queued and dropped packet counts. The old
`stallSocket()` / `resumeSocket()` names are deprecated compatibility aliases.

## PluginRuntime

All plugin-owned waits and timers should use the runtime:

```ts
await runtime.sleep(500);
const ready = await runtime.waitUntil(
  () => client.isInVault() && client.getVaultSlot() !== null,
  10_000,
  100,
);
```

| member | behavior |
|---|---|
| `setTimeout(fn, ms)` / `setInterval(fn, ms)` | Managed timers. |
| `clearTimer(handle)` / `clearAllTimers()` | Cancel owned timers. |
| `sleep(ms)` | Sleep which resolves early on unload. |
| `waitUntil(predicate, timeout?, poll?)` | Cancellable polling; supports async predicates. |
| `isDisposed` | Whether the plugin has been unloaded. |
| `client` / `name` | Owning client and plugin name. |

## Events

Use `@EventHook(ClientEvent.X)` or `client.on(ClientEvent.X, listener)`.

| event | payload |
|---|---|
| `Connected` | none |
| `Ready` | player object ID |
| `MapChange` | map name |
| `EnterNexus`, `EnterVault`, `EnterPetYard` | none |
| `VaultContents` | `VaultContentPacket` |
| `InventoryResult` | `InvResultPacket` after local state reconciliation |
| `RealmPortal` | `RealmPortal` |
| `Tick` | `PlayerData \| undefined` |
| `ReachedTarget` | `{x, y}` |
| `Death` | `DeathPacket` |
| `Failure` | `FailurePacket` |
| `Disconnect` | none |

`InventoryResult` is emitted after successful swaps have updated local player
and container slots, so event handlers may immediately query the new state.

## Live-server constraints

- Runtime object IDs change between maps. Resolve slots again after reconnects.
- Direct vault↔potion and pet↔storage swaps are rejected. Use async slot-object
  overloads which route through player inventory.
- A pet bag is unavailable until the character reports a usable pet identifier
  and its slots become known.
- `VAULT_CONTENT` may arrive in chunks. Wait for `lastVaultPacket` before
  planning against the complete snapshot.
- `deleteCharacter()` is irreversible and should not target the active or an
  unverified character ID.
- A successful outgoing send only means the packet was queued. Use
  `InventoryResult` or the async transfer methods for server acknowledgement.
