import type { AffinityControlMode } from './affinityControl.js';

import type { ClientRole, ClientRoleRule } from './exaltClientRoles.js';
import { ROLE_RULES } from './exaltClientRoles.js';

import type { PriorityPreset } from './rotmgWindowsClientTune.js';

import { loadExaltTuneSettings, saveExaltTuneSettings } from './exaltTuneSettings.js';


export type TuningPresetName = 'safe' | 'balanced' | 'multibox' | 'aggressive' | 'lowHeat';

export type TuningPresetPack = {
  /** Preset-specific role rules (merged over `ROLE_RULES`). */
  rolePatch: Partial<Record<ClientRole, Partial<ClientRoleRule>>>;
  affinityMode: AffinityControlMode;
  /** Hot/cool-ish defaults merged into `priorityPreset*` in exalt tune. */
  idlePriorityDefault: PriorityPreset;
  hotPriorityDefault: PriorityPreset;
  smartTrimRequireMemoryLoadPercent: number;
  /** Optional smart-trim defaults merged into `smart-trim-settings.exalt`. */
  smartTrimPatch?: Partial<{
    periodicTrim: boolean;
    checkIntervalMs: number;
    minTrimIntervalMs: number;
    maxCpuPercentForTrim: number;
  }>;
};

/** UI “profile” presets — safe defaults tuned for readability over raw numbers. */
export const TUNING_PRESETS: Record<TuningPresetName, TuningPresetPack> = {
  safe: {
    affinityMode: 'none',
    idlePriorityDefault: 'Normal',
    hotPriorityDefault: 'Normal',
    smartTrimRequireMemoryLoadPercent: 88,
    rolePatch: {
      active: { priority: 'Normal', affinityStrategy: 'none' },
      background: { priority: 'Normal', affinityStrategy: 'none' },
      parked: { priority: 'BelowNormal', affinityStrategy: 'none' },
    },
  },
  balanced: {
    affinityMode: 'rolePartition',
    idlePriorityDefault: 'Normal',
    hotPriorityDefault: 'AboveNormal',
    smartTrimRequireMemoryLoadPercent: 85,
    rolePatch: {
      active: {
        affinityStrategy: 'spread-four-cores',
        priority: 'AboveNormal',
      },
      background: {
        affinityStrategy: 'spread-two-cores',
        priority: 'Normal',
      },
      parked: {
        affinityStrategy: 'spread-one-core',
        priority: 'BelowNormal',
      },
    },
  },
  /** Layer 3 hard allocation: active = full cores + no EcoQoS; bg/parked = EcoQoS on (see `multiboxRoleWantsEcoQosExecutionThrottle`). */
  multibox: {
    affinityMode: 'rolePartition',
    idlePriorityDefault: 'BelowNormal',
    hotPriorityDefault: 'Normal',
    smartTrimRequireMemoryLoadPercent: 82,
    smartTrimPatch: {
      periodicTrim: false,
      checkIntervalMs: 30_000,
      minTrimIntervalMs: 180_000,
      maxCpuPercentForTrim: 18,
    },
    rolePatch: {
      active: { affinityStrategy: 'spread-four-cores', priority: 'Normal' },
      background: { affinityStrategy: 'spread-two-cores', priority: 'BelowNormal' },
      parked: {
        affinityStrategy: 'spread-one-core',
        priority: 'Idle',
        allowMinimize: true,
      },
    },
  },
  aggressive: {
    affinityMode: 'rolePartition',
    idlePriorityDefault: 'BelowNormal',
    hotPriorityDefault: 'High',
    smartTrimRequireMemoryLoadPercent: 80,
    rolePatch: {
      active: { affinityStrategy: 'spread-four-cores', priority: 'High' },
      background: { affinityStrategy: 'spread-two-cores', priority: 'BelowNormal' },
      parked: { affinityStrategy: 'spread-one-core', priority: 'Idle' },
    },
  },
  lowHeat: {
    affinityMode: 'rolePartition',
    idlePriorityDefault: 'BelowNormal',
    hotPriorityDefault: 'Normal',
    smartTrimRequireMemoryLoadPercent: 85,
    smartTrimPatch: {
      periodicTrim: true,
      checkIntervalMs: 25_000,
      minTrimIntervalMs: 120_000,
      maxCpuPercentForTrim: 10,
    },
    rolePatch: {
      active: { affinityStrategy: 'spread-two-cores', priority: 'Normal' },
      background: { affinityStrategy: 'spread-one-core', priority: 'BelowNormal' },
      parked: { affinityStrategy: 'spread-one-core', priority: 'Idle' },
    },
  },
};

const ROLES_ORDER: ClientRole[] = ['active', 'background', 'parked'];

export function mergeRoleRulesWithPatch(
  base: Record<ClientRole, ClientRoleRule>,
  patch: Partial<Record<ClientRole, Partial<ClientRoleRule>>>,
): Record<ClientRole, ClientRoleRule> {
  const out = { ...base };
  for (const r of ROLES_ORDER) {
    const q = patch[r];
    if (!q) continue;
    out[r] = { ...out[r], ...q, role: r };
  }
  return out;
}

/** `ROLE_RULES` plus optional saved tuning preset (JSON). */
export function getEffectiveMultiboxRoleRules(): Record<ClientRole, ClientRoleRule> {
  const name = loadExaltTuneSettings().tuningPreset;
  if (!name || !(name in TUNING_PRESETS)) return ROLE_RULES;
  const p = TUNING_PRESETS[name as TuningPresetName];
  return mergeRoleRulesWithPatch(ROLE_RULES, p.rolePatch);
}

export function getAffinityModeForDisk(): AffinityControlMode {
  const name = loadExaltTuneSettings().tuningPreset;
  if (!name || !(name in TUNING_PRESETS)) return 'rolePartition';
  return TUNING_PRESETS[name as TuningPresetName].affinityMode;
}

/** Applies preset → JSON (`exalt-tune-settings` + smart-trim memory gate). */
export function applyTuningPresetToDisk(name: TuningPresetName): void {
  const p = TUNING_PRESETS[name];
  saveExaltTuneSettings({
    tuningPreset: name,
    priorityPresetIdle: p.idlePriorityDefault,
    priorityPresetHot: p.hotPriorityDefault,
  });
}
