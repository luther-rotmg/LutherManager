/**
 * When thermal stress is active, multibox **background** clusters are demoted further (lower priority class)
 * than `ROLE_RULES` alone — transient layer on top of normal policy.
 */

const PRESET_ORDER = ['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High'] as const;

export type PriorityPresetName = (typeof PRESET_ORDER)[number];

let thermalBackgroundDemotionActive = false;
let thermalDemotePreset: PriorityPresetName = 'BelowNormal';

export function isThermalBackgroundDemotionActive(): boolean {
  return thermalBackgroundDemotionActive;
}

/** Arm before re-applying multibox priorities; background role uses the tighter of rule vs this preset. */
export function armThermalBackgroundDemotion(preset: string): void {
  thermalDemotePreset = normalizePreset(preset);
  thermalBackgroundDemotionActive = true;
}

export function clearThermalBackgroundDemotion(): void {
  thermalBackgroundDemotionActive = false;
}

export function getThermalDemotePreset(): PriorityPresetName {
  return thermalDemotePreset;
}

function normalizePreset(s: string): PriorityPresetName {
  const x = String(s || '').trim();
  return (PRESET_ORDER as readonly string[]).includes(x) ? (x as PriorityPresetName) : 'BelowNormal';
}

/** More “idle” / power-saving of two presets (Idle wins). */
export function tighterIdlePreset(
  rulePreset: string,
  thermalCap: string,
): PriorityPresetName {
  const a = normalizePreset(rulePreset);
  const b = normalizePreset(thermalCap);
  const ia = Math.max(0, PRESET_ORDER.indexOf(a));
  const ib = Math.max(0, PRESET_ORDER.indexOf(b));
  return PRESET_ORDER[Math.min(ia, ib)];
}
