/**
 * Merged client config: bundled `resources/data/config.json` + optional persistent user overlay.
 * Packaged apps often run from a temp `resources` tree each launch; dashboard writes must survive restarts.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export function getUserClientConfigPath(): string | null {
  const p = String(process.env.HIVE_USER_CONFIG_PATH || '').trim();
  return p ? resolve(p) : null;
}

/** Where dashboard saves: user overlay file when set, else bundled data/config.json */
export function getClientConfigWritePath(resourcesRoot: string): string {
  return getUserClientConfigPath() ?? resolve(resourcesRoot, 'data', 'config.json');
}

/** Bundled defaults merged with user file (user wins on overlapping keys). */
export function readMergedClientConfigRaw(resourcesRoot: string): Record<string, unknown> {
  const bundled = resolve(resourcesRoot, 'data', 'config.json');
  let out: Record<string, unknown> = {};
  if (existsSync(bundled)) {
    try {
      out = { ...out, ...(JSON.parse(readFileSync(bundled, 'utf8')) as Record<string, unknown>) };
    } catch {
      /* keep out */
    }
  }
  const user = getUserClientConfigPath();
  if (user && existsSync(user)) {
    try {
      out = { ...out, ...(JSON.parse(readFileSync(user, 'utf8')) as Record<string, unknown>) };
    } catch {
      /* keep out */
    }
  }
  return out;
}

export function truthyConfigFlag(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}
