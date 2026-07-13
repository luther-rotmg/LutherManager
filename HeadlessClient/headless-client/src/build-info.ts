import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ENDPOINTS, UNITY_HEADERS } from './constants';

/**
 * Build metadata from the AppEngine `/app/init` response.
 *
 * NOTE: `buildVersion` here is the build **artifact hash** (a SHA1-looking
 * string), NOT the dotted game version sent in the Hello packet
 * (`BUILD_VERSION` in constants.ts). The dotted version is not exposed by the
 * API — it lives in the `buildCdn` manifest — so it cannot be auto-sourced
 * from here. `buildHash` is a stable per-release fingerprint, which is what
 * this module uses to detect that the live build changed.
 */
export interface BuildInfo {
  /** `<BuildHash>` — changes every game release. */
  buildHash: string;
  /** `<BuildVersion>` — the build artifact hash (not the Hello version). */
  buildVersion: string;
  /** `<BuildId>` — e.g. `rotmg-exalt-win-64`. */
  buildId: string;
  /** `<BuildCDN>` — base URL of the build manifest. */
  buildCdn: string;
}

const BUILD_CACHE_FILE = path.resolve(process.cwd(), '.build-cache.json');
const UNITY_FIELDS = { game_net: 'Unity', play_platform: 'Unity', game_net_user_id: '' };

function tag(xml: string, name: string): string {
  return new RegExp(`<${name}>(.*?)</${name}>`).exec(xml)?.[1] ?? '';
}

/** Fetches build metadata from `/app/init`. */
export async function fetchBuildInfo(): Promise<BuildInfo> {
  const res = await axios.post<string>(ENDPOINTS.APP_INIT, new URLSearchParams(UNITY_FIELDS).toString(), {
    headers: UNITY_HEADERS,
    responseType: 'text',
    timeout: 15_000,
    validateStatus: () => true,
  });
  const xml = typeof res.data === 'string' ? res.data : String(res.data);
  return {
    buildHash: tag(xml, 'BuildHash'),
    buildVersion: tag(xml, 'BuildVersion'),
    buildId: tag(xml, 'BuildId'),
    buildCdn: tag(xml, 'BuildCDN'),
  };
}

function readCachedHash(): string | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(BUILD_CACHE_FILE, 'utf8')) as { buildHash?: unknown };
    return typeof parsed.buildHash === 'string' ? parsed.buildHash : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedHash(buildHash: string): void {
  try {
    fs.writeFileSync(BUILD_CACHE_FILE, JSON.stringify({ buildHash }, null, 2));
  } catch {
    // best-effort: drift detection is advisory, never fatal
  }
}

/**
 * Fetches the current build hash and warns if it changed since the last run.
 * A changed build almost always means the dotted `BUILD_VERSION` in
 * constants.ts needs bumping, so this surfaces the problem proactively —
 * before the Hello handshake fails with a version-mismatch. Never throws:
 * network issues just skip the check.
 */
export async function checkBuildDrift(): Promise<void> {
  let info: BuildInfo;
  try {
    info = await fetchBuildInfo();
  } catch (err) {
    console.warn(`[build-info] could not fetch /app/init: ${(err as Error).message}`);
    return;
  }
  if (!info.buildHash) {
    return;
  }
  const previous = readCachedHash();
  if (previous && previous !== info.buildHash) {
    console.warn(
      `[build-info] live game build changed (${previous.slice(0, 8)} -> ${info.buildHash.slice(0, 8)}). ` +
        'If Hello starts failing with a version error, bump BUILD_VERSION in constants.ts.',
    );
  }
  writeCachedHash(info.buildHash);
}
