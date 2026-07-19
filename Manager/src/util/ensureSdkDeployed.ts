import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { Logger } from './Logger.js';

/**
 * SDK deployment to Documents.
 *
 * The packaged SDK (resources/sdk/) contains the full user SDK:
 *   - sdk/dist/index.js      - bridge stub entrypoint
 *   - sdk/dist JS files      - compiled fallback/submodule implementations
 *   - sdk/dist/types/        - TypeScript autocomplete
 *   - sdk/package.json       - version info
 *
 * Scripts can accidentally shadow the managed SDK with
 * Documents/Luther/Scripts/node_modules/@luthermanager/sdk. Since Node
 * resolves that before Documents/Luther/node_modules, keep known shadow
 * installs synchronized too.
 */

const VERSION_FILE = 'sdk-version.txt';

function repoRoot(): string {
  return process.env.HIVE_APP_ROOT
    ? resolve(process.env.HIVE_APP_ROOT)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Find the packaged SDK directory (resources/ or dev source). */
function findPackagedSdkDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  const candidates = [
    // Packaged mode: electron-builder extraResources copies packages/sdk/ to resources/sdk/.
    resourcesPath ? join(resourcesPath, 'sdk') : '',
    process.env.HIVE_ROOT ? join(resolve(process.env.HIVE_ROOT), 'sdk') : '',
    // Dev mode: packages/sdk/.
    join(repoRoot(), 'packages', 'sdk'),
  ].filter(Boolean);

  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }

  return null;
}

/** Read version from an SDK package.json. */
function readSdkVersion(sdkDir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
    return String(pkg.version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function sdkMatchesPackaged(packagedSdkDir: string, targetDir: string, packagedVersion: string): boolean {
  if (!existsSync(join(targetDir, 'package.json'))) return false;
  if (!existsSync(join(targetDir, 'dist', 'index.js'))) return false;
  if (!existsSync(join(targetDir, 'dist', 'types', 'index.d.ts'))) return false;
  if (readSdkVersion(targetDir) !== packagedVersion) return false;

  const sentinelFiles = [
    join('dist', 'index.js'),
    join('dist', 'events.js'),
    join('dist', 'types', 'events.d.ts'),
    join('dist', 'types', 'index.d.ts'),
    join('dist', 'combat', 'Combat.js'),
    join('dist', 'types', 'combat', 'Combat.d.ts'),
    join('dist', 'walking', 'Walking.js'),
    join('dist', 'types', 'walking', 'Walking.d.ts'),
    join('dist', 'self', 'Self.js'),
    join('dist', 'types', 'self', 'Self.d.ts'),
    join('dist', 'ui', 'Panel.js'),
    join('dist', 'types', 'ui', 'Panel.d.ts'),
    join('dist', 'inventory.js'),
    join('dist', 'types', 'inventory.d.ts'),
    join('src', 'events.ts'),
    join('src', 'types', 'events.ts'),
    join('src', 'combat', 'Combat.ts'),
    join('src', 'self', 'Self.ts'),
    join('src', 'walking', 'Walking.ts'),
    join('src', 'ui', 'Panel.ts'),
    join('src', 'inventory.ts'),
    join('src', 'types', 'items', 'StorageItem.ts'),
  ];

  return sentinelFiles.every((file) => {
    const packagedText = readText(join(packagedSdkDir, file));
    const installedText = readText(join(targetDir, file));
    return packagedText != null && packagedText === installedText;
  });
}

/** Copy the entire packaged SDK to the target. */
function copySdkToDocuments(sdkDir: string, targetDir: string): void {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(targetDir, { recursive: true });
  cpSync(sdkDir, targetDir, { recursive: true });
}

function findShadowSdkDirs(hiveDir: string): string[] {
  const scriptsDir = join(hiveDir, 'Scripts');
  const dirs = [
    join(scriptsDir, 'node_modules', '@hive', 'sdk'),
  ];

  if (!existsSync(scriptsDir)) return dirs;

  try {
    for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }

      const localSdk = join(scriptsDir, entry.name, 'node_modules', '@hive', 'sdk');
      if (existsSync(localSdk)) dirs.push(localSdk);
    }
  } catch {
    // Shared SDK deployment still covers scripts without a local node_modules SDK.
  }

  return dirs;
}

/** List installed files in the Documents SDK directory (for logging). */
function listInstalledFiles(targetDir: string): string[] {
  try {
    return readdirSync(targetDir, { recursive: true })
      .filter((f) => typeof f === 'string')
      .map((f) => String(f));
  } catch {
    return [];
  }
}

export function ensureSdkDeployed(): void {
  const userDir = process.env.USERPROFILE || homedir();
  const hiveDir = join(userDir, 'Documents', 'Hive');
  const sdkTargetDir = join(hiveDir, 'node_modules', '@hive', 'sdk');
  const versionFilePath = join(hiveDir, VERSION_FILE);

  const packagedSdkDir = findPackagedSdkDir();
  if (!packagedSdkDir) {
    Logger.warn('SDK', 'Packaged SDK not found; cannot deploy to Documents.');
    return;
  }

  const packagedVersion = readSdkVersion(packagedSdkDir);
  const installedVersion = existsSync(versionFilePath)
    ? readFileSync(versionFilePath, 'utf8').trim()
    : 'none';

  const targetDirs = Array.from(new Set([
    sdkTargetDir,
    ...findShadowSdkDirs(hiveDir),
  ]));
  const staleDirs = targetDirs.filter((dir) => !sdkMatchesPackaged(packagedSdkDir, dir, packagedVersion));

  if (installedVersion === packagedVersion && staleDirs.length === 0) {
    Logger.log('SDK', `v${packagedVersion} already installed in Documents (skipping deploy).`);
    return;
  }

  Logger.log(
    'SDK',
    `Deploying SDK v${packagedVersion} to Documents (installed: ${installedVersion}; stale copies: ${staleDirs.length})...`,
  );

  try {
    for (const targetDir of staleDirs) {
      copySdkToDocuments(packagedSdkDir, targetDir);
    }
    mkdirSync(hiveDir, { recursive: true });
    writeFileSync(versionFilePath, packagedVersion);

    const installedFiles = listInstalledFiles(sdkTargetDir);
    Logger.log(
      'SDK',
      `SDK v${packagedVersion} deployed. Updated ${staleDirs.length} location(s). Files: ${installedFiles.join(', ')}`,
    );
  } catch (err: any) {
    Logger.warn('SDK', `SDK deploy failed: ${err.message}`);
  }
}
