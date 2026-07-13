import { loadExaltClientRoles, resolveClusterRole, saveExaltClientRoles, type ClientRole } from './exaltClientRoles.js';
import type { ExaltProcessRow } from './rotmgWindowsClientTune.js';
import {
  getForegroundPid,
  getRelatedRealmProcessIds,
  listExaltProcesses,
} from './rotmgWindowsClientTune.js';

export type RealmClusterResolved = {
  seedPid: number;
  pids: number[];
  role: ClientRole;
};

/** Prune persisted parked IDs that died; persists if pruning changed the file. */
function pruneAndPersistStaleParked(runningPids: Set<number>): Set<number> {
  const prev = loadExaltClientRoles();
  const filtered = prev.parkedPids.filter((p) => runningPids.has(p));
  const prevSort = [...prev.parkedPids].sort((a, b) => a - b);
  const filtSort = [...filtered].sort((a, b) => a - b);
  if (filtSort.length !== prevSort.length || JSON.stringify(filtSort) !== JSON.stringify(prevSort)) {
    saveExaltClientRoles({ parkedPids: filtered });
    return new Set(filtered);
  }
  return new Set(prev.parkedPids.filter((p) => runningPids.has(p)));
}

export type EnumerateRealmClusterOptions = {
  /** Omit to sample live foreground (PowerShell); pass from watchdog / apply batches. */
  foregroundPid?: number | null;
  parkedPids?: number[] | Set<number>;
};

/**
 * Launcher/Unity bundles with resolved multibox role (foreground vs parked buckets).
 *
 * Optionally uses caller-provided FG + parked overrides (deterministic watchdog / apply batches).
 */
export async function enumerateRealmClustersWithRoles(
  options?: EnumerateRealmClusterOptions,
): Promise<{
  clusters: RealmClusterResolved[];
  foregroundPid: number | null;
  logicalProcessors: number;
}> {
  const raw = await listExaltProcesses();
  const procs = raw.processes || [];
  const running = new Set(procs.map((p) => p.pid));

  pruneAndPersistStaleParked(running);

  let fg: number | null;
  if (options && 'foregroundPid' in options) {
    fg = options.foregroundPid ?? null;
  } else {
    fg = await getForegroundPid();
  }

  let effectiveParked: Set<number>;
  if (options?.parkedPids != null) {
    const arr = options.parkedPids instanceof Set ? [...options.parkedPids] : options.parkedPids;
    effectiveParked = new Set(arr.map((p) => Math.floor(Number(p))).filter((p) => p > 0));
  } else {
    const prev = loadExaltClientRoles();
    effectiveParked = new Set(prev.parkedPids.filter((p) => running.has(p)));
    if (
      prev.parkedPids.length !== [...effectiveParked].length ||
      [...prev.parkedPids].sort((a, b) => a - b).join() !== [...effectiveParked].sort((a, b) => a - b).join()
    ) {
      saveExaltClientRoles({ parkedPids: [...effectiveParked] });
    }
  }

  const uniq = [...new Set(procs.map((p) => p.pid))].sort((a, b) => a - b);

  let accounted = new Set<number>();
  const clusters: RealmClusterResolved[] = [];

  for (const seed of uniq) {
    if (accounted.has(seed)) continue;
    const rel = await getRelatedRealmProcessIds(seed);
    for (const id of rel) accounted.add(id);
    const seedPid = Math.min(...rel);
    clusters.push({
      seedPid,
      pids: rel,
      role: resolveClusterRole(rel, fg, effectiveParked),
    });
  }

  return {
    clusters,
    foregroundPid: fg,
    logicalProcessors: raw.logicalProcessors,
  };
}

export function clusterListToPidRoleMap(
  clusters: RealmClusterResolved[],
): Map<number, ClientRole> {
  const map = new Map<number, ClientRole>();
  for (const c of clusters) {
    for (const pid of c.pids) map.set(pid, c.role);
  }
  return map;
}

export async function resolvePidRolesForProcesses(
  processes: ExaltProcessRow[],
  options?: EnumerateRealmClusterOptions,
): Promise<Map<number, ClientRole>> {
  if (!processes.length) return new Map();

  const running = new Set(processes.map((p) => p.pid));

  let fg: number | null;
  if (options && 'foregroundPid' in options) {
    fg = options.foregroundPid ?? null;
  } else {
    fg = await getForegroundPid();
  }

  let effectiveParked: Set<number>;
  if (options?.parkedPids != null) {
    const arr = options.parkedPids instanceof Set ? [...options.parkedPids] : options.parkedPids;
    effectiveParked = new Set(arr.map((p) => Math.floor(Number(p))).filter((p) => p > 0));
  } else {
    const prev = loadExaltClientRoles();
    effectiveParked = new Set(prev.parkedPids.filter((p) => running.has(p)));
    if (
      prev.parkedPids.length !== [...effectiveParked].length ||
      [...prev.parkedPids].sort((a, b) => a - b).join() !== [...effectiveParked].sort((a, b) => a - b).join()
    ) {
      saveExaltClientRoles({ parkedPids: [...effectiveParked] });
    }
  }

  const uniq = [...new Set(processes.map((p) => p.pid))].sort((a, b) => a - b);

  let accounted = new Set<number>();
  const pidToRole = new Map<number, ClientRole>();

  for (const seed of uniq) {
    if (accounted.has(seed)) continue;
    const rel = await getRelatedRealmProcessIds(seed);
    for (const id of rel) accounted.add(id);
    const role = resolveClusterRole(rel, fg, effectiveParked);
    for (const id of rel) pidToRole.set(id, role);
  }
  return pidToRole;
}
