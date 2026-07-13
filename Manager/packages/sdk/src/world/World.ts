export class World {
    static isNexus(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isRealm(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isDungeon(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isVault(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static isPetYard(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getServerHost(): string {
        throw new Error('Must be run inside Hive client');
    }

    static getRealmPortals(): Array<{ objectId: number; name: string; players: number; maxPlayers: number; x: number; y: number }> {
        throw new Error('Must be run inside Hive client');
    }

    static getVisibleObjects(): Array<{ objectId: number; type: number; x: number; y: number; name?: string }> {
        throw new Error('Must be run inside Hive client');
    }

    static getVisibleTiles(): Array<{ x: number; y: number; type: number }> {
        throw new Error('Must be run inside Hive client');
    }

    static getTile(_x: number, _y: number): { x: number; y: number; type: number } | undefined {
        throw new Error('Must be run inside Hive client');
    }

    static getObject(_objectId: number): { objectId: number; type: number; x: number; y: number; name?: string } | undefined {
        throw new Error('Must be run inside Hive client');
    }

    static getNearestObject(): { objectId: number; type: number; x: number; y: number; name?: string } | undefined {
        throw new Error('Must be run inside Hive client');
    }

    static getName(): string {
        throw new Error('Must be run inside Hive client');
    }
}
