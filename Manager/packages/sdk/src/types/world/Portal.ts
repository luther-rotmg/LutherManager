import { Position } from './Position';

export interface Portal {
    objectId: number;
    name: string;
    position: Position;
    isOpen: boolean;
    playerCount: number;
    enter(): boolean;
}
