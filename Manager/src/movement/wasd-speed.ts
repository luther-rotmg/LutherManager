import type { ClientConnection } from '../proxy/ClientConnection.js';

export const CALIBRATED_BASE_TPS = 3.92;
export const CALIBRATED_SPEED_TPS_PER_POINT = 0.045;
export const SPEEDY_MULTIPLIER = 1.5;

/** Optional tile-speed helpers previously supplied by PluginContext. */
export type SpeedContext = {
  worldState?: { getTileAt(x: number, y: number): number | null | undefined } | null;
  gameData?: { getTileSpeed(tileType: number): number } | null;
  getEffectivePlayerPos?(client: ClientConnection): { x: number; y: number } | null;
} | null;

function clampSpeedStat(totalSpeed: number): number {
  return Math.max(0, Math.min(75, totalSpeed));
}

export function getCalibratedBaseTilesPerSecond(totalSpeed: number): number {
  return CALIBRATED_BASE_TPS + clampSpeedStat(totalSpeed) * CALIBRATED_SPEED_TPS_PER_POINT;
}

export function getCalibratedMoveTilesPerSecond(
  client: ClientConnection,
  ctx?: SpeedContext,
  pos?: { x: number; y: number } | null,
): number {
  const pd = client.playerData;
  if (!pd) return CALIBRATED_BASE_TPS;

  if (pd.hasConditionEffect('Paralyzed') || pd.hasConditionEffect('Paused') || pd.hasConditionEffect('Petrified')) {
    return 0;
  }

  const totalSpeed = Number(pd.speed || 0) + Number(pd.speedBonus || 0);
  let tilesPerSecond = pd.hasConditionEffect('Slowed')
    ? CALIBRATED_BASE_TPS
    : getCalibratedBaseTilesPerSecond(totalSpeed);

  if (pd.hasConditionEffect('Speedy') || pd.hasConditionEffect('NinjaSpeedy')) {
    tilesPerSecond *= SPEEDY_MULTIPLIER;
  }

  if (ctx?.worldState && ctx?.gameData) {
    const tilePos = pos ?? ctx.getEffectivePlayerPos?.(client) ?? pd.pos;
    if (tilePos) {
      const tileType = ctx.worldState.getTileAt(Math.floor(tilePos.x), Math.floor(tilePos.y));
      if (tileType != null) {
        tilesPerSecond *= ctx.gameData.getTileSpeed(tileType);
      }
    }
  }

  return Math.max(0, tilesPerSecond);
}

export function getCalibratedMsPerTile(
  client: ClientConnection,
  ctx?: SpeedContext,
  pos?: { x: number; y: number } | null,
): number {
  const tilesPerSecond = getCalibratedMoveTilesPerSecond(client, ctx, pos);
  if (tilesPerSecond <= 0) return Infinity;
  return 1000 / tilesPerSecond;
}
