import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { ClientEvent, type Client } from 'headless-client';
import type { FleetAccount } from './HeadlessFleet.js';

export type DailyLoginEntryStatus = 'pending' | 'running' | 'deferred' | 'succeeded' | 'failed';

export interface DailyLoginCandidate extends FleetAccount {
  configurationError?: string;
}

export interface DailyLoginReportEntry {
  accountId: string;
  label: string;
  status: DailyLoginEntryStatus;
  startedAt?: string;
  completedAt?: string;
  mapName?: string;
  message?: string;
}

export interface DailyLoginReport {
  utcDate: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  entries: Record<string, DailyLoginReportEntry>;
}

export interface DailyLoginFleet {
  isBusy(accountId: string): boolean;
  connect(account: FleetAccount): Promise<Client>;
  disconnect(accountId: string, reason?: string): boolean;
}

export interface DailyLoginServiceOptions {
  stateFile: string;
  concurrency?: number;
  readyTimeoutMs?: number;
  gracePeriodMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

const DEFAULT_CONCURRENCY = 2;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_GRACE_PERIOD_MS = 3_000;

/**
 * Runs opted-in accounts through a short, full headless game login once per
 * UTC day. Reports are persisted so completed/failed accounts are not repeated
 * after a Manager restart and interrupted work can resume.
 */
export class DailyLoginService {
  private readonly concurrency: number;
  private readonly readyTimeoutMs: number;
  private readonly gracePeriodMs: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private activeRun: Promise<DailyLoginReport | null> | null = null;

  constructor(
    private readonly fleet: DailyLoginFleet,
    private readonly options: DailyLoginServiceOptions,
  ) {
    this.concurrency = Math.max(1, Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.readyTimeoutMs = Math.max(1, Math.trunc(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS));
    this.gracePeriodMs = Math.max(0, Math.trunc(options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS));
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
  }

  runDue(accounts: DailyLoginCandidate[], force = false): Promise<DailyLoginReport | null> {
    if (this.activeRun) return this.activeRun;
    const task = this.runDueInternal(accounts, force).finally(() => {
      if (this.activeRun === task) this.activeRun = null;
    });
    this.activeRun = task;
    return task;
  }

  getReport(): DailyLoginReport | null {
    return this.readReport();
  }

  private async runDueInternal(accounts: DailyLoginCandidate[], force: boolean): Promise<DailyLoginReport | null> {
    const now = this.now();
    if (!force && !isDailyLoginWindowOpen(now)) return this.readReport();
    if (accounts.length === 0) return this.readReport();

    const utcDate = toUtcDate(now);
    let report = this.readReport();
    if (!report || report.utcDate !== utcDate) {
      const timestamp = now.toISOString();
      report = { utcDate, startedAt: timestamp, updatedAt: timestamp, entries: {} };
    }

    for (const entry of Object.values(report.entries)) {
      if (entry.status === 'running') entry.status = 'pending';
    }
    for (const account of accounts) {
      const existing = report.entries[account.id];
      if (!existing) {
        report.entries[account.id] = {
          accountId: account.id,
          label: account.label || account.email,
          status: 'pending',
        };
      } else {
        existing.label = account.label || account.email;
      }
    }

    const candidates = accounts.filter((account) => {
      const status = report!.entries[account.id]?.status;
      return status === 'pending' || status === 'deferred';
    });
    if (candidates.length === 0) return report;

    report.completedAt = undefined;
    this.persistReport(report);
    this.log(`starting ${candidates.length} account(s) with concurrency ${this.concurrency}`);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < candidates.length) {
        const account = candidates[cursor++];
        await this.runAccount(report!, account);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, candidates.length) }, () => worker()));

    const enabledIds = new Set(accounts.map((account) => account.id));
    const unfinished = Object.values(report.entries).some(
      (entry) => enabledIds.has(entry.accountId) && (entry.status === 'pending' || entry.status === 'running' || entry.status === 'deferred'),
    );
    if (!unfinished) report.completedAt = this.now().toISOString();
    this.persistReport(report);
    return report;
  }

  private async runAccount(report: DailyLoginReport, account: DailyLoginCandidate): Promise<void> {
    const entry = report.entries[account.id];
    if (this.fleet.isBusy(account.id)) {
      entry.status = 'deferred';
      entry.message = 'Account is already running; daily login was deferred.';
      entry.completedAt = undefined;
      this.persistReport(report);
      return;
    }

    entry.status = 'running';
    entry.startedAt = this.now().toISOString();
    entry.completedAt = undefined;
    entry.mapName = undefined;
    entry.message = undefined;
    this.persistReport(report);
    this.log(`connecting ${entry.label}`);

    let ownsSession = false;
    try {
      if (account.configurationError) throw new Error(account.configurationError);
      if (!account.email.trim() || !account.password) throw new Error('Missing account credentials.');
      const client = await this.fleet.connect(account);
      ownsSession = true;
      await this.waitUntilReady(client);
      if (this.gracePeriodMs > 0) await delay(this.gracePeriodMs);
      entry.status = 'succeeded';
      entry.mapName = client.getMapName();
      entry.message = `Connected fully to ${entry.mapName || 'the game'}.`;
      this.log(`completed ${entry.label} on ${entry.mapName || 'unknown map'}`);
    } catch (error) {
      entry.status = 'failed';
      entry.message = error instanceof Error ? error.message : String(error);
      this.log(`failed ${entry.label}: ${entry.message}`);
    } finally {
      entry.completedAt = this.now().toISOString();
      if (ownsSession) this.fleet.disconnect(account.id, 'daily login complete');
      this.persistReport(report);
    }
  }

  private waitUntilReady(client: Client): Promise<void> {
    if (client.isInWorld()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timeout);
        client.off(ClientEvent.Ready, onReady);
      };
      const onReady = (): void => {
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting ${Math.round(this.readyTimeoutMs / 1000)}s for the account to enter the game.`));
      }, this.readyTimeoutMs);
      client.on(ClientEvent.Ready, onReady);
    });
  }

  private readReport(): DailyLoginReport | null {
    try {
      if (!existsSync(this.options.stateFile)) return null;
      const parsed = JSON.parse(readFileSync(this.options.stateFile, 'utf8')) as DailyLoginReport;
      if (!parsed || typeof parsed !== 'object' || !parsed.utcDate || !parsed.entries) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private persistReport(report: DailyLoginReport): void {
    report.updatedAt = this.now().toISOString();
    mkdirSync(dirname(this.options.stateFile), { recursive: true });
    const temporaryFile = `${this.options.stateFile}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    renameSync(temporaryFile, this.options.stateFile);
  }
}

export function toUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function isDailyLoginWindowOpen(value: Date): boolean {
  return value.getUTCHours() > 0 || value.getUTCMinutes() >= 5;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
