import type { GameDataLoader } from '../../../game-data/GameDataLoader.js';

export interface TeleportBeaconCandidate {
  objectId: number;
  type: number;
  x: number;
  y: number;
}

const DESTINATION_ALIASES: Readonly<Record<string, string>> = {
  beach: 'shore',
  undead: 'undeadforest',
  coral: 'coralreefs',
  reef: 'coralreefs',
  reefs: 'coralreefs',
  church: 'deadchurch',
  haunted: 'hauntedhallows',
  hallows: 'hauntedhallows',
  shipwreck: 'shipwreckcove',
  cove: 'shipwreckcove',
  sprite: 'spriteforest',
  deepsea: 'deepseaabyss',
  abyss: 'deepseaabyss',
  floral: 'floralescape',
  sanguine: 'sanguineforest',
  runic: 'runictundra',
  tundra: 'runictundra',
};

function normalizeDestination(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^teleport\s*beacon\s*/, '')
    .replace(/[^a-z0-9]/g, '');
}

function destinationForType(gameData: GameDataLoader, objectType: number): string | undefined {
  if (!gameData.isTeleportBeacon(objectType)) return undefined;
  const name = gameData.getObject(objectType)?.id ?? '';
  const destination = normalizeDestination(name);
  return destination || undefined;
}

/** Resolves a user-facing destination to the nearest matching live beacon. */
export function resolveTeleportBeacon(
  destination: string,
  candidates: readonly TeleportBeaconCandidate[],
  gameData: GameDataLoader,
  origin: { x: number; y: number },
): TeleportBeaconCandidate | undefined {
  const query = normalizeDestination(destination);
  if (!query) return undefined;
  const target = DESTINATION_ALIASES[query] ?? query;

  const byDestination = new Map<string, TeleportBeaconCandidate[]>();
  for (const candidate of candidates) {
    const key = destinationForType(gameData, candidate.type);
    if (!key) continue;
    const entries = byDestination.get(key) ?? [];
    entries.push(candidate);
    byDestination.set(key, entries);
  }

  let matches = byDestination.get(target);
  if (!matches) {
    const partialKeys = [...byDestination.keys()].filter((key) => key.startsWith(target));
    if (partialKeys.length !== 1) return undefined;
    matches = byDestination.get(partialKeys[0]!);
  }
  return matches
    ?.slice()
    .sort((a, b) => Math.sqrt((a.x - origin.x) * (a.x - origin.x) + (a.y - origin.y) * (a.y - origin.y)) - Math.sqrt((b.x - origin.x) * (b.x - origin.x) + (b.y - origin.y) * (b.y - origin.y)))[0];
}
