(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.HiveMulingItemSearch = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeText(value) {
    var text = String(value || '').trim().toLowerCase();
    if (typeof text.normalize === 'function') {
      text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    }
    return text.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function parseObjectType(value) {
    var raw = String(value || '').trim();
    if (!raw) return null;
    var bracket = raw.match(/\[(0x[0-9a-f]+|\d+)\]\s*$/i);
    var direct = bracket ? bracket[1] : raw;
    var parsed = null;
    if (/^0x[0-9a-f]+$/i.test(direct)) parsed = parseInt(direct.slice(2), 16);
    else if (/^\d+$/.test(direct)) parsed = Number(direct);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 0xffff ? parsed : null;
  }

  function createIndex(items) {
    var source = items && typeof items === 'object' ? items : {};
    return Object.keys(source).map(function (key) {
      var objectType = Number(key);
      var record = source[key];
      if (!Number.isInteger(objectType) || objectType <= 0 || objectType > 0xffff || !record || record[8] === true) {
        return null;
      }
      var name = String(record[0] || ('Object ' + objectType)).trim();
      return {
        objectType: objectType,
        name: name,
        label: name + ' [' + objectType + ']',
        normalizedName: normalizeText(name),
        words: normalizeText(name).split(' ').filter(Boolean),
        decimal: String(objectType),
        hexadecimal: '0x' + objectType.toString(16),
      };
    }).filter(Boolean).sort(function (left, right) {
      return left.name.localeCompare(right.name) || left.objectType - right.objectType;
    });
  }

  function scoreEntry(entry, normalizedQuery, queryWords, parsedObjectType, rawLower) {
    if (parsedObjectType !== null && entry.objectType === parsedObjectType) return -10;
    if (entry.normalizedName === normalizedQuery) return 0;
    if (entry.normalizedName.indexOf(normalizedQuery) === 0) return 1;
    var tokenMatch = queryWords.length > 0 && queryWords.every(function (queryWord) {
      return entry.words.some(function (word) { return word.indexOf(queryWord) === 0; });
    });
    if (tokenMatch) return 2;
    if (entry.normalizedName.indexOf(normalizedQuery) >= 0) return 3;
    if (entry.decimal.indexOf(rawLower) === 0 || entry.hexadecimal.indexOf(rawLower) === 0) return 4;
    return null;
  }

  function search(index, query, limit) {
    var raw = String(query || '').trim();
    if (!raw) return [];
    var normalizedQuery = normalizeText(raw.replace(/\[(?:0x[0-9a-f]+|\d+)\]\s*$/i, ''));
    var rawLower = raw.toLowerCase();
    var queryWords = normalizedQuery.split(' ').filter(Boolean);
    var parsedObjectType = parseObjectType(raw);
    var max = Math.max(1, Math.trunc(Number(limit) || 8));
    return (Array.isArray(index) ? index : []).map(function (entry) {
      return { entry: entry, score: scoreEntry(entry, normalizedQuery, queryWords, parsedObjectType, rawLower) };
    }).filter(function (result) {
      return result.score !== null;
    }).sort(function (left, right) {
      return left.score - right.score
        || left.entry.words.length - right.entry.words.length
        || left.entry.name.localeCompare(right.entry.name)
        || left.entry.objectType - right.entry.objectType;
    }).slice(0, max).map(function (result) {
      return result.entry;
    });
  }

  function resolve(index, value) {
    var parsed = parseObjectType(value);
    if (parsed !== null) return parsed;
    var normalized = normalizeText(value);
    var exact = (Array.isArray(index) ? index : []).find(function (entry) {
      return entry.normalizedName === normalized;
    });
    return exact ? exact.objectType : null;
  }

  return {
    normalizeText: normalizeText,
    parseObjectType: parseObjectType,
    createIndex: createIndex,
    search: search,
    resolve: resolve,
  };
}));
