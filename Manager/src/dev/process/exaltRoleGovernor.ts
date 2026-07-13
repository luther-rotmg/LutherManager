import { loadExaltTuneSettings, saveExaltTuneSettings } from './exaltTuneSettings.js';
import {
  loadExaltClientRoles,
  saveExaltClientRoles,
} from './exaltClientRoles.js';
import { enumerateRealmClustersWithRoles } from './exaltRealmClusters.js';
import {
  applyMultiboxRolePrioritiesFromDisk,
  applyResolvedRolesMultiboxClusters,
  activatePowerPlan,
  getForegroundPid,
  listPowerPlans,
  rebalanceMultiboxAffinityFromDisk,
  resetAllExaltAffinityToAllLogicalCpus,
  setAllExaltPriority,
  tuningSupported,
} from './rotmgWindowsClientTune.js';
import { syncExaltTuneWatchdogFromDisk } from './exaltTuneWatchdog.js';
import { applyTuningPresetToDisk, type TuningPresetName } from './tuningPresets.js';
import { clearThermalBackgroundDemotion } from './thermalStressLayer.js';

/** Re-read foreground + parked clusters (no process mutation). */
export async function refreshResolvedClientRoles() {
  return enumerateRealmClustersWithRoles();
}

export async function applyRolePrioritiesFromDisk() {
  return applyMultiboxRolePrioritiesFromDisk();
}

export async function applyRoleAffinityFromDisk() {
  return rebalanceMultiboxAffinityFromDisk();
}

export function applyRoleTrimPolicyFromDisk() {
}

/**
 * Safety reset: Normal priority + full CPU affinity, clears parked list, stops CPU watchdog, clears dashboard preset name.
 * Optionally activates a power plan whose name matches /balanced/i (typically "Balanced").
 */
export async function restoreAllClientTuning(options?: {
  activateBalancedPowerPlan?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    saveExaltClientRoles({ parkedPids: [] });

    const cur = loadExaltTuneSettings();
    saveExaltTuneSettings({
      tuningPreset: null,
      watchdog: { ...cur.watchdog, enabled: false },
      thermal: { ...cur.thermal, enabled: false },
    });
    syncExaltTuneWatchdogFromDisk();

    clearThermalBackgroundDemotion();

    const sup = await tuningSupported();
    if (sup.ok) {
      await setAllExaltPriority('Normal');
      await resetAllExaltAffinityToAllLogicalCpus();
    }

    if (options?.activateBalancedPowerPlan && sup.ok) {
      const plans = await listPowerPlans();
      const bal =
        plans.find((p) => /\bbalanced\b/i.test(p.name)) ||
        plans.find((p) => /^balanced$/i.test(String(p.name).trim()));
      if (bal) await activatePowerPlan(bal.guid);
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

/** Apply saved foreground + parked list (`loadExaltClientRoles`) and current disk preset. */
export async function applyEffectiveMultiboxPolicyFromDisk() {
  const fg = await getForegroundPid();
  const parked = new Set(loadExaltClientRoles().parkedPids);
  return applyResolvedRolesMultiboxClusters(fg, parked);
}

/** Alias: one call applies per-role priority + affinity (`applyResolvedRolesMultiboxClusters`). */
export async function applyRoleTuning(): Promise<{
  ok: boolean;
  error?: string;
  slots: Array<{ seedPid: number; pids: number[]; role: import('./exaltClientRoles.js').ClientRole }>;
}> {
  return applyEffectiveMultiboxPolicyFromDisk();
}

/**
 * Optional `preset` writes tuning JSON first; always applies resolved role priorities + affinity for live FG/parked.
 */
export async function applyMultiboxPresetAndLivePolicy(parsed?: {
  preset?: string;
}) {
  const raw = String(parsed?.preset || '').trim();
  if (raw) {
    const want = raw.toLowerCase().replace(/\s+/g, '');
    const NAMES: readonly TuningPresetName[] = ['safe', 'balanced', 'multibox', 'aggressive', 'lowHeat'];
    const key = NAMES.find((n) => n.toLowerCase().replace(/\s+/g, '') === want);
    if (key) applyTuningPresetToDisk(key);
  }
  syncExaltTuneWatchdogFromDisk();
  return applyEffectiveMultiboxPolicyFromDisk();
}
