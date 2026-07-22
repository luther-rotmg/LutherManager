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
