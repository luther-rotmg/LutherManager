import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// token-cache resolves its file from process.cwd() at import time. Switch into a
// throwaway cwd once, then import the module a single time so the whole file
// operates on a temp cache rather than the repo's.
let tmpDir: string;
let originalCwd: string;
let cache: typeof import('../src/token-cache');

before(async () => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-cache-'));
  process.chdir(tmpDir);
  cache = await import('../src/token-cache');
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('round-trips a token and honours the 60s expiry margin', () => {
  const soon = Date.now() + 30_000; // inside the 60s safety margin → treated as expired
  cache.setCachedToken('guid-soon', { accessToken: 'a', clientToken: 'ca', expiresAt: soon });
  assert.equal(cache.getCachedToken('guid-soon'), undefined);

  const later = Date.now() + 10 * 60_000;
  cache.setCachedToken('guid-later', { accessToken: 'b', clientToken: 'cb', expiresAt: later });
  assert.deepEqual(cache.getCachedToken('guid-later'), { accessToken: 'b', clientToken: 'cb', expiresAt: later });
});

test('persists the cache file with owner-only (0600) permissions', () => {
  cache.setCachedToken('guid-perm', { accessToken: 'a', clientToken: 'ca', expiresAt: Date.now() + 600_000 });
  const stat = fs.statSync(path.join(tmpDir, '.token-cache.json'));
  // Low 9 permission bits should be 0o600 (rw for owner only).
  assert.equal(stat.mode & 0o777, 0o600);
});

test('does not leave stray .tmp files behind', () => {
  cache.setCachedToken('guid-tmp', { accessToken: 'a', clientToken: 'ca', expiresAt: Date.now() + 600_000 });
  const leftovers = fs.readdirSync(tmpDir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('tolerates a corrupt cache file by returning nothing', () => {
  fs.writeFileSync(path.join(tmpDir, '.token-cache.json'), '{ not json');
  assert.equal(cache.getCachedToken('anything'), undefined);
});
