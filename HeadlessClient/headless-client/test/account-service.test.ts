import assert from 'node:assert/strict';
import { test } from 'node:test';
import axios from 'axios';
import { AppEngineError, classifyError, deleteCharacter, resolveClassType } from '../src/account-service';
import { Classes } from 'realmlib';

test('classifyError returns undefined when there is no <Error> element', () => {
  assert.equal(classifyError('<Success/>'), undefined);
  assert.equal(classifyError('<Account><Name>foo</Name></Account>'), undefined);
});

test('classifyError detects account-in-use and parses the lock seconds', () => {
  const err = classifyError('<Error>Account in use! (143 seconds until timeout)</Error>');
  assert.ok(err instanceof AppEngineError);
  assert.equal(err?.kind, 'account_in_use');
  assert.equal(err?.retryAfterSeconds, 143);
});

test('classifyError detects invalid credentials in its several forms', () => {
  for (const body of [
    '<Error>Credentials not valid.</Error>',
    '<Error>PasswordError</Error>',
    '<Error>Email and password combination was incorrect.</Error>',
  ]) {
    const err = classifyError(body);
    assert.equal(err?.kind, 'credentials');
  }
});

test('classifyError falls back to unknown for unrecognised errors', () => {
  const err = classifyError('<Error>Something exploded</Error>');
  assert.equal(err?.kind, 'unknown');
  assert.equal(err?.detail, 'Something exploded');
});

test('resolveClassType accepts class names and numeric object types', () => {
  assert.equal(resolveClassType('Wizard'), Classes.Wizard);
  assert.equal(resolveClassType('rOgUe'), Classes.Rogue);
  assert.equal(resolveClassType(12345), 12345);
  assert.equal(resolveClassType('not-a-class'), Classes.Wizard);
});

test('deleteCharacter posts accessToken and charId to /char/delete', async () => {
  const original = axios.post;
  const calls: Array<{ url: string; body: string }> = [];
  axios.post = (async (url: string, body: string) => {
    calls.push({ url, body });
    return { status: 200, data: '<Success/>' };
  }) as typeof axios.post;
  try {
    await deleteCharacter('test-token', 42);
  } finally {
    axios.post = original;
  }

  assert.equal(calls[0].url, 'https://www.realmofthemadgod.com/char/delete');
  const form = new URLSearchParams(calls[0].body);
  assert.equal(form.get('accessToken'), 'test-token');
  assert.equal(form.get('charId'), '42');
});

test('deleteCharacter rejects non-success server responses', async () => {
  const original = axios.post;
  axios.post = (async () => ({ status: 200, data: '<Error>Character not found</Error>' })) as typeof axios.post;
  try {
    await assert.rejects(() => deleteCharacter('test-token', 999), /Character not found/);
  } finally {
    axios.post = original;
  }
});
