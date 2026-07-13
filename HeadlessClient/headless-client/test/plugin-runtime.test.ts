import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '../src/client';
import { ManagedPluginRuntime, PluginLifecycle } from '../src/plugin-runtime';

test('ManagedPluginRuntime catches sync and async failures', async () => {
  const errors: string[] = [];
  const lifecycle: PluginLifecycle = {
    onError: (_client, _runtime, error, context) => {
      errors.push(`${context}:${(error as Error).message}`);
    },
  };
  const runtime = new ManagedPluginRuntime('TestPlugin', fakeClient(), lifecycle);

  runtime.run('syncHook', () => {
    throw new Error('sync boom');
  });
  runtime.run('asyncHook', async () => {
    throw new Error('async boom');
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ['syncHook:sync boom', 'asyncHook:async boom']);
});

test('ManagedPluginRuntime clears owned timers on dispose', async () => {
  let fired = false;
  const runtime = new ManagedPluginRuntime('TimerPlugin', fakeClient(), {});
  runtime.setTimeout(() => {
    fired = true;
  }, 5);
  runtime.dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(fired, false);
});

test('ManagedPluginRuntime resolves sleeps on dispose', async () => {
  const runtime = new ManagedPluginRuntime('SleepPlugin', fakeClient(), {});
  let resolved = false;
  const sleeping = runtime.sleep(1000).then(() => {
    resolved = true;
  });
  runtime.dispose();
  await sleeping;

  assert.equal(resolved, true);
});

test('ManagedPluginRuntime waitUntil resolves on success and timeout', async () => {
  const runtime = new ManagedPluginRuntime('WaitPlugin', fakeClient(), {});
  let checks = 0;
  assert.equal(await runtime.waitUntil(() => ++checks >= 3, 100, 1), true);
  assert.ok(checks >= 3);
  assert.equal(await runtime.waitUntil(() => false, 5, 1), false);
  runtime.dispose();
  assert.equal(runtime.isDisposed, true);
});

function fakeClient(): Client {
  return { alias: 'test' } as Client;
}
