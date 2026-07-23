import assert from 'node:assert/strict';
import test from 'node:test';
import { analyze, parsePcStats } from '../src/dev/public/account-fame.js';

function encodeValue(value) {
  if (value < 0x40) return [value];
  var bytes = [0x80 | (value & 0x3f)];
  value = Math.floor(value / 0x40);
  while (value >= 0x80) {
    bytes.push(0x80 | (value & 0x7f));
    value = Math.floor(value / 0x80);
  }
  bytes.push(value);
  return bytes;
}

function encodePcStats(version, flagWordCount, valuesByStat) {
  var header = [version, 0xf0, 0xad, 0xba];
  var flags = new Uint8Array(flagWordCount * 4);
  var ordered = Object.keys(valuesByStat).map(Number).sort(function (a, b) { return a - b; });
  ordered.forEach(function (statType) {
    var wordIndex = Math.floor(statType / 32);
    var bitIndex = statType % 32;
    var view = new DataView(flags.buffer);
    view.setUint32(wordIndex * 4, view.getUint32(wordIndex * 4, false) | (1 << bitIndex), false);
  });
  var values = ordered.flatMap(function (statType) { return encodeValue(valuesByStat[statType]); });
  return Buffer.concat([Buffer.from(header), Buffer.from(flags), Buffer.from(values)]).toString('base64');
}

test('PCStats 0x0e reads values after the expanded eight-word flag vector', function () {
  var encoded = encodePcStats(0x0e, 8, { 0: 68945, 6: 729, 20: 74, 80: 2 });
  var stats = parsePcStats(encoded);
  var byType = new Map(stats.map(function (stat) { return [stat.statType, stat.value]; }));

  assert.equal(byType.get(0), 68945);
  assert.equal(byType.get(6), 729);
  assert.equal(byType.get(20), 74);
  assert.equal(byType.get(80), 2);

  var result = analyze({ charId: 370, fame: 163, pcStats: encoded });
  assert.ok(result);
  assert.equal(result.predictedFame, 163);
  assert.equal(result.groups.flatMap(function (group) { return group.categories; })
    .find(function (category) { return category.name === 'Hero Kills'; }).absoluteBonus, 0);
});

test('PCStats 0x0d remains compatible with the legacy four-word flag vector', function () {
  var encoded = encodePcStats(0x0d, 4, { 0: 31, 6: 3 });
  var stats = parsePcStats(encoded);
  var byType = new Map(stats.map(function (stat) { return [stat.statType, stat.value]; }));

  assert.equal(byType.get(0), 31);
  assert.equal(byType.get(6), 3);
  assert.equal(byType.get(80), 0);
});

test('invalid PCStats layouts are rejected instead of producing a prediction', function () {
  var encoded = encodePcStats(0x0e, 8, { 80: 2 });
  var truncated = Buffer.from(encoded, 'base64').subarray(0, -1).toString('base64');

  assert.deepEqual(parsePcStats(truncated), []);
  assert.equal(analyze({ charId: 370, fame: 163, pcStats: truncated }), null);
});
