import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { getHiveDocumentsDir } from '../../util/rotmgAssetExtractor.js';

import type { AffinityStrategy, PriorityPreset } from './rotmgWindowsClientTune.js';

export const EXALT_CLIENT_ROLES_VERSION = 1 as const;

export type ClientRole = 'active' | 'background' | 'parked';

export type ClientRoleRule = {
  role: ClientRole;
  priority: PriorityPreset;
  affinityStrategy: AffinityStrategy;
  trimEligible: boolean;
  allowMinimize: boolean;
};

/** Default role rules (Process Lasso–style: active gets boost; parked is restrained). */
export const ROLE_RULES: Record<ClientRole, ClientRoleRule> = {
  active: {
    role: 'active',
    priority: 'AboveNormal',
    affinityStrategy: 'spread-four-cores',
    trimEligible: false,
    allowMinimize: false,
  },
  background: {
    role: 'background',
    priority: 'Normal',
    affinityStrategy: 'spread-two-cores',
    trimEligible: true,
    allowMinimize: false,
  },
  parked: {
    role: 'parked',
    priority: 'BelowNormal',
    affinityStrategy: 'spread-one-core',
    trimEligible: true,
    allowMinimize: true,
  },
};

export type ExaltClientRolesState = {
  version: typeof EXALT_CLIENT_ROLES_VERSION;
  /** Launcher + Unity PIDs explicitly marked parked (multibox). */
  parkedPids: number[];
};

const FILE = 'exalt-client-roles.json';

export function clientRolesPath(): string {
  return join(getHiveDocumentsDir(), FILE);
}

export function defaultExaltClientRoles(): ExaltClientRolesState {
  return {
    version: EXALT_CLIENT_ROLES_VERSION,
    parkedPids: [],
  };
}

export function loadExaltClientRoles(): ExaltClientRolesState {
  const base = defaultExaltClientRoles();
  const path = clientRolesPath();
  if (!existsSync(path)) return base;
  try {
    const raw = readFileSync(path, 'utf8');
    const j = JSON.parse(raw) as Partial<ExaltClientRolesState>;
    const parkedRaw = Array.isArray(j.parkedPids) ? j.parkedPids : [];
    const parkedPids = [
      ...new Set(
        parkedRaw
          .map((p) => Math.floor(Number(p)))
          .filter((p) => Number.isFinite(p) && p > 0),
      ),
    ];
    return { ...base, parkedPids };
  } catch {
    return base;
  }
}

export function saveExaltClientRoles(partial: Partial<ExaltClientRolesState>): ExaltClientRolesState {
  const prev = loadExaltClientRoles();
  const next: ExaltClientRolesState = {
    ...prev,
    ...partial,
    version: EXALT_CLIENT_ROLES_VERSION,
    parkedPids: Array.isArray(partial.parkedPids)
      ? [
          ...new Set(
            partial.parkedPids
              .map((p) => Math.floor(Number(p)))
              .filter((p) => Number.isFinite(p) && p > 0),
          ),
        ]
      : prev.parkedPids,
  };
  const dir = getHiveDocumentsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(clientRolesPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Parked wins; else foreground `active`; else background. */
export function resolveClusterRole(
  clusterPids: number[],
  foregroundPid: number | null,
  parked: Set<number>,
): ClientRole {
  if (clusterPids.some((p) => parked.has(p))) return 'parked';
  if (foregroundPid != null && clusterPids.some((p) => p === foregroundPid)) return 'active';
  return 'background';
}

/** Per-process row (foreground / parked are per-PID; cluster role is authoritative for display). */
export function resolveRowRole(
  pid: number,
  foregroundPid: number | null,
  parked: Set<number>,
): ClientRole {
  if (parked.has(pid)) return 'parked';
  if (foregroundPid != null && pid === foregroundPid) return 'active';
  return 'background';
}
