import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';

import { join } from 'path';

import { getHiveDocumentsDir } from '../../util/rotmgAssetExtractor.js';

import type { PriorityPreset } from './rotmgWindowsClientTune.js';
import {
  activatePowerPlan,
  getActivePowerPlanGuid,
  listExaltProcesses,
  resetPidsProcessPowerThrottlingToDefault,
  setAffinityMaskForPid,
  setExaltPidsPriority,
  tuningSupported,
} from './rotmgWindowsClientTune.js';

const FILE = 'exalt-process-baseline.json';

export const PROCESS_BASELINE_VERSION = 1 as const;

export type ProcessBaselineRow = {
  priorityClass: string;
  affinityMask: string;
};

export type ExaltProcessBaselineFile = {
  version: typeof PROCESS_BASELINE_VERSION;
  capturedAt: string;
  powerPlanGuid?: string;
  /** pid string → baseline row */
  processes: Record<string, ProcessBaselineRow>;
};

function baselinePath(): string {
  return join(getHiveDocumentsDir(), FILE);
}

function mapPriorityClassToPreset(s: string): PriorityPreset {
  const x = String(s || '').trim();
  if (/^idle$/i.test(x)) return 'Idle';
  if (/^belownormal$/i.test(x.replace(/\s+/g, ''))) return 'BelowNormal';
  if (/^abovenormal$/i.test(x.replace(/\s+/g, ''))) return 'AboveNormal';
  if (/^high$/i.test(x)) return 'High';
  if (/^normal$/i.test(x)) return 'Normal';
  return 'Normal';
}

let captureOnceInFlight = false;

/** First time only: snapshot current Realm PIDs × priority × affinity (+ active power plan). Skips when file exists. */
export async function ensureProcessBaselineCapturedOnce(): Promise<void> {
  if (captureOnceInFlight) return;
  const p = baselinePath();
  if (existsSync(p)) return;

  const sup = await tuningSupported();
  if (!sup.ok) return;

  captureOnceInFlight = true;
  try {
    const raw = await listExaltProcesses();
    const powerGuid = await getActivePowerPlanGuid();
    const processes: Record<string, ProcessBaselineRow> = {};
    for (const row of raw.processes || []) {
      const pid = Math.floor(Number(row.pid));
      if (!(pid > 0)) continue;
      const aff = String(row.processorAffinityMask ?? '').trim();
      const pri = String(row.priorityClass ?? 'Normal').trim();
      const maskOk = /^[0-9]+$/.test(aff);
      processes[String(pid)] = {
        priorityClass: pri,
        affinityMask: maskOk ? aff : '',
      };
    }

    const out: ExaltProcessBaselineFile = {
      version: PROCESS_BASELINE_VERSION,
      capturedAt: new Date().toISOString(),
      powerPlanGuid: powerGuid ?? undefined,
      processes,
    };
    const dir = getHiveDocumentsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  } finally {
    captureOnceInFlight = false;
  }
}

/** Delete baseline file then capture afresh (e.g. after user stabilizes configs). */
export async function captureProcessBaselineOverwrite(): Promise<{ ok: boolean; error?: string }> {
  try {
    const p = baselinePath();
    if (existsSync(p)) unlinkSync(p);
    await ensureProcessBaselineCapturedOnce();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

/** Restore saved priority class + affinity (and optionally power scheme) — best-effort for still-running PIDs. */
export async function restoreProcessBaseline(): Promise<{ ok: boolean; error?: string; restored?: number }> {
  const p = baselinePath();
  if (!existsSync(p)) return { ok: true, restored: 0 };

  let data: ExaltProcessBaselineFile;
  try {
    data = JSON.parse(readFileSync(p, 'utf8')) as ExaltProcessBaselineFile;
  } catch {
    return { ok: false, error: 'invalid baseline file', restored: 0 };
  }

  const sup = await tuningSupported();
  if (!sup.ok) return { ok: false, error: sup.reason, restored: 0 };

  try {
    if (data.powerPlanGuid) await activatePowerPlan(data.powerPlanGuid);

    let restored = 0;
    for (const [pidStr, ent] of Object.entries(data.processes || {})) {
      const pid = Math.floor(Number(pidStr));
      if (!(pid > 0)) continue;
      const mask = String(ent.affinityMask || '').trim();
      if (/^[0-9]+$/.test(mask)) {
        await setAffinityMaskForPid(pid, mask);
      }
      const preset = mapPriorityClassToPreset(ent.priorityClass);
      await setExaltPidsPriority([pid], preset);
      await resetPidsProcessPowerThrottlingToDefault([pid]);
      restored++;
    }
    return { ok: true, restored };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e), restored: 0 };
  }
}

export function processBaselinePath(): string {
  return baselinePath();
}
