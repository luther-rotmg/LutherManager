import { Position } from '../types/world/Position';
import { Enemy } from '../types/entities/Enemy';

export type CombatAimTarget = number | { objectId: number };
export type AutoAimMode = 'closest' | 'maxHp' | 'lowestHp' | 'random';

export interface AutoAimOptions {
    mode?: AutoAimMode;
    /** Maximum range in tiles. Zero derives it from the equipped weapon. */
    range?: number;
    bossPriority?: boolean;
    leadTargets?: boolean;
    includeInvulnerable?: boolean;
    weaponSlot?: number;
}

export interface AutoAbilityOptions {
    /** Minimum current MP percentage (0-100). */
    minMpPercent?: number;
    minTargetHp?: number;
    minTargets?: number;
    /** Maximum range in tiles. Zero derives it from the ability projectile. */
    range?: number;
    /** Additional minimum cooldown; item cooldowns are always respected. */
    cooldownMs?: number;
    /** Teleporting abilities are excluded by default. */
    allowTeleport?: boolean;
}

export interface CombatAutomationState {
    autoAimEnabled: boolean;
    autoAbilityEnabled: boolean;
    mode: AutoAimMode;
    targetObjectId: number | null;
    fixedPosition: { x: number; y: number } | null;
    autoAim: Required<AutoAimOptions>;
    autoAbility: Required<AutoAbilityOptions>;
}

export class Combat {
    static shootAt(x: number, y: number, weaponSlot = 0): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Auto-aim weapon shots at a tracked object id until stopped or changed. */
    static aimAt(target: CombatAimTarget): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Aim at a tile; pass world **X** and **Y** as two numbers (same units as `Walking.walkTo`). */
    static aimAtPosition(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static stopAiming(): void {
        throw new Error('Must be run inside Hive client');
    }

    /** Select and fire at visible enemies until disabled. */
    static enableAutoAim(options?: AutoAimOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Update automatic target selection without changing its enabled state. */
    static setAutoAim(options: AutoAimMode | AutoAimOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static disableAutoAim(): void {
        throw new Error('Must be run inside Hive client');
    }

    /** Disable SDK auto-aim and leave weapon shots at the player's manual aim angle. */
    static autoAimOff(): void {
        throw new Error('Must be run inside Hive client');
    }

    static getAutoAimTarget(): number | null {
        throw new Error('Must be run inside Hive client');
    }

    static getAutomationState(): CombatAutomationState | null {
        throw new Error('Must be run inside Hive client');
    }

    static useAbility(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Use ability toward a tile; **x** and **y** are world coordinates as numbers. */
    static useAbilityAt(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static useAbilityOn(enemy: Enemy): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Automatically use the equipped ability during combat. */
    static enableAutoAbility(options?: AutoAbilityOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static setAutoAbility(options: AutoAbilityOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static disableAutoAbility(): void {
        throw new Error('Must be run inside Hive client');
    }

    /** Allow locally fired projectiles to pass through cover objects. */
    static enableProjectileNoclip(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static disableProjectileNoclip(): void {
        throw new Error('Must be run inside Hive client');
    }

    static isProjectileNoclipEnabled(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Shot accuracy since tracking began (or since the last reset).
     * Returns a 0–1 fraction (multiply by 100 for a percentage).
     * Returns 0 if no shots have been fired.
     */
    static accuracy(): number {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Shot accuracy over the last `minutes` minutes.
     * Returns a 0–1 fraction. Returns 0 if no shots in the window.
     */
    static recentAccuracy(minutes: number): number {
        throw new Error('Must be run inside Hive client');
    }

    /** Reset the accuracy counters. */
    static resetAccuracy(): void {
        throw new Error('Must be run inside Hive client');
    }
}
