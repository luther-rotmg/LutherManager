/**
 * clientToken (HWID) for Deca account/verify.
 * Matches LoginGUI: hwid.txt file → WMI SHA1 → hostname+username fallback.
 */
import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { platform, hostname } from 'os';
import { createHash } from 'crypto';

/**
 * Path to hwid.txt (LoginGUI / official launcher style).
 * Windows: %LocalAppData%\RealmOfTheMadGod\hwid.txt
 */
function getHwidFilePath(): string {
  if (platform() !== 'win32') return '';
  const base = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return join(base, 'RealmOfTheMadGod', 'hwid.txt');
}

/**
 * WMI serials concatenated, then SHA1 hex. If concat empty, use fallback string before hashing.
 */
function getWmiSha1Hex(fallbackWhenEmpty: string): string | null {
  if (platform() !== 'win32') return null;
  try {
    const script = "$c='';Get-WmiObject Win32_BaseBoard|ForEach-Object{$c+=$_.SerialNumber};Get-WmiObject Win32_BIOS|ForEach-Object{$c+=$_.SerialNumber};Get-WmiObject Win32_OperatingSystem|ForEach-Object{$c+=$_.SerialNumber};$c";
    const concat = execSync(`powershell -NoProfile -Command ${JSON.stringify(script)}`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    const toHash = concat || fallbackWhenEmpty;
    const hash = createHash('sha1').update(toHash, 'utf8').digest('hex');
    return /^[a-f0-9]{40}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/**
 * Get clientToken for Deca account/verify. Matches LoginGUI logic.
 * 1. If %LocalAppData%\RealmOfTheMadGod\hwid.txt exists and non-empty → use it.
 *    (Skipped when opts.skipFile is true — used to recover from a stale
 *    hwid.txt left over from before a HWID spoof.)
 * 2. Else: WMI BaseBoard+BIOS+OS serials → SHA1 hex; if concat empty use hostname+username then SHA1.
 * 3. On exception: return hostname+username (no hash).
 * Never returns empty string.
 */
export function getClientToken(opts?: { skipFile?: boolean }): string {
  const fallback = hostname() + (process.env.USERNAME || process.env.USER || 'user');

  try {
    if (!opts?.skipFile) {
      const hwidPath = getHwidFilePath();
      if (hwidPath && existsSync(hwidPath)) {
        const content = readFileSync(hwidPath, 'utf8').trim();
        if (content) return content;
      }
    }

    const wmi = getWmiSha1Hex(fallback);
    if (wmi) return wmi;

    return fallback;
  } catch {
    return fallback;
  }
}

/**
 * Delete the cached hwid.txt if present. Called after a fresh-WMI verify
 * succeeds where the file-based one failed — the file is stale (e.g. user
 * ran a HWID spoofer after the official launcher created it).
 * Returns true if a file was removed.
 */
export function clearCachedHwid(): boolean {
  try {
    const hwidPath = getHwidFilePath();
    if (hwidPath && existsSync(hwidPath)) {
      unlinkSync(hwidPath);
      return true;
    }
  } catch { /* best-effort */ }
  return false;
}
