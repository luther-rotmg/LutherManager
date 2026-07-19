/** Map classification helpers and low-level map snapshots (`Luther.world`). */
export class World {
    static isNexus(): boolean {
        throw new Error('Must be run inside LutherManager client');
    }

    static isRealm(): boolean {
        throw new Error('Must be run inside LutherManager client');
    }

    static isDungeon(): boolean {
        throw new Error('Must be run inside LutherManager client');
    }

    static isVault(): boolean {
        throw new Error('Must be run inside LutherManager client');
    }

    static isPetYard(): boolean {
        throw new Error('Must be run inside LutherManager client');
    }

    static getServerHost(): string {
        throw new Error('Must be run inside LutherManager client');
    }

    static getRealmPortals(): Array<{ objectId: number; name: string; players: number; maxPlayers: number; x: number; y: number }> {
        throw new Error('Must be run inside LutherManager client');
    }

    /**
     * Low-level visible-object snapshot retained for compatibility.
     * Prefer `Luther.world.objects` for categorized and typed object queries.
     */
    static getVisibleObjects(): Array<{ objectId: number; type: number; x: number; y: number; name?: string }> {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Low-level tile snapshot; prefer `Luther.world.tiles` for tile queries. */
    static getVisibleTiles(): Array<{ x: number; y: number; type: number }> {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Low-level tile lookup; prefer `Luther.world.tiles.getAt()`. */
    static getTile(_x: number, _y: number): { x: number; y: number; type: number } | undefined {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Low-level object lookup; prefer `Luther.world.objects.getById()`. */
    static getObject(_objectId: number): { objectId: number; type: number; x: number; y: number; name?: string } | undefined {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Low-level object lookup; prefer `Luther.world.objects.getNearest()`. */
    static getNearestObject(): { objectId: number; type: number; x: number; y: number; name?: string } | undefined {
        throw new Error('Must be run inside LutherManager client');
    }

    static getName(): string {
        throw new Error('Must be run inside LutherManager client');
    }

    /** Current map dimensions in tiles. */
    static getDimensions(): { width: number; height: number } {
        throw new Error('Must be run inside LutherManager client');
    }
}
