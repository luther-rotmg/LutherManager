import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import type { PacketTraffic } from 'headless-client';
import { RuntimeDiagnostics } from '../src/mcp/RuntimeDiagnostics.js';

function fakePacket(direction: 'incoming' | 'outgoing', type: string, size = 16): PacketTraffic {
  return {
    direction,
    id: 42,
    type,
    size,
    timestamp: Date.now(),
    payload: Buffer.alloc(size),
  } as unknown as PacketTraffic;
}

test('recentLogs clamps limit to 1000 and preserves monotonic seq across large pushes', () => {
  const diag = new RuntimeDiagnostics();
  const LOG_HISTORY_LIMIT = 2_000;
  // Push LIMIT+5 entries. Eviction is a memory-side invariant not observable via
  // the public API (recentLogs caps output at 1000), so we cover the *observable*
  // guarantees here: (a) recentLogs never returns more than the clamp max, (b) seq
  // monotonically continues past the buffer size (i.e., the counter never wraps).
  for (let i = 0; i < LOG_HISTORY_LIMIT + 5; i++) {
    diag.appendScriptLog('probe', `entry-${i}`, 'info');
  }
  const clampedHigh = diag.recentLogs({ limit: 5_000 });
  assert.equal(clampedHigh.length, 1_000,
    'limit above the max ceiling (1000) must clamp, not return everything');
  const clampedDefault = diag.recentLogs();
  assert.equal(clampedDefault.length, 200,
    'default limit is 200 per clampLimit fallback');
  // Newest seq must be LIMIT+5 — the counter increments across every push regardless of eviction.
  const [newest] = diag.recentLogs({ limit: 1 });
  assert.equal(newest?.seq, LOG_HISTORY_LIMIT + 5, 'seq counter must not wrap or reset');
});

test('recentPackets clamps limit to PACKET_HISTORY_LIMIT and preserves monotonic seq', () => {
  const diag = new RuntimeDiagnostics();
  const PACKET_HISTORY_LIMIT = 500;
  for (let i = 0; i < PACKET_HISTORY_LIMIT + 3; i++) {
    diag.appendPacket('account-x', fakePacket('incoming', `TYPE_${i}`));
  }
  const clampedHigh = diag.recentPackets({ limit: 5_000 });
  assert.equal(clampedHigh.length, PACKET_HISTORY_LIMIT,
    'limit above the max ceiling must clamp to PACKET_HISTORY_LIMIT');
  const [newest] = diag.recentPackets({ limit: 1 });
  assert.equal(newest?.seq, PACKET_HISTORY_LIMIT + 3, 'packet seq counter must not wrap');
});

test('clear() with no accountId wipes everything and returns counts as of the wipe', () => {
  const diag = new RuntimeDiagnostics();
  for (let i = 0; i < 10; i++) diag.appendScriptLog('s', `m${i}`, 'info', 'account-a');
  for (let i = 0; i < 5; i++) diag.appendPacket('account-a', fakePacket('outgoing', 'X'));
  const result = diag.clear();
  assert.deepEqual(result, { logsRemoved: 10, packetsRemoved: 5 });
  assert.equal(diag.recentLogs().length, 0);
  assert.equal(diag.recentPackets().length, 0);
});

test('clear(accountId) removes only that account and preserves other accounts', () => {
  const diag = new RuntimeDiagnostics();
  for (let i = 0; i < 4; i++) diag.appendScriptLog('s', `a-${i}`, 'info', 'account-a');
  for (let i = 0; i < 3; i++) diag.appendScriptLog('s', `b-${i}`, 'info', 'account-b');
  for (let i = 0; i < 2; i++) diag.appendPacket('account-a', fakePacket('incoming', 'X'));
  for (let i = 0; i < 6; i++) diag.appendPacket('account-b', fakePacket('outgoing', 'Y'));

  const result = diag.clear('account-a');
  assert.deepEqual(result, { logsRemoved: 4, packetsRemoved: 2 },
    'only account-a entries counted as removed');

  const remainingLogs = diag.recentLogs();
  assert.equal(remainingLogs.length, 3, 'account-b logs must be preserved');
  for (const entry of remainingLogs) {
    assert.equal(entry.accountId, 'account-b', 'no account-a log should survive the scoped clear');
  }
  const remainingPackets = diag.recentPackets();
  assert.equal(remainingPackets.length, 6, 'account-b packets must be preserved');
  for (const entry of remainingPackets) {
    assert.equal(entry.accountId, 'account-b');
  }
});

test('recentLogs afterSeq/accountId/levels/contains filter compose correctly', () => {
  const diag = new RuntimeDiagnostics();
  diag.appendScriptLog('s', 'apple pie', 'info', 'account-a');       // seq 1
  diag.appendScriptLog('s', 'banana bread', 'warn', 'account-a');    // seq 2
  diag.appendScriptLog('s', 'apple crisp', 'error', 'account-b');    // seq 3
  diag.appendScriptLog('s', 'cherry tart', 'info', 'account-b');     // seq 4
  diag.appendScriptLog('s', 'apple ROLL', 'info', 'account-a');      // seq 5 — ROLL uppercase-tests case-insensitivity

  // account-a AND contains "apple" AND after seq 1 -> seq 5 only.
  const filtered = diag.recentLogs({
    accountId: 'account-a',
    contains: 'apple',
    afterSeq: 1,
  });
  assert.equal(filtered.length, 1, 'compound filter must narrow to exactly one');
  assert.equal(filtered[0]?.seq, 5);

  // levels filter — warning + error only (skips info).
  const errorsAndWarnings = diag.recentLogs({ levels: ['warning', 'error'] });
  assert.equal(errorsAndWarnings.length, 2);
  assert.deepEqual(errorsAndWarnings.map((e) => e.seq).sort(), [2, 3]);

  // "warn" input (script-log input level) got mapped to "warning" by appendScriptLog — verify.
  assert.equal(errorsAndWarnings.find((e) => e.seq === 2)?.level, 'warning',
    'appendScriptLog must translate "warn" input to "warning" storage level');
});

test('log listener errors do not disrupt appendLog or drop entries', () => {
  const diag = new RuntimeDiagnostics();
  let notifications = 0;
  const unsub = diag.onLog(() => {
    notifications++;
    throw new Error('listener explosion');
  });
  try {
    diag.appendScriptLog('s', 'still-lands', 'info');
    diag.appendScriptLog('s', 'also-lands', 'info');
  } finally {
    unsub();
  }
  assert.equal(notifications, 2, 'listener fires per entry even after throwing');
  const all = diag.recentLogs();
  assert.equal(all.length, 2, 'listener errors must not swallow log entries');
});
