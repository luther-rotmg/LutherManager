import { Item } from './Item';

export interface VaultItem extends Item {
    slotIndex: number;
    chestIndex: number;
}
