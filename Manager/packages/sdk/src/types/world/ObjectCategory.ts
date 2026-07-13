/**
 * High-level bucket every world object falls into, as classified by the
 * client's game-data loader. Use with `Objects.getByCategory(...)` and
 * `Objects.getCategory(...)` when you want to treat entities generically.
 */
export type ObjectCategory =
    | 'Portal'
    | 'Beacon'
    | 'VisualOnly'
    | 'Pet'
    | 'Player'
    | 'Projectile'
    | 'Container'
    | 'Enemy'
    | 'Other';
