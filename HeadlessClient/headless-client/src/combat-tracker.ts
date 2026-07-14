import {
  ConditionEffectBits,
  EnemyHitPacket,
  EnemyShootPacket,
  OtherHitPacket,
  Packet,
  PlayerHitPacket,
  PlayerShootPacket,
  ServerPlayerShootPacket,
  StatType,
  SquareHitPacket,
} from 'realmlib';

export interface CombatProjectileDefinition {
  speed: number;
  lifetimeMs: number;
  /** Unscaled lifetime used by path shapes whose phase is tied to XML lifetime. */
  trajectoryLifetimeMs?: number;
  multiHit: boolean;
  passesCover: boolean;
  amplitude: number;
  frequency: number;
  magnitude: number;
  wavy: boolean;
  parametric: boolean;
  boomerang: boolean;
  acceleration: number;
  accelerationDelay: number;
  speedClamp: number;
  armorPiercing?: boolean;
}

export interface CombatPlayerHit {
  bulletId: number;
  ownerId: number;
  damage: number;
  projectile: CombatProjectileDefinition;
}

export interface CombatWeaponPatternDefinition {
  projectileId: number;
  patternIndex: number;
  numProjectiles: number;
  arcGap: number;
  defaultAngle: number;
  posOffsetX: number;
  posOffsetY: number;
}

export interface CombatWeaponSubattackDefinition {
  rateOfFire: number;
  isDummy: boolean;
  defaultAngleIncrease: number;
  minIncrAngleCounter: number;
  maxIncrAngleCounter: number;
  patterns: readonly CombatWeaponPatternDefinition[];
}

export interface CombatObjectDefinition {
  isEnemy: boolean;
  invincible?: boolean;
  isPlayer?: boolean;
  occupySquare: boolean;
  fullOccupy?: boolean;
  enemyOccupySquare?: boolean;
  protectFromGroundDamage?: boolean;
  /** Weapon RateOfFire (1 = full speed); used to derive the shot cooldown. */
  rateOfFire?: number;
  /** Number of projectiles the weapon fires per trigger. */
  numProjectiles?: number;
  /** Arc gap between projectiles, in degrees. */
  arcGap?: number;
  /** Modern weapon fire definitions parsed from `<Subattack>`. */
  subattacks?: readonly CombatWeaponSubattackDefinition[];
  maxHp?: number;
  quest?: boolean;
  usable?: boolean;
  mpCost?: number;
  cooldownMs?: number;
  activateEffects?: readonly string[];
}

/** Minimal game-data surface needed by combat simulation. */
export interface CombatDataProvider {
  getObject(type: number): CombatObjectDefinition | undefined;
  getProjectile(objectType: number, projectileId: number): CombatProjectileDefinition | undefined;
  getTileDamage?(tileType: number): number | undefined;
  getTileSpeed?(tileType: number): number;
  tileIsBlockingWalk?(tileType: number): boolean;
}

export interface CombatEntity {
  objectId: number;
  type: number;
  x: number;
  y: number;
  player?: {
    hp: number;
    condition: number;
    condition2: number;
  };
  rawStats?: Record<string, number | string>;
}

export interface CombatTile {
  x: number;
  y: number;
  type: number;
}

export interface CombatWorldSnapshot {
  playerId: number;
  playerPos: { x: number; y: number };
  mapWidth: number;
  mapHeight: number;
  entities: Iterable<CombatEntity>;
  tiles: Iterable<CombatTile>;
  /** Resolves the render-time position of a server-tick-interpolated entity. */
  resolveEntityPosition?(entity: CombatEntity): { x: number; y: number };
}

export type CombatProjectileSide = 'enemy' | 'own';

/** Read-only combat state consumed by predictive systems such as auto-dodge. */
export interface CombatProjectileSnapshot {
  side: CombatProjectileSide;
  bulletId: number;
  bulletType: number;
  ownerId: number;
  containerType: number;
  startX: number;
  startY: number;
  angle: number;
  startTime: number;
  definition: CombatProjectileDefinition;
  damage: number;
  hitObjects: ReadonlySet<number>;
}

interface ActiveProjectile extends CombatProjectileSnapshot {
  simulatedElapsed: number;
  hitObjects: Set<number>;
}

interface PreparedWorld {
  snapshot: CombatWorldSnapshot;
  tiles: Map<string, CombatTile>;
  covers: Map<string, CombatEntity[]>;
  enemies: CombatEntity[];
  players: CombatEntity[];
}

const SIMULATION_STEP_MS = 16;
const INVALID_TILE_TYPE = 0xffff;
const ACCURACY_HISTORY_MS = 60 * 60 * 1000;

/**
 * Replays the projectile lifecycle that the current game client uses to emit
 * PLAYERHIT/OTHERHIT/SQUAREHIT/ENEMYHIT claims.
 */
export class CombatTracker {
  private readonly projectiles = new Map<string, ActiveProjectile>();
  private readonly shotTimes: number[] = [];
  private readonly hitTimes: number[] = [];
  private projectileNoclipEnabled = false;

  constructor(
    private readonly data: CombatDataProvider,
    private readonly send: (packet: Packet) => void,
    private readonly onPlayerHit?: (hit: CombatPlayerHit) => boolean,
  ) {}

  clear(): void {
    this.projectiles.clear();
  }

  setProjectileNoclip(enabled: boolean): void {
    this.projectileNoclipEnabled = enabled;
  }

  isProjectileNoclipEnabled(): boolean {
    return this.projectileNoclipEnabled;
  }

  removeOwner(ownerId: number): void {
    for (const [key, projectile] of this.projectiles) {
      if (projectile.ownerId === ownerId) {
        this.projectiles.delete(key);
      }
    }
  }

  trackEnemyShoot(packet: EnemyShootPacket, ownerType: number | undefined, startTime: number): void {
    if (ownerType === undefined) {
      return;
    }
    const definition = this.data.getProjectile(ownerType, packet.bulletType);
    if (!definition || definition.lifetimeMs <= 0) {
      return;
    }
    const shotCount = packet.numShots > 0 && packet.numShots !== 0xff ? packet.numShots : 1;
    for (let index = 0; index < shotCount; index++) {
      const bulletId = (packet.bulletId + index) & 0xff;
      this.add({
        side: 'enemy',
        bulletId,
        bulletType: packet.bulletType,
        ownerId: packet.ownerId,
        containerType: ownerType,
        startX: packet.startingPos.x,
        startY: packet.startingPos.y,
        angle: packet.angle + packet.angleInc * index,
        startTime,
        simulatedElapsed: -SIMULATION_STEP_MS,
        definition,
        damage: packet.damage,
        hitObjects: new Set(),
      });
    }
  }

  /**
   * Registers a weapon shot we announced via PLAYERSHOOT. The server keeps a
   * ledger of the bullets we fire and expects every one of them to resolve
   * with an ENEMYHIT/OTHERHIT/SQUAREHIT; leaving them unresolved gets the
   * connection dropped with FAILURE errorId=0 after roughly a dozen shots.
   */
  trackPlayerShoot(
    ownerId: number,
    packet: PlayerShootPacket,
    startTime: number,
    projectileId = 0,
    speedMultiplier = 1,
    lifetimeMultiplier = 1,
  ): void {
    if (ownerId === -1) {
      return;
    }
    this.shotTimes.push(Date.now());
    this.pruneAccuracy();
    const baseDefinition = this.data.getProjectile(packet.containerType, projectileId);
    if (!baseDefinition || baseDefinition.lifetimeMs <= 0) {
      return;
    }
    const definition = scaleProjectileDefinition(baseDefinition, speedMultiplier, lifetimeMultiplier);
    this.add({
      side: 'own',
      bulletId: packet.bulletId,
      bulletType: projectileId,
      ownerId,
      containerType: packet.containerType,
      startX: packet.startingPos.x,
      startY: packet.startingPos.y,
      angle: packet.angle,
      startTime,
      simulatedElapsed: -SIMULATION_STEP_MS,
      definition,
      damage: 0,
      hitObjects: new Set(),
    });
  }

  trackOwnShoot(packet: ServerPlayerShootPacket, startTime: number): void {
    // ProdMafia keeps its locally-created projectile when the server echoes the
    // shot. Preserve it here because it has the exact subattack projectile id.
    if (this.projectiles.has(projectileKey(packet.ownerId, packet.bulletId))) {
      return;
    }
    const definition = this.data.getProjectile(packet.containerType, 0);
    if (!definition || definition.lifetimeMs <= 0) {
      return;
    }
    this.add({
      side: 'own',
      bulletId: packet.bulletId,
      bulletType: 0,
      ownerId: packet.ownerId,
      containerType: packet.containerType,
      startX: packet.startingPos.x,
      startY: packet.startingPos.y,
      angle: packet.angle,
      startTime,
      simulatedElapsed: -SIMULATION_STEP_MS,
      definition,
      damage: packet.damage,
      hitObjects: new Set(),
    });
  }

  update(now: number, snapshot: CombatWorldSnapshot): void {
    if (this.projectiles.size === 0) {
      return;
    }
    const world = this.prepareWorld(snapshot);
    for (const [key, projectile] of this.projectiles) {
      if (!this.advance(projectile, now, world)) {
        this.projectiles.delete(key);
      }
    }
  }

  get size(): number {
    return this.projectiles.size;
  }

  /** Live projectile snapshots. Callers must not mutate values yielded here. */
  getActiveProjectiles(): Iterable<CombatProjectileSnapshot> {
    return this.projectiles.values();
  }

  accuracy(): number {
    this.pruneAccuracy();
    return this.shotTimes.length > 0
      ? Math.min(1, this.hitTimes.length / this.shotTimes.length)
      : 0;
  }

  recentAccuracy(minutes: number): number {
    this.pruneAccuracy();
    const cutoff = Date.now() - Math.max(0, minutes) * 60_000;
    const shots = this.shotTimes.filter((time) => time >= cutoff).length;
    if (shots === 0) return 0;
    return Math.min(1, this.hitTimes.filter((time) => time >= cutoff).length / shots);
  }

  resetAccuracy(): void {
    this.shotTimes.length = 0;
    this.hitTimes.length = 0;
  }

  private pruneAccuracy(): void {
    const cutoff = Date.now() - ACCURACY_HISTORY_MS;
    while (this.shotTimes.length > 0 && this.shotTimes[0]! < cutoff) this.shotTimes.shift();
    while (this.hitTimes.length > 0 && this.hitTimes[0]! < cutoff) this.hitTimes.shift();
  }

  private add(projectile: ActiveProjectile): void {
    this.projectiles.set(projectileKey(projectile.ownerId, projectile.bulletId), projectile);
  }

  private prepareWorld(snapshot: CombatWorldSnapshot): PreparedWorld {
    const tiles = new Map<string, CombatTile>();
    for (const tile of snapshot.tiles) {
      tiles.set(tileKey(tile.x, tile.y), tile);
    }
    const covers = new Map<string, CombatEntity[]>();
    const enemies: CombatEntity[] = [];
    const players: CombatEntity[] = [];
    for (const source of snapshot.entities) {
      const position = snapshot.resolveEntityPosition?.(source);
      const entity = position && (position.x !== source.x || position.y !== source.y)
        ? { ...source, x: position.x, y: position.y }
        : source;
      const definition = this.data.getObject(entity.type);
      if (!definition) {
        continue;
      }
      const hp = entity.player?.hp ?? rawNumber(entity, StatType.HP_STAT);
      const condition = entity.player?.condition ?? rawNumber(entity, StatType.CONDITION_STAT) ?? 0;
      const dead = hp !== undefined && hp <= 0;
      const blocked = ConditionEffectBits.PAUSED
        | ConditionEffectBits.STASIS
        | ConditionEffectBits.INVINCIBLE;
      if (definition.isEnemy && !definition.invincible && !dead && (condition & blocked) === 0) {
        enemies.push(entity);
      }
      const playerBlocked = ConditionEffectBits.STASIS | ConditionEffectBits.INVINCIBLE;
      if (definition.isPlayer && !dead && (condition & playerBlocked) === 0) {
        players.push(entity);
      }
      if (definition.occupySquare || definition.enemyOccupySquare) {
        const key = tileKey(Math.floor(entity.x), Math.floor(entity.y));
        const list = covers.get(key) ?? [];
        list.push(entity);
        covers.set(key, list);
      }
    }
    return { snapshot, tiles, covers, enemies, players };
  }

  private advance(projectile: ActiveProjectile, now: number, world: PreparedWorld): boolean {
    const targetElapsed = Math.min(now - projectile.startTime, projectile.definition.lifetimeMs);
    if (targetElapsed < 0) {
      return true;
    }
    let elapsed = projectile.simulatedElapsed;
    while (elapsed < targetElapsed) {
      elapsed = Math.min(Math.max(0, elapsed + SIMULATION_STEP_MS), targetElapsed);
      const pos = positionAt(projectile, elapsed);
      const hit = this.resolveAt(projectile, projectile.startTime + elapsed, pos, world);
      projectile.simulatedElapsed = elapsed;
      if (hit) {
        return false;
      }
    }
    return targetElapsed < projectile.definition.lifetimeMs;
  }

  private resolveAt(
    projectile: ActiveProjectile,
    time: number,
    pos: { x: number; y: number },
    world: PreparedWorld,
  ): boolean {
    const tileX = Math.floor(pos.x);
    const tileY = Math.floor(pos.y);
    const outside = tileX < 0 || tileY < 0
      || (world.snapshot.mapWidth > 0 && tileX >= world.snapshot.mapWidth)
      || (world.snapshot.mapHeight > 0 && tileY >= world.snapshot.mapHeight);
    const tile = world.tiles.get(tileKey(tileX, tileY));
    if (outside || tile?.type === INVALID_TILE_TYPE) {
      this.sendSquareHit(projectile, time);
      return true;
    }

    const skipsCover = this.projectileNoclipEnabled
      && projectile.side === 'own'
      && projectile.ownerId === world.snapshot.playerId;
    if (!skipsCover) {
      for (const cover of world.covers.get(tileKey(tileX, tileY)) ?? []) {
        if (cover.objectId === projectile.ownerId) {
          continue;
        }
        const definition = this.data.getObject(cover.type);
        if (!definition) {
          continue;
        }
        const blocksOwnShot = projectile.side !== 'own' || !definition.isEnemy;
        const blocksProjectile = !!definition.enemyOccupySquare
          || (!projectile.definition.passesCover && definition.occupySquare);
        if (blocksOwnShot && blocksProjectile) {
          this.sendOtherHit(projectile, time, cover.objectId);
          return true;
        }
      }
    }

    if (projectile.side === 'enemy') {
      if (withinHitBox(pos, world.snapshot.playerPos)
        && !projectile.hitObjects.has(world.snapshot.playerId)) {
        const intercepted = this.onPlayerHit?.({
          bulletId: projectile.bulletId,
          ownerId: projectile.ownerId,
          damage: projectile.damage,
          projectile: projectile.definition,
        }) ?? false;
        projectile.hitObjects.add(world.snapshot.playerId);
        if (intercepted) return true;
        const hit = new PlayerHitPacket();
        hit.bulletId = projectile.bulletId;
        hit.objectId = projectile.ownerId;
        this.send(hit);
        return !projectile.definition.multiHit;
      }
      const player = nearestHit(pos, world.players, projectile.hitObjects);
      if (player) {
        projectile.hitObjects.add(player.objectId);
        if (!projectile.definition.multiHit) {
          this.sendOtherHit(projectile, time, player.objectId);
          return true;
        }
      }
      return false;
    }

    const enemy = firstHit(pos, world.enemies, projectile.hitObjects);
    if (!enemy) {
      return false;
    }
    const hit = new EnemyHitPacket();
    hit.time = Math.trunc(time);
    hit.bulletId = projectile.bulletId;
    hit.shooterId = projectile.ownerId;
    hit.targetId = enemy.objectId;
    hit.kill = false;
    hit.mainId = projectile.ownerId;
    this.send(hit);
    this.hitTimes.push(Date.now());
    this.pruneAccuracy();
    projectile.hitObjects.add(enemy.objectId);
    return !projectile.definition.multiHit;
  }

  private sendOtherHit(projectile: ActiveProjectile, time: number, targetId: number): void {
    const hit = new OtherHitPacket();
    hit.time = Math.trunc(time);
    hit.bulletId = projectile.bulletId;
    hit.objectId = projectile.ownerId;
    hit.targetId = targetId;
    this.send(hit);
  }

  private sendSquareHit(projectile: ActiveProjectile, time: number): void {
    const hit = new SquareHitPacket();
    hit.time = Math.trunc(time);
    hit.bulletId = projectile.bulletId;
    hit.objectId = projectile.ownerId;
    this.send(hit);
  }
}

function scaleProjectileDefinition(
  definition: CombatProjectileDefinition,
  speedMultiplier: number,
  lifetimeMultiplier: number,
): CombatProjectileDefinition {
  const speed = validMultiplier(speedMultiplier);
  const lifetime = validMultiplier(lifetimeMultiplier);
  return {
    ...definition,
    speed: definition.speed * speed,
    lifetimeMs: definition.lifetimeMs * lifetime,
    trajectoryLifetimeMs: definition.trajectoryLifetimeMs ?? definition.lifetimeMs,
  };
}

function validMultiplier(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function projectileKey(ownerId: number, bulletId: number): string {
  return `${ownerId}:${bulletId}`;
}

function rawNumber(entity: CombatEntity, stat: number): number | undefined {
  const value = entity.rawStats?.[String(stat)];
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function withinHitBox(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5;
}

function nearestHit(
  pos: { x: number; y: number },
  entities: CombatEntity[],
  ignored: Set<number>,
): CombatEntity | undefined {
  let nearest: CombatEntity | undefined;
  let nearestDistance = Infinity;
  for (const entity of entities) {
    if (ignored.has(entity.objectId) || !withinHitBox(pos, entity)) {
      continue;
    }
    const dx = entity.x - pos.x;
    const dy = entity.y - pos.y;
    const distance = dx * dx + dy * dy;
    if (distance < nearestDistance) {
      nearest = entity;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function firstHit(
  pos: { x: number; y: number },
  entities: CombatEntity[],
  ignored: Set<number>,
): CombatEntity | undefined {
  return entities.find((entity) => !ignored.has(entity.objectId) && withinHitBox(pos, entity));
}

/** Predicts a projectile's analytic world position at an absolute client time. */
export function predictProjectilePosition(
  projectile: CombatProjectileSnapshot,
  time: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  return positionAt(projectile, time - projectile.startTime, out);
}

export function isProjectileAliveAt(projectile: CombatProjectileSnapshot, time: number): boolean {
  const elapsed = time - projectile.startTime;
  return elapsed >= 0 && elapsed <= projectile.definition.lifetimeMs;
}

function positionAt(
  projectile: CombatProjectileSnapshot,
  elapsed: number,
  out: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  const definition = projectile.definition;
  const trajectoryLifetime = definition.trajectoryLifetimeMs ?? definition.lifetimeMs;
  const baseSpeed = definition.speed / 10000;
  let distance: number;
  if (definition.acceleration === 0 || elapsed < definition.accelerationDelay) {
    distance = elapsed * baseSpeed;
  } else {
    const accelerationElapsed = elapsed - definition.accelerationDelay;
    let accelerationTime = definition.lifetimeMs - definition.accelerationDelay;
    let clampedTime = 0;
    let clampedSpeed = 0;
    if (definition.speedClamp !== -1) {
      clampedSpeed = definition.speedClamp / 10000;
      const speedNeeded = Math.abs(definition.speedClamp - definition.speed);
      const timeToClamp = speedNeeded / Math.abs(definition.acceleration) * 1000;
      accelerationTime = Math.min(accelerationElapsed, timeToClamp);
      clampedTime = Math.max(0, accelerationElapsed - accelerationTime);
    }
    distance = definition.accelerationDelay * baseSpeed
      + accelerationTime * baseSpeed
      + (accelerationTime * accelerationTime / 1000) * 0.5 * (definition.acceleration / 10000)
      + clampedTime * clampedSpeed;
  }

  const phase = projectile.bulletId % 2 === 0 ? 0 : Math.PI;
  let x = projectile.startX;
  let y = projectile.startY;
  if (definition.wavy) {
    const angle = projectile.angle + Math.PI / 64 * Math.sin(phase + 6 * Math.PI * elapsed / 1000);
    x += distance * Math.cos(angle);
    y += distance * Math.sin(angle);
  } else if (definition.parametric) {
    const t = elapsed / trajectoryLifetime * 2 * Math.PI;
    const localX = Math.sin(t) * (projectile.bulletId % 2 ? 1 : -1);
    const localY = Math.sin(2 * t) * (projectile.bulletId % 4 < 2 ? 1 : -1);
    x += (localX * Math.cos(projectile.angle) - localY * Math.sin(projectile.angle)) * definition.magnitude;
    y += (localX * Math.sin(projectile.angle) + localY * Math.cos(projectile.angle)) * definition.magnitude;
  } else {
    if (definition.boomerang) {
      const halfway = trajectoryLifetime * baseSpeed * 0.5;
      if (distance > halfway) {
        distance = halfway - (distance - halfway);
      }
    }
    x += distance * Math.cos(projectile.angle);
    y += distance * Math.sin(projectile.angle);
    if (definition.amplitude !== 0) {
      const deflection = definition.amplitude * Math.sin(
        phase + elapsed / trajectoryLifetime * definition.frequency * 2 * Math.PI,
      );
      x += deflection * Math.cos(projectile.angle + Math.PI / 2);
      y += deflection * Math.sin(projectile.angle + Math.PI / 2);
    }
  }
  out.x = x;
  out.y = y;
  return out;
}
