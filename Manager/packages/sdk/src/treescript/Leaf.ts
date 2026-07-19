/**
 * A single node in a {@link TreeScript} tree. A `Leaf` knows two things:
 * whether it **should** run right now (`isValid`), and what to do when
 * it **does** run (`onLoop`).
 *
 * Extend `Leaf` for a terminal action. Extend `Branch` if you also want
 * to hold child leaves.
 *
 * ```ts
 * class NexusAtLowHp extends Leaf {
 *   isValid() {
 *     return Luther.self.getHP() / Luther.self.getMaxHP() < 0.3;
 *   }
 *   onLoop() {
 *     Luther.walking.nexus();
 *     return 1000; // sleep 1s before the tree re-evaluates
 *   }
 * }
 * ```
 *
 * If a full class feels like too much ceremony, use the
 * {@link Leaf.of} factory (or the top-level `leaf(...)` helper):
 *
 * ```ts
 * const heartbeat = Leaf.of({
 *   name: 'Heartbeat',
 *   isValid: () => true,
 *   onLoop: () => { Luther.log.info('tick'); return 2000; },
 * });
 * ```
 */
export abstract class Leaf {
    /**
     * Sentinel sleep value: return this from `onLoop()` to ask the host
     * to stop the script after this tick.
     *
     * The host treats any `onLoop()` return value `<= Leaf.STOP` as a
     * stop request. `Leaf.STOP` itself is `-1`, which is plenty negative
     * for most use-cases.
     */
    static readonly STOP = -1;

    private _name: string;

    constructor(name?: string) {
        this._name = name ?? this.constructor.name;
    }

    /** Human-readable node name (defaults to the class name). */
    getName(): string {
        return this._name;
    }

    /** Rename this node — handy when a script reports the current branch/leaf. */
    setName(name: string): void {
        this._name = name;
    }

    /**
     * Return `true` when this leaf should execute on the current tick.
     * Keep it cheap; it may be called every loop iteration.
     */
    abstract isValid(): boolean;

    /**
     * Run the leaf's action.
     *
     * @returns Sleep duration (ms) before the next {@link TreeScript} tick.
     *          Return `Leaf.STOP` (or any value `<= -1`) to stop the script.
     */
    abstract onLoop(): number;

    /**
     * Build a `Leaf` from plain functions — no subclass required.
     *
     * ```ts
     * Leaf.of({
     *   name: 'Escape',
     *   isValid: () => Luther.self.getHPPercent() < 0.3,
     *   onLoop: () => { Luther.walking.nexus(); return 2000; },
     * });
     * ```
     */
    static of(opts: { name?: string; isValid: () => boolean; onLoop: () => number }): Leaf {
        return new InlineLeaf(opts.name, opts.isValid, opts.onLoop);
    }
}

class InlineLeaf extends Leaf {
    constructor(
        name: string | undefined,
        private readonly _isValid: () => boolean,
        private readonly _onLoop: () => number,
    ) {
        super(name ?? 'Leaf');
    }

    isValid(): boolean {
        return this._isValid();
    }

    onLoop(): number {
        return this._onLoop();
    }
}
