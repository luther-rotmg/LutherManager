import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Panel } from '@luthermanager/sdk';
import type { BridgeDeps } from '../src/scripts/bridge/BridgeDeps.js';
import { ScriptPanelRegistry } from '../src/scripts/bridge/scriptUi/ScriptPanels.js';

function depsFor(
  configDir: string,
  accountId = 'account-a',
): BridgeDeps {
  return {
    scriptSession: { scriptId: 'persistent-script', accountId },
    getScriptSession: () => ({ scriptId: 'persistent-script', accountId }),
    runInScriptSession: (_session, fn) => fn(),
    scriptPanelConfigDir: configDir,
    emitScriptLog() {},
  } as unknown as BridgeDeps;
}

test('panel autosave restores persistent inputs and runs their handlers', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-panel-config-'));
  try {
    const first = new ScriptPanelRegistry(depsFor(configDir));
    const firstHandle = first.define({
      persistence: { autoSave: true, scope: 'script' },
      widgets: [
        Panel.toggle({ id: 'auto-loot', label: 'Auto loot', value: false, onChange() {} }),
        Panel.slider({ id: 'nexus-hp', label: 'Nexus HP', value: 20, min: 1, max: 100, onChange() {} }),
        Panel.text({ id: 'session-note', label: 'Note', value: 'default', persist: false, onChange() {} }),
        Panel.progress({ id: 'health', value: 0.75 }),
      ],
    });

    first.dispatchEvent(
      { scriptId: 'persistent-script', widgetId: 'auto-loot', kind: 'change', value: true },
      (_scriptId, _accountId, fn) => fn(),
    );
    first.dispatchEvent(
      { scriptId: 'persistent-script', widgetId: 'nexus-hp', kind: 'change', value: 33 },
      (_scriptId, _accountId, fn) => fn(),
    );
    firstHandle.setValue('session-note', 'do not save');
    firstHandle.setValue('health', 0.1);
    first.destroyForScript('persistent-script');

    const restored: Array<[string, unknown]> = [];
    const second = new ScriptPanelRegistry(depsFor(configDir));
    const secondHandle = second.define({
      persistence: { autoSave: true, scope: 'script' },
      widgets: [
        Panel.toggle({ id: 'auto-loot', label: 'Auto loot', value: false,
          onChange: (value) => restored.push(['auto-loot', value]) }),
        Panel.slider({ id: 'nexus-hp', label: 'Nexus HP', value: 20, min: 1, max: 100,
          onChange: (value) => restored.push(['nexus-hp', value]) }),
        Panel.text({ id: 'session-note', label: 'Note', value: 'default', persist: false,
          onChange: (value) => restored.push(['session-note', value]) }),
        Panel.progress({ id: 'health', value: 0.75 }),
      ],
    });

    await Promise.resolve();
    assert.equal(secondHandle.getValue('auto-loot'), true);
    assert.equal(secondHandle.getValue('nexus-hp'), 33);
    assert.equal(secondHandle.getValue('session-note'), 'default');
    assert.equal(secondHandle.getValue('health'), 0.75);
    assert.deepEqual(restored, [['auto-loot', true], ['nexus-hp', 33]]);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('panel named configs can be saved, loaded, listed, and deleted', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-panel-config-'));
  try {
    const changes: number[] = [];
    const registry = new ScriptPanelRegistry(depsFor(configDir));
    const handle = registry.define({
      widgets: [
        Panel.slider({ id: 'nexus-hp', label: 'Nexus HP', value: 20, min: 1, max: 100,
          onChange: (value) => changes.push(value) }),
      ],
    });

    handle.setValue('nexus-hp', 40);
    assert.equal(handle.saveConfig('farming').name, 'farming');
    handle.setValue('nexus-hp', 70);
    assert.equal(handle.saveConfig('bosses').name, 'bosses');
    assert.deepEqual(new Set(handle.listConfigs().map((config) => config.name)), new Set(['farming', 'bosses']));

    assert.equal(handle.loadConfig('farming'), true);
    assert.equal(handle.activeConfig, 'farming');
    assert.equal(handle.getValue('nexus-hp'), 40);
    assert.deepEqual(changes, [40]);
    assert.equal(handle.deleteConfig('bosses'), true);
    assert.deepEqual(handle.listConfigs().map((config) => config.name), ['farming']);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('account-scoped panel configs stay isolated between accounts', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-panel-config-'));
  try {
    const first = new ScriptPanelRegistry(depsFor(configDir, 'account-a'));
    const firstHandle = first.define({
      persistence: { autoSave: true, scope: 'account' },
      widgets: [Panel.toggle({ id: 'auto-aim', label: 'Auto aim', value: false, onChange() {} })],
    });
    firstHandle.setValue('auto-aim', true);
    first.destroyForScript('persistent-script');

    const second = new ScriptPanelRegistry(depsFor(configDir, 'account-b'));
    const secondHandle = second.define({
      persistence: { autoSave: true, scope: 'account' },
      widgets: [Panel.toggle({ id: 'auto-aim', label: 'Auto aim', value: false, onChange() {} })],
    });
    await Promise.resolve();
    assert.equal(secondHandle.getValue('auto-aim'), false);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('two account-bound panels keep state and handlers isolated', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'hive-panel-config-'));
  try {
    let accountId = 'account-a';
    const messages: Array<{ type: string; scriptId: string; accountId?: string }> = [];
    const deps = depsFor(configDir, accountId);
    deps.getScriptSession = () => ({ scriptId: 'persistent-script', accountId });
    deps.emitScriptPanelMessage = (message) => messages.push(message);
    const registry = new ScriptPanelRegistry(deps);
    const clicks: string[] = [];

    const first = registry.define({
      widgets: [Panel.button({ id: 'start-stop', label: 'Start', onClick: () => clicks.push('account-a') })],
    });
    accountId = 'account-b';
    const second = registry.define({
      widgets: [Panel.button({ id: 'start-stop', label: 'Start', onClick: () => clicks.push('account-b') })],
    });

    first.setText('start-stop', 'First running');
    second.setText('start-stop', 'Second running');
    assert.equal(first.getValue('start-stop'), undefined);
    assert.equal(registry.instances().length, 2);
    assert.ok(registry.snapshot('persistent-script', 'account-a'));
    assert.ok(registry.snapshot('persistent-script', 'account-b'));
    assert.deepEqual(
      messages.filter((message) => message.type === 'scriptPanelPatches').map((message) => message.accountId),
      ['account-a', 'account-b'],
    );

    const sessions: Array<string | undefined> = [];
    registry.dispatchEvent(
      { scriptId: 'persistent-script', accountId: 'account-b', widgetId: 'start-stop', kind: 'click' },
      (_scriptId, eventAccountId, fn) => {
        sessions.push(eventAccountId);
        fn();
      },
    );
    assert.deepEqual(clicks, ['account-b']);
    assert.deepEqual(sessions, ['account-b']);

    registry.destroyForScript('persistent-script', 'account-a');
    assert.equal(registry.snapshot('persistent-script', 'account-a'), undefined);
    assert.ok(registry.snapshot('persistent-script', 'account-b'));
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
});
