export interface AutoNexusConfig {
  enabled: boolean;
  thresholdPercent: number;
}

export type AutoNexusTriggerSource = 'server' | 'projectile' | 'aoe' | 'ground';

export interface AutoNexusState extends AutoNexusConfig {
  serverHp: number | null;
  predictedHp: number | null;
  syncedHp: number | null;
  maxHp: number | null;
  safeMap: boolean;
  triggered: boolean;
  lastTriggerAt: number | null;
  lastTriggerSource: AutoNexusTriggerSource | null;
}

export interface AutoNexusTrigger {
  source: AutoNexusTriggerSource;
  hp: number;
  maxHp: number;
  thresholdHp: number;
  thresholdPercent: number;
}

export interface AutoNexusDamageOptions {
  baseDamage: number;
  defense: number;
  armorPiercing?: boolean;
  armorBroken?: boolean;
  armored?: boolean;
  invincible?: boolean;
  invulnerable?: boolean;
  exposed?: boolean;
  petrified?: boolean;
  cursed?: boolean;
}

const DEFAULT_THRESHOLD_PERCENT = 5;

const AUTO_NEXUS_SAFE_MAPS = new Set([
  'nexus',
  'vault',
  'guild hall',
  'guild hall 1',
  'guild hall 2',
  'guild hall 3',
  'guild hall 4',
  'guild hall 5',
  'cloth bazaar',
  'nexus explanation',
  'daily quest room',
  'daily login room',
  'pet yard',
  'pet yard 1',
  'pet yard 2',
  'pet yard 3',
  'pet yard 4',
  'pet yard 5',
]);

/** Maps where ProdMafia suppresses autonexus health checks. */
export function isAutoNexusSafeMap(mapName: string): boolean {
  return AUTO_NEXUS_SAFE_MAPS.has(String(mapName ?? '').trim().toLowerCase());
}

/** RotMG player-damage formula used by ProdMafia's local HP prediction. */
export function calculateAutoNexusDamage(options: AutoNexusDamageOptions): number {
  if (options.invincible || options.invulnerable) return 0;
  const baseDamage = Math.max(0, Math.trunc(Number(options.baseDamage) || 0));
  let defense = Math.max(0, Math.trunc(Number(options.defense) || 0));
  if (options.armorPiercing || options.armorBroken) defense = 0;
  else if (options.armored) defense = Math.trunc(defense * 1.5);
  if (options.exposed) defense -= 20;
  let damage = Math.max(baseDamage - defense, Math.trunc(baseDamage * 3 / 20));
  if (options.petrified) damage = Math.trunc(damage * 0.9);
  if (options.cursed) damage = Math.trunc(damage * 1.25);
  return damage;
}

/**
 * Maintains authoritative and predicted HP and latches a single emergency
 * trigger per dangerous map. Positive server deltas reconcile predicted HP;
 * negative deltas never erase locally predicted damage.
 */
export class AutoNexusMonitor {
  private enabled = false;
  private thresholdPercent = DEFAULT_THRESHOLD_PERCENT;
  private serverHp: number | null = null;
  private predictedHp: number | null = null;
  private syncedHp: number | null = null;
  private maxHp: number | null = null;
  private safeMap = true;
  private triggered = false;
  private lastTriggerAt: number | null = null;
  private lastTriggerSource: AutoNexusTriggerSource | null = null;

  constructor(private readonly onTrigger: (trigger: AutoNexusTrigger) => void) {}

  configure(options: Partial<AutoNexusConfig>): void {
    if (options.thresholdPercent !== undefined) this.setThreshold(options.thresholdPercent);
    if (options.enabled !== undefined) this.setEnabled(options.enabled);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = !!enabled;
    if (!this.enabled) this.triggered = false;
    else this.check('server');
  }

  setThreshold(thresholdPercent: number): void {
    const value = Number(thresholdPercent);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      throw new RangeError('Autonexus threshold must be between 1 and 100 percent.');
    }
    this.thresholdPercent = value;
    this.check('server');
  }

  setSafeMap(safeMap: boolean): void {
    this.safeMap = !!safeMap;
    if (this.safeMap) this.triggered = false;
    else this.check('server');
  }

  reset(serverHp?: number, maxHp?: number): void {
    this.serverHp = validHp(serverHp);
    this.predictedHp = this.serverHp;
    this.syncedHp = this.serverHp;
    this.maxHp = validMaxHp(maxHp);
    this.triggered = false;
  }

  reconcileServerHp(serverHp: number, maxHp: number, full = false): boolean {
    const nextMax = validMaxHp(maxHp);
    const nextServer = validHp(serverHp);
    if (nextMax === null || nextServer === null) return false;

    if (full || this.syncedHp === null || this.predictedHp === null) {
      this.serverHp = Math.min(nextServer, nextMax);
      this.predictedHp = this.serverHp;
      this.syncedHp = this.serverHp;
      this.maxHp = nextMax;
      return this.check('server');
    }

    const serverDelta = nextServer - this.syncedHp;
    this.maxHp = nextMax;
    this.serverHp = Math.min(nextServer, nextMax);
    if (serverDelta > 0) this.predictedHp += serverDelta;
    this.predictedHp = Math.min(this.predictedHp, this.serverHp, nextMax);
    this.syncedHp = this.serverHp;
    return this.check('server');
  }

  applyDamage(amount: number, source: AutoNexusTriggerSource): boolean {
    if (this.predictedHp === null) return false;
    const damage = Math.max(0, Math.trunc(Number(amount) || 0));
    if (damage <= 0) return false;
    this.predictedHp -= damage;
    return this.check(source);
  }

  getState(): AutoNexusState {
    return {
      enabled: this.enabled,
      thresholdPercent: this.thresholdPercent,
      serverHp: this.serverHp,
      predictedHp: this.predictedHp,
      syncedHp: this.syncedHp,
      maxHp: this.maxHp,
      safeMap: this.safeMap,
      triggered: this.triggered,
      lastTriggerAt: this.lastTriggerAt,
      lastTriggerSource: this.lastTriggerSource,
    };
  }

  private check(source: AutoNexusTriggerSource): boolean {
    if (!this.enabled || this.safeMap || this.triggered || this.maxHp === null) return false;
    const hpValues = [this.serverHp, this.predictedHp, this.syncedHp]
      .filter((hp): hp is number => hp !== null);
    if (hpValues.length === 0) return false;
    const hp = Math.min(...hpValues);
    const thresholdHp = this.maxHp * this.thresholdPercent * 0.01;
    if (hp > thresholdHp) return false;

    this.triggered = true;
    this.lastTriggerAt = Date.now();
    this.lastTriggerSource = source;
    this.onTrigger({
      source,
      hp,
      maxHp: this.maxHp,
      thresholdHp,
      thresholdPercent: this.thresholdPercent,
    });
    return true;
  }
}

function validHp(value: unknown): number | null {
  const hp = Number(value);
  return Number.isFinite(hp) && hp >= 0 ? hp : null;
}

function validMaxHp(value: unknown): number | null {
  const hp = Number(value);
  return Number.isFinite(hp) && hp > 0 ? hp : null;
}
