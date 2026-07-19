import { Tiles, Position } from '@luthermanager/sdk';
import type { MapTile } from '@luthermanager/sdk';
import type { BridgeDeps } from '../../BridgeDeps.js';
import type { GameDataLoader } from '../../../../game-data/GameDataLoader.js';
import { warnUnimplemented } from '../../stubWarn.js';

function normalizeFilter(f: string): string {
  return f.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function tileMatchesFilter(tileType: number, filterNorm: string, gd: GameDataLoader): boolean {
  switch (filterNorm) {
    case 'damaging':
      return (gd.getTileDamage(tileType) ?? 0) > 0;
    case 'conditioneffect':
    case 'condition':
      return gd.getTileHasConditionEffect(tileType);
    case 'slowing':
      return gd.getTileSpeed(tileType) < 1;
    case 'speedy':
    case 'faster':
      return gd.getTileSpeed(tileType) > 1;
    case 'speedmodified':
      return gd.getTileSpeed(tileType) !== 1;
    case 'blocking':
    case 'nowalk':
      return gd.tileIsBlockingWalk(tileType);
    case 'sink':
      return gd.tileIsSink(tileType);
    case 'push':
    case 'pushes':
      return gd.getTileHasPush(tileType);
    case 'slide':
    case 'sliding':
      return (gd.getTileSlideAmount(tileType) ?? 0) > 0;
    default:
      return false;
  }
}

function parseNearbyArgs(
  a?: number | string,
  b?: string,
): { radius: number; filter?: string } {
  if (a === undefined) return { radius: 5 };
  if (typeof a === 'string') {
    const t = a.trim();
    if (!t) return { radius: 5 };
    return { radius: 5, filter: normalizeFilter(t) };
  }
  const radius = Number.isFinite(a) ? Math.max(0, Math.floor(Number(a))) : 5;
  const filter =
    typeof b === 'string' && b.trim() ? normalizeFilter(b) : undefined;
  return { radius, filter };
}

function buildMapTile(
  x: number,
  y: number,
  tileType: number,
  gd: GameDataLoader,
  occupied: Set<number>,
): MapTile {
  const packed = (x << 16) | (y & 0xffff);
  const dmg = gd.getTileDamage(tileType) ?? 0;
  return {
    type: tileType,
    name: gd.getTileName(tileType),
    position: new Position(x + 0.5, y + 0.5),
    isBlocking: gd.tileIsBlockingWalk(tileType),
    isOccupied: occupied.has(packed),
    isSafe: false,
    speedMultiplier: gd.getTileSpeed(tileType),
    damaging: dmg > 0,
    damagePerTick: dmg,
    hasConditionEffect: gd.getTileHasConditionEffect(tileType),
  };
}

function playerPos(deps: BridgeDeps): { x: number; y: number } {
  const p = deps.clientRef.current?.playerData;
  return { x: p?.pos.x ?? 0, y: p?.pos.y ?? 0 };
}

export class BridgeTiles {
  static install(deps: BridgeDeps): void {
    const gd = deps.gameData;
    const ws = deps.worldState;

    Tiles.getAll = (filter?: string): MapTile[] => {
      const f = filter?.trim() ? normalizeFilter(filter) : undefined;
      const occupied = ws.getOccupiedTileKeys();
      const out: MapTile[] = [];
      ws.forEachKnownTile((x, y, tileType) => {
        if (f && !tileMatchesFilter(tileType, f, gd)) return;
        out.push(buildMapTile(x, y, tileType, gd, occupied));
      });
      return out;
    };

    Tiles.getNearby = ((a?: number | string, b?: string): MapTile[] => {
      const { radius, filter } = parseNearbyArgs(a, b);
      const { x: px, y: py } = playerPos(deps);
      const occupied = ws.getOccupiedTileKeys();
      const out: MapTile[] = [];
      const r2 = radius * radius;
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const pad = Math.ceil(radius) + 1;

      ws.forEachKnownTileInBounds(
        ix - pad,
        ix + pad,
        iy - pad,
        iy + pad,
        (x, y, tileType) => {
          const cx = x + 0.5;
          const cy = y + 0.5;
          const dx = cx - px;
          const dy = cy - py;
          if (dx * dx + dy * dy > r2) return;
          if (filter && !tileMatchesFilter(tileType, filter, gd)) return;
          out.push(buildMapTile(x, y, tileType, gd, occupied));
        },
      );
      return out;
    }) as typeof Tiles.getNearby;

    Tiles.getByType = (tileType: number): MapTile[] => {
      const occupied = ws.getOccupiedTileKeys();
      const out: MapTile[] = [];
      ws.forEachKnownTile((x, y, t) => {
        if (t !== tileType) return;
        out.push(buildMapTile(x, y, t, gd, occupied));
      });
      return out;
    };

    Tiles.getAt = (x: number, y: number): MapTile | null => {
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      const tileType = ws.getTileAt(tx, ty);
      if (tileType === undefined) return null;
      return buildMapTile(tx, ty, tileType, gd, ws.getOccupiedTileKeys());
    };

    Tiles.isBlocking = (x: number, y: number): boolean => {
      const t = ws.getTileAt(Math.floor(x), Math.floor(y));
      if (t === undefined) return false;
      return gd.tileIsBlockingWalk(t);
    };

    Tiles.isSafe = (_x: number, _y: number): boolean => {
      warnUnimplemented('Tiles.isSafe');
      return false;
    };
  }
}
