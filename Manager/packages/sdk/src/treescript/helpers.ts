import { Leaf } from './Leaf';
import { Branch, BranchWalker } from './Branch';

// ─── Factory shorthands ─────────────────────────────────────────────────────

/**
 * Build a {@link Leaf} from plain functions — no subclass required.
 *
 * ```ts
 * const escape = leaf({
 *   name: 'Escape',
 *   isValid: () => Luther.self.getHPPercent() < 0.3,
 *   onLoop: () => { Luther.walking.nexus(); return 2000; },
 * });
 * ```
 */
export function leaf(opts: {
    name?: string;
    isValid: () => boolean;
    onLoop: () => number;
}): Leaf {
    return Leaf.of(opts);
}

/**
 * Build a {@link Branch} from plain options — no subclass required.
 * Default traversal is "first valid child". For other shapes see
 * {@link sequence} and {@link parallel}.
 *
 * ```ts
 * const combat = branch({
 *   name: 'Combat',
 *   isValid: () => Luther.enemies.count() > 0,
 *   children: [nexusLowHp, attackNearest],
 * });
 * ```
 */
export function branch(opts: {
    name?: string;
    isValid: () => boolean;
    children?: Leaf[];
}): Branch {
    return Branch.of(opts);
}

// ─── Predicate decorators ───────────────────────────────────────────────────

/**
 * Gate an existing `Leaf` behind an additional predicate. The returned
 * leaf `isValid()` is `cond() && inner.isValid()`; `onLoop()` is delegated.
 *
 * ```ts
 * when(() => Luther.world.isRealm(), attackNearest);
 * ```
 */
export function when(cond: () => boolean, inner: Leaf): Leaf {
    return Leaf.of({
        name: `when(${inner.getName()})`,
        isValid: () => cond() && inner.isValid(),
        onLoop: () => inner.onLoop(),
    });
}

/** Invert a leaf's validity — `!inner.isValid()`. */
export function not(inner: Leaf): Leaf {
    return Leaf.of({
        name: `not(${inner.getName()})`,
        isValid: () => !inner.isValid(),
        onLoop: () => inner.onLoop(),
    });
}

/**
 * Mark a leaf as always valid (without touching its action). Handy for
 * catch-all fallbacks where you want the action of an existing leaf but
 * don't want its own gate.
 */
export function always(inner: Leaf): Leaf {
    return Leaf.of({
        name: `always(${inner.getName()})`,
        isValid: () => true,
        onLoop: () => inner.onLoop(),
    });
}

/**
 * Rate-limit a leaf: it becomes invalid for `ms` milliseconds after
 * each time its `onLoop()` runs.
 *
 * ```ts
 * cooldown(5000, leaf({ isValid: ..., onLoop: pickUpBag }));
 * ```
 */
export function cooldown(ms: number, inner: Leaf): Leaf {
    let lastFiredAt = -Infinity;
    return Leaf.of({
        name: `cooldown(${ms}ms, ${inner.getName()})`,
        isValid: () => Date.now() - lastFiredAt >= ms && inner.isValid(),
        onLoop: () => {
            lastFiredAt = Date.now();
            return inner.onLoop();
        },
    });
}

/**
 * Run a leaf at most one time per script run. After the first `onLoop()`
 * it reports `isValid() === false` forever.
 */
export function once(inner: Leaf): Leaf {
    let fired = false;
    return Leaf.of({
        name: `once(${inner.getName()})`,
        isValid: () => !fired && inner.isValid(),
        onLoop: () => {
            fired = true;
            return inner.onLoop();
        },
    });
}

// ─── Composite branches ─────────────────────────────────────────────────────

/**
 * Run every valid child in insertion order, but only one per tick: on
 * each call, pick up where the previous tick left off. Great for
 * step-by-step workflows like *deposit → withdraw → nexus*.
 *
 * `isValid()` returns `true` while any child is still valid. The branch
 * resets when it runs off the end of the list.
 */
export function sequence(name: string, ...children: Leaf[]): Branch {
    let cursor = 0;
    return new class extends Branch {
        constructor() { super(name); super.addLeaves(...children); }
        isValid(): boolean {
            // Find the next valid child starting at the cursor; wrap if needed.
            const kids = this._iterateChildren();
            for (let i = 0; i < kids.length; i++) {
                const idx = (cursor + i) % kids.length;
                if (kids[idx].isValid()) return true;
            }
            return false;
        }
        tick(walker: BranchWalker): number {
            const kids = this._iterateChildren();
            for (let i = 0; i < kids.length; i++) {
                const idx = (cursor + i) % kids.length;
                const child = kids[idx];
                if (!walker.isValidSafe(child)) continue;
                cursor = (idx + 1) % kids.length;
                if (child instanceof Branch) return walker.enterBranch(child);
                return walker.runLeaf(child);
            }
            return walker.idle();
        }
    }();
}

/**
 * Run **every** valid child on each tick (order: insertion). Returns the
 * **minimum** sleep value the children asked for, so the tree wakes up as
 * soon as the most impatient child wants another tick.
 *
 * Use this when siblings are independent and all need to run (e.g. a
 * "movement" leaf and a "chat" leaf).
 */
export function parallel(name: string, ...children: Leaf[]): Branch {
    return new class extends Branch {
        constructor() { super(name); super.addLeaves(...children); }
        isValid(): boolean {
            for (const c of this._iterateChildren()) {
                if (c.isValid()) return true;
            }
            return false;
        }
        tick(walker: BranchWalker): number {
            let minSleep = Infinity;
            let ran = false;
            for (const child of this._iterateChildren()) {
                if (!walker.isValidSafe(child)) continue;
                ran = true;
                const sleep = child instanceof Branch
                    ? walker.enterBranch(child)
                    : walker.runLeaf(child);
                if (sleep <= Leaf.STOP) return sleep; // propagate stop
                if (sleep < minSleep) minSleep = sleep;
            }
            return ran ? minSleep : walker.idle();
        }
    }();
}
