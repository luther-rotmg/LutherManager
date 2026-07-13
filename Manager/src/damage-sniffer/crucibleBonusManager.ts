/**
 * Port of Tomato {@code CrucibleBonusManager} — type-5 damage multipliers from crucible JSON.
 */

const crucibleDamageMultipliers = new Map<string, number>();
let currentPlayerCrucibleId128: string | null = null;
let currentPlayerCrucibleId155: string | null = null;

function findAndStoreType5Bonuses(element: unknown, crucibleId: string): void {
  if (element == null || crucibleId == null) return;
  if (crucibleDamageMultipliers.has(crucibleId)) return;

  if (typeof element === 'object' && element !== null && !Array.isArray(element)) {
    const obj = element as Record<string, unknown>;
    const bonuses = obj.bonuses;
    if (Array.isArray(bonuses)) {
      for (const bonusElement of bonuses) {
        if (
          bonusElement &&
          typeof bonusElement === 'object' &&
          (bonusElement as { type?: number }).type === 5 &&
          'amount' in (bonusElement as object)
        ) {
          const amount = Number((bonusElement as { amount: unknown }).amount);
          if (Number.isFinite(amount)) {
            crucibleDamageMultipliers.set(crucibleId, amount);
            return;
          }
        }
      }
    }
    for (const v of Object.values(obj)) {
      findAndStoreType5Bonuses(v, crucibleId);
      if (crucibleDamageMultipliers.has(crucibleId)) return;
    }
  } else if (Array.isArray(element)) {
    for (const el of element) {
      findAndStoreType5Bonuses(el, crucibleId);
      if (crucibleDamageMultipliers.has(crucibleId)) return;
    }
  }
}

function processJsonData(jsonData: string): void {
  let root: unknown;
  try {
    root = JSON.parse(jsonData) as unknown;
  } catch {
    return;
  }
  crucibleDamageMultipliers.clear();
  if (!Array.isArray(root)) return;

  for (const crucibleJsonElement of root) {
    if (!crucibleJsonElement || typeof crucibleJsonElement !== 'object') continue;
    const arr = (crucibleJsonElement as { array?: unknown }).array;
    if (!Array.isArray(arr)) continue;
    for (const element of arr) {
      if (!element || typeof element !== 'object') continue;
      const id = (element as { id?: unknown }).id;
      if (typeof id === 'string') {
        findAndStoreType5Bonuses(element, id);
      }
    }
  }
}

export function processCrucibleJsonStrings(...parts: string[]): void {
  for (const s of parts) {
    if (typeof s === 'string' && s.trim().length > 0 && (s.includes('"array"') || s.includes('"id"'))) {
      processJsonData(s);
      return;
    }
  }
}

function getMultiplierForId(crucibleId: string | null): number {
  if (crucibleId == null) return 1;
  return crucibleDamageMultipliers.get(crucibleId) ?? 1;
}

export function getPlayerCrucibleDamageMultiplier(): number {
  return getMultiplierForId(currentPlayerCrucibleId128) * getMultiplierForId(currentPlayerCrucibleId155);
}

export function updatePlayerCrucibleFromStats(stats: Record<string, number | string> | undefined): void {
  if (!stats) return;
  const s128 = stats['128'];
  const s155 = stats['155'];
  if (typeof s128 === 'string' && s128.length > 0) currentPlayerCrucibleId128 = s128;
  if (typeof s155 === 'string' && s155.length > 0) currentPlayerCrucibleId155 = s155;
}

export function clearCrucibleState(): void {
  crucibleDamageMultipliers.clear();
  currentPlayerCrucibleId128 = null;
  currentPlayerCrucibleId155 = null;
}
