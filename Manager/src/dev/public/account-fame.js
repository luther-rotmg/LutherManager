import fameBonuses from './eam-fame-bonuses.js';
import playerStats from './eam-player-stats.js';

var MAXED_STAT_MAP = {
  health: 'maxHp',
  magic: 'maxMp',
  attack: 'attack',
  defense: 'defense',
  speed: 'speed',
  dexterity: 'dexterity',
  vitality: 'vitality',
  wisdom: 'wisdom',
};

function parsePcStats(encoded) {
  var source = String(encoded || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!source) return [];
  while (source.length % 4) source += '=';

  var bytes;
  try {
    var binary = atob(source);
    bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  } catch (_err) {
    return [];
  }
  if (bytes.length < 20) return [];

  function readLayout(flagsEnd) {
    if (flagsEnd > bytes.length || (flagsEnd - 4) % 4 !== 0) return null;
    var flagged = [];
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var flagWordCount = (flagsEnd - 4) / 4;
    for (var wordIndex = 0; wordIndex < flagWordCount; wordIndex += 1) {
      var word = view.getUint32(4 + (wordIndex * 4), false);
      for (var bit = 0; bit < 32; bit += 1) {
        if ((word & (1 << bit)) !== 0) flagged.push((wordIndex * 32) + bit);
      }
    }

    var offset = flagsEnd;
    var values = [];
    while (offset < bytes.length) {
      var first = bytes[offset];
      offset += 1;
      if (first < 0x40) {
        values.push(first);
        continue;
      }
      if (first < 0x80 || first > 0xbf) return null;
      var value = first & 0x3f;
      var shift = 6;
      var complete = false;
      while (offset < bytes.length) {
        var next = bytes[offset];
        offset += 1;
        value += (next & 0x7f) * Math.pow(2, shift);
        if ((next & 0x80) === 0) {
          complete = true;
          break;
        }
        shift += 7;
      }
      if (!complete) return null;
      values.push(value);
    }
    return flagged.length === values.length ? { flagged: flagged, values: values } : null;
  }

  // PCStats format 0x0d has four 32-bit flag words. Format 0x0e expanded
  // that vector to eight words, moving the first encoded value from byte 20
  // to byte 36. Validate both counts so an unknown format cannot produce a
  // believable but wildly incorrect fame prediction.
  var preferredFlagsEnd = bytes[0] >= 0x0e ? 36 : 20;
  var candidates = [preferredFlagsEnd, 20, 36, 68, 132].filter(function (value, index, list) {
    return value <= bytes.length && list.indexOf(value) === index;
  });
  var layout = null;
  for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    layout = readLayout(candidates[candidateIndex]);
    if (layout) break;
  }
  if (!layout) return [];
  var flagged = layout.flagged;
  var values = layout.values;

  return Object.keys(playerStats).map(function (key) {
    var statType = Number(key);
    var valueIndex = flagged.indexOf(statType);
    var definition = playerStats[key];
    return {
      statType: statType,
      short: definition.short,
      name: definition.name,
      isDungeon: !!definition.isDungeon,
      value: valueIndex >= 0 && Number.isFinite(values[valueIndex]) ? values[valueIndex] : 0,
    };
  });
}

function buildStatLookup(stats) {
  return stats.reduce(function (lookup, stat) {
    lookup[stat.short] = stat.value;
    return lookup;
  }, Object.create(null));
}

function isCharacterStatMaxed(character, statName) {
  var key = MAXED_STAT_MAP[statName];
  if (!key) return false;
  var value = Number(character && character[key]);
  var cap = Number(character && character.statMaxes && character.statMaxes[key]);
  return Number.isFinite(value) && Number.isFinite(cap) && cap > 0 && value >= cap;
}

function isConditionMet(condition, lookup, character) {
  if (condition.type === 'StatValue') return Number(lookup[condition.stat] || 0) >= Number(condition.threshold || 0);
  if (condition.type === 'MaxedStat') return isCharacterStatMaxed(character, condition.stat);
  if (condition.type === 'FirstCharacter') return Number(character && character.charId) === 0;
  return false;
}

function conditionProgress(condition, lookup, character, multiplier) {
  if (condition.type === 'StatValue') {
    var threshold = Number(condition.threshold || 0) * Math.max(1, Number(multiplier || 1));
    var current = Number(lookup[condition.stat] || 0);
    return {
      type: condition.type,
      stat: condition.stat,
      current: current,
      threshold: threshold,
      complete: current >= threshold,
    };
  }
  if (condition.type === 'MaxedStat') {
    return {
      type: condition.type,
      stat: condition.stat,
      complete: isCharacterStatMaxed(character, condition.stat),
    };
  }
  return {
    type: condition.type,
    stat: condition.stat || '',
    complete: isConditionMet(condition, lookup, character),
  };
}

function isTieredCategory(entries) {
  if (entries.length <= 1) return true;
  return entries.every(function (entry) {
    return entry.conditions.length === 1 && entry.conditions[0].type === 'StatValue';
  }) && new Set(entries.map(function (entry) { return entry.conditions[0].stat; })).size === 1;
}

function minimumThreshold(entry) {
  return entry.conditions.reduce(function (minimum, condition) {
    return Math.min(minimum, Number(condition.threshold || 0));
  }, Infinity);
}

function analyzeCategory(entries, lookup, character) {
  var sorted = entries.slice().sort(function (left, right) {
    return minimumThreshold(left) - minimumThreshold(right);
  });
  var tiered = isTieredCategory(sorted);
  var absoluteBonus = 0;
  var relativeBonus = 0;
  var highestAchieved = null;
  var nextGoals = [];
  var achievedEntries = [];

  for (var entryIndex = 0; entryIndex < sorted.length; entryIndex += 1) {
    var entry = sorted[entryIndex];
    if (entry.repeatable && Number(entry.maxRepeatCount) > 0 && entry.conditions.length === 1 && entry.conditions[0].type === 'StatValue') {
      var repeatCondition = entry.conditions[0];
      var repeatThreshold = Number(repeatCondition.threshold || 0);
      var times = repeatThreshold > 0
        ? Math.min(Math.floor(Number(lookup[repeatCondition.stat] || 0) / repeatThreshold), Number(entry.maxRepeatCount))
        : 0;
      if (times > 0) {
        absoluteBonus += Number(entry.absoluteBonus || 0) * times;
        relativeBonus += Number(entry.relativeBonus || 0) * times;
        highestAchieved = entry.displayName.replace('{0}', String(times));
        achievedEntries.push({ name: highestAchieved, count: times });
      }
      if (times < Number(entry.maxRepeatCount) && nextGoals.length === 0) {
        nextGoals.push({
          name: entry.displayName.replace('{0}', String(times + 1)),
          absoluteBonus: Number(entry.absoluteBonus || 0),
          relativeBonus: Number(entry.relativeBonus || 0),
          conditions: [conditionProgress(repeatCondition, lookup, character, times + 1)],
        });
      }
      continue;
    }

    var conditions = entry.conditions.map(function (condition) {
      return conditionProgress(condition, lookup, character, 1);
    });
    var achieved = conditions.every(function (condition) { return condition.complete; });
    if (achieved) {
      absoluteBonus += Number(entry.absoluteBonus || 0);
      relativeBonus += Number(entry.relativeBonus || 0);
      highestAchieved = entry.displayName;
      achievedEntries.push({ name: entry.displayName, count: 1 });
    } else {
      nextGoals.push({
        name: entry.displayName,
        absoluteBonus: Number(entry.absoluteBonus || 0),
        relativeBonus: Number(entry.relativeBonus || 0),
        conditions: conditions,
      });
      if (tiered) break;
    }
  }

  return {
    absoluteBonus: absoluteBonus,
    relativeBonus: relativeBonus,
    highestAchieved: highestAchieved,
    achievedEntries: achievedEntries,
    nextGoals: nextGoals,
  };
}

function analyze(character) {
  var encoded = String(character && character.pcStats || '');
  if (!encoded) return null;
  var stats = parsePcStats(encoded);
  if (!stats.length) return null;
  var lookup = buildStatLookup(stats);
  var absoluteBonus = 0;
  var relativeBonus = 0;
  var groups = [];

  Object.keys(fameBonuses).forEach(function (groupName) {
    var categories = [];
    Object.keys(fameBonuses[groupName]).forEach(function (categoryName) {
      var result = analyzeCategory(fameBonuses[groupName][categoryName], lookup, character);
      absoluteBonus += result.absoluteBonus;
      relativeBonus += result.relativeBonus;
      categories.push(Object.assign({ name: categoryName }, result));
    });
    groups.push({ name: groupName, categories: categories });
  });

  var currentFame = Math.max(0, Number(character && character.fame || 0));
  var relativeFame = Math.ceil(currentFame * relativeBonus / 100);
  return {
    currentFame: currentFame,
    absoluteBonus: absoluteBonus,
    relativeBonus: relativeBonus,
    relativeFame: relativeFame,
    predictedFame: currentFame + absoluteBonus + relativeFame,
    groups: groups,
    dungeons: stats.filter(function (stat) { return stat.isDungeon; }),
    otherStats: stats.filter(function (stat) { return !stat.isDungeon; }),
    statNames: stats.reduce(function (names, stat) {
      names[stat.short] = stat.name;
      return names;
    }, Object.create(null)),
  };
}

export { analyze, parsePcStats };

if (typeof window !== 'undefined') {
  window.EAMAccountFame = { analyze: analyze };
  window.dispatchEvent(new CustomEvent('eam-account-fame-ready'));
}
