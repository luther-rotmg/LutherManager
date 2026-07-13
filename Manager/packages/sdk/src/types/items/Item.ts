export interface Item {
    id: number;
    name: string;
    tier: string;
    slotType: 'weapon' | 'ability' | 'armor' | 'ring' | 'consumable' | 'material';
    feedPower: number;
    bagType: number;
    soulbound: boolean;
    tradeable: boolean;
}
