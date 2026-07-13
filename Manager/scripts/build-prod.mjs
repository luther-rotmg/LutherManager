/**
 * Production build for Hive Manager (no DLL / plugins).
 *
 * Pipeline:
 *   1. Clean dist/
 *   2. Bundle core app with esbuild
 *   3. Obfuscate core JS
 *   4. Copy dashboard public assets
 *   5. Generate dist/integrity.json
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync, existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { createHash } from 'crypto';
import JavaScriptObfuscator from 'javascript-obfuscator';

const ADMIN_BUILD = process.argv.includes('--admin');

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const DATA_DIR = join(ROOT, 'data');

const PACKET_DEFINITIONS_JSON = readFileSync(join(DATA_DIR, 'packet-definitions.json'), 'utf8');
const STAT_TYPES_JSON = readFileSync(join(DATA_DIR, 'stat-types.json'), 'utf8');
const SERVERS_JSON = readFileSync(join(DATA_DIR, 'servers.json'), 'utf8');

const OBFUSCATOR_CORE_CONFIG = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.4,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.15,
  debugProtection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

function log(msg) {
  console.log(`[build-prod] ${msg}`);
}

function fileSize(path) {
  try { return (statSync(path).size / 1024).toFixed(1) + ' KB'; }
  catch { return '?'; }
}

log(`Build mode: ${ADMIN_BUILD ? 'ADMIN' : 'USER'}`);
log('Cleaning dist/...');
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

log('Bundling core application...');
await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(DIST, 'app.cjs'),
  minify: true,
  sourcemap: false,
  treeShaking: true,
  external: ['koffi', 'sharp', 'electron'],
  banner: {
    js: 'var __importMetaUrl=require("url").pathToFileURL(__filename).href;',
  },
  define: {
    PRODUCTION: '"true"',
    __ADMIN_BUILD__: String(ADMIN_BUILD),
    __PACKET_DEFINITIONS_JSON__: JSON.stringify(PACKET_DEFINITIONS_JSON),
    __STAT_TYPES_JSON__: JSON.stringify(STAT_TYPES_JSON),
    __SERVERS_JSON__: JSON.stringify(SERVERS_JSON),
    'import.meta.url': '__importMetaUrl',
  },
  logLevel: 'warning',
});
log(`Core bundled: ${fileSize(join(DIST, 'app.cjs'))}`);

log('Obfuscating core...');
const appCode = readFileSync(join(DIST, 'app.cjs'), 'utf-8');
const obfuscatedApp = JavaScriptObfuscator.obfuscate(appCode, OBFUSCATOR_CORE_CONFIG).getObfuscatedCode();
writeFileSync(join(DIST, 'app.cjs'), obfuscatedApp);
log(`Core obfuscated: ${fileSize(join(DIST, 'app.cjs'))}`);

const PUBLIC_SRC = join(ROOT, 'src', 'dev', 'public');
const PUBLIC_DIST = join(DIST, 'public');
mkdirSync(PUBLIC_DIST, { recursive: true });
for (const f of readdirSync(PUBLIC_SRC)) {
  const src = join(PUBLIC_SRC, f);
  if (statSync(src).isFile()) copyFileSync(src, join(PUBLIC_DIST, f));
}
for (const f of readdirSync(PUBLIC_SRC)) {
  const src = join(PUBLIC_SRC, f);
  if (statSync(src).isDirectory()) {
    const destDir = join(PUBLIC_DIST, f);
    mkdirSync(destDir, { recursive: true });
    for (const sub of readdirSync(src)) {
      const subSrc = join(src, sub);
      if (statSync(subSrc).isFile()) copyFileSync(subSrc, join(destDir, sub));
    }
  }
}

{
  const appJsPath = join(PUBLIC_DIST, 'app.js');
  if (existsSync(appJsPath)) {
    let js = readFileSync(appJsPath, 'utf-8');
    js = `var __ADMIN_BUILD__=${ADMIN_BUILD};\n` + js;
    writeFileSync(appJsPath, js);
  }
  log(ADMIN_BUILD ? 'Admin build — all features enabled' : 'User build — admin features locked');
}

log('Generating integrity manifest...');

function hashFile(filePath) {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

const MANIFEST_FILES = [
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/security.cjs',
  'electron/loading.html',
  'dist/app.cjs',
];

const manifest = MANIFEST_FILES.map(relPath => {
  const fullPath = resolve(ROOT, relPath.replace(/\//g, process.platform === 'win32' ? '\\' : '/'));
  if (!existsSync(fullPath)) {
    console.error(`[build-prod] ERROR: manifest target not found: ${fullPath}`);
    process.exit(1);
  }
  return { path: relPath, sha256: hashFile(fullPath) };
});

writeFileSync(join(DIST, 'integrity.json'), JSON.stringify(manifest, null, 2));
log(`Integrity manifest written: dist/integrity.json (${manifest.length} entries)`);

log('');
log('Production build complete!');
log(`  Core:      dist/app.cjs (${fileSize(join(DIST, 'app.cjs'))})`);
log(`  Integrity: dist/integrity.json (${manifest.length} entries)`);
log('');
log('Run "npm run dist" to package with electron-builder.');
