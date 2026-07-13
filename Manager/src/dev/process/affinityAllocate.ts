import type { ClientRole, ClientRoleRule } from './exaltClientRoles.js';
import type { AffinityStrategy } from './rotmgWindowsClientTune.js';

import type { RealmClusterResolved } from './exaltRealmClusters.js';

/**
 * Perf-counter style CPU bitmask as decimal string (`UInt64` parse in PowerShell).
 */
export function buildAffinityMask(cpuLogicalIndices: number[]): string {
  let mask = 0n;
  for (const raw of cpuLogicalIndices) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const cpu = Math.floor(raw);
    if (cpu < 0 || cpu > 4095) continue;
    mask |= 1n << BigInt(cpu);
  }
  return mask.toString();
}

export function strategyToCpuBudget(s: AffinityStrategy, lp: number): number {
  if (s === 'none' || lp < 1) return 0;
  if (s === 'spread-one-core') return 1;
  if (s === 'spread-two-cores') return Math.min(2, lp);
  if (s === 'spread-four-cores') return Math.min(4, lp);
  return 0;
}

type CpuCursorState = {
  cursor: number;
};

function advanceSlot(lp: number, avoidCpuZero: boolean, state: CpuCursorState): number | null {
  const maxSteps = lp * Math.max(lp, 64);
  for (let step = 0; step < maxSteps; step++) {
    const slot = state.cursor % lp;
    state.cursor++;
    if (avoidCpuZero && lp > 1 && slot === 0) continue;
    return slot;
  }
  return null;
}

export function takeBudgetFromRing(
  lp: number,
  budget: number,
  avoidCpuZero: boolean,
  ring: CpuCursorState,
): number[] {
  const want = Math.max(0, Math.min(Math.floor(budget), lp));
  const picked: number[] = [];
  while (picked.length < want) {
    const s = advanceSlot(lp, avoidCpuZero, ring);
    if (s === null) break;
    picked.push(s);
  }
  return picked;
}

/** Ordered: active clusters first (stable by seed PID), background, parked. */
export function sortClustersForAffinity(clusters: RealmClusterResolved[]): RealmClusterResolved[] {
  const rank = (r: ClientRole): number =>
    r === 'active' ? 0 : r === 'background' ? 1 : 2;
  return [...clusters].sort((a, b) => {
    const dr = rank(a.role) - rank(b.role);
    return dr !== 0 ? dr : a.seedPid - b.seedPid;
  });
}

/**
 * One mask per Realm client cluster (`seedPid` key). Omits clusters when affinity strategy is `none`.
 */
export function allocateAffinityMaskByRolePartition(
  clustersSorted: RealmClusterResolved[],
  effectiveRules: Record<ClientRole, ClientRoleRule>,
  logicalProcessors: number,
  reserveLogicalCores: number,
  avoidCpuZero: boolean,
): Map<number, string> {
  const lp = Math.max(1, Math.floor(Number(logicalProcessors)) || 1);
  const res = Math.max(0, Math.floor(reserveLogicalCores));

  const ordered = sortClustersForAffinity(clustersSorted);
  const ring: CpuCursorState = { cursor: res };
  const out = new Map<number, string>();

  for (const cl of ordered) {
    const strat = effectiveRules[cl.role]?.affinityStrategy ?? 'spread-two-cores';
    const budget = strategyToCpuBudget(strat, lp);
    if (budget <= 0) continue;

    const picked = takeBudgetFromRing(lp, budget, avoidCpuZero, ring);
    if (!picked.length) continue;
    out.set(cl.seedPid, buildAffinityMask(picked));
  }

  return out;
}
