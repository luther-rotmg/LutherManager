import { Position } from '../types/world/Position';
import { Enemy } from '../types/entities/Enemy';

export type DodgeMovementIntentMode = 'goal' | 'combat_range';
export type DodgeMovementIntentId = string | number;
export type DodgeSafetyState = 'normal' | 'evasive' | 'recovering';
export type DodgeReplanCause =
    | 'initial'
    | 'new_threat'
    | 'unsafe'
    | 'intent_changed'
    | 'route_changed'
    | 'drift'
    | 'expired'
    | 'better_plan'
    | 'correction'
    | 'periodic_refresh';

export interface GoalDodgeIntent {
    mode: 'goal';
    goalX: number;
    goalY: number;
    goalId?: DodgeMovementIntentId;
    arriveThreshold?: number;
}

export interface CombatRangeDodgeIntent {
    mode: 'combat_range';
    targetId: number;
    targetX: number;
    targetY: number;
    hardMinimumRange: number;
    preferredMinimumRange: number;
    preferredMaximumRange: number;
}

export type DodgeMovementIntent = GoalDodgeIntent | CombatRangeDodgeIntent;

export interface AutoDodgeOptions {
    /** Avoid tiles that deal ground damage. Defaults to true. */
    safeWalk?: boolean;
    /** Allow adaptive MOVE-position jumps across projectile paths. Defaults to false. */
    projectileJump?: boolean;
    /** Requested jump ceiling in tiles. Clamped to 0.01-1.5. */
    maxJumpDistance?: number;
}

export interface AutoDodgeState {
    enabled: boolean;
    overrideActive: boolean;
    velocity: { x: number; y: number };
    target: { x: number; y: number } | null;
    /** Current direct-walk target or local pathfinding waypoint supplied to dodge. */
    goal: { x: number; y: number } | null;
    /** Absolute points in the active short-horizon dodge route. */
    path: Array<{ x: number; y: number }>;
    /** Position that will be reported in the next normal MOVE record. */
    jumpTarget: { x: number; y: number } | null;
    jumpDistance: number;
    /** Distance currently permitted by recovery and learned server tolerance. */
    jumpAllowance: number;
    jumpStatus: 'ready' | 'recovering' | 'awaiting_move' | 'awaiting_confirmation' | 'backoff' | 'disabled';
    /** Increments only when the local planner selects a new timed trajectory. */
    planRevision: number;
    /** True when the current frame kept the existing trajectory after validating it. */
    planReused: boolean;
    searchRevision: number;
    searchPerformed: boolean;
    planCommitted: boolean;
    replanCause: DodgeReplanCause | null;
    movementIntentMode: DodgeMovementIntentMode | null;
    safetyState: DodgeSafetyState;
    retreatPenaltyScale: number;
    lastReplanAt: number | null;
    replanReason: 'normal' | 'urgent' | null;
    /** Increments when projectile or AOE occupancy changes in the rolling danger field. */
    dangerRevision: number;
    threatCount: number;
    earliestImpactMs: number | null;
    selectedCandidate: number;
    speedScale: number;
    commandedSpeed: number;
    progressSpeed: number;
    firstControlHeading: number | null;
    headingChange: number | null;
    committedScore: number | null;
    proposedScore: number | null;
    comparisonHorizonMs: number | null;
    movementTargetDistance: number;
    timeSinceLastMovementCommandMs: number | null;
    lookaheadRevision: number;
    lookaheadChanged: boolean;
    decision: string;
}

export interface NavigationOptions extends AutoDodgeOptions {
    /** Distance from the destination at which navigation stops. */
    arriveThreshold?: number;
    /** Stable identity for repeated updates of the same destination. */
    goalId?: DodgeMovementIntentId;
}

export type NavigationStatus =
    | 'idle'
    | 'planning'
    | 'moving'
    | 'arrived'
    | 'no_path'
    | 'dodge_blocked'
    | 'cancelled';

export interface NavigationState {
    status: NavigationStatus;
    target: { x: number; y: number; threshold: number } | null;
    path: Array<{ x: number; y: number }>;
    dodgeDecision: string | null;
}

export interface CombatPathfindingOptions {
    /** Stable runtime identity of the selected combat target. */
    targetId?: number;
    /** Weapon range in tiles. Zero or omitted derives it from the equipped weapon. */
    weaponRange?: number;
    /** Preferred fraction of weapon range. Defaults to 0.75. */
    preferredRangeRatio?: number;
    /** @deprecated Use `hardMinimumRange`. Retained for existing scripts. */
    minimumEnemyDistance?: number;
    /** Hard selected-enemy exclusion floor. Clamped to the canonical 1.0 tile. */
    hardMinimumRange?: number;
    /** Lower edge of the preferred firing band. */
    preferredMinimumRange?: number;
    /** Upper edge of the preferred firing band. Clamped inside effective weapon range. */
    preferredMaximumRange?: number;
    /** Distance reserved inside the weapon's maximum range. Defaults to max(0.5, range * 0.1). */
    shotRangeMargin?: number;
    /** Half-width of the acceptable firing band around the preferred distance. */
    rangeBandWidth?: number;
}

export interface CombatNavigationOptions extends CombatPathfindingOptions, AutoDodgeOptions {}

/**
 * A Realm teleport-beacon destination. Canonical region names and common
 * short aliases are suggested while future game destinations remain valid.
 */
export type TeleportBeaconDestination =
    | 'shore'
    | 'beach'
    | 'forest'
    | 'undead forest'
    | 'undead'
    | 'desert'
    | 'plains'
    | 'coral reefs'
    | 'coral'
    | 'dead church'
    | 'church'
    | 'haunted hallows'
    | 'haunted'
    | 'shipwreck cove'
    | 'shipwreck'
    | 'sprite forest'
    | 'sprite'
    | 'deep sea abyss'
    | 'deepsea'
    | 'floral escape'
    | 'floral'
    | 'sanguine forest'
    | 'sanguine'
    | 'runic tundra'
    | 'runic'
    | (string & {});

export class Walking {
    /**
     * Walk directly toward a tile without pathfinding. Pass world **X** and **Y** as two separate numbers
     * (same units as engine/player world coordinates, e.g. from `Hive.self.getX()` / `getY()`).
     */
    static walkTo(x: number, y: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Pathfind toward a tile. Unknown map space remains traversable while observed
     * blocking ground and objects are routed around. `arriveThreshold` stops the
     * route once the player is within that many tiles of the destination.
     */
    static pathfindingWalkTo(x: number, y: number, arriveThreshold?: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Exploratively pathfind to one world coordinate while the predictive dodge
     * planner owns every movement step, including steps with no active shots.
     */
    static navigateTo(x: number, y: number, options?: NavigationOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /**
     * Pathfind to a reachable firing band around a combat target. The equipped
     * weapon determines the range unless `weaponRange` is supplied.
     */
    static pathfindingWalkToCombatTarget(
        x: number,
        y: number,
        options?: CombatPathfindingOptions,
    ): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Pathfind to a firing band while the predictive dodge planner owns movement. */
    static navigateToCombatTarget(
        x: number,
        y: number,
        options?: CombatNavigationOptions,
    ): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToPosition(position: Position): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Walk directly toward the nearest visible combat enemy. */
    static walkToEnemy(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Pathfind to within 1 tile of the nearest visible combat enemy. */
    static pathfindingWalkToEnemy(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToPortal(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToNearestPortal(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static enterPortal(objectId: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static enterVault(): void { throw new Error('Must be run inside Hive client'); }
    static enterPetYard(): void { throw new Error('Must be run inside Hive client'); }
    static enterGuildHall(): void { throw new Error('Must be run inside Hive client'); }
    static enterDailyQuestRoom(): void { throw new Error('Must be run inside Hive client'); }

    static walkToNexusPortal(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToLeftWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToRightWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToTopWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static walkToBottomWall(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static followPlayer(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static stopMoving(): void {
        throw new Error('Must be run inside Hive client');
    }

    static isMoving(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Current global-pathfinding and local-dodge execution state. */
    static getNavigationState(): NavigationState {
        throw new Error('Must be run inside Hive client');
    }

    static hasReached(position: Position, tolerance?: number): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static nexus(): void {
        throw new Error('Must be run inside Hive client');
    }

    /** Enable predictive projectile and thrown-AOE dodging without clearing the current walk target. */
    static enableAutoDodge(options?: AutoDodgeOptions): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static disableAutoDodge(): void {
        throw new Error('Must be run inside Hive client');
    }

    static isAutoDodgeEnabled(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getAutoDodgeState(): AutoDodgeState | null {
        throw new Error('Must be run inside Hive client');
    }

    static setDodgeMovementIntent(intent: DodgeMovementIntent | null): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static getDodgeMovementIntent(): DodgeMovementIntent | null {
        throw new Error('Must be run inside Hive client');
    }

    static getDodgePosition(): Position | null {
        throw new Error('Must be run inside Hive client');
    }

    static dodge(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static dodgeFrom(enemy: Enemy): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static canTeleport(): boolean {
        throw new Error('Must be run inside Hive client');
    }

    static teleportToPlayer(name: string): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Teleport to the nearest live teleport beacon matching a region name or alias. */
    static teleportBeacon(destination: TeleportBeaconDestination): boolean {
        throw new Error('Must be run inside Hive client');
    }

    /** Teleport to a currently tracked teleport beacon by runtime object ID. */
    static teleportToBeacon(objectId: number): boolean {
        throw new Error('Must be run inside Hive client');
    }
}
