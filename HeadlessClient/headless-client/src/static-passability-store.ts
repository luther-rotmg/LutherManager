import {
  buildDilatedFullOccupyTiles,
  buildDilatedObstacleTiles,
  isBlockedByInflatedPassability,
  updateDilatedObstacleDirtyRegion,
} from './inflated-passability';
import type {
  GridTile,
  StaticObjectPassabilityProfile,
  StaticOccupancyQuery,
  StaticPassabilityConfig,
  StaticPassabilityDataProvider,
  StaticPassabilityStore,
  StaticTileQuery,
} from './static-passability-model';

const INVALID_TILE_TYPE = 0xffff;

interface StoredObjectRecord {
  key: number;
  occupySquare: boolean;
  fullOccupy: boolean;
}

/**
 * Packed 32-bit tile-key for Map<number, ...> / Set<number> lookups.
 * Matches dodge-collision-world.ts + inflated-passability.ts encoding so keys are
 * interchangeable across modules. P9 audit item tileKey-template-string-per-sample.
 */
function tileKey(x: number, y: number): number {
  return ((x + 0x8000) << 16) | ((y + 0x8000) & 0xffff);
}

function addToSet(values: Set<number>, value: number): boolean {
  if (values.has(value)) return false;
  values.add(value);
  return true;
}

function tilesEqual(a: GridTile | undefined, x: number, y: number): boolean {
  return a !== undefined && a.x === x && a.y === y;
}

/**
 * Shared static passability state for pathfinding and dodge (Commit 4.2).
 *
 * Pathfinding queries mirror ExplorativePathfinder.isBlocked(); dodge occupancy
 * mirrors DodgeCollisionWorld.canOccupyStatic().
 */
export class StaticPassabilityStoreImpl implements StaticPassabilityStore {
  private width = 0;
  private height = 0;
  private revision = 0;
  private explorativeUnknown = false;
  private readonly useInflatedPassability: boolean;
  /** Pathfinding: observed blocking terrain (unknown cells are absent). */
  private readonly blockedTerrain = new Set<number>();
  /** Dodge: observed tile types for unresolved-tile handling. */
  private readonly tileTypes = new Map<number, number>();
  private readonly learnedBlocked = new Set<number>();
  private readonly objectTiles = new Map<number, StoredObjectRecord>();
  private readonly occupyCounts = new Map<number, number>();
  private readonly fullOccupyCounts = new Map<number, number>();
  /** Rebuilt on each geometry change when inflated passability is enabled (Step 5.2). */
  private obstacleSources = new Set<number>();
  private fullOccupySources = new Set<number>();
  /** Dilated integer-tile grids cached for the current revision. */
  private dilatedObstacleTiles = new Set<number>();
  private dilatedFullOccupyTiles = new Set<number>();
  /** Revision that dilatedObstacleTiles/dilatedFullOccupyTiles were built for. */
  private inflatedCacheRevision = -1;

  constructor(
    private readonly data?: StaticPassabilityDataProvider,
    config?: StaticPassabilityConfig,
  ) {
    this.useInflatedPassability = !!config?.useInflatedPassability;
  }

  isInflatedPassabilityEnabled(): boolean {
    return this.useInflatedPassability;
  }

  getRevision(): number {
    return this.revision;
  }

  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
  }

  inBounds(tileX: number, tileY: number): boolean {
    return tileX >= 0 && tileY >= 0
      && (this.width === 0 || tileX < this.width)
      && (this.height === 0 || tileY < this.height);
  }

  isExplorativeUnknown(): boolean {
    return this.explorativeUnknown;
  }

  getObservedTileType(tileX: number, tileY: number): number | undefined {
    return this.tileTypes.get(tileKey(Math.trunc(tileX), Math.trunc(tileY)));
  }

  hasOccupySquareAt(tileX: number, tileY: number): boolean {
    return (this.occupyCounts.get(tileKey(Math.trunc(tileX), Math.trunc(tileY))) ?? 0) > 0;
  }

  isTileStaticallyBlocked(tileX: number, tileY: number, query: StaticTileQuery): boolean {
    if (this.isBaseTileStaticallyBlocked(tileX, tileY, query)) return true;
    if (!this.useInflatedPassability) return false;
    return this.isInflatedBlockedAt(tileX + 0.5, tileY + 0.5);
  }

  private isBaseTileStaticallyBlocked(tileX: number, tileY: number, query: StaticTileQuery): boolean {
    if (tilesEqual(query.exemptTile, tileX, tileY)) return false;
    if (!this.inBounds(tileX, tileY)) return true;

    const key = tileKey(tileX, tileY);
    if (query.consumer === 'pathfinding') {
      return this.blockedTerrain.has(key)
        || this.learnedBlocked.has(key)
        || (this.occupyCounts.get(key) ?? 0) > 0;
    }

    const type = this.tileTypes.get(key);
    if (type === INVALID_TILE_TYPE) return true;
    if (type === undefined && !this.explorativeUnknown) return true;
    if (this.learnedBlocked.has(key)) return true;
    if (type !== undefined && !!this.data?.tileIsBlockingWalk?.(type)) return true;
    if (type !== undefined && query.safeWalk && (this.data?.getTileDamage?.(type) ?? 0) > 0) {
      return true;
    }
    return (this.occupyCounts.get(key) ?? 0) > 0;
  }

  private isInflatedBlockedAt(px: number, py: number): boolean {
    if (this.inflatedCacheRevision === this.revision
      && this.width > 0
      && this.height > 0
      && px === Math.floor(px) + 0.5
      && py === Math.floor(py) + 0.5) {
      const key = tileKey(Math.floor(px), Math.floor(py));
      return this.dilatedObstacleTiles.has(key) || this.dilatedFullOccupyTiles.has(key);
    }
    return isBlockedByInflatedPassability(
      px,
      py,
      this.obstacleSources,
      this.fullOccupySources,
    );
  }

  private rebuildObstacleSources(): void {
    this.obstacleSources = this.collectObstacleTiles();
  }

  private rebuildFullOccupySources(): void {
    this.fullOccupySources = this.collectFullOccupyTiles();
  }

  private rebuildInflatedPassabilityFull(): void {
    this.rebuildObstacleSources();
    this.rebuildFullOccupySources();
    this.dilatedObstacleTiles = buildDilatedObstacleTiles(
      this.obstacleSources,
      this.width,
      this.height,
    );
    this.dilatedFullOccupyTiles = buildDilatedFullOccupyTiles(
      this.fullOccupySources,
      this.width,
      this.height,
    );
    this.inflatedCacheRevision = this.revision;
  }

  private incrementalLearnedBlockInflation(tileX: number, tileY: number): void {
    this.obstacleSources.add(tileKey(tileX, tileY));
    updateDilatedObstacleDirtyRegion(
      this.dilatedObstacleTiles,
      this.obstacleSources,
      tileX,
      tileY,
      this.width,
      this.height,
    );
    this.inflatedCacheRevision = this.revision;
  }

  private syncInflatedCacheRevision(): void {
    if (!this.useInflatedPassability) return;
    this.inflatedCacheRevision = this.revision;
  }

  private clearInflatedPassabilityCache(): void {
    this.obstacleSources.clear();
    this.fullOccupySources.clear();
    this.dilatedObstacleTiles.clear();
    this.dilatedFullOccupyTiles.clear();
    this.inflatedCacheRevision = -1;
  }

  private touchInflatedPassabilityFull(): void {
    if (!this.useInflatedPassability) return;
    this.rebuildInflatedPassabilityFull();
  }

  private collectObstacleTiles(): Set<number> {
    const obstacles = new Set<number>();
    for (const key of this.blockedTerrain) obstacles.add(key);
    for (const key of this.learnedBlocked) obstacles.add(key);
    for (const [key, count] of this.occupyCounts) {
      if (count > 0) obstacles.add(key);
    }
    return obstacles;
  }

  private collectFullOccupyTiles(): Set<number> {
    const fullOccupy = new Set<number>();
    for (const [key, count] of this.fullOccupyCounts) {
      if (count > 0) fullOccupy.add(key);
    }
    return fullOccupy;
  }

  private touchInflatedSources(): void {
    this.touchInflatedPassabilityFull();
  }

  // TEMPORARY SCAFFOLDING FOR COMMIT 5 — to be deleted.
  isTileBlockedForPathfinding(tileX: number, tileY: number, exemptTile?: GridTile): boolean {
    return this.isTileStaticallyBlocked(tileX, tileY, { consumer: 'pathfinding', exemptTile });
  }

  // TEMPORARY SCAFFOLDING FOR COMMIT 5 — to be deleted.
  isTileBlockedForDodge(
    tileX: number,
    tileY: number,
    options?: Pick<StaticTileQuery, 'exemptTile' | 'safeWalk'>,
  ): boolean {
    return this.isTileStaticallyBlocked(tileX, tileY, { consumer: 'dodge', ...options });
  }

  // TEMPORARY SCAFFOLDING FOR COMMIT 5 — to be deleted.
  canOccupyForPathfindingAt(x: number, y: number, exemptTile?: GridTile): boolean {
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    return !this.isTileBlockedForPathfinding(tileX, tileY, exemptTile);
  }

  // TEMPORARY SCAFFOLDING FOR COMMIT 5 — to be deleted.
  canOccupyForDodgeAt(
    x: number,
    y: number,
    options?: Pick<StaticOccupancyQuery, 'exemptTile' | 'safeWalk'>,
  ): boolean {
    return this.canOccupyAt(x, y, {
      consumer: 'dodge',
      checkFullOccupyNeighbors: true,
      ...options,
    });
  }

  canOccupyAt(x: number, y: number, query: StaticOccupancyQuery): boolean {
    const tileX = Math.floor(x);
    const tileY = Math.floor(y);
    if (this.isBaseTileStaticallyBlocked(tileX, tileY, query)) return false;

    if (this.useInflatedPassability) {
      return !this.isInflatedBlockedAt(x, y);
    }

    if (query.checkFullOccupyNeighbors === false) return true;

    const fracX = x - tileX;
    const fracY = y - tileY;
    const minX = fracX < 0.5 ? tileX - 1 : tileX;
    const maxX = fracX > 0.5 ? tileX + 1 : tileX;
    const minY = fracY < 0.5 ? tileY - 1 : tileY;
    const maxY = fracY > 0.5 ? tileY + 1 : tileY;
    for (let neighborX = minX; neighborX <= maxX; neighborX++) {
      for (let neighborY = minY; neighborY <= maxY; neighborY++) {
        if (neighborX === tileX && neighborY === tileY) continue;
        const key = tileKey(neighborX, neighborY);
        const neighborType = this.tileTypes.get(key);
        if (!this.inBounds(neighborX, neighborY)
          || neighborType === INVALID_TILE_TYPE
          || neighborType === undefined && !this.explorativeUnknown
          || this.learnedBlocked.has(key)
          || (this.fullOccupyCounts.get(key) ?? 0) > 0) {
          return false;
        }
      }
    }
    return true;
  }

  reset(): void {
    this.width = 0;
    this.height = 0;
    this.explorativeUnknown = false;
    this.blockedTerrain.clear();
    this.tileTypes.clear();
    this.learnedBlocked.clear();
    this.objectTiles.clear();
    this.occupyCounts.clear();
    this.fullOccupyCounts.clear();
    this.clearInflatedPassabilityCache();
    this.revision++;
    this.touchInflatedPassabilityFull();
  }

  setMapBounds(width: number, height: number): void {
    const nextWidth = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
    const nextHeight = Number.isFinite(height) ? Math.max(0, Math.trunc(height)) : 0;
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.revision++;
    this.touchInflatedSources();
  }

  observeTile(x: number, y: number, tileType: number): void {
    const tileX = Math.trunc(x);
    const tileY = Math.trunc(y);
    const key = tileKey(tileX, tileY);
    const nextType = Math.trunc(tileType);

    const blocked = nextType === INVALID_TILE_TYPE
      || !!this.data?.tileIsBlockingWalk?.(nextType)
      || (this.data?.getTileDamage?.(nextType) ?? 0) > 0;
    let changed = blocked ? addToSet(this.blockedTerrain, key) : this.blockedTerrain.delete(key);

    if (this.tileTypes.get(key) !== nextType) {
      this.tileTypes.set(key, nextType);
      changed = true;
    }

    if (changed) {
      this.revision++;
      this.touchInflatedSources();
    }
  }

  markLearnedBlocked(tileX: number, tileY: number): boolean {
    const key = tileKey(Math.floor(tileX), Math.floor(tileY));
    if (!addToSet(this.learnedBlocked, key)) return false;
    this.revision++;
    if (this.useInflatedPassability) {
      this.incrementalLearnedBlockInflation(Math.floor(tileX), Math.floor(tileY));
    }
    return true;
  }

  setExplorativeUnknown(enabled: boolean): void {
    if (this.explorativeUnknown === enabled) return;
    this.explorativeUnknown = enabled;
    this.revision++;
    this.syncInflatedCacheRevision();
  }

  upsertObject(
    objectId: number,
    _objectType: number,
    x: number,
    y: number,
    profile: StaticObjectPassabilityProfile,
  ): void {
    const oldRecord = this.objectTiles.get(objectId);
    const key = tileKey(Math.floor(x), Math.floor(y));
    const occupySquare = !!profile.occupySquare;
    const fullOccupy = !!profile.fullOccupy;

    if (oldRecord
      && oldRecord.key === key
      && oldRecord.occupySquare === occupySquare
      && oldRecord.fullOccupy === fullOccupy) {
      return;
    }

    let changed = false;
    if (oldRecord) {
      if (oldRecord.occupySquare) {
        this.adjustCount(this.occupyCounts, oldRecord.key, -1);
        changed = true;
      }
      if (oldRecord.fullOccupy) {
        this.adjustCount(this.fullOccupyCounts, oldRecord.key, -1);
        changed = true;
      }
      this.objectTiles.delete(objectId);
    }

    if (!occupySquare && !fullOccupy) {
      if (changed) {
        this.revision++;
        this.touchInflatedSources();
      }
      return;
    }

    this.objectTiles.set(objectId, { key, occupySquare, fullOccupy });
    if (occupySquare) {
      this.adjustCount(this.occupyCounts, key, 1);
      changed = true;
    }
    if (fullOccupy) {
      this.adjustCount(this.fullOccupyCounts, key, 1);
      changed = true;
    }
    if (changed) {
      this.revision++;
      this.touchInflatedSources();
    }
  }

  removeObject(objectId: number): void {
    if (this.removeObjectRecord(objectId)) {
      this.revision++;
      this.touchInflatedSources();
    }
  }

  private removeObjectRecord(objectId: number): boolean {
    const record = this.objectTiles.get(objectId);
    if (!record) return false;
    this.objectTiles.delete(objectId);
    this.adjustCount(this.occupyCounts, record.key, record.occupySquare ? -1 : 0);
    this.adjustCount(this.fullOccupyCounts, record.key, record.fullOccupy ? -1 : 0);
    return true;
  }

  private adjustCount(counts: Map<number, number>, key: number, delta: number): void {
    if (delta === 0) return;
    const count = (counts.get(key) ?? 0) + delta;
    if (count > 0) counts.set(key, count);
    else counts.delete(key);
  }

  /** @internal Step 5.2 test helper — revision the dilated cache was built for. */
  getInflatedCacheRevisionForTest(): number {
    return this.inflatedCacheRevision;
  }

  /** @internal Step 5.2 test helper — copy of dilated obstacle tile keys. */
  getDilatedObstacleTilesForTest(): ReadonlySet<number> {
    return this.dilatedObstacleTiles;
  }

  /** @internal Step 5.2 test helper — copy of dilated fullOccupy tile keys. */
  getDilatedFullOccupyTilesForTest(): ReadonlySet<number> {
    return this.dilatedFullOccupyTiles;
  }
}

export function createStaticPassabilityStore(
  data?: StaticPassabilityDataProvider,
  config?: StaticPassabilityConfig,
): StaticPassabilityStore {
  return new StaticPassabilityStoreImpl(data, config);
}
