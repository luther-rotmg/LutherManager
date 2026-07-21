#!/usr/bin/env node
// Emit release/latest.yml for the packaged portable artifact — electron-builder's
// `dist:portable` doesn't produce one (only `dist:installer` / nsis does), so we
// hand-roll it. Reads the built exe under release/, hashes it, and writes the
// manifest the release-channel Worker expects at luther-rotmg.com/api/releases/win/latest.yml.
//
// Usage: node scripts/write-latest.mjs [artifactPath]
//   default artifactPath: release/LutherManager-<version>-x64.exe (matches electron-builder.json
//   artifactName template ${name}-${version}-${arch}.${ext})
//
// Fallback: if the templated path isn't found, scans release/ for the first *.exe.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const managerDir = join(scriptsDir, '..');
const releaseDir = join(managerDir, 'release');
const pkg = JSON.parse(readFileSync(join(managerDir, 'package.json'), 'utf8'));

if (!existsSync(releaseDir)) {
  console.error('[write-latest] release/ does not exist. Run `npm run dist:portable` first.');
  process.exit(1);
}

const explicitPath = process.argv[2];
let artifactPath;
if (explicitPath) {
  artifactPath = existsSync(explicitPath) ? explicitPath : join(managerDir, explicitPath);
} else {
  const templated = join(releaseDir, `${pkg.name}-${pkg.version}-x64.exe`);
  if (existsSync(templated)) {
    artifactPath = templated;
  } else {
    const exes = readdirSync(releaseDir)
      .filter((name) => name.endsWith('.exe') && !name.includes('unpacked'))
      .map((name) => join(releaseDir, name));
    if (exes.length === 0) {
      console.error(`[write-latest] no *.exe found under ${releaseDir}. Run \`npm run dist:portable\`.`);
      process.exit(1);
    }
    if (exes.length > 1) {
      console.warn(`[write-latest] multiple exes found; picking newest by mtime:`);
      exes.forEach((p) => console.warn('  -', basename(p)));
    }
    exes.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    artifactPath = exes[0];
  }
}

if (!existsSync(artifactPath)) {
  console.error(`[write-latest] artifact not found: ${artifactPath}`);
  process.exit(1);
}

console.log('[write-latest] hashing', basename(artifactPath));
const buf = readFileSync(artifactPath);
const sha512 = createHash('sha512').update(buf).digest('base64');
const size = buf.length;
const releaseDate = new Date().toISOString();
const url = basename(artifactPath);

const yaml = [
  `version: ${pkg.version}`,
  `files:`,
  `  - url: ${url}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${url}`,
  `sha512: ${sha512}`,
  `releaseDate: '${releaseDate}'`,
  '',
].join('\n');

const outPath = join(releaseDir, 'latest.yml');
writeFileSync(outPath, yaml, 'utf8');

console.log('[write-latest] wrote', outPath);
console.log(`[write-latest]   version: ${pkg.version}`);
console.log(`[write-latest]   url:     ${url}`);
console.log(`[write-latest]   size:    ${size} bytes (${(size / 1024 / 1024).toFixed(1)} MB)`);
console.log(`[write-latest]   sha512:  ${sha512.slice(0, 24)}...`);
console.log(`[write-latest]   date:    ${releaseDate}`);
console.log('[write-latest]');
console.log('[write-latest] upload with:');
console.log(`[write-latest]   wrangler r2 object put luther-manager-releases/win/${pkg.version}/${url} --file "${artifactPath}" --content-type application/octet-stream --remote`);
console.log(`[write-latest]   wrangler r2 object put luther-manager-releases/win/${url} --file "${artifactPath}" --content-type application/octet-stream --remote`);
console.log(`[write-latest]   wrangler r2 object put luther-manager-releases/win/latest.yml --file "${outPath}" --content-type text/yaml --remote`);
