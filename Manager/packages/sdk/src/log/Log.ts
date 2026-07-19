/** Level for `Luther.log` lines in the dashboard Script log. */
export type ScriptLogLevel = 'info' | 'warn' | 'error';

/**
 * Write to the dev dashboard **Script log** tab (when a user script is running).
 * Falls back to the host console if no script session is active.
 */
export class Log {
    static info(message: string): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static warn(message: string): void {
        throw new Error('Must be run inside LutherManager client');
    }

    static error(message: string): void {
        throw new Error('Must be run inside LutherManager client');
    }
}
