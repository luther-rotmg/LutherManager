import { Item } from '../types/items/Item';

export class GiftChest {
    static getItems(): Item[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Claim a single gift-chest item into the local player's inventory. */
    static withdraw(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Claim all gift-chest items into the local player's inventory. */
    static withdrawAll(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static contains(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
