import { Logger } from '../../util/Logger.js';

const warned = new Set<string>();

/**
 * Log a one-time warning for an SDK method that is still stubbed.
 *
 * The bridge replaces the SDK's noop stubs with host implementations at startup.
 * A handful of surfaces (Walking, Combat, Enemies, Objects, Projectiles, loot, most
 * of Vault/GiftChest/Settings) are not wired yet and silently return defaults —
 * scripts previously had no way to tell. Call this from the stub body so the first
 * invocation logs `<api>: not implemented yet` and subsequent calls stay quiet.
 */
export function warnUnimplemented(api: string): void {
  if (warned.has(api)) return;
  warned.add(api);
  Logger.warn('ScriptBridge', `${api}: not implemented yet`);
}
