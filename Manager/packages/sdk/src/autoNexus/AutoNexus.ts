export interface AutoNexusOptions {
    enabled: boolean;
    /** HP percentage from 1 through 100. */
    thresholdPercent: number;
}

export type AutoNexusTriggerSource = 'server' | 'projectile' | 'aoe' | 'ground' | 'condition';

export interface AutoNexusState extends AutoNexusOptions {
    serverHp: number | null;
    predictedHp: number | null;
    syncedHp: number | null;
    maxHp: number | null;
    safeMap: boolean;
    triggered: boolean;
    lastTriggerAt: number | null;
    lastTriggerSource: AutoNexusTriggerSource | null;
}

/**
 * Automatic emergency return to Nexus.
 *
 * The runtime checks authoritative HP and locally predicted damage. When any
 * tracked HP value reaches the configured percentage, it drops the dangerous
 * map connection and immediately reconnects to Nexus. It is enabled by default
 * at 20%; scripts can adjust or disable it explicitly.
 */
export class AutoNexus {
    /** Enables autonexus. Passing a percentage also updates the threshold. */
    static enable(_thresholdPercent?: number): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static disable(): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static setEnabled(_enabled: boolean): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static isEnabled(): boolean {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Sets the trigger percentage. Valid values are 1 through 100. */
    static setThreshold(_thresholdPercent: number): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static getThreshold(): number {
        throw new Error('Must be run inside LutherManager client');
    }

    static configure(_options: Partial<AutoNexusOptions>): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static getState(): AutoNexusState {
        throw new Error('Must be run inside LutherManager client');
    }
}
