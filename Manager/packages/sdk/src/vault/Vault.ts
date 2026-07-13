import { VaultChest } from './VaultChest';
import { GiftChest } from './GiftChest';
import { Item } from '../types/items/Item';

/**
 * Legacy class-style vault API retained for existing scripts.
 *
 * @deprecated Use the vault storage and transfer methods on `Hive.inventory`.
 */
export const Vault = {
    giftChest: GiftChest,

    get(index: number): VaultChest {
        throw new Error('Must be run inside Hive client');
    },

    vaultChest: {
        get(index: number): VaultChest {
            throw new Error('Must be run inside Hive client');
        },

        findChestWith(itemName: string): VaultChest | null {
            throw new Error('Must be run inside Hive client');
        },

        getAll(): VaultChest[] {
            throw new Error('Must be run inside Hive client');
        },
    },

    findItem(name: string): Item | null {
        throw new Error('Must be run inside Hive client');
    },

    getAllItems(): Item[] {
        throw new Error('Must be run inside Hive client');
    },
};
