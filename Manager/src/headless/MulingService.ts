import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import {
  AcceptTradePacket,
  CancelTradePacket,
  ChangeTradePacket,
  ClientEvent,
  PacketType,
  RequestTradePacket,
  type Client,
  type TradeAcceptedPacket,
  type TradeChangedPacket,
  type TradeDonePacket,
  type TradeItem,
  type TradeRequestedPacket,
  type TradeStartPacket,
} from 'headless-client';
import type { GameDataLoader } from '../game-data/GameDataLoader.js';
import type { FleetAccount } from './HeadlessFleet.js';

export type MulingRole = 'off' | 'source' | 'mule';
export type MulingGearKind = 'weapon' | 'ability' | 'armor' | 'ring';
export type MulingPotionKind = 'attack' | 'defense' | 'speed' | 'dexterity' | 'vitality' | 'wisdom' | 'life' | 'mana';

export interface MulingRules {
  potions: MulingPotionKind[];
  weaponTiers: number[];
  abilityTiers: number[];
  armorTiers: number[];
  ringTiers: number[];
  itemTypes: number[];
}

export interface MulingCandidate extends FleetAccount {
  role: MulingRole;
  rules: MulingRules;
  configurationError?: string;
}

export interface MulingCapacity {
  inventoryFree: number;
  vaultFree: number;
  potionFree: number;
  full: boolean;
}

export interface MulingAccountReport {
  accountId: string;
  label: string;
  role: MulingRole;
  status: 'pending' | 'running' | 'skipped' | 'completed' | 'failed' | 'full' | 'cancelled';
  message: string;
  serverName?: string;
  movedItems?: number;
  capacity?: MulingCapacity;
  updatedAt: string;
}

export interface MulingReport {
  running: boolean;
  stopping?: boolean;
  cycleId: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  accounts: Record<string, MulingAccountReport>;
}

export interface MulingFleet {
  isBusy(accountId: string): boolean;
  connect(account: FleetAccount): Promise<Client>;
  disconnect(accountId: string, reason?: string): boolean;
}

export interface MulingServiceOptions {
  stateFile: string;
  intervalMs?: number;
  readyTimeoutMs?: number;
  tradeTimeoutMs?: number;
  tradeSettleMs?: number;
  vaultTimeoutMs?: number;
  now?: () => Date;
  random?: () => number;
  log?: (message: string) => void;
}

const MAIN_INVENTORY_SLOTS = [4, 5, 6, 7, 8, 9, 10, 11] as const;
const DEFAULT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_TRADE_TIMEOUT_MS = 20_000;
const DEFAULT_TRADE_SETTLE_MS = 1_500;
const DEFAULT_VAULT_TIMEOUT_MS = 60_000;
const INVENTORY_TRANSFER_SETTLE_MS = 650;
const RECONNECT_INVENTORY_SETTLE_MS = 500;
const POTION_KINDS: MulingPotionKind[] = [
  'attack', 'defense', 'speed', 'dexterity', 'vitality', 'wisdom', 'life', 'mana',
];

/**
 * Coordinates safe one-way trades from source accounts to configured mules.
 * A cycle uses one source and one mule at a time, keeping the pair on the same
 * randomly selected regional server and preserving each account's proxy.
 */
export class MulingService {
  private readonly intervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly tradeTimeoutMs: number;
  private readonly tradeSettleMs: number;
  private readonly vaultTimeoutMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly log: (message: string) => void;
  private activeRun: Promise<MulingReport | null> | null = null;
  private activeReport: MulingReport | null = null;
  private cancellationRequested = false;
  private readonly cycleConnections = new Set<string>();

  constructor(
    private readonly fleet: MulingFleet,
    private readonly gameData: GameDataLoader,
    private readonly options: MulingServiceOptions,
  ) {
    this.intervalMs = Math.max(60_000, Math.trunc(options.intervalMs ?? DEFAULT_INTERVAL_MS));
    this.readyTimeoutMs = Math.max(1_000, Math.trunc(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS));
    this.tradeTimeoutMs = Math.max(1_000, Math.trunc(options.tradeTimeoutMs ?? DEFAULT_TRADE_TIMEOUT_MS));
    this.tradeSettleMs = Math.max(0, Math.trunc(options.tradeSettleMs ?? DEFAULT_TRADE_SETTLE_MS));
    this.vaultTimeoutMs = Math.max(1_000, Math.trunc(options.vaultTimeoutMs ?? DEFAULT_VAULT_TIMEOUT_MS));
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => undefined);
  }

  runDue(accounts: MulingCandidate[], serverNames: string[], force = false): Promise<MulingReport | null> {
    if (this.activeRun) return this.activeRun;
    const previous = this.readReport();
    const completedAt = previous?.completedAt ? Date.parse(previous.completedAt) : 0;
    if (!force && completedAt > 0 && this.now().getTime() - completedAt < this.intervalMs) {
      return Promise.resolve(previous);
    }
    this.cancellationRequested = false;
    const task = this.runCycle(accounts, serverNames).finally(() => {
      if (this.activeRun === task) this.activeRun = null;
      this.activeReport = null;
      this.cycleConnections.clear();
    });
    this.activeRun = task;
    return task;
  }

  getReport(): MulingReport | null {
    return this.readReport();
  }

  stop(): MulingReport | null {
    const report = this.activeReport;
    if (!report || (!report.running && !report.stopping)) return this.readReport();
    this.cancellationRequested = true;
    report.stopping = true;
    const cancelledAt = this.now().toISOString();
    report.cancelledAt = cancelledAt;
    for (const entry of Object.values(report.accounts)) {
      if (entry.status !== 'pending' && entry.status !== 'running') continue;
      entry.status = 'cancelled';
      entry.message = 'Stopping muling at the user\'s request.';
      entry.updatedAt = cancelledAt;
    }
    this.persistReport(report);
    for (const accountId of this.cycleConnections) {
      this.fleet.disconnect(accountId, 'muling stopped by user');
    }
    this.log('Muling stop requested; active cycle connections are being closed.');
    return report;
  }

  private async runCycle(accounts: MulingCandidate[], serverNames: string[]): Promise<MulingReport | null> {
    const sources = accounts.filter((account) => account.role === 'source');
    const mules = accounts.filter((account) => account.role === 'mule');
    if (sources.length === 0 || mules.length === 0 || serverNames.length === 0) {
      const previous = this.readReport();
      if (previous?.running) {
        previous.running = false;
        previous.completedAt = undefined;
        this.persistReport(previous);
      }
      return previous;
    }

    const startedAt = this.now().toISOString();
    const report: MulingReport = {
      running: true,
      cycleId: `mule-${this.now().getTime().toString(36)}`,
      startedAt,
      updatedAt: startedAt,
      accounts: {},
    };
    this.activeReport = report;
    for (const account of [...sources, ...mules]) {
      report.accounts[account.id] = {
        accountId: account.id,
        label: account.label || account.email,
        role: account.role,
        status: 'pending',
        message: 'Waiting for this muling cycle.',
        movedItems: 0,
        updatedAt: startedAt,
      };
    }
    this.persistReport(report);

    for (const source of sources) {
      if (this.cancellationRequested) break;
      await this.runSource(report, source, mules, serverNames);
    }

    for (const mule of mules) {
      if (this.cancellationRequested) break;
      if (report.accounts[mule.id]?.status === 'pending') {
        await this.runMuleMaintenance(report, mule, serverNames);
      }
    }

    for (const entry of Object.values(report.accounts)) {
      if (entry.status === 'pending') {
        entry.status = this.cancellationRequested ? 'cancelled' : 'skipped';
        entry.message = this.cancellationRequested
          ? 'Muling stopped before this account was processed.'
          : 'No configured items were routed to this account during the cycle.';
        entry.updatedAt = this.now().toISOString();
      }
    }

    report.running = false;
    report.stopping = false;
    report.completedAt = this.now().toISOString();
    if (this.cancellationRequested) report.cancelledAt = report.completedAt;
    this.persistReport(report);
    return report;
  }

  private async runMuleMaintenance(
    report: MulingReport,
    mule: MulingCandidate,
    serverNames: string[],
  ): Promise<void> {
    const entry = report.accounts[mule.id];
    if (mule.configurationError) {
      this.updateEntry(report, entry, 'failed', mule.configurationError);
      return;
    }
    if (this.fleet.isBusy(mule.id)) {
      this.updateEntry(report, entry, 'skipped', 'Mule is already running; storage maintenance was skipped.');
      return;
    }
    const serverName = chooseServer(serverNames, this.random);
    entry.serverName = serverName;
    this.updateEntry(report, entry, 'running', `Checking and organizing storage on ${serverName}.`);
    let client: Client | undefined;
    try {
      this.throwIfCancelled();
      this.cycleConnections.add(mule.id);
      client = await this.fleet.connect({ ...mule, serverName });
      this.throwIfCancelled();
      await this.waitForReady(client);
      await this.requireNexus(client, mule);
      const capacity = await this.organizeMule(client);
      entry.capacity = capacity;
      this.updateEntry(
        report,
        entry,
        capacity.full ? 'full' : 'completed',
        capacity.full
          ? 'Storage organized; mule has no free inventory, vault, or potion-storage space.'
          : 'Storage organized and capacity refreshed.',
      );
    } catch (error) {
      this.updateEntry(report, entry, this.cancellationRequested ? 'cancelled' : 'failed',
        this.cancellationRequested ? 'Muling stopped by user.' : errorMessage(error));
    } finally {
      if (client) this.fleet.disconnect(mule.id, 'muling storage maintenance complete');
      this.cycleConnections.delete(mule.id);
    }
  }

  private async runSource(
    report: MulingReport,
    source: MulingCandidate,
    mules: MulingCandidate[],
    serverNames: string[],
  ): Promise<void> {
    const sourceReport = report.accounts[source.id];
    if (source.configurationError) {
      this.updateEntry(report, sourceReport, 'failed', source.configurationError);
      return;
    }
    if (this.fleet.isBusy(source.id)) {
      this.updateEntry(report, sourceReport, 'skipped', 'Account is already running; this cycle left it untouched.');
      return;
    }

    const serverName = chooseServer(serverNames, this.random);
    sourceReport.serverName = serverName;
    this.updateEntry(report, sourceReport, 'running', `Connecting to ${serverName}.`);
    let sourceClient: Client | undefined;
    let moved = 0;
    try {
      this.throwIfCancelled();
      this.cycleConnections.add(source.id);
      sourceClient = await this.fleet.connect({ ...source, serverName });
      this.throwIfCancelled();
      await this.waitForReady(sourceClient);
      await this.requireNexus(sourceClient, source);

      for (const mule of mules) {
        this.throwIfCancelled();
        if (report.accounts[mule.id]?.status === 'full') continue;
        moved += await this.runPair(report, source, sourceClient, mule, serverName);
      }

      await this.waitForReady(sourceClient);
      await this.requireNexus(sourceClient, source);
      const remaining = this.countMatchingCarriedItems(sourceClient, source.rules)
        + this.countMatchingStoredItems(sourceClient, source.rules);
      sourceReport.movedItems = moved;
      this.updateEntry(
        report,
        sourceReport,
        'completed',
        remaining > 0
          ? `Moved ${moved} item(s); ${remaining} configured item(s) remain because no available mule could accept them.`
          : `Moved ${moved} item(s); no configured dump items remain in inventory or storage.`,
      );
    } catch (error) {
      sourceReport.movedItems = moved;
      this.updateEntry(report, sourceReport, this.cancellationRequested ? 'cancelled' : 'failed',
        this.cancellationRequested ? `Muling stopped after moving ${moved} item(s).` : errorMessage(error));
    } finally {
      if (sourceClient) this.fleet.disconnect(source.id, 'muling source complete');
      this.cycleConnections.delete(source.id);
    }
  }

  private async runPair(
    report: MulingReport,
    source: MulingCandidate,
    sourceClient: Client,
    mule: MulingCandidate,
    serverName: string,
  ): Promise<number> {
    const muleReport = report.accounts[mule.id];
    if (mule.configurationError) {
      this.updateEntry(report, muleReport, 'failed', mule.configurationError);
      return 0;
    }
    if (this.fleet.isBusy(mule.id)) {
      this.updateEntry(report, muleReport, 'skipped', 'Mule is already running; this cycle left it untouched.');
      return 0;
    }

    await this.requireNexus(sourceClient, source);
    await this.stageMatchingStoredItems(sourceClient, source.rules, mule.rules);
    if (!this.sourceHasItemsForMule(sourceClient, source.rules, mule.rules)) return 0;

    muleReport.serverName = serverName;
    this.updateEntry(report, muleReport, 'running', `Pairing with ${source.label || source.email} on ${serverName}.`);
    let muleClient: Client | undefined;
    let moved = 0;
    try {
      this.throwIfCancelled();
      this.cycleConnections.add(mule.id);
      muleClient = await this.fleet.connect({ ...mule, serverName });
      this.throwIfCancelled();
      await this.waitForReady(muleClient);
      await this.requireNexus(muleClient, mule);
      let capacity = await this.organizeMule(muleClient);
      muleReport.capacity = capacity;
      if (capacity.full) {
        this.updateEntry(report, muleReport, 'full', 'Mule has no free inventory, vault, or potion-storage space.');
        return 0;
      }

      while (true) {
        this.throwIfCancelled();
        await this.requireNexus(sourceClient, source);
        await this.requireNexus(muleClient, mule);
        if (moved > 0) await this.stageMatchingStoredItems(sourceClient, source.rules, mule.rules);
        await this.stageMatchingBackpackItems(sourceClient, source.rules, mule.rules);
        if (!this.sourceHasItemsForMule(sourceClient, source.rules, mule.rules)) break;
        const receivingSlots = this.emptyMainInventoryCount(muleClient);
        if (receivingSlots <= 0) {
          capacity = await this.organizeMule(muleClient);
          muleReport.capacity = capacity;
          if (this.emptyMainInventoryCount(muleClient) <= 0) break;
          continue;
        }

        const traded = await this.tradeBatch(
          sourceClient,
          muleClient,
          source.rules,
          mule.rules,
          receivingSlots,
        );
        if (traded <= 0) break;
        moved += traded;
        muleReport.movedItems = (muleReport.movedItems ?? 0) + traded;
        capacity = await this.organizeMule(muleClient);
        muleReport.capacity = capacity;
        this.updateEntry(report, muleReport, capacity.full ? 'full' : 'running',
          capacity.full ? `Stored ${moved} item(s); mule is now full.` : `Stored ${moved} item(s); checking for another batch.`);
        if (capacity.full) break;
      }

      if (muleReport.status !== 'full') {
        this.updateEntry(report, muleReport, 'completed', `Received and organized ${moved} item(s).`);
      }
      return moved;
    } catch (error) {
      this.updateEntry(report, muleReport, this.cancellationRequested ? 'cancelled' : 'failed',
        this.cancellationRequested ? `Muling stopped after receiving ${moved} item(s).` : errorMessage(error));
      return moved;
    } finally {
      if (muleClient) this.fleet.disconnect(mule.id, 'muling mule complete');
      this.cycleConnections.delete(mule.id);
    }
  }

  private async tradeBatch(
    source: Client,
    mule: Client,
    sourceRules: MulingRules,
    muleRules: MulingRules,
    receivingSlots: number,
  ): Promise<number> {
    this.throwIfCancelled();
    const sourceName = await this.waitForPlayerName(source);
    const muleName = await this.waitForPlayerName(mule);
    const sourceTrade = new TradePeer(source);
    const muleTrade = new TradePeer(mule);
    try {
      sourceTrade.request(muleName);
      await muleTrade.waitForRequest(sourceName, this.tradeTimeoutMs, () => this.cancellationRequested);
      muleTrade.request(sourceName);
      const [sourceStart, muleStart] = await Promise.all([
        sourceTrade.waitForStart(muleName, this.tradeTimeoutMs, () => this.cancellationRequested),
        muleTrade.waitForStart(sourceName, this.tradeTimeoutMs, () => this.cancellationRequested),
      ]);
      this.throwIfCancelled();
      const indexes: number[] = [];
      for (let index = 4; index < sourceStart.clientItems.length && indexes.length < receivingSlots; index++) {
        const item = sourceStart.clientItems[index];
        if (!item || item.item <= 0 || !item.tradeable) continue;
        if (matchesMulingRules(this.gameData, item.item, sourceRules)
          && matchesMulingRules(this.gameData, item.item, muleRules)) {
          indexes.push(index);
        }
      }
      if (indexes.length === 0) {
        sourceTrade.cancel();
        return 0;
      }

      const sourceOffer = sourceStart.clientItems.map((_, index) => indexes.includes(index));
      const muleOffer = muleStart.clientItems.map(() => false);
      sourceTrade.changeOffer(sourceOffer);
      muleTrade.changeOffer(muleOffer);
      await waitUntil(() => offersEqual(muleTrade.partnerOffer, sourceOffer), this.tradeTimeoutMs,
        'Mule did not receive the expected source offer.', () => this.cancellationRequested);
      await waitUntil(() => !sourceTrade.partnerOffer.some(Boolean), this.tradeTimeoutMs,
        'Source received an unexpected return offer from the mule.', () => this.cancellationRequested);

      const expected = indexes.map((index) => sourceStart.clientItems[index].item).sort((a, b) => a - b);
      const observed = muleStart.partnerItems
        .filter((_, index) => muleTrade.partnerOffer[index])
        .map((item) => item.item)
        .sort((a, b) => a - b);
      if (!numberArraysEqual(expected, observed)
        || observed.some((itemType) => !matchesMulingRules(this.gameData, itemType, muleRules))) {
        throw new Error('Mule rejected a trade whose offered items did not match its acceptance rules.');
      }

      await delay(this.tradeSettleMs, () => this.cancellationRequested);
      await this.confirmTradeAcceptance(
        muleTrade,
        sourceTrade,
        'mule',
      );
      await this.confirmTradeAcceptance(
        sourceTrade,
        muleTrade,
        'source',
      );
      const [sourceDone, muleDone] = await Promise.all([
        sourceTrade.waitForDone(this.tradeTimeoutMs, () => this.cancellationRequested),
        muleTrade.waitForDone(this.tradeTimeoutMs, () => this.cancellationRequested),
      ]);
      if (Number(sourceDone.code) !== 0 || Number(muleDone.code) !== 0) {
        throw new Error(sourceDone.description || muleDone.description || 'The game cancelled the trade.');
      }
      await delay(500, () => this.cancellationRequested);
      return indexes.length;
    } finally {
      sourceTrade.dispose();
      muleTrade.dispose();
    }
  }

  private async confirmTradeAcceptance(
    acceptingPeer: TradePeer,
    observingPeer: TradePeer,
    label: string,
  ): Promise<void> {
    const attemptTimeout = Math.min(4_000, this.tradeTimeoutMs);
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.throwIfCancelled();
      const acceptedBaseline = acceptingPeer.acceptedCount + observingPeer.acceptedCount;
      acceptingPeer.accept();
      try {
        await waitUntil(
          () => acceptingPeer.done !== null
            || observingPeer.done !== null
            || acceptingPeer.acceptedCount + observingPeer.acceptedCount > acceptedBaseline,
          attemptTimeout,
          `The game did not acknowledge the ${label}'s trade acceptance.`,
          () => this.cancellationRequested,
        );
        return;
      } catch (error) {
        this.throwIfCancelled();
        if (attempt >= 3) throw error;
        this.log(`retrying ${label} trade acceptance (${attempt + 1}/3)`);
        await delay(750, () => this.cancellationRequested);
      }
    }
  }

  private async organizeMule(client: Client): Promise<MulingCapacity> {
    const mainSlots = new Set<number>(MAIN_INVENTORY_SLOTS);
    const failedSlots = new Map<string, number>();
    const maxAttempts = Math.max(16, client.getCarriedInventorySlotIds().length * 3);
    let attempts = 0;
    while (attempts < maxAttempts) {
      this.throwIfCancelled();
      await this.enterMuleVault(client);

      const candidate = client.getCarriedInventorySlotIds()
        .map((slotId) => {
          const source = client.getContainerSlot('inventory', slotId);
          if (!source || source.objectType <= 0) return undefined;
          const key = `${slotId}:${source.objectType}`;
          if ((failedSlots.get(key) ?? 0) >= 2) return undefined;
          const potionKind = classifyStatPotion(this.gameData, source.objectType);
          let destination = potionKind
            ? client.getPotionVaultSlots().find((slot) => slot.objectType === -1)
            : undefined;
          destination ??= client.getVaultSlots().find((slot) => slot.objectType === -1);
          // Once account storage is full, use unlocked backpack/extender slots
          // as overflow so occupied trade-visible slots can still be cleared
          // for one final batch.
          if (!destination && mainSlots.has(slotId)) {
            destination = client.getCarriedInventorySlotIds()
              .filter((candidateSlotId) => !mainSlots.has(candidateSlotId))
              .map((candidateSlotId) => client.getContainerSlot('inventory', candidateSlotId))
              .find((slot) => slot?.objectType === -1) ?? undefined;
          }
          return destination ? { source, destination, slotId, key } : undefined;
        })
        .find((entry) => !!entry);
      if (!candidate) break;

      attempts += 1;
      const { source, destination, slotId, key } = candidate;
      const itemType = source.objectType;
      const beforeStored = [...client.getPotionVaultSlots(), ...client.getVaultSlots()]
        .filter((slot) => slot.objectType === itemType).length;
      let transferConfirmed = false;
      try {
        transferConfirmed = await client.transferBetweenContainers(source, destination, 8_000);
      } catch (error) {
        if (this.cancellationRequested) throw error;
        this.log(`mule storage transfer for item ${itemType} was interrupted: ${errorMessage(error)}`);
      }
      this.throwIfCancelled();
      await delay(INVENTORY_TRANSFER_SETTLE_MS, () => this.cancellationRequested);

      let recoveredFromReconnect = false;
      if (!client.isInVault() || !client.isInWorld() || !this.isClientInventoryReady(client)) {
        await waitUntil(
          () => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
          this.readyTimeoutMs,
          'Timed out recovering the mule in Nexus after a storage transfer.',
          () => this.cancellationRequested,
        );
        await delay(RECONNECT_INVENTORY_SETTLE_MS, () => this.cancellationRequested);
        await this.enterMuleVault(client);
        recoveredFromReconnect = true;
      }

      const currentSource = client.getContainerSlot('inventory', slotId);
      const afterStored = [...client.getPotionVaultSlots(), ...client.getVaultSlots()]
        .filter((slot) => slot.objectType === itemType).length;
      const madeProgress = currentSource?.objectType !== itemType
        || afterStored > beforeStored
        || (transferConfirmed && recoveredFromReconnect);
      if (madeProgress) {
        failedSlots.delete(key);
      } else {
        failedSlots.set(key, (failedSlots.get(key) ?? 0) + 1);
        this.log(`could not store item ${itemType} from slot ${slotId}`);
      }
    }

    const capacity = this.readCapacity(client);
    if (client.isInVault() && client.isInWorld()) client.escape();
    await waitUntil(
      () => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
      this.readyTimeoutMs,
      'Timed out returning from the vault to Nexus.', () => this.cancellationRequested);
    return capacity;
  }

  private async enterMuleVault(client: Client): Promise<void> {
    const currentSnapshot = client.getVaultContent();
    if (client.isInVault() && client.isInWorld() && this.isClientInventoryReady(client)
      && currentSnapshot?.active !== false && currentSnapshot?.lastVaultPacket) {
      return;
    }
    if (!client.isInNexus() || !client.isInWorld() || !this.isClientInventoryReady(client)) {
      await waitUntil(
        () => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
        this.readyTimeoutMs,
        'Timed out waiting for the mule to recover in Nexus.',
        () => this.cancellationRequested,
      );
    }
    const previousRevision = client.getVaultContent()?.revision ?? 0;
    client.enterVault();
    await waitUntil(() => {
      const snapshot = client.getVaultContent();
      return client.isInVault() && client.isInWorld() && this.isClientInventoryReady(client)
        && snapshot?.active !== false && !!snapshot?.lastVaultPacket
        && snapshot.revision > previousRevision;
    }, this.vaultTimeoutMs, 'Timed out waiting for complete mule vault contents.',
    () => this.cancellationRequested);
  }

  private readCapacity(client: Client): MulingCapacity {
    const inventoryFree = client.getCarriedInventorySlotIds()
      .filter((slotId) => client.getContainerSlot('inventory', slotId)?.objectType === -1).length;
    const vaultFree = client.getVaultSlots().filter((slot) => slot.objectType === -1).length;
    const potionFree = client.getPotionVaultSlots().filter((slot) => slot.objectType === -1).length;
    return {
      inventoryFree,
      vaultFree,
      potionFree,
      full: inventoryFree === 0 && vaultFree === 0 && potionFree === 0,
    };
  }

  private async stageMatchingStoredItems(
    client: Client,
    sourceRules: MulingRules,
    muleRules: MulingRules,
  ): Promise<number> {
    let staged = 0;
    let consecutiveFailures = 0;
    while (consecutiveFailures < 2) {
      this.throwIfCancelled();
      await this.enterSourceVault(client);
      if (!this.hasEmptyCarriedSlot(client)) {
        await this.returnSourceToNexus(client);
        break;
      }

      while (client.isInVault() && client.isInWorld() && this.hasEmptyCarriedSlot(client)) {
        this.throwIfCancelled();
        const storedItem = this.findMatchingStoredItem(client, sourceRules, muleRules);
        const destination = client.getCarriedInventorySlotIds()
          .map((slotId) => client.getContainerSlot('inventory', slotId))
          .find((slot) => !!slot && slot.objectType === -1);
        if (!storedItem || !destination) {
          await this.returnSourceToNexus(client);
          return staged;
        }

        const itemType = storedItem.objectType;
        const destinationSlotId = destination.slotId;
        const beforeCarried = this.countMatchingCarriedItemsForMule(client, sourceRules, muleRules);
        const beforeStored = this.countMatchingStoredItemsForMule(client, sourceRules, muleRules);
        let transferConfirmed = false;
        try {
          transferConfirmed = await client.transferBetweenContainers(storedItem, destination, 8_000);
        } catch (error) {
          if (this.cancellationRequested) throw error;
          this.log(`storage withdrawal for item ${itemType} was interrupted: ${errorMessage(error)}`);
        }
        this.throwIfCancelled();

        // A transient Vault disconnect can arrive immediately after a successful
        // INVRESULT. Give it time to surface before reusing any map-scoped slots.
        await delay(350, () => this.cancellationRequested);
        let recoveredFromReconnect = false;
        if (!client.isInVault() || !client.isInWorld()) {
          await waitUntil(() => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
            this.readyTimeoutMs,
            'Timed out recovering the source in Nexus after a storage withdrawal.',
            () => this.cancellationRequested);
          await delay(RECONNECT_INVENTORY_SETTLE_MS, () => this.cancellationRequested);
          recoveredFromReconnect = true;
        }

        const currentDestination = client.getContainerSlot('inventory', destinationSlotId);
        const afterCarried = this.countMatchingCarriedItemsForMule(client, sourceRules, muleRules);
        const afterStored = this.countMatchingStoredItemsForMule(client, sourceRules, muleRules);
        const madeProgress = currentDestination?.objectType === itemType
          || afterCarried > beforeCarried
          || afterStored < beforeStored
          || (transferConfirmed && recoveredFromReconnect);
        if (madeProgress) {
          staged += 1;
          consecutiveFailures = 0;
          this.log(`staged stored item ${itemType} for muling (${staged} this batch)`);
        } else {
          consecutiveFailures += 1;
          this.log(`could not stage stored item ${itemType} for muling`);
          if (consecutiveFailures >= 2) break;
        }

        // Object ids from Vault are map-scoped. If the server reconnected us to
        // Nexus, leave this inner loop and load a fresh Vault snapshot before
        // attempting the next item.
        if (!client.isInVault() || !client.isInWorld()) break;

        // Even when the promise did not observe the INVRESULT, authoritative
        // before/after state is sufficient to confirm the withdrawal.
        if (!transferConfirmed && !madeProgress) break;
      }

      if (client.isInVault() && client.isInWorld()) await this.returnSourceToNexus(client);
      if (!this.hasEmptyCarriedSlot(client)
        || this.countMatchingStoredItemsForMule(client, sourceRules, muleRules) === 0) break;
    }
    return staged;
  }

  private async enterSourceVault(client: Client): Promise<void> {
    if (!client.isInNexus() || !client.isInWorld() || !this.isClientInventoryReady(client)) {
      await waitUntil(() => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
        this.readyTimeoutMs,
        'Timed out waiting for the source to recover in Nexus.', () => this.cancellationRequested);
    }
    const previousRevision = client.getVaultContent()?.revision ?? 0;
    client.enterVault();
    await waitUntil(() => {
      const snapshot = client.getVaultContent();
      return client.isInVault() && client.isInWorld()
        && this.isClientInventoryReady(client) && snapshot?.active !== false
        && !!snapshot?.lastVaultPacket && snapshot.revision > previousRevision;
    }, this.vaultTimeoutMs, 'Timed out waiting for source storage contents.', () => this.cancellationRequested);
  }

  private async returnSourceToNexus(client: Client): Promise<void> {
    if (client.isInVault() && client.isInWorld()) client.escape();
    await waitUntil(() => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
      this.readyTimeoutMs,
      'Timed out returning the source from the vault to Nexus.', () => this.cancellationRequested);
  }

  private isClientInventoryReady(client: Client): boolean {
    return client.getInventory() !== undefined;
  }

  private hasEmptyCarriedSlot(client: Client): boolean {
    return client.getCarriedInventorySlotIds().some((slotId) => {
      return client.getContainerSlot('inventory', slotId)?.objectType === -1;
    });
  }

  private findMatchingStoredItem(client: Client, sourceRules: MulingRules, muleRules: MulingRules) {
    return [...client.getPotionVaultSlots(), ...client.getVaultSlots()].find((slot) => {
      return slot.objectType > 0
        && matchesMulingRules(this.gameData, slot.objectType, sourceRules)
        && matchesMulingRules(this.gameData, slot.objectType, muleRules);
    });
  }

  private async stageMatchingBackpackItems(
    client: Client,
    sourceRules: MulingRules,
    muleRules: MulingRules,
  ): Promise<void> {
    const mainSlots = new Set<number>(MAIN_INVENTORY_SLOTS);
    let consecutiveFailures = 0;
    while (consecutiveFailures < 2) {
      this.throwIfCancelled();
      if (!client.isInNexus() || !client.isInWorld() || !this.isClientInventoryReady(client)) {
        await waitUntil(
          () => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
          this.readyTimeoutMs,
          'Timed out recovering the source while staging backpack items.',
          () => this.cancellationRequested,
        );
      }

      const mainInventory = MAIN_INVENTORY_SLOTS
        .map((slotId) => client.getContainerSlot('inventory', slotId));
      const destination = mainInventory.find((slot) => slot?.objectType === -1)
        ?? mainInventory.find((slot) => {
          const itemType = slot?.objectType ?? -1;
          return itemType > 0
            && (!matchesMulingRules(this.gameData, itemType, sourceRules)
              || !matchesMulingRules(this.gameData, itemType, muleRules));
        });
      const source = client.getCarriedInventorySlotIds()
        .filter((slotId) => !mainSlots.has(slotId))
        .map((slotId) => client.getContainerSlot('inventory', slotId))
        .find((slot) => !!slot && slot.objectType > 0
          && matchesMulingRules(this.gameData, slot.objectType, sourceRules)
          && matchesMulingRules(this.gameData, slot.objectType, muleRules));
      if (!source || !destination) return;

      const itemType = source.objectType;
      const sourceSlotId = source.slotId;
      const destinationSlotId = destination.slotId;
      let transferConfirmed = false;
      try {
        transferConfirmed = await client.transferBetweenContainers(source, destination, 8_000);
      } catch (error) {
        if (this.cancellationRequested) throw error;
        this.log(`backpack staging for item ${itemType} was interrupted: ${errorMessage(error)}`);
      }
      this.throwIfCancelled();
      await delay(INVENTORY_TRANSFER_SETTLE_MS, () => this.cancellationRequested);

      let recoveredFromReconnect = false;
      if (!client.isInNexus() || !client.isInWorld() || !this.isClientInventoryReady(client)) {
        await waitUntil(
          () => client.isInNexus() && client.isInWorld() && this.isClientInventoryReady(client),
          this.readyTimeoutMs,
          'Timed out recovering the source after staging a backpack item.',
          () => this.cancellationRequested,
        );
        await delay(RECONNECT_INVENTORY_SETTLE_MS, () => this.cancellationRequested);
        recoveredFromReconnect = true;
      }

      const currentSource = client.getContainerSlot('inventory', sourceSlotId);
      const currentDestination = client.getContainerSlot('inventory', destinationSlotId);
      const madeProgress = currentDestination?.objectType === itemType
        || currentSource?.objectType !== itemType
        || (transferConfirmed && recoveredFromReconnect);
      if (madeProgress) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        this.log(`could not stage backpack item ${itemType} for muling`);
      }
    }
  }

  private sourceHasItemsForMule(client: Client, sourceRules: MulingRules, muleRules: MulingRules): boolean {
    return client.getCarriedInventorySlotIds().some((slotId) => {
      const itemType = client.getContainerSlot('inventory', slotId)?.objectType ?? -1;
      return itemType > 0
        && matchesMulingRules(this.gameData, itemType, sourceRules)
        && matchesMulingRules(this.gameData, itemType, muleRules);
    });
  }

  private countMatchingCarriedItemsForMule(
    client: Client,
    sourceRules: MulingRules,
    muleRules: MulingRules,
  ): number {
    return client.getCarriedInventorySlotIds().filter((slotId) => {
      const itemType = client.getContainerSlot('inventory', slotId)?.objectType ?? -1;
      return itemType > 0
        && matchesMulingRules(this.gameData, itemType, sourceRules)
        && matchesMulingRules(this.gameData, itemType, muleRules);
    }).length;
  }

  private countMatchingCarriedItems(client: Client, rules: MulingRules): number {
    return client.getCarriedInventorySlotIds().filter((slotId) => {
      const itemType = client.getContainerSlot('inventory', slotId)?.objectType ?? -1;
      return itemType > 0 && matchesMulingRules(this.gameData, itemType, rules);
    }).length;
  }

  private countMatchingStoredItems(client: Client, rules: MulingRules): number {
    return [...client.getPotionVaultSlots(), ...client.getVaultSlots()].filter((slot) => {
      return slot.objectType > 0 && matchesMulingRules(this.gameData, slot.objectType, rules);
    }).length;
  }

  private countMatchingStoredItemsForMule(
    client: Client,
    sourceRules: MulingRules,
    muleRules: MulingRules,
  ): number {
    return [...client.getPotionVaultSlots(), ...client.getVaultSlots()].filter((slot) => {
      return slot.objectType > 0
        && matchesMulingRules(this.gameData, slot.objectType, sourceRules)
        && matchesMulingRules(this.gameData, slot.objectType, muleRules);
    }).length;
  }

  private emptyMainInventoryCount(client: Client): number {
    return MAIN_INVENTORY_SLOTS
      .filter((slotId) => client.getContainerSlot('inventory', slotId)?.objectType === -1).length;
  }

  private async waitForReady(client: Client): Promise<void> {
    await waitUntil(() => client.isInWorld() && this.isClientInventoryReady(client), this.readyTimeoutMs,
      'Timed out waiting for the account and inventory to enter the game.', () => this.cancellationRequested);
  }

  private async waitForPlayerName(client: Client): Promise<string> {
    await waitUntil(() => !!client.getPlayer()?.name, 10_000,
      'Player name was not available for trading.', () => this.cancellationRequested);
    return client.getPlayer()!.name;
  }

  private async requireNexus(client: Client, account: MulingCandidate): Promise<void> {
    await waitUntil(
      () => client.isInWorld() && this.isClientInventoryReady(client),
      this.readyTimeoutMs,
      'Account did not finish connecting and loading its inventory.',
      () => this.cancellationRequested,
    );
    if (!client.isInNexus()) {
      throw new Error(`${account.label || account.email} loaded into ${client.getMapName() || 'an unknown map'} instead of Nexus.`);
    }
  }

  private throwIfCancelled(): void {
    if (this.cancellationRequested) throw new MulingCancelledError();
  }

  private updateEntry(
    report: MulingReport,
    entry: MulingAccountReport,
    status: MulingAccountReport['status'],
    message: string,
  ): void {
    entry.status = status;
    entry.message = message;
    entry.updatedAt = this.now().toISOString();
    this.persistReport(report);
    this.log(`${entry.label}: ${message}`);
  }

  private readReport(): MulingReport | null {
    try {
      if (!existsSync(this.options.stateFile)) return null;
      const parsed = JSON.parse(readFileSync(this.options.stateFile, 'utf8')) as MulingReport;
      return parsed && typeof parsed === 'object' && parsed.accounts ? parsed : null;
    } catch {
      return null;
    }
  }

  private persistReport(report: MulingReport): void {
    report.updatedAt = this.now().toISOString();
    mkdirSync(dirname(this.options.stateFile), { recursive: true });
    const temporaryFile = `${this.options.stateFile}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    renameSync(temporaryFile, this.options.stateFile);
  }
}

export function emptyMulingRules(): MulingRules {
  return { potions: [], weaponTiers: [], abilityTiers: [], armorTiers: [], ringTiers: [], itemTypes: [] };
}

export function normalizeMulingRules(raw: unknown): MulingRules {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const tiers = (key: string): number[] => uniqueNumbers(value[key], 0, 20);
  return {
    potions: Array.isArray(value.potions)
      ? [...new Set(value.potions.map((item) => String(item).toLowerCase())
          .filter((item): item is MulingPotionKind => POTION_KINDS.includes(item as MulingPotionKind)))]
      : [],
    weaponTiers: tiers('weaponTiers'),
    abilityTiers: tiers('abilityTiers'),
    armorTiers: tiers('armorTiers'),
    ringTiers: tiers('ringTiers'),
    itemTypes: uniqueNumbers(value.itemTypes, 1, 0xffff),
  };
}

export function matchesMulingRules(gameData: GameDataLoader, itemType: number, rules: MulingRules): boolean {
  const item = gameData.buildSdkItem(itemType);
  if (item?.tradeable === false) return false;
  if (rules.itemTypes.includes(itemType)) return true;
  const potion = classifyStatPotion(gameData, itemType);
  if (potion && rules.potions.includes(potion)) return true;
  if (!item) return false;
  const tier = Number(item.tier);
  if (!Number.isInteger(tier)) return false;
  if (item.slotType === 'weapon') return rules.weaponTiers.includes(tier);
  if (item.slotType === 'ability') return rules.abilityTiers.includes(tier);
  if (item.slotType === 'armor') return rules.armorTiers.includes(tier);
  if (item.slotType === 'ring') return rules.ringTiers.includes(tier);
  return false;
}

export function classifyStatPotion(gameData: GameDataLoader, itemType: number): MulingPotionKind | null {
  const item = gameData.buildSdkItem(itemType);
  const name = String(item?.name || '').toLowerCase();
  if (!name.includes('potion')) return null;
  for (const kind of POTION_KINDS) {
    const aliases = kind === 'life' ? ['life', 'max life'] : kind === 'mana' ? ['mana', 'max mana'] : [kind];
    if (aliases.some((alias) => new RegExp(`(?:potion of|potion).*${alias}|${alias}.*potion`).test(name))) return kind;
  }
  return null;
}

function uniqueNumbers(value: unknown, minimum: number, maximum: number): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number)
    .filter((item) => Number.isInteger(item) && item >= minimum && item <= maximum))].sort((a, b) => a - b);
}

function chooseServer(serverNames: string[], random: () => number): string {
  const index = Math.min(serverNames.length - 1, Math.max(0, Math.floor(random() * serverNames.length)));
  return serverNames[index];
}

class TradePeer {
  start: TradeStartPacket | null = null;
  requestedBy: string | null = null;
  partnerOffer: boolean[] = [];
  done: TradeDonePacket | null = null;
  acceptedCount = 0;
  private ourOffer: boolean[] = [];
  private readonly onRequested = (packet: TradeRequestedPacket): void => {
    this.requestedBy = packet.name;
  };
  private readonly onStart = (packet: TradeStartPacket): void => {
    this.start = packet;
    this.ourOffer = packet.clientItems.map((item) => !!item.included);
    this.partnerOffer = packet.partnerItems.map((item) => !!item.included);
  };
  private readonly onChanged = (packet: TradeChangedPacket): void => {
    this.partnerOffer = packet.offer.map(Boolean);
  };
  private readonly onDone = (packet: TradeDonePacket): void => {
    this.done = packet;
  };
  private readonly onAccepted = (_packet: TradeAcceptedPacket): void => {
    this.acceptedCount += 1;
  };

  constructor(private readonly client: Client) {
    client.onPacket<TradeRequestedPacket>(PacketType.TRADEREQUESTED, this.onRequested);
    client.onPacket<TradeStartPacket>(PacketType.TRADESTART, this.onStart);
    client.onPacket<TradeChangedPacket>(PacketType.TRADECHANGED, this.onChanged);
    client.onPacket<TradeAcceptedPacket>(PacketType.TRADEACCEPTED, this.onAccepted);
    client.onPacket<TradeDonePacket>(PacketType.TRADEDONE, this.onDone);
  }

  request(playerName: string): void {
    const packet = new RequestTradePacket();
    packet.name = playerName;
    this.client.send(packet);
  }

  async waitForRequest(
    requesterName: string,
    timeoutMs: number,
    isCancelled?: () => boolean,
  ): Promise<void> {
    const normalizedName = requesterName.trim().toLowerCase();
    await waitUntil(
      () => this.requestedBy?.trim().toLowerCase() === normalizedName,
      timeoutMs,
      `Timed out waiting for a trade request from ${requesterName}.`,
      isCancelled,
    );
  }

  async waitForStart(partnerName: string, timeoutMs: number, isCancelled?: () => boolean): Promise<TradeStartPacket> {
    await waitUntil(() => !!this.start, timeoutMs, `Timed out starting a trade with ${partnerName}.`, isCancelled);
    if (this.start!.partnerName.trim().toLowerCase() !== partnerName.trim().toLowerCase()) {
      throw new Error(`Unexpected trade partner ${this.start!.partnerName}.`);
    }
    return this.start!;
  }

  changeOffer(offer: boolean[]): void {
    const packet = new ChangeTradePacket();
    packet.offer = offer.map(Boolean);
    this.client.send(packet);
    this.ourOffer = packet.offer.slice();
  }

  accept(): void {
    const packet = new AcceptTradePacket();
    packet.clientOffer = this.ourOffer.slice();
    packet.partnerOffer = this.partnerOffer.slice();
    this.client.send(packet);
  }

  cancel(): void {
    this.client.send(new CancelTradePacket());
  }

  async waitForDone(timeoutMs: number, isCancelled?: () => boolean): Promise<TradeDonePacket> {
    await waitUntil(() => !!this.done, timeoutMs, 'Timed out waiting for the game to complete the trade.', isCancelled);
    return this.done!;
  }

  dispose(): void {
    this.client.offPacket<TradeRequestedPacket>(PacketType.TRADEREQUESTED, this.onRequested);
    this.client.offPacket<TradeStartPacket>(PacketType.TRADESTART, this.onStart);
    this.client.offPacket<TradeChangedPacket>(PacketType.TRADECHANGED, this.onChanged);
    this.client.offPacket<TradeAcceptedPacket>(PacketType.TRADEACCEPTED, this.onAccepted);
    this.client.offPacket<TradeDonePacket>(PacketType.TRADEDONE, this.onDone);
  }
}

function offersEqual(left: boolean[], right: boolean[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function numberArraysEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

class MulingCancelledError extends Error {
  constructor() {
    super('Muling stopped by user.');
    this.name = 'MulingCancelledError';
  }
}

function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
  isCancelled?: () => boolean,
): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (isCancelled?.()) {
        reject(new MulingCancelledError());
        return;
      }
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(message));
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}

function delay(ms: number, isCancelled?: () => boolean): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (isCancelled?.()) {
        reject(new MulingCancelledError());
        return;
      }
      const remaining = ms - (Date.now() - startedAt);
      if (remaining <= 0) {
        resolve();
        return;
      }
      setTimeout(check, Math.min(50, remaining));
    };
    check();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
