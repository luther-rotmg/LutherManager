import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ScriptHost } from '../src/scripts/ScriptHost.js';

test('local script restart reloads the complete nested module graph', async () => {
  const previousProfile = process.env.USERPROFILE;
  const profile = mkdtempSync(join(tmpdir(), 'luther-script-reload-'));
  const scriptRoot = join(profile, 'Documents', 'Luther', 'Scripts', 'reload-probe');
  mkdirSync(scriptRoot, { recursive: true });
  writeFileSync(join(scriptRoot, 'hive.script.json'), JSON.stringify({
    name: 'Reload Probe',
    developer: 'Test',
    version: '1.0.0',
    entry: 'entry.mjs',
  }));
  writeFileSync(join(scriptRoot, 'entry.mjs'), `
    import { value } from './value.mjs';
    export default class ReloadProbe {
      onStart() { globalThis.__hiveReloadProbe = value; }
      onLoop() { return 1000; }
      onStop() {}
    }
  `);
  writeFileSync(join(scriptRoot, 'value.mjs'), 'export const value = 1;\n');
  process.env.USERPROFILE = profile;

  try {
    const host = new ScriptHost({ scriptId: undefined });
    assert.deepEqual(await host.start('reload-probe'), { ok: true });
    assert.equal((globalThis as { __hiveReloadProbe?: number }).__hiveReloadProbe, 1);
    assert.deepEqual(host.stop('reload-probe'), { ok: true });

    writeFileSync(join(scriptRoot, 'value.mjs'), 'export const value = 2;\n');
    assert.deepEqual(await host.start('reload-probe'), { ok: true });
    assert.equal((globalThis as { __hiveReloadProbe?: number }).__hiveReloadProbe, 2);
    assert.deepEqual(host.stop('reload-probe'), { ok: true });

    const runtimeBase = join(profile, 'Documents', 'Luther', 'ScriptRuntime');
    assert.deepEqual(readdirSync(runtimeBase), []);
  } finally {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    delete (globalThis as { __hiveReloadProbe?: number }).__hiveReloadProbe;
    rmSync(profile, { recursive: true, force: true });
  }
});
