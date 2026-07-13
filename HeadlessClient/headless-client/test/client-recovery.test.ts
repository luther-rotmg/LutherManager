import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backoffDelay, classifyFailure } from '../src/client';

test('classifyFailure distinguishes rate-limit, auth, fatal, and transient failures', () => {
  assert.equal(classifyFailure('You are banned for abuse'), 'rate-limited');
  assert.equal(classifyFailure('Too many connections, try again later'), 'rate-limited');
  assert.equal(classifyFailure('Access token not verified'), 'auth');
  assert.equal(classifyFailure('Invalid account credentials'), 'auth');
  assert.equal(classifyFailure('Your client is out of date, please upgrade'), 'fatal');
  assert.equal(classifyFailure('Unexpected server error'), 'transient');
  assert.equal(classifyFailure(''), 'transient');
});

test('backoffDelay stays within [base, min(base*2^attempt, max)] and respects the ceiling', () => {
  const base = 1000;
  const max = 60_000;
  for (let attempt = 0; attempt < 12; attempt++) {
    const ceiling = Math.min(base * 2 ** attempt, max);
    for (let i = 0; i < 50; i++) {
      const delay = backoffDelay(attempt, base, max);
      assert.ok(delay >= base, `delay ${delay} below base at attempt ${attempt}`);
      assert.ok(delay <= ceiling + 1e-9, `delay ${delay} above ceiling ${ceiling} at attempt ${attempt}`);
    }
  }
});

test('backoffDelay first attempt has no jitter room and equals the base', () => {
  assert.equal(backoffDelay(0, 1000, 60_000), 1000);
});
