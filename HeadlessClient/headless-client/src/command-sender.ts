import {
  ConditionEffectBits,
  ConditionEffectBits2,
  InvSwapPacket,
  Packet,
  PlayerData,
  PlayerShootPacket,
  PlayerTextPacket,
  TeleportPacket,
  UsePortalPacket,
  UseItemPacket,
} from 'realmlib';
import { CONSUMABLE_SLOT_IDS, isConsumableSlot, makeSlot, type SlotRef } from './inventory';

export type { SlotRef } from './inventory';

/** Weapon firing data used to pace and shape PLAYERSHOOT volleys. */
export interface WeaponFireInfo {
  rateOfFire: number;
  numProjectiles: number;
  /** Arc gap between projectiles, in degrees. */
  arcGap: number;
  subattacks?: readonly WeaponSubattackInfo[];
}

export interface WeaponFirePatternInfo {
  projectileId: number;
  patternIndex: number;
  numProjectiles: number;
  arcGap: number;
  defaultAngle: number;
  posOffsetX: number;
  posOffsetY: number;
}

export interface WeaponSubattackInfo {
  rateOfFire: number;
  isDummy: boolean;
  defaultAngleIncrease: number;
  minIncrAngleCounter: number;
  maxIncrAngleCounter: number;
  patterns: readonly WeaponFirePatternInfo[];
}

/** Exact geometry of one projectile in the next weapon volley. */
export interface WeaponAimPreview {
  projectileId: number;
  bulletId: number;
  /** Projectile angle relative to the base aim angle, in radians. */
  angleOffset: number;
  /** Forward offset of PLAYERSHOOT.startingPos from the player. */
  spawnDistance: number;
  /** Leftward offset of PLAYERSHOOT.startingPos from the player. */
  spawnOffsetX: number;
}

export interface AbilityUseInfo {
  usable: boolean;
  mpCost: number;
  cooldownMs: number;
  activateEffects: readonly string[];
}

interface CommandState {
  io: PacketSink | undefined;
  time: number;
  pos: { x: number; y: number };
  objectId: number;
  player: PlayerData | undefined;
  peekBulletId(): number;
  nextBulletId(): number;
  /** Firing data for a weapon item type (defaults when game data is absent). */
  weapon(weaponType: number): WeaponFireInfo;
  ability(abilityType: number): AbilityUseInfo;
  /** Registers a sent shot with the combat simulation so its hit resolves. */
  trackShot(packet: PlayerShootPacket, projectileId: number): void;
}

/** Projectiles spawn this far ahead of the player, like the game client. */
const SHOT_SPAWN_OFFSET = 0.3;

export interface PacketSink {
  send(packet: Packet): void;
}

/** Builds and sends outgoing gameplay packets from the current client state. */
export class CommandSender {
  constructor(private readonly state: () => CommandState) {}

  /** Resets firing cadence and pattern state when a new player/map is loaded. */
  resetMap(): void {
    this.attackStart = -Infinity;
    this.subattackStates.clear();
    this.nextAbilityAt = -Infinity;
  }

  send(packet: Packet): void {
    this.state().io?.send(packet);
  }

  say(message: string): void {
    const packet = new PlayerTextPacket();
    packet.text = message;
    this.send(packet);
  }

  usePortal(objectId: number): void {
    const use = new UsePortalPacket();
    use.objectId = objectId;
    this.send(use);
  }

  teleportTo(objectId: number): boolean {
    const state = this.state();
    if (!state.io || state.objectId === -1 || !Number.isInteger(objectId) || objectId <= 0) {
      return false;
    }
    const packet = new TeleportPacket();
    packet.objectId = objectId;
    state.io.send(packet);
    return true;
  }

  swapInventorySlots(fromSlotId: number, toSlotId: number): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) {
      return false;
    }
    const packet = new InvSwapPacket();
    packet.time = state.time;
    packet.position.x = state.pos.x;
    packet.position.y = state.pos.y;
    packet.slotObject1 = makeSlot({
      objectId: state.objectId,
      slotId: fromSlotId,
      itemType: state.player.inventory?.[fromSlotId] ?? -1,
    });
    packet.slotObject2 = makeSlot({
      objectId: state.objectId,
      slotId: toSlotId,
      itemType: state.player.inventory?.[toSlotId] ?? -1,
    });
    state.io.send(packet);
    return true;
  }

  invSwap(from: SlotRef, to: SlotRef): boolean {
    const state = this.state();
    if (state.objectId === -1 || !state.io) {
      return false;
    }
    const packet = new InvSwapPacket();
    packet.time = state.time;
    packet.position.x = state.pos.x;
    packet.position.y = state.pos.y;
    packet.slotObject1 = makeSlot(from);
    packet.slotObject2 = makeSlot(to);
    state.io.send(packet);
    return true;
  }

  /**
   * Swaps the consumable item in the player's inventory slot `fromSlotId` into
   * a consumable-belt slot (`1000000`, `1000001`, or `1000003`) via an INVSWAP.
   * Returns false if not in-world, the destination isn't a valid consumable
   * slot, or the source slot is empty.
   */
  swapToConsumable(fromSlotId: number, consumableSlotId: number): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) {
      return false;
    }
    if (!isConsumableSlot(consumableSlotId)) {
      console.warn(`invalid consumable slot ${consumableSlotId} (valid: ${CONSUMABLE_SLOT_IDS.join(', ')})`);
      return false;
    }
    const itemType = state.player.inventory?.[fromSlotId] ?? -1;
    if (itemType === -1) {
      return false; // nothing in the source slot to move
    }
    return this.invSwap(
      { objectId: state.objectId, slotId: fromSlotId, itemType },
      { objectId: state.objectId, slotId: consumableSlotId, itemType: -1 },
    );
  }

  /**
   * Describes the projectile nearest the base aim line in the next accepted
   * volley. This mirrors shootAt's pattern/counter logic without advancing it.
   */
  previewWeaponAim(weaponSlot = 0): WeaponAimPreview | null {
    const state = this.state();
    if (!state.player || state.objectId === -1) return null;
    const weaponType = state.player.inventory?.[weaponSlot] ?? -1;
    if (weaponType === -1) return null;
    const info = state.weapon(weaponType);
    const subattacks = normalizeSubattacks(info);
    const fastestRate = subattacks.reduce(
      (fastest, subattack) => Math.max(fastest, validRate(subattack.rateOfFire)),
      validRate(info.rateOfFire),
    );
    if (state.time < this.attackStart) {
      this.attackStart = -Infinity;
      this.subattackStates.clear();
    }

    const nextVolleyAt = Math.max(
      state.time,
      this.attackStart + this.attackPeriod(state.player, fastestRate),
    );
    const fireStates = this.fireStates(weaponType, subattacks.length);
    let bulletId = normalizeBulletId(state.peekBulletId());
    let best: WeaponAimPreview | null = null;
    let bestOffset = Infinity;

    for (let attackIndex = 0; attackIndex < subattacks.length; attackIndex++) {
      const subattack = subattacks[attackIndex]!;
      const fireState = fireStates[attackIndex]!;
      const lastFire = state.time < fireState.lastFire ? -Infinity : fireState.lastFire;
      const subattackPeriod = Math.max(0, this.attackPeriod(state.player, subattack.rateOfFire) - 2);
      if (nextVolleyAt < lastFire + subattackPeriod) continue;

      const pattern = subattack.patterns[fireState.patternIndex % subattack.patterns.length]!;
      const count = positiveInteger(pattern.numProjectiles, 1);
      const arcGap = finiteNumber(pattern.arcGap, 11.25) * Math.PI / 180;
      const defaultAngle = finiteNumber(pattern.defaultAngle, 0) * Math.PI / 180;
      const angleIncrease = finiteNumber(subattack.defaultAngleIncrease, 0) * Math.PI / 180
        * fireState.incrCounter;
      const startOffset = -arcGap * (count - 1) / 2 + defaultAngle + angleIncrease;
      for (let projectileIndex = 0; projectileIndex < count; projectileIndex++) {
        const angleOffset = startOffset + projectileIndex * arcGap;
        const absoluteOffset = Math.abs(boundAngle(angleOffset));
        if (absoluteOffset < bestOffset) {
          bestOffset = absoluteOffset;
          best = {
            projectileId: pattern.projectileId,
            bulletId,
            angleOffset,
            spawnDistance: SHOT_SPAWN_OFFSET + finiteNumber(pattern.posOffsetY, 0),
            spawnOffsetX: finiteNumber(pattern.posOffsetX, 0),
          };
        }
        bulletId = (bulletId + 1) % 128;
      }
    }
    return best;
  }

  shootAt(target: { x: number; y: number }, weaponSlot = 0): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) {
      return false;
    }
    if (![state.pos.x, state.pos.y, target.x, target.y].every(Number.isFinite)) {
      return false;
    }
    if ((state.player.condition & ConditionEffectBits.STUNNED) !== 0
      || (state.player.condition2 & ConditionEffectBits2.PETRIFIED) !== 0) {
      return false;
    }
    const weaponType = state.player.inventory?.[weaponSlot] ?? -1;
    if (weaponType === -1) {
      return false;
    }
    const info = state.weapon(weaponType);
    const subattacks = normalizeSubattacks(info);
    const fastestRate = subattacks.reduce(
      (fastest, subattack) => Math.max(fastest, validRate(subattack.rateOfFire)),
      validRate(info.rateOfFire),
    );
    if (state.time < this.attackStart) {
      // The client clock restarted (reconnect); drop the stale cooldown.
      this.attackStart = -Infinity;
      this.subattackStates.clear();
    }
    if (state.time < this.attackStart + this.attackPeriod(state.player, fastestRate)) {
      return false;
    }
    this.attackStart = state.time;

    const aimAngle = (state.player.condition & ConditionEffectBits.UNSTABLE) !== 0
      ? Math.random() * Math.PI * 2
      : Math.atan2(target.y - state.pos.y, target.x - state.pos.x);
    const fireStates = this.fireStates(weaponType, subattacks.length);
    let sent = false;
    for (let attackIndex = 0; attackIndex < subattacks.length; attackIndex++) {
      const subattack = subattacks[attackIndex]!;
      const fireState = fireStates[attackIndex]!;
      if (state.time < fireState.lastFire) {
        fireState.lastFire = -Infinity;
      }
      const subattackPeriod = Math.max(0, this.attackPeriod(state.player, subattack.rateOfFire) - 2);
      if (state.time < fireState.lastFire + subattackPeriod) {
        continue;
      }
      fireState.lastFire = state.time;

      const pattern = subattack.patterns[fireState.patternIndex % subattack.patterns.length]!;
      fireState.patternIndex = (fireState.patternIndex + 1) % subattack.patterns.length;
      const count = positiveInteger(pattern.numProjectiles, 1);
      const arcGap = finiteNumber(pattern.arcGap, 11.25) * Math.PI / 180;
      const defaultAngle = finiteNumber(pattern.defaultAngle, 0) * Math.PI / 180;
      const offsetX = finiteNumber(pattern.posOffsetX, 0);
      const spawnDistance = SHOT_SPAWN_OFFSET + finiteNumber(pattern.posOffsetY, 0);
      const cos = Math.cos(aimAngle);
      const sin = Math.sin(aimAngle);
      const spawnX = state.pos.x + spawnDistance * cos - offsetX * sin;
      const spawnY = state.pos.y + spawnDistance * sin + offsetX * cos;
      let angleIncrease = 0;
      const angleIncrement = finiteNumber(subattack.defaultAngleIncrease, 0);
      if (angleIncrement !== 0) {
        angleIncrease = angleIncrement * Math.PI / 180 * fireState.incrCounter;
        fireState.incrCounter += fireState.incrDirection;
        const minCounter = Math.trunc(finiteNumber(subattack.minIncrAngleCounter, 0));
        const maxCounter = Math.trunc(finiteNumber(subattack.maxIncrAngleCounter, 0));
        if (fireState.incrCounter > maxCounter || fireState.incrCounter < minCounter) {
          fireState.incrDirection *= -1;
        }
      }
      let angle = aimAngle - arcGap * (count - 1) / 2 + defaultAngle + angleIncrease;

      for (let projectileIndex = 0; projectileIndex < count; projectileIndex++) {
        const shot = new PlayerShootPacket();
        shot.time = state.time;
        shot.bulletId = state.nextBulletId();
        shot.containerType = weaponType;
        shot.attackIndex = subattack.isDummy ? -1 : attackIndex;
        shot.startingPos.x = spawnX;
        shot.startingPos.y = spawnY;
        shot.angle = angle;
        shot.attackType = 0;
        shot.patternIndex = pattern.patternIndex;
        shot.burstIndex = 0;
        shot.playerPos.x = state.pos.x;
        shot.playerPos.y = state.pos.y;
        state.io.send(shot);
        state.trackShot(shot, pattern.projectileId);
        angle += arcGap;
        sent = true;
      }
    }
    return sent;
  }

  /** Sends USEITEM for the equipped ability slot after client-side safety checks. */
  useAbilityAt(target: { x: number; y: number }, abilitySlot = 1): boolean {
    const state = this.state();
    if (!state.player || state.objectId === -1 || !state.io) return false;
    const abilityType = state.player.inventory?.[abilitySlot] ?? -1;
    if (abilityType < 0) return false;
    const info = state.ability(abilityType);
    if (!info.usable || (state.player.mp ?? 0) < info.mpCost) return false;
    if ((state.player.condition & ConditionEffectBits.QUIET) !== 0) return false;
    if ((state.player.condition2 & ConditionEffectBits2.SILENCED) !== 0) return false;
    const shoots = info.activateEffects.some((effect) => effect.toLowerCase() === 'shoot');
    if (shoots && (state.player.condition & ConditionEffectBits.STUNNED) !== 0) return false;
    if (state.time < this.nextAbilityAt - Math.max(0, info.cooldownMs)) {
      // The client clock restarted after reconnect; discard the old cooldown.
      this.nextAbilityAt = -Infinity;
    }
    if (state.time < this.nextAbilityAt) return false;

    const packet = new UseItemPacket();
    packet.time = state.time;
    packet.slotObject = makeSlot({ objectId: state.objectId, slotId: abilitySlot, itemType: abilityType });
    packet.itemUsePos.x = target.x;
    packet.itemUsePos.y = target.y;
    packet.useType = 1;
    packet.useItemFlag = 0;
    state.io.send(packet);
    this.nextAbilityAt = state.time + Math.max(0, info.cooldownMs);
    return true;
  }

  /** Client time of the last accepted shot; paces PLAYERSHOOT volleys. */
  private attackStart = -Infinity;
  private readonly subattackStates = new Map<number, SubattackFireState[]>();
  private nextAbilityAt = -Infinity;

  private fireStates(weaponType: number, count: number): SubattackFireState[] {
    let states = this.subattackStates.get(weaponType);
    if (!states || states.length !== count) {
      states = Array.from({ length: count }, () => ({
        lastFire: -Infinity,
        patternIndex: 0,
        incrCounter: 0,
        incrDirection: 1,
      }));
      this.subattackStates.set(weaponType, states);
    }
    return states;
  }

  /**
   * Milliseconds between volleys, from the game client's formula:
   * `1 / attackFrequency(dex) / RateOfFire`. Firing faster than this is a
   * shot-flood protocol violation the server kicks for (FAILURE errorId=0).
   */
  private attackPeriod(player: PlayerData, rateOfFire: number): number {
    const dazed = (player.condition & ConditionEffectBits.DAZED) !== 0;
    const rawDex = player.dex ?? 0;
    const dex = dazed || !Number.isFinite(rawDex) ? 0 : Math.max(0, rawDex);
    let frequency = 0.0015 + (dex / 75) * 0.0065;
    if (!dazed && (player.condition & ConditionEffectBits.BERSERK) !== 0) {
      frequency *= 1.25;
    }
    return 1 / frequency / validRate(rateOfFire);
  }
}

interface SubattackFireState {
  lastFire: number;
  patternIndex: number;
  incrCounter: number;
  incrDirection: number;
}

function normalizeSubattacks(info: WeaponFireInfo): readonly WeaponSubattackInfo[] {
  const modern = info.subattacks?.filter((subattack) => subattack.patterns.length > 0) ?? [];
  if (modern.length > 0) {
    return modern;
  }
  return [{
    rateOfFire: validRate(info.rateOfFire),
    isDummy: true,
    defaultAngleIncrease: 0,
    minIncrAngleCounter: 0,
    maxIncrAngleCounter: 0,
    patterns: [{
      projectileId: 0,
      patternIndex: -1,
      numProjectiles: positiveInteger(info.numProjectiles, 1),
      arcGap: finiteNumber(info.arcGap, 11.25),
      defaultAngle: 0,
      posOffsetX: 0,
      posOffsetY: 0,
    }],
  }];
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.trunc(value)) : fallback;
}

function validRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizeBulletId(value: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : 0;
  return ((integer % 128) + 128) % 128;
}

function boundAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}
