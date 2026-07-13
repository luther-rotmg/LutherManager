import * as fs from 'fs';
import * as path from 'path';

const CACHE_FILE = path.resolve(process.cwd(), '.token-cache.json');

export interface CachedToken {
  accessToken: string;
  clientToken: string;
  /** Epoch milliseconds at which the access token expires. */
  expiresAt: number;
}

type Cache = Record<string, CachedToken>;

function read(): Cache {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as unknown;
    if (!isCache(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function isCache(value: unknown): value is Cache {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (!entry || typeof entry !== 'object') {
      return false;
    }
    const token = entry as Record<string, unknown>;
    return (
      typeof token.accessToken === 'string' &&
      typeof token.clientToken === 'string' &&
      typeof token.expiresAt === 'number'
    );
  });
}

/**
 * Returns the cached token for an account if it is still valid (with a 60s
 * safety margin), otherwise undefined.
 */
export function getCachedToken(guid: string): CachedToken | undefined {
  const entry = read()[guid];
  if (entry && entry.expiresAt > Date.now() + 60_000) {
    return entry;
  }
  return undefined;
}

/** Persists a token for an account. */
export function setCachedToken(guid: string, token: CachedToken): void {
  const cache = read();
  cache[guid] = token;
  // Tokens are secrets: write 0600 (owner-only) so the cache isn't world-readable.
  // Use a per-process unique tmp name so concurrent processes don't collide on it;
  // the rename is atomic, so the worst case across processes is last-writer-wins.
  const tmp = `${CACHE_FILE}.${process.pid}.${nextTmpSeq++}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CACHE_FILE);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup of the tmp file
    }
    throw err;
  }
}

let nextTmpSeq = 0;
