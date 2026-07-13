import { VaultItem } from '../types/items/VaultItem';

export class VaultChest {
    constructor(public readonly index: number) {}

    getItems(): (VaultItem | null)[] {
        throw new Error('Must be run inside Hive client');
    }

    /** Move an item from this vault chest into the local player's inventory. */
    withdraw(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Move an item from the local player's inventory into this vault chest. */
    deposit(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    contains(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    getFreeSlots(): number {
        throw new Error('Must be run inside Hive client');
    }

    isFull(): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
