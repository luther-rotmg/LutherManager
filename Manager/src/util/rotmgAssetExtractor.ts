/**
 * Extracts objects.xml and tiles.xml from the RotMG CDN at startup.
 *
 * Flow:
 *   1. Fetch https://www.realmofthemadgod.com/app/init → baseCdnUrl + buildHash
 *   2. Compare buildHash to Documents/Luther/data/.build-hash (skip if fresh)
 *   3. Fetch checksum.json to discover which Unity asset bundle file to download
 *   4. Download + gunzip the bundle, regex-search for <Objects> and <GroundTypes>
 *   5. Write objects.xml + tiles.xml, save new .build-hash
 *   Fallback: mirror download via ensureRotmgMetadataXml if CDN extraction fails
 */

import { createGunzip } from 'zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Readable } from 'stream';
import { XMLParser } from 'fast-xml-parser';
import { Logger } from './Logger.js';
import { ensureRotmgMetadataXml } from './ensureRotmgMetadataXml.js';
import {
  findLocalGameDataDir,
  extractLocalGameAssets,
  isLocalCacheFresh,
} from './rotmgLocalExtractor.js';

const INIT_URL =
  'https://www.realmofthemadgod.com/app/init?platform=standalonewindows64&key=9KnJFxtTvLu2frXv';
const HASH_FILE = '.build-hash';
const MANIFEST_FILE = '.asset-manifest.json';
const SHORT_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** Ordered patterns for selecting the asset bundle to search.
 *  More specific / smaller bundles before resources.assets. */
const BUNDLE_PRIORITY: RegExp[] = [
  /gamedata/i,
  /xmldata/i,
  /xml[_.-]?bundle/i,
  /data[_.-]?bundle/i,
  /_Data\/(?!Managed|MonoBleedingEdge|Plugins|Videos|Shaders)[^/]+\.assets(\.resS)?$/i,
  /resources\.assets$/i,
];

// ── Public API ────────────────────────────────────────────────────────────────

export function getLutherDataDir(): string {
  return join(process.env.USERPROFILE || homedir(), 'Documents', 'Hive', 'data');
}

/** `Documents/Luther` — dashboard accounts, plugin config snapshots; sits alongside `data/`, `Plugins/`, `Scripts/`. */
export function getLutherDocumentsDir(): string {
  return join(process.env.USERPROFILE || homedir(), 'Documents', 'Hive');
}

export interface ExtractResult {
  objectsXml: string | null;
  tilesXml: string | null;
}

/**
 * Ensures objects.xml and tiles.xml are present and up-to-date in {@code dataDir}.
 * Returns resolved absolute paths (null if a file could not be obtained).
 */
export async function extractGameXmls(dataDir: string): Promise<ExtractResult> {
  mkdirSync(dataDir, { recursive: true });

  // ── Step 1: Try local game installation ────────────────────────────────────
  const localGameDir = findLocalGameDataDir();
  if (localGameDir) {
    if (isLocalCacheFresh(localGameDir, dataDir)) {
      Logger.log('AssetExtractor', 'Local game assets are up-to-date — skipping re-extraction');
    } else {
      try {
        Logger.log('AssetExtractor', `Extracting from local game: ${localGameDir}`);
        await extractLocalGameAssets(localGameDir, dataDir);
      } catch (localErr) {
        Logger.warn(
          'AssetExtractor',
          `Local extraction failed (${(localErr as Error).message}) — falling back to CDN`,
        );
      }
    }
  }

  // ── Step 2: CDN extraction if local didn't produce the XMLs ───────────────
  const needsXml =
    !existsSync(join(dataDir, 'objects.xml')) || !existsSync(join(dataDir, 'tiles.xml'));

  if (needsXml) {
    try {
      const { baseCdnUrl, buildHash } = await getBuildInfo();
      Logger.log('AssetExtractor', `Build hash: ${buildHash}`);

      if (isFresh(dataDir, buildHash)) {
        Logger.log('AssetExtractor', 'Game XML files are up-to-date — skipping CDN extraction');
      } else {
        const assetFile = await discoverAssetFile(baseCdnUrl, buildHash, dataDir);
        await downloadAndExtractXmls(baseCdnUrl, buildHash, assetFile, dataDir);
      }
    } catch (cdnErr) {
      Logger.warn(
        'AssetExtractor',
        `CDN extraction failed (${(cdnErr as Error).message}) — trying mirror download`,
      );
      await ensureRotmgMetadataXml(dataDir, {
        full: true,
        log(level, msg) {
          if (level === 'error') Logger.error('AssetExtractor', msg);
          else if (level === 'warn') Logger.warn('AssetExtractor', msg);
          else Logger.log('AssetExtractor', msg);
        },
      });
    }
  }

  return {
    objectsXml: existsSync(join(dataDir, 'objects.xml')) ? join(dataDir, 'objects.xml') : null,
    tilesXml: existsSync(join(dataDir, 'tiles.xml')) ? join(dataDir, 'tiles.xml') : null,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface BuildInfo {
  baseCdnUrl: string;
  buildHash: string;
}

interface AssetManifest {
  buildHash: string;
  assetFile: string;
}

async function getBuildInfo(): Promise<BuildInfo> {
  const xml = await fetchText(INIT_URL, SHORT_TIMEOUT_MS);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  // Response shape varies by client version; try common field names
  const node: Record<string, unknown> =
    (parsed?.AppSettings as Record<string, unknown>) ??
    (parsed?.Data as Record<string, unknown>) ??
    (parsed as Record<string, unknown>) ??
    {};
  const baseCdnUrl = String(
    node.baseCdnUrl ?? node.BuildCdnUrl ?? node.cdnUrl ?? '',
  ).trim();
  const buildHash = String(
    node.buildHash ?? node.BuildHash ?? node.build_hash ?? '',
  ).trim();
  if (!baseCdnUrl || !buildHash) {
    throw new Error('Could not parse baseCdnUrl / buildHash from app/init response');
  }
  return {
    baseCdnUrl: baseCdnUrl.endsWith('/') ? baseCdnUrl : `${baseCdnUrl}/`,
    buildHash,
  };
}

function isFresh(dataDir: string, buildHash: string): boolean {
  const hashPath = join(dataDir, HASH_FILE);
  if (!existsSync(hashPath)) return false;
  if (readFileSync(hashPath, 'utf8').trim() !== buildHash) return false;
  return existsSync(join(dataDir, 'objects.xml')) && existsSync(join(dataDir, 'tiles.xml'));
}

/** Returns the CDN-relative file path for the bundle that contains game XML data.
 *  Caches the discovery result in MANIFEST_FILE so checksum.json is only fetched once per build. */
async function discoverAssetFile(
  baseCdnUrl: string,
  buildHash: string,
  dataDir: string,
): Promise<string> {
  const manifestPath = join(dataDir, MANIFEST_FILE);
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as AssetManifest;
      if (m.buildHash === buildHash && m.assetFile) {
        Logger.log('AssetExtractor', `Using cached asset manifest: ${m.assetFile}`);
        return m.assetFile;
      }
    } catch {
      // stale / corrupt manifest — re-discover
    }
  }

  const checksumUrl = `${baseCdnUrl}${buildHash}/checksum.json`;
  Logger.log('AssetExtractor', `Fetching build checksum: ${checksumUrl}`);
  const raw = await fetchText(checksumUrl, SHORT_TIMEOUT_MS);
  const data = JSON.parse(raw) as unknown;

  // checksum.json is either an object keyed by filename or an array of file entry objects
  let fileNames: string[];
  if (Array.isArray(data)) {
    fileNames = (data as Record<string, unknown>[]).map((e) =>
      String(e.fileName ?? e.file ?? e.path ?? e),
    );
  } else if (data && typeof data === 'object') {
    fileNames = Object.keys(data as Record<string, unknown>);
  } else {
    throw new Error('Unrecognised checksum.json format');
  }

  for (const pattern of BUNDLE_PRIORITY) {
    const match = fileNames.find((f) => pattern.test(f));
    if (match) {
      Logger.log('AssetExtractor', `Selected asset bundle: ${match}`);
      writeFileSync(manifestPath, JSON.stringify({ buildHash, assetFile: match }));
      return match;
    }
  }

  throw new Error(
    `No matching asset bundle in checksum.json (${fileNames.length} files scanned)`,
  );
}

async function downloadAndExtractXmls(
  baseCdnUrl: string,
  buildHash: string,
  assetFile: string,
  dataDir: string,
): Promise<void> {
  // RotMG CDN serves files with .gz suffix
  const cdnFile = assetFile.endsWith('.gz') ? assetFile : `${assetFile}.gz`;
  const url = `${baseCdnUrl}${buildHash}/${cdnFile}`;
  Logger.log('AssetExtractor', `Downloading ${url} …`);

  const buf = await fetchAndDecompress(url, DOWNLOAD_TIMEOUT_MS);
  Logger.log(
    'AssetExtractor',
    `Decompressed ${(buf.length / 1024 / 1024).toFixed(1)} MB — searching for XML sections`,
  );

  const objectsBuf = extractXmlSection(buf, '<Objects>', '</Objects>');
  const tilesBuf = extractXmlSection(buf, '<GroundTypes>', '</GroundTypes>');

  if (!objectsBuf && !tilesBuf) {
    throw new Error('No XML game data sections found in asset bundle — wrong bundle selected');
  }

  if (objectsBuf) {
    writeFileSync(join(dataDir, 'objects.xml'), objectsBuf);
    Logger.log(
      'AssetExtractor',
      `Wrote objects.xml (${(objectsBuf.length / 1024 / 1024).toFixed(1)} MB)`,
    );
  }
  if (tilesBuf) {
    writeFileSync(join(dataDir, 'tiles.xml'), tilesBuf);
    Logger.log(
      'AssetExtractor',
      `Wrote tiles.xml (${(tilesBuf.length / 1024 / 1024).toFixed(1)} MB)`,
    );
  }

  writeFileSync(join(dataDir, HASH_FILE), buildHash);
}

/** Search a binary buffer for a UTF-8 XML section bounded by openTag / closeTag. */
function extractXmlSection(buf: Buffer, openTag: string, closeTag: string): Buffer | null {
  const open = Buffer.from(openTag, 'utf8');
  const close = Buffer.from(closeTag, 'utf8');
  const start = buf.indexOf(open);
  if (start === -1) return null;
  const end = buf.indexOf(close, start);
  if (end === -1) return null;
  return buf.subarray(start, end + close.length);
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Download a (possibly gzip-compressed) URL and return the decompressed Buffer.
 *  Streams through gunzip to avoid holding both the compressed and decompressed
 *  data in memory simultaneously. */
async function fetchAndDecompress(url: string, timeoutMs: number): Promise<Buffer> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

    const isGzip =
      url.endsWith('.gz') || res.headers.get('content-encoding') === 'gzip';

    if (!isGzip || !res.body) {
      return Buffer.from(await res.arrayBuffer());
    }

    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);

    await new Promise<void>((resolve, reject) => {
      gunzip.on('data', (c: Buffer) => chunks.push(c));
      gunzip.on('end', resolve);
      gunzip.on('error', reject);
      nodeStream.on('error', reject);
      nodeStream.pipe(gunzip);
    });

    return Buffer.concat(chunks);
  } finally {
    clearTimeout(t);
  }
}
