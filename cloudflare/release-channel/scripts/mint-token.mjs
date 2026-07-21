#!/usr/bin/env node
// Mint a fresh install token, write it to the LUTHER_MANAGER_TOKENS KV via wrangler,
// and print it. The token is what a subscriber pastes into
// %USERPROFILE%\Documents\LutherManager\update-token to unlock auto-updates from
// luther-rotmg.com/api/releases/win/*.
//
// Usage:
//   node scripts/mint-token.mjs [--email <address>] [--note <text>] [--dry-run]
//
// Options:
//   --email <addr>  Optional email tagged onto the token record. No verification;
//                   just metadata to know who a token belongs to when auditing.
//   --note <text>   Optional free-form note (e.g. "champion-dev-machine",
//                   "reissue-2026-08-01").
//   --dry-run       Print what would be written; do NOT call wrangler.
//
// Requires: wrangler CLI logged in as the account that owns the
// luther-manager-release-channel Worker (verify with `wrangler whoami`).

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const wranglerDir = join(scriptsDir, '..');
const wranglerTomlPath = join(wranglerDir, 'wrangler.toml');

if (!existsSync(wranglerTomlPath)) {
  console.error('[mint-token] cannot find wrangler.toml at', wranglerTomlPath);
  process.exit(1);
}

// Parse args.
const args = process.argv.slice(2);
const opts = { email: null, note: null, dryRun: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--email' && i + 1 < args.length) { opts.email = args[++i]; continue; }
  if (a === '--note'  && i + 1 < args.length) { opts.note  = args[++i]; continue; }
  if (a === '--dry-run' || a === '--dryrun')   { opts.dryRun = true;    continue; }
  if (a === '-h' || a === '--help') {
    console.log('mint-token.mjs — mint an install token for LutherManager auto-updates.');
    console.log('Options: [--email <addr>] [--note <text>] [--dry-run]');
    process.exit(0);
  }
  console.error('[mint-token] unknown arg:', a);
  process.exit(1);
}

const token = randomBytes(32).toString('base64url');
const record = {
  revoked: false,
  ...(opts.email ? { email: opts.email } : {}),
  install_date: new Date().toISOString(),
  ...(opts.note ? { note: opts.note } : {}),
};
const value = JSON.stringify(record);

console.log('[mint-token] token: ', token);
console.log('[mint-token] record:', value);

if (opts.dryRun) {
  console.log('[mint-token] --dry-run: skipping wrangler write.');
  process.exit(0);
}

console.log('[mint-token] writing to KV via wrangler...');
try {
  const out = execFileSync('wrangler', [
    'kv', 'key', 'put',
    '--binding=TOKENS',
    token,
    value,
    '--remote',
  ], {
    cwd: wranglerDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  console.log(out.trim());
} catch (err) {
  console.error('[mint-token] wrangler put failed:', err && (err.message || err));
  process.exit(1);
}

console.log('');
console.log('[mint-token] TOKEN MINTED SUCCESSFULLY. Paste this into the install:');
console.log('');
console.log('  Windows:  %USERPROFILE%\\Documents\\LutherManager\\update-token');
console.log('  Contents: ' + token);
console.log('');
console.log('[mint-token] Revoke later with:');
console.log(`  wrangler kv key put --binding=TOKENS "${token}" '{"revoked":true}' --remote`);
