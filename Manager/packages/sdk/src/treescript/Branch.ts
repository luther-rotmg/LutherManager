import { Leaf } from './Leaf';

/**
 * A decision node that holds an ordered list of child {@link Leaf}s (which
 * may themselves be `Branch`es). `Branch` **is** a `Leaf`, so a branch can
 * live inside another branch.
 *
 * Traversal inside a {@link TreeScript} is handled by {@link Branch.tick}
 * (not `onLoop`). The default `tick` is a *selector*: children are checked
 * in insertion order and the first one whose `isValid()` returns `true`
 * runs. Override `tick` to change that — see `sequence(...)` / `parallel(...)`
 * in the helpers module for ready-made alternatives.
 *
 * ```ts
 * class CombatBranch extends Branch {
 *   isValid() { return Hive.enemies.count() > 0; }
 * }
 *
 * const combat = new CombatBranch()
 *   .addLeaves(new NexusAtLowHp(), new AttackNearest(), new StrafeDodge());
 * ```
 */
export abstract class Branch extends Leaf {
    private _children: Leaf[] = [];

    /** Sleep (ms) returned by the default `tick()` when no child is valid. */
    protected idleSleep: number = 100;

    /**
     * Append one or more child leaves. Returns `this` so chaining is fluent.
     *
     * ```ts
     * root.addLeaves(combat, vault, fameFarm);
     * ```
     */
    addLeaves(...leaves: Leaf[]): this {
        for (const leaf of leaves) {
            this._children.push(leaf);
        }
        return this;
    }

    /** Defensive copy of the children list. */
    getLeaves(): Leaf[] {
        return this._children.slice();
    }

    /** Number of direct children attached to this branch. */
    size(): number {
        return this._children.length;
    }

    /** Drop every child. Sub-branches' children are left alone. */
    clear(): void {
        this._children = [];
    }

    /**
     * First valid child — the tick target when this branch is active.
     * Returns `null` when no child wants to run.
     */
    next(): Leaf | null {
        for (const child of this._children) {
            if (child.isValid()) return child;
        }
        return null;
    }

    /**
     * Minimal interface the tree walker exposes to {@link Branch.tick} so
     * branches can implement custom traversal without reaching into the
     * walker's private state.
     */
    private static readonly _walkerMethods = ['enterBranch', 'runLeaf', 'idle'] as const;

    /**
     * Walk this branch for one tick. The walker calls this method — override
     * it to change how children are chosen (priority, random, parallel, etc.).
     *
     * Default implementation: *first-valid* selector.
     *
     * @param walker  The running {@link TreeScript}. Use its `enterBranch`,
     *                `runLeaf`, and `idle` helpers so status tracking stays
     *                consistent.
     */
    tick(walker: BranchWalker): number {
        for (const child of this._children) {
            if (!walker.isValidSafe(child)) continue;
            if (child instanceof Branch) return walker.enterBranch(child);
            return walker.runLeaf(child);
        }
        return walker.idle();
    }

    /**
     * Legacy selector-style runner. Kept so `Branch` instances remain useful
     * outside a `TreeScript`, but {@link TreeScript} itself routes through
     * {@link Branch.tick} — overriding `onLoop` will **not** change
     * traversal inside a `TreeScript`.
     */
    onLoop(): number {
        const next = this.next();
        if (!next) return this.idleSleep;
        return next.onLoop();
    }

    /**
     * Internal: iterate children without allocating a defensive copy.
     * Used by the walker on the hot path.
     * @internal
     */
    _iterateChildren(): readonly Leaf[] {
        return this._children;
    }

    /**
     * Build an anonymous `Branch` from plain options — no subclass required.
     *
     * ```ts
     * Branch.of({
     *   name: 'Combat',
     *   isValid: () => Hive.enemies.count() > 0,
     *   children: [nexusLowHp, attackNearest],
     * });
     * ```
     */
    static of(opts: {
        name?: string;
        isValid: () => boolean;
        children?: Leaf[];
    }): Branch {
        const b = new InlineBranch(opts.name, opts.isValid);
        if (opts.children?.length) b.addLeaves(...opts.children);
        return b;
    }
}

/**
 * The slice of {@link TreeScript} that {@link Branch.tick} is allowed to
 * use. Lets branches implement custom traversal without depending on
 * `TreeScript` itself (avoids a circular import).
 */
export interface BranchWalker {
    /** Record the branch as active and descend into it. */
    enterBranch(b: Branch): number;
    /** Record the leaf as active and run its `onLoop`. */
    runLeaf(l: Leaf): number;
    /** Produce the sleep value to use when a level has no valid child. */
    idle(): number;
    /** Run `node.isValid()` with error isolation. */
    isValidSafe(node: Leaf): boolean;
}

class InlineBranch extends Branch {
    constructor(
        name: string | undefined,
        private readonly _isValid: () => boolean,
    ) {
        super(name ?? 'Branch');
    }

    isValid(): boolean {
        return this._isValid();
    }
}
