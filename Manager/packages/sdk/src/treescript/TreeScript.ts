import { Script } from '../Script';
import { Log } from '../log/Log';
import { Leaf } from './Leaf';
import { Branch, BranchWalker } from './Branch';
import { Root } from './Root';

/**
 * A {@link Script} organised as a tree of decision {@link Branch}es and
 * action {@link Leaf}s — the same pattern popularised by DreamBot's
 * Tree Branch Leaf framework.
 *
 * Build the tree once in `onStart()`, let `onLoop()` walk it every tick.
 *
 * Traversal (each tick):
 *  1. Start at {@link Root} and call its `tick()`.
 *  2. The default `tick` iterates children in insertion order.
 *  3. First child whose `isValid()` is `true` becomes the active node:
 *     - If it's a `Branch`, descend into it and repeat step 2.
 *     - If it's a `Leaf`, run its `onLoop()` and sleep for the returned ms.
 *  4. If nothing is valid on the current level, sleep {@link idleSleep} ms.
 *
 * Along the way `getCurrentBranchName()` / `getCurrentLeafName()` are kept
 * in sync with whatever the walker stepped through this tick. They are
 * cleared at the start of each walk so "stale" status strings no longer
 * linger after an idle tick.
 *
 * ```ts
 * class VaultTradeScript extends TreeScript {
 *   onStart() {
 *     this.addBranches(
 *       new CombatBranch().addLeaves(new NexusAtLowHp(), new AttackNearest()),
 *       new VaultBranch().addLeaves(new DepositLoot(), new WithdrawPots()),
 *       new IdleLeaf(),
 *     );
 *   }
 * }
 * ```
 */
export abstract class TreeScript implements Script, BranchWalker {
    /** Root of the tree. Add branches / leaves here. */
    protected readonly root: Root = new Root();

    /** Sleep (ms) when the tree has no valid leaf this tick. */
    public idleSleep: number = 100;

    /**
     * When `true`, every `isValid()` / `onLoop()` call is logged to
     * {@link Log}. Handy when a tree isn't firing the leaf you expect.
     */
    public trace: boolean = false;

    private _currentBranchName: string = '';
    private _currentLeafName: string = '';

    // ─── Script lifecycle ───────────────────────────────────────────────────

    /** Override to build the tree, register event handlers, etc. */
    onStart(): void {}

    /** Walks the tree from the root and runs the first valid leaf path. */
    onLoop(): number {
        this._currentBranchName = '';
        this._currentLeafName = '';
        return this.root.tick(this);
    }

    /** Override to clean up listeners, timers, state, etc. */
    onStop(): void {}

    // ─── Tree construction ──────────────────────────────────────────────────

    /**
     * Append branches/leaves to the root. Mirrors DreamBot's
     * {@link https://dreambot.org/javadocs/org/dreambot/api/script/frameworks/treebranch/TreeScript.html TreeScript#addBranches}.
     *
     * `children` accepts anything that extends `Leaf` — that includes `Branch`
     * and `Root`, so the name is a little misleading but kept for familiarity.
     * Use {@link addChildren} if you prefer a clearer alias.
     *
     * @returns the root node so chained adds are fluent.
     */
    addBranches(...children: Leaf[]): Root {
        this.root.addLeaves(...children);
        return this.root;
    }

    /** Alias for {@link addBranches}. */
    addChildren(...children: Leaf[]): Root {
        return this.addBranches(...children);
    }

    /** Clears every child of the root (see {@link Branch.clear}). */
    clear(): void {
        this.root.clear();
        this._currentBranchName = '';
        this._currentLeafName = '';
    }

    /** The tree root — extend it with your own `addLeaves(...)`. */
    getRoot(): Root {
        return this.root;
    }

    // ─── Status tracking ────────────────────────────────────────────────────

    /** Name of the branch entered this tick (empty when idle). */
    getCurrentBranchName(): string {
        return this._currentBranchName;
    }

    /** Manually override the status string (rarely needed). */
    setCurrentBranchName(name: string): void {
        this._currentBranchName = name;
    }

    /** Name of the leaf executed this tick (empty when idle). */
    getCurrentLeafName(): string {
        return this._currentLeafName;
    }

    /** Manually override the status string (rarely needed). */
    setCurrentLeafName(name: string): void {
        this._currentLeafName = name;
    }

    // ─── Walker interface (called by Branch.tick) ───────────────────────────

    /** @internal */
    enterBranch(b: Branch): number {
        this._currentBranchName = b.getName();
        if (this.trace) this.log(`→ ${b.getName()} (branch)`);
        try {
            return b.tick(this);
        } catch (err) {
            this.logError(b, err);
            return this.idleSleep;
        }
    }

    /** @internal */
    runLeaf(l: Leaf): number {
        this._currentLeafName = l.getName();
        if (this.trace) this.log(`▶ ${l.getName()} (leaf)`);
        try {
            return l.onLoop();
        } catch (err) {
            this.logError(l, err);
            return this.idleSleep;
        }
    }

    /** @internal */
    idle(): number {
        if (this.trace) this.log('… idle');
        return this.idleSleep;
    }

    /** @internal */
    isValidSafe(node: Leaf): boolean {
        try {
            return node.isValid();
        } catch (err) {
            this.logError(node, err, 'isValid');
            return false;
        }
    }

    // ─── Introspection ──────────────────────────────────────────────────────

    /**
     * Render the tree as a human-readable string. Great for dropping into
     * a log line or a dashboard panel.
     *
     * ```
     * Root
     * ├── CombatBranch
     * │   ├── NexusLowHp
     * │   └── AttackNearest
     * └── IdleLeaf
     * ```
     */
    describe(): string {
        return TreeScript._describeNode(this.root, '', true, true);
    }

    /**
     * Dry-walk the tree and return the path of nodes (`[branch, branch, leaf]`)
     * that **would** fire if a real tick ran right now. `isValid()` is called
     * but no `onLoop()` is invoked.
     */
    getActivePath(): Leaf[] {
        const path: Leaf[] = [];
        let cursor: Branch | null = this.root;
        while (cursor) {
            path.push(cursor);
            let next: Leaf | null = null;
            for (const child of cursor._iterateChildren()) {
                if (this.isValidSafe(child)) { next = child; break; }
            }
            if (!next) break;
            if (next instanceof Branch) { cursor = next; continue; }
            path.push(next);
            break;
        }
        return path;
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    private log(line: string): void {
        try { Log.info(`[tree] ${line}`); } catch { /* outside host */ }
    }

    private logError(node: Leaf, err: unknown, where: 'isValid' | 'onLoop' = 'onLoop'): void {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            Log.error(`[tree] ${node.getName()}.${where}() threw: ${msg}`);
        } catch {
            console.error(`[tree] ${node.getName()}.${where}() threw: ${msg}`);
        }
    }

    private static _describeNode(node: Leaf, prefix: string, isLast: boolean, isRoot: boolean): string {
        const connector = isRoot ? '' : (isLast ? '└── ' : '├── ');
        let out = `${prefix}${connector}${node.getName()}\n`;
        if (node instanceof Branch) {
            const children = node._iterateChildren();
            const childPrefix = isRoot ? prefix : prefix + (isLast ? '    ' : '│   ');
            children.forEach((c, i) => {
                out += TreeScript._describeNode(c, childPrefix, i === children.length - 1, false);
            });
        }
        return out;
    }
}
