import { PlayerEntity } from '../types/entities/PlayerEntity';

/** How {@link Players.getPlayerGuild} (and similar lookups) match display names. */
export type PlayerNameMatchMode = 'equals' | 'contains';

/**
 * Tracked player-like entities on the current map (`Luther.players`).
 * Wired in the client: names, positions, and vitals from world state status.
 */
export class Players {
    static getAll(): PlayerEntity[] {
        throw new Error('Must be run inside LutherManager client');
    }

    static getNearest(): PlayerEntity | null {
        throw new Error('Must be run inside LutherManager client');
    }

    static find(name: string): PlayerEntity | null {
        throw new Error('Must be run inside LutherManager client');
    }

    static getHP(name: string): number {
        throw new Error('Must be run inside LutherManager client');
    }

    static getMaxHP(name: string): number {
        throw new Error('Must be run inside LutherManager client');
    }

    static getHPPercent(name: string): number {
        throw new Error('Must be run inside LutherManager client');
    }

    static getMP(name: string): number {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Account fame for a player (stat **39**, same meaning as `Luther.self.getAccountFame`). */
    static getAccountFame(name: string): number {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Alive character fame for a player (stat **57**, same meaning as `Luther.self.getCharacterFame`). */
    static getCharacterFame(name: string): number {
        throw new Error('Must be run inside LutherManager client');
    }

    static count(): number {
        throw new Error('Must be run inside LutherManager client');
    }

    /**
     * Guild name string (stat **62**) for a player matched by display name.
     * Empty string if no match or guild unknown.
     */
    static getPlayerGuild(_name: string, _match: PlayerNameMatchMode = 'equals'): string {
        void _name;
        void _match;
        throw new Error('Must be run inside LutherManager client');
    }

    /**
     * Distinct guild names (stat **62**) for every tracked player on the current map
     * (same pool as {@link Players.getAll}), sorted alphabetically. Omits empty / unknown.
     */
    static getNearbyGuilds(): string[] {
        throw new Error('Must be run inside LutherManager client');
    }
}
