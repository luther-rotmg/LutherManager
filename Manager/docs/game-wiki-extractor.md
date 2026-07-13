# Game Wiki and RotMGAssetExtractor dumps

## Bundled copy in this repo (`data/rotmg-extractor-game/`)

If `data/rotmg-extractor-game/GameData/spritesheet.xml` and `data/rotmg-extractor-game/GameData/images/` exist, the dev server uses them **automatically** (no Settings path required). Copy from your extractor output, for example:

```powershell
$src = "C:\Users\trump\Desktop\RotMG-extractor-output\GameData"
$dst = ".\data\rotmg-extractor-game\GameData"
New-Item -ItemType Directory -Force -Path (Join-Path $dst "images") | Out-Null
Copy-Item -Force (Join-Path $src "spritesheet.xml") (Join-Path $dst "spritesheet.xml")
Copy-Item -Force -Recurse (Join-Path $src "images\*") (Join-Path $dst "images")
```

`data/rotmg-extractor-game/` is **gitignored** so atlases are not pushed by default; remove that `.gitignore` line if you want the dump in version control.

## What the extractor path is for

Settings **RotMG extractor GameData** overrides the bundled folder when set. It should point at either:

- The folder that **contains** a `GameData` directory (e.g. the output of `RotMGExtractorRunner` such as `RotMG-extractor-output`), or  
- The **`GameData` directory itself** (the folder that directly contains `spritesheet.xml` and `images/`).

The dev server uses that dump to serve **cropped** PNGs for Game Wiki object headers: it looks up `<Texture><File>` + `<Index>` from your cached object XML in `spritesheet.xml`, then crops the correct rectangle from `groundTiles.png`, `characters.png`, `characters_masks.png`, or `mapObjects.png` (same atlas rules as [RotMGAssetExtractor](https://github.com/TadusPro/RotMGAssetExtractor) `ImageBuffer`).

If no dump is configured or a sprite is missing there, the server falls back to **loose `Drawings/*.png` files** under **RotMG Exalt Path** (when set).

## What stays on monolithic `data/*.xml`

`GameDataLoader` still reads **monolithic** RotMG-format files:

- [`data/objects.xml`](../data/objects.xml) — object types, projectiles, wiki catalog, raw `<Object>` XML for the wiki pane  
- [`data/tiles.xml`](../data/tiles.xml) — tile walkability, damage, wiki tile XML  

The extractor’s `GameData/models/*.xml` files (`GameObject.xml`, `Equipment.xml`, …) are **C# serialization** lists; they are **not** drop-in replacements for `objects.xml` / `tiles.xml` without a dedicated converter.

To align XML with the same game build as your extractor dump, refresh `objects.xml` / `tiles.xml` from a mirror, for example:

```bash
npm run download-game-xml
```

(or copy monolithic files from an official install).

## EAM, enchants, and `renders.png`

Account item icons and enchant UI still use **EAM** assets and [`renders.png`](../src/dev/public/renders.png) as before. The extractor dump does not replace those.

## Full vs lite extraction

A **lite** extractor run may only populate a subset of atlases; rare `<Texture><File>` groups can still 404 until you run a **full** asset extraction (`--full` in the runner) so every `SpriteGroup` in `spritesheet.xml` has backing pixels in `images/`.
