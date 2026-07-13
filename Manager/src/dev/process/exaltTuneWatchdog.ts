import { Logger } from '../../util/Logger.js';

import type { ExaltProcessRow } from './rotmgWindowsClientTune.js';

import { loadExaltTuneSettings } from './exaltTuneSettings.js';
import type { ExaltTuneSettings } from './exaltTuneSettings.js';

import {

  activatePowerPlan,

  applyResolvedRolesMultiboxClusters,

  getForegroundPid,

  listExaltProcesses,

  rebalanceMultiboxAffinityFromDisk,

  sampleWindowsThermalSignals,

  tuningSupported,

} from './rotmgWindowsClientTune.js';

import { loadExaltClientRoles } from './exaltClientRoles.js';

import { armThermalBackgroundDemotion, clearThermalBackgroundDemotion } from './thermalStressLayer.js';


export const EXALT_WATCHDOG_TICK_MS = 3000;



type WatchMode = 'hot' | 'cool';



let intervalId: ReturnType<typeof setInterval> | null = null;



let agg = {

  hotMs: 0,

  coolMs: 0,

  mode: 'cool' as WatchMode,

};


let thermalEnterAggMs = 0;

let thermalExitAggMs = 0;

let thermalStressActive = false;

let thermalNoSensorLogged = false;


/** Last successful affinity layout for this PID:image set */

let lastAffinityPidSignature = '';



function pidSignature(processes: ExaltProcessRow[]): string {

  return processes

    .map((p) => `${Math.floor(Number(p.pid))}:${String(p.imageName || '')}`)

    .sort()

    .join('|');

}



let watchdogInFlight = false;



export function resetExaltTuneWatchdogState(): void {

  agg = { hotMs: 0, coolMs: 0, mode: 'cool' };

  lastAffinityPidSignature = '';

  thermalEnterAggMs = 0;

  thermalExitAggMs = 0;

  thermalStressActive = false;

  thermalNoSensorLogged = false;

}



async function reapplyResolvedMultiboxNoThermal(): Promise<void> {

  const fg = await getForegroundPid();

  const parked = new Set(loadExaltClientRoles().parkedPids);

  const out = await applyResolvedRolesMultiboxClusters(fg, parked);

  if (!out.ok) Logger.warn('exaltTune.watchdog', out.error || 'role tuning apply');

}



async function runCpuWatchdogTick(deltaMs: number, s: ExaltTuneSettings): Promise<void> {

  const lpRes = await listExaltProcesses();

  const processes = lpRes.processes;

  const lp = Math.max(1, Number(lpRes.logicalProcessors) || 1);



  const rawSumCpu = processes.reduce((a, p) => a + (Number(p.cpuPercent) || 0), 0);

  const normalizedCpu = rawSumCpu / lp;



  const wd = s.watchdog;

  const metricCpu = wd.cpuMetric === 'raw' ? rawSumCpu : normalizedCpu;



  let nextHotMs = agg.hotMs;

  let nextCoolMs = agg.coolMs;



  const sig = pidSignature(processes);

  const isHotBand = processes.length > 0 && metricCpu >= wd.cpuSumThreshold;



  if (isHotBand) {

    nextHotMs = agg.hotMs + deltaMs;

    nextCoolMs = 0;

    if (nextHotMs >= wd.cpuSumHotDebounceMs && agg.mode === 'cool') {

      agg.mode = 'hot';

      Logger.log(

        'exaltTune.watchdog',

        `HOT: rawΣ=${rawSumCpu.toFixed(1)}% equiv=${normalizedCpu.toFixed(1)}% (cpuMetric=${wd.cpuMetric}, threshold=${wd.cpuSumThreshold}, LP=${lp}, procs=${processes.length})`,

      );

      try {

        if (wd.onHotActivateHotPlan && s.powerGuidHot) await activatePowerPlan(s.powerGuidHot);

        if (wd.onHotSetPriorityHot) await reapplyResolvedMultiboxNoThermal();

      } catch (e) {

        Logger.warn('exaltTune.watchdog', String((e as Error).message || e));

      }

    }

  } else {

    nextCoolMs = agg.coolMs + deltaMs;

    nextHotMs = 0;

    if (nextCoolMs >= wd.cpuSumCoolDebounceMs && agg.mode === 'hot') {

      agg.mode = 'cool';

      Logger.log(

        'exaltTune.watchdog',

        `COOL: rawΣ=${processes.length ? rawSumCpu.toFixed(1) : '0'} (${processes.length} process(es))`,

      );

      try {

        if (wd.onCoolActivateIdlePlan && s.powerGuidIdle) await activatePowerPlan(s.powerGuidIdle);

        if (wd.onCoolSetPriorityIdle) await reapplyResolvedMultiboxNoThermal();

      } catch (e) {

        Logger.warn('exaltTune.watchdog', String((e as Error).message || e));

      }

    }

  }



  agg.hotMs = nextHotMs;

  agg.coolMs = nextCoolMs;



  try {

    if (

      wd.onHotSpreadCores &&

      agg.mode === 'hot' &&

      isHotBand &&

      nextHotMs >= wd.cpuSumHotDebounceMs &&

      sig &&

      sig !== lastAffinityPidSignature

    ) {

      const aff = await rebalanceMultiboxAffinityFromDisk();

      if (aff.ok) lastAffinityPidSignature = sig;

    }

  } catch (e) {

    Logger.warn('exaltTune.watchdog', String((e as Error).message || e));

  }

}



async function runThermalWatchdogTick(deltaMs: number, cfg: ExaltTuneSettings['thermal']): Promise<void> {

  if (!cfg.enabled) {

    if (thermalStressActive) {

      thermalStressActive = false;

      thermalEnterAggMs = 0;

      thermalExitAggMs = 0;

      clearThermalBackgroundDemotion();

      try {

        await reapplyResolvedMultiboxNoThermal();

      } catch (e) {

        Logger.warn('exaltTune.thermal', String((e as Error).message || e));

      }

    }

    return;

  }



  const sample = await sampleWindowsThermalSignals();

  const hasTemp = sample.pkgMaxCelsius != null;

  const hasFreq = sample.minFreqPctOfMax != null;



  if (!hasTemp && !hasFreq) {

    if (!thermalNoSensorLogged) {

      thermalNoSensorLogged = true;

      Logger.log('exaltTune.thermal', 'No WMI ACPI temp nor CPU frequency counter — thermal demotion inactive');

    }

    return;

  }



  thermalNoSensorLogged = false;



  const tempAbove = hasTemp && (sample.pkgMaxCelsius as number) >= cfg.pkgTempCelsiusThreshold;

  const tempClearBand = !hasTemp || (sample.pkgMaxCelsius as number) <= cfg.pkgTempCelsiusClear;



  const freqLeg = hasFreq && cfg.freqPctLowThreshold != null;

  const fLow = cfg.freqPctLowThreshold ?? 0;

  const freqClearLim = cfg.freqPctClear ?? (cfg.freqPctLowThreshold != null ? cfg.freqPctLowThreshold + 7 : null);

  const freqDropped = freqLeg && (sample.minFreqPctOfMax as number) <= fLow;

  const freqClearBand =

    !freqLeg || freqClearLim == null || (sample.minFreqPctOfMax as number) >= freqClearLim;



  const stressBand = tempAbove || freqDropped;



  /** Clear stress when every available axis reports “cool enough”. */

  const clearBand = tempClearBand && freqClearBand;



  if (stressBand) {

    thermalExitAggMs = 0;

    thermalEnterAggMs += deltaMs;



    if (!thermalStressActive && thermalEnterAggMs >= cfg.sustainMs) {

      thermalStressActive = true;

      Logger.log(

        'exaltTune.thermal',

        `Thermal stress sustained: demoting background (max ${hasTemp ? (sample.pkgMaxCelsius as number).toFixed(1) + ' °C' : 'no temp'}, ` +

          `freqMin≈${hasFreq ? (sample.minFreqPctOfMax as number).toFixed(0) : 'na'} %)`,

      );

      try {

        armThermalBackgroundDemotion(cfg.demoteBackgroundTo);

        await reapplyResolvedMultiboxNoThermal();

      } catch (e) {

        Logger.warn('exaltTune.thermal', String((e as Error).message || e));

      }

    }

  } else {

    thermalEnterAggMs = 0;



    if (thermalStressActive && clearBand) {

      thermalExitAggMs += deltaMs;

      if (thermalExitAggMs >= cfg.clearMs) {

        thermalStressActive = false;

        thermalExitAggMs = 0;

        Logger.log('exaltTune.thermal', 'Thermal cleared — restoring background priorities from rules');

        try {

          clearThermalBackgroundDemotion();

          await reapplyResolvedMultiboxNoThermal();

        } catch (e) {

          Logger.warn('exaltTune.thermal', String((e as Error).message || e));

        }

      }

    } else {

      thermalExitAggMs = 0;

    }

  }

}



async function watchdogTick(deltaMs: number): Promise<void> {

  const sup = await tuningSupported();

  if (!sup.ok) return;



  const s = loadExaltTuneSettings();

  const cpuOn = s.watchdog.enabled;

  const thOn = s.thermal.enabled;



  if (!cpuOn && !thOn) return;



  if (cpuOn) await runCpuWatchdogTick(deltaMs, s);



  await runThermalWatchdogTick(deltaMs, s.thermal);

}



export function stopExaltTuneWatchdog(): void {

  const wasThermalStress = thermalStressActive;

  if (intervalId != null) {

    clearInterval(intervalId as ReturnType<typeof setInterval>);

    intervalId = null;

  }

  if (wasThermalStress) {

    clearThermalBackgroundDemotion();

    void reapplyResolvedMultiboxNoThermal().catch(() => {});

  }

  resetExaltTuneWatchdogState();

}



export function startExaltTuneWatchdog(): void {

  if (intervalId != null) return;

  resetExaltTuneWatchdogState();

  intervalId = setInterval(() => {

    if (watchdogInFlight) return;

    watchdogInFlight = true;

    watchdogTick(EXALT_WATCHDOG_TICK_MS)

      .catch((err) => Logger.warn('exaltTune.watchdog', String((err as Error).message || err)))

      .finally(() => {

        watchdogInFlight = false;

      });

  }, EXALT_WATCHDOG_TICK_MS);

}



/** Stop if disabled; start + reset when enabled (e.g. after settings POST). */

export function syncExaltTuneWatchdogFromDisk(): void {

  const s = loadExaltTuneSettings();

  stopExaltTuneWatchdog();

  const run = s.watchdog.enabled || s.thermal.enabled;

  if (run) startExaltTuneWatchdog();

}


