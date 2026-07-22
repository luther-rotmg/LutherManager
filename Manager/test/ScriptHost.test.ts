import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ScriptHost } from '../src/scripts/ScriptHost.js';

test('the same script package can run independently on two headless accounts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'luther-script-host-'));
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const scriptRoot = join(root, 'Documents', 'Luther', 'Scripts', 'demo');
  mkdirSync(scriptRoot, { recursive: true });
  writeFileSync(join(scriptRoot, 'hive.script.json'), JSON.stringify({
    name: 'Demo',
    developer: 'Test',
    version: '1.0.0',
    entry: 'main.mjs',
  }));
  writeFileSync(join(scriptRoot, 'main.mjs'), `
    export default class Demo {
      onStart() {}
      onLoop() { return 10000; }
      onStop() {}
    }
  `);

  const host = new ScriptHost({ scriptId: undefined });
  try {
    assert.deepEqual(await host.start('demo', 'account-a'), { ok: true });
    assert.deepEqual(await host.start('demo', 'account-b'), { ok: true });
    assert.equal(host.isRunning('demo', 'account-a'), true);
    assert.equal(host.isRunning('demo', 'account-b'), true);
    assert.deepEqual(
      host.list()[0]?.runs?.map((run) => run.accountId).sort(),
      ['account-a', 'account-b'],
    );

    assert.deepEqual(await host.start('demo', 'account-a'), {
      ok: false,
      error: 'Already running for this account',
    });
    const concurrent = await Promise.all([
      host.start('demo', 'account-c'),
      host.start('demo', 'account-c'),
    ]);
    assert.equal(concurrent.filter((result) => result.ok).length, 1);
    assert.equal(concurrent.filter((result) => !result.ok).length, 1);
    assert.deepEqual(host.stop('demo', 'account-c'), { ok: true });
    assert.deepEqual(host.stop('demo', 'account-a'), { ok: true });
    assert.equal(host.isRunning('demo', 'account-a'), false);
    assert.equal(host.isRunning('demo', 'account-b'), true);
    assert.deepEqual(host.list()[0]?.runs?.map((run) => run.accountId), ['account-b']);
  } finally {
    host.stopAll();
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test('ScriptHost falls back to Documents/Hive/Scripts when Documents/Luther/Scripts is absent', async () => {
  // Simulates a pre-P1-rename Hive install upgrading to LutherManager: the user's scripts
  // live at Documents/Hive/Scripts and Documents/Luther/Scripts doesn't exist yet.
  // ScriptHost must find the legacy dir instead of returning empty.
  const root = mkdtempSync(join(tmpdir(), 'luther-script-host-fallback-'));
  const previousUserProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = root;
  const legacyScriptRoot = join(root, 'Documents', 'Hive', 'Scripts', 'legacy-demo');
  mkdirSync(legacyScriptRoot, { recursive: true });
  writeFileSync(join(legacyScriptRoot, 'hive.script.json'), JSON.stringify({
    name: 'Legacy Demo',
    developer: 'Test',
    version: '1.0.0',
    entry: 'main.mjs',
  }));
  writeFileSync(join(legacyScriptRoot, 'main.mjs'), `
    export default class LegacyDemo {
      onStart() {}
      onLoop() { return 10000; }
      onStop() {}
    }
  `);

  const host = new ScriptHost({ scriptId: undefined });
  try {
    const installed = host.list();
    assert.equal(installed.length, 1, 'ScriptHost must discover the legacy-dir script via fallback');
    assert.equal(installed[0]?.id, 'legacy-demo');
    assert.deepEqual(await host.start('legacy-demo', 'account-fallback'), { ok: true },
      'ScriptHost must be able to start a script found via the fallback');
    assert.equal(host.isRunning('legacy-demo', 'account-fallback'), true);
  } finally {
    host.stopAll();
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
