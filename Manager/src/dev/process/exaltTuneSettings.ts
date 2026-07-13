import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

import { join } from 'path';



import { getHiveDocumentsDir } from '../../util/rotmgAssetExtractor.js';

import type { PriorityPreset } from './rotmgWindowsClientTune.js';



const FILE = 'exalt-tune-settings.json';



export const EXALT_TUNE_SETTINGS_VERSION = 1 as const;



export type CpuWatchdogMetric = 'raw' | 'normalized';



/** Persisted Hive tuning for RotMG Exalt.exe (priority, power plans, watchdog). */

export type TuningPresetName = 'safe' | 'balanced' | 'multibox' | 'aggressive' | 'lowHeat';

export type ExaltTuneSettings = {

  version: typeof EXALT_TUNE_SETTINGS_VERSION;

  /**
   * Dashboard “profile” preset (merges `ROLE_RULES`, affinity mode, smart-trim memory gate).
   * `undefined` ⇒ use hard-coded `ROLE_RULES` defaults.
   */
  tuningPreset?: TuningPresetName | null;

  /** Preferred priority for auto-apply and watchdog cool-down restore. */

  priorityPresetIdle: PriorityPreset;

  /** Used when watchdog marks the system “hot”. */

  priorityPresetHot: PriorityPreset;

  /** If set, `powercfg /setactive` when proxy/dashboard starts (with auto-apply). */

  startupPowerGuid?: string;

  /** Activates when sum(Exalt CPU%) crosses the hot threshold (watchdog). */

  powerGuidHot?: string;

  /** Restores after sustained idle below threshold (watchdog). */

  powerGuidIdle?: string;

  autoApplyOnProxyStart: boolean;

  /** When true (opt-in), best-effort restore of priority/affinity/power from first capture when DevServer shuts down. */
  restoreProcessBaselineOnExit: boolean;

  watchdog: {

    enabled: boolean;

    /**

     * When `normalized`: threshold is Σ Exalt Perf raw % divided by logical CPU count (~system share).

     * When `raw`: threshold is summed raw Perf % across Exalt instances (often &gt; 100 on multicore).

     */

    cpuMetric: CpuWatchdogMetric;

    /** Compared against either raw or normalized Σ Exalt CPU, per `cpuMetric`. */

    cpuSumThreshold: number;

    cpuSumHotDebounceMs: number;

    cpuSumCoolDebounceMs: number;

    onHotSetPriorityHot: boolean;

    onHotActivateHotPlan: boolean;

    onHotSpreadCores: boolean;

    onCoolSetPriorityIdle: boolean;

    onCoolActivateIdlePlan: boolean;

  };

  /**
   * WMI ACPI thermal zones + CPU “% of maximum frequency”; when sustained stress, tighten **background**
   * client priority vs `ROLE_RULES` alone (helps long multibox sessions).
   */
  thermal: ExaltTuneThermalSettings;

};


export type ExaltTuneThermalSettings = {

  enabled: boolean;

  /** Enter stress when max reported ACPI zone °C reaches this (if WMI exposes temps). */

  pkgTempCelsiusThreshold: number;

  /** Exit stress hysteresis — must stay at/below this to count as cooled (temp axis). */

  pkgTempCelsiusClear: number;

  /** Duration temp/freq stays in stress band before arming demotion */

  sustainMs: number;

  /** Duration readings stay in clear band before releasing demotion */

  clearMs: number;

  /** When minimum `% of Maximum Frequency` is at/below this, count as thermal stress (null = ignore freq). */

  freqPctLowThreshold: number | null;

  /** Min freq must recover to ≥ this to clear freq leg (null = derive from threshold + increment). */

  freqPctClear: number | null;

  demoteBackgroundTo: PriorityPreset;

};



const PRIO_OPTS: PriorityPreset[] = [

  'Idle',

  'BelowNormal',

  'Normal',

  'AboveNormal',

  'High',

];



export function defaultExaltTuneSettings(): ExaltTuneSettings {

  return {

    version: EXALT_TUNE_SETTINGS_VERSION,

    tuningPreset: undefined,

    priorityPresetIdle: 'Normal',

    priorityPresetHot: 'AboveNormal',

    startupPowerGuid: undefined,

    powerGuidHot: '{8c5e7fda-e8bf-4a96-9a85-a6e23a635635}',

    powerGuidIdle: '{381b4222-f694-41f0-9685-ff5bb260df2e}',

    autoApplyOnProxyStart: false,

    restoreProcessBaselineOnExit: false,

    watchdog: {

      enabled: false,

      cpuMetric: 'normalized',

      cpuSumThreshold: 25,

      cpuSumHotDebounceMs: 5000,

      cpuSumCoolDebounceMs: 45000,

      onHotSetPriorityHot: true,

      onHotActivateHotPlan: true,

      onHotSpreadCores: false,

      onCoolSetPriorityIdle: true,

      onCoolActivateIdlePlan: true,

    },

    thermal: {

      enabled: false,

      pkgTempCelsiusThreshold: 84,

      pkgTempCelsiusClear: 80,

      sustainMs: 45_000,

      clearMs: 60_000,

      freqPctLowThreshold: 65,

      freqPctClear: 72,

      demoteBackgroundTo: 'BelowNormal',

    },

  };

}



function mergePatch(raw: unknown): ExaltTuneSettings {

  const d = defaultExaltTuneSettings();

  if (!raw || typeof raw !== 'object') return d;

  const o = raw as Record<string, unknown>;

  const pr = (v: unknown): PriorityPreset => {

    const s = String(v || '');

    return PRIO_OPTS.includes(s as PriorityPreset) ? (s as PriorityPreset) : 'Normal';

  };

  const w0 = (o.watchdog && typeof o.watchdog === 'object' ? o.watchdog : {}) as Record<string, unknown>;



  const thrUnknown =

    typeof w0.cpuSumThreshold === 'number' && Number.isFinite(w0.cpuSumThreshold)

      ? Math.max(0, w0.cpuSumThreshold)

      : d.watchdog.cpuSumThreshold;

  /** Legacy files had no metric; large thresholds were raw Σ%. */

  const metricFromLegacy =

    w0.cpuMetric === 'normalized' || w0.cpuMetric === 'raw'

      ? (w0.cpuMetric as CpuWatchdogMetric)

      : thrUnknown > 100

        ? 'raw'

        : 'normalized';



  const presetNames = new Set<string>(['safe', 'balanced', 'multibox', 'aggressive', 'lowHeat']);

  const tuningPresetParsed = (v: unknown): TuningPresetName | undefined => {

    if (v === undefined || v === null || v === '') return undefined;

    const s = String(v);

    return presetNames.has(s) ? (s as TuningPresetName) : undefined;

  };



  return {

    version: EXALT_TUNE_SETTINGS_VERSION,

    tuningPreset: tuningPresetParsed(o.tuningPreset) ?? d.tuningPreset,

    priorityPresetIdle: pr(o.priorityPresetIdle ?? o.priorityPreset),

    priorityPresetHot: pr(o.priorityPresetHot),

    startupPowerGuid: o.startupPowerGuid != null ? String(o.startupPowerGuid) || undefined : d.startupPowerGuid,

    powerGuidHot:

      o.powerGuidHot != null ? String(o.powerGuidHot) || undefined : d.powerGuidHot,

    powerGuidIdle:

      o.powerGuidIdle != null ? String(o.powerGuidIdle) || undefined : d.powerGuidIdle,

    autoApplyOnProxyStart:

      typeof o.autoApplyOnProxyStart === 'boolean' ? o.autoApplyOnProxyStart : d.autoApplyOnProxyStart,

    restoreProcessBaselineOnExit:

      typeof o.restoreProcessBaselineOnExit === 'boolean'

        ? o.restoreProcessBaselineOnExit

        : d.restoreProcessBaselineOnExit,

    watchdog: {

      enabled:

        typeof w0.enabled === 'boolean'

          ? w0.enabled

          : typeof (o as { watchdogEnabled?: boolean }).watchdogEnabled === 'boolean'

            ? Boolean((o as { watchdogEnabled?: boolean }).watchdogEnabled)

            : d.watchdog.enabled,

      cpuMetric: metricFromLegacy,

      cpuSumThreshold: thrUnknown,

      cpuSumHotDebounceMs:

        typeof w0.cpuSumHotDebounceMs === 'number' && Number.isFinite(w0.cpuSumHotDebounceMs)

          ? Math.max(500, w0.cpuSumHotDebounceMs)

          : d.watchdog.cpuSumHotDebounceMs,

      cpuSumCoolDebounceMs:

        typeof w0.cpuSumCoolDebounceMs === 'number' && Number.isFinite(w0.cpuSumCoolDebounceMs)

          ? Math.max(2000, w0.cpuSumCoolDebounceMs)

          : d.watchdog.cpuSumCoolDebounceMs,

      onHotSetPriorityHot:

        typeof w0.onHotSetPriorityHot === 'boolean' ? w0.onHotSetPriorityHot : d.watchdog.onHotSetPriorityHot,

      onHotActivateHotPlan:

        typeof w0.onHotActivateHotPlan === 'boolean'

          ? w0.onHotActivateHotPlan

          : d.watchdog.onHotActivateHotPlan,

      onHotSpreadCores:

        typeof w0.onHotSpreadCores === 'boolean' ? w0.onHotSpreadCores : d.watchdog.onHotSpreadCores,

      onCoolSetPriorityIdle:

        typeof w0.onCoolSetPriorityIdle === 'boolean'

          ? w0.onCoolSetPriorityIdle

          : d.watchdog.onCoolSetPriorityIdle,

      onCoolActivateIdlePlan:

        typeof w0.onCoolActivateIdlePlan === 'boolean'

          ? w0.onCoolActivateIdlePlan

          : d.watchdog.onCoolActivateIdlePlan,

    },

    thermal: mergeThermalPatch(d.thermal, (o as Record<string, unknown>).thermal),

  };

}

function mergeThermalPatch(

  base: ExaltTuneThermalSettings,

  raw: unknown,

): ExaltTuneThermalSettings {

  if (!raw || typeof raw !== 'object') return base;

  const t = raw as Record<string, unknown>;

  const nn = (v: unknown, fallback: number): number =>

    typeof v === 'number' && Number.isFinite(v) ? v : fallback;

  const freqLow =

    t.freqPctLowThreshold === null

      ? null

      : typeof t.freqPctLowThreshold === 'number' && Number.isFinite(t.freqPctLowThreshold)

        ? t.freqPctLowThreshold

        : base.freqPctLowThreshold;

  const freqClr =

    t.freqPctClear === null

      ? null

      : typeof t.freqPctClear === 'number' && Number.isFinite(t.freqPctClear)

        ? t.freqPctClear

        : base.freqPctClear;

  const pr = (v: unknown): PriorityPreset => {

    const s = String(v || '');

    return PRIO_OPTS.includes(s as PriorityPreset) ? (s as PriorityPreset) : base.demoteBackgroundTo;

  };

  return {

    enabled: typeof t.enabled === 'boolean' ? t.enabled : base.enabled,

    pkgTempCelsiusThreshold: nn(t.pkgTempCelsiusThreshold, base.pkgTempCelsiusThreshold),

    pkgTempCelsiusClear: nn(t.pkgTempCelsiusClear, base.pkgTempCelsiusClear),

    sustainMs: Math.max(3000, nn(t.sustainMs, base.sustainMs)),

    clearMs: Math.max(3000, nn(t.clearMs, base.clearMs)),

    freqPctLowThreshold: freqLow,

    freqPctClear: freqClr,

    demoteBackgroundTo: pr(t.demoteBackgroundTo),

  };

}



export function tuneSettingsPath(): string {

  return join(getHiveDocumentsDir(), FILE);

}



export function loadExaltTuneSettings(): ExaltTuneSettings {

  const dir = getHiveDocumentsDir();

  const p = join(dir, FILE);

  try {

    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(p)) {

      return defaultExaltTuneSettings();

    }

    const raw = JSON.parse(readFileSync(p, 'utf8'));

    const merged = mergePatch(raw);

    return merged;

  } catch {

    return defaultExaltTuneSettings();

  }

}



/** Deep merge patches into persisted settings file. */

export function saveExaltTuneSettings(patch: Partial<ExaltTuneSettings>): ExaltTuneSettings {

  const cur = loadExaltTuneSettings();

  const next: ExaltTuneSettings = {

    ...cur,

    ...patch,

    version: EXALT_TUNE_SETTINGS_VERSION,

    watchdog: { ...cur.watchdog, ...(patch.watchdog ?? {}) },

    thermal: patch.thermal ? { ...cur.thermal, ...patch.thermal } : cur.thermal,

  };

  const dir = getHiveDocumentsDir();

  const p = tuneSettingsPath();

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');

  return next;

}

