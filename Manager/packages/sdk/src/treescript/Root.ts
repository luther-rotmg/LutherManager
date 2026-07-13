import { Branch } from './Branch';

/**
 * Top of every {@link TreeScript} tree. `Root` is a {@link Branch} that is
 * **always valid** — the tree walker enters it on every tick and descends
 * into whichever child branch/leaf wins the `isValid()` check.
 *
 * You usually don't instantiate `Root` yourself; {@link TreeScript}
 * constructs one and hands it back via `getRoot()`.
 */
export class Root extends Branch {
    constructor() {
        super('Root');
    }

    /** Root is always active. */
    isValid(): boolean {
        return true;
    }
}
