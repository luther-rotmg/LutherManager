#!/usr/bin/env node
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const publicDir = path.join(__dirname, '..', 'src', 'dev', 'public');

function buildAsset(filename, globalName) {
  const jsPath = path.join(publicDir, filename);
  const jsonPath = path.join(publicDir, filename.replace('.js', '.json'));
  const gzPath = jsonPath + '.gz';

  console.log(`Processing ${filename}...`);

  const src = fs.readFileSync(jsPath, 'utf8');

  const sandbox = { window: {} };
  vm.runInNewContext(src, sandbox);

  const data = sandbox.window[globalName];
  if (data === undefined) {
    throw new Error(`${globalName} was not set in sandbox after evaluating ${filename}`);
  }

  const json = JSON.stringify(data);
  const jsonBytes = Buffer.byteLength(json, 'utf8');
  fs.writeFileSync(jsonPath, json, 'utf8');
  console.log(`  JSON: ${jsonPath} (${(jsonBytes / 1024).toFixed(1)} KB)`);

  const gz = zlib.gzipSync(json, { level: 9 });
  fs.writeFileSync(gzPath, gz);
  console.log(`  GZIP: ${gzPath} (${(gz.length / 1024).toFixed(1)} KB, ${(100 * gz.length / jsonBytes).toFixed(1)}% of JSON)`);
}

buildAsset('eam-assets.js', 'EAMAssets');
buildAsset('eam-enchantments.js', 'EAMEnchantments');

console.log('Done.');
