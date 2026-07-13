import { GameObject } from './GameObject';

/**
 * A world container instance — anything the game classifies as a `Container`
 * (loot bags of every rarity, vault chests, gift chests, and other
 * pickup-able stashes).
 *
 * Returned by `Objects.getContainers()`, `Objects.getNearestContainer()`,
 * and `Objects.findContainer(name)`.
 */
export interface Container extends GameObject {
    /**
     * Lowercase bag rarity token when the game-data loader can infer one
     * from the object id (e.g. `'white'`, `'cyan'`, `'purple'`, `'orange'`,
     * `'pink'`, `'brown'`). Undefined for non-bag containers (chests, etc.).
     */
    rarity?: string;
}
