/**
 * Tile query filters (from tiles.xml semantics). Host matching is case-insensitive;
 * common synonyms (e.g. `Condition` for `ConditionEffect`) are accepted by the client.
 */
export type TileCondition =
    | 'Damaging'
    | 'ConditionEffect'
    | 'Slowing'
    | 'Speedy'
    | 'SpeedModified'
    | 'Blocking'
    | 'Sink'
    | 'Push'
    | 'Sliding';
