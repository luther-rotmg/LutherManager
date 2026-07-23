import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/dev/public/muling-item-search.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const searchApi = context.globalThis.HiveMulingItemSearch;

const index = searchApi.createIndex({
  2591: ['Potion of Attack'],
  2592: ['Potion of Defense'],
  9064: ['Greater Potion of Attack'],
  1234: ['Sword of the Colossus'],
  7777: ['Soulbound Test Item', null, null, null, null, null, null, null, true],
});

test('muling item search matches out-of-order words and partial names', () => {
  assert.deepEqual(
    Array.from(searchApi.search(index, 'attack pot', 8), (item) => item.objectType),
    [2591, 9064],
  );
  assert.equal(searchApi.search(index, 'coloss', 8)[0].objectType, 1234);
});

test('muling item search resolves labels, decimal ids, and hexadecimal ids', () => {
  assert.equal(searchApi.resolve(index, 'Potion of Defense [2592]'), 2592);
  assert.equal(searchApi.resolve(index, '2591'), 2591);
  assert.equal(searchApi.resolve(index, '0x2388'), 9096);
  assert.equal(searchApi.resolve(index, 'Potion of Attack'), 2591);
});

test('muling item search omits records marked untradeable', () => {
  assert.equal(index.some((item) => item.objectType === 7777), false);
});
