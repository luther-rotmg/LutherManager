# LutherManager

LutherManager is a hard fork of [HiveRotmg/HiveManager](https://github.com/HiveRotmg/HiveManager)
maintained by [luther-rotmg](https://github.com/luther-rotmg).

## What's in this repo

- **`HeadlessClient/`** — clientless Realm of the Mad God client + dodge/pathfinding/planner subsystems. See [`HeadlessClient/headless-client/README.md`](HeadlessClient/headless-client/README.md).
- **`Manager/`** — Electron shell, dev server, MCP surface, and SDK (`@luthermanager/sdk`) that runs on top of the headless client.

## Fork status

- **Rebranded** from HiveManager → LutherManager: repo name, Electron `productName`/`appId` (`world.luthermanager.app`), SDK package name (`@luthermanager/sdk`), the primary SDK global class (`Luther`).
- **RotMG game-data references intact:** `Manager/data/objects.xml` and similar files carry the game's real asset names (`epicHiveObjects*`, `Hivemaster`, `Hivemind`, etc.) unchanged.
- **Legacy `~/Documents/Hive/` config-directory** kept working via a preference/fallback resolver — existing HiveManager installs upgrade without losing accounts, proxies, script configs, or extracted game data. Fresh installs get `~/Documents/LutherManager/`.
- **Upstream tracking:** `upstream` remote points at `HiveRotmg/HiveManager` for occasional cherry-picks. This fork is not a downstream trying to send every change back — it's a self-directed project.

## Relationship to upstream

LutherManager sits alongside HiveManager, not under it. Improvements to shared subsystems (dodge planner, projectile prediction, pathfinding) are candidates for opportunistic upstream PRs; opinionated fork-specific work (Electron branding, config-dir path, whatever else) stays LutherManager-only.

## For AI agents / assistants

See [`CLAUDE.md`](CLAUDE.md) for project instructions.
