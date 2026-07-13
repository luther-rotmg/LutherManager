/**
 * Legacy class-style inventory API retained for existing direct imports.
 *
 * @deprecated Use `Hive.inventory` (or the exported `inventory` object), which
 * returns structured inventory data and contains the current transfer helpers.
 */
export class Inventory {
    /**
     * One entry per occupied slot (0–11 main, 12–27 backpack), ascending by slot.
     * Each string is `<objectType>; <slot>` (e.g. `"2012; 1"`). Join with `\\n` for line-per-slot text.
     */
    static getAll(): string[] {
        throw new Error('Must be run inside Hive client');
    }

    static contains(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getCount(name: string): number {
        throw new Error('Must be run inside Hive client');
    }

    static getFreeSlots(): number {
        throw new Error('Must be run inside Hive client');
    }

    static isFull(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static use(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static useBySlot(slotIndex: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static drop(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
