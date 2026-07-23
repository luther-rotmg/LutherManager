import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PacketType,
  type Client,
  type ProxyConfig,
  type TradeItem,
} from 'headless-client';
import type { FleetAccount } from '../src/headless/HeadlessFleet.js';
import type { GameDataLoader } from '../src/game-data/GameDataLoader.js';
import {
  MulingService,
  classifyStatPotion,
  matchesMulingRules,
  normalizeMulingRules,
  type MulingFleet,
} from '../src/headless/MulingService.js';

const gameData = {
  buildSdkItem: (objectType: number) => {
    if (objectType === 100) return { id: 100, name: 'Potion of Attack', tier: '', slotType: 'consumable' };
    if (objectType === 101) return { id: 101, name: 'Greater Potion of Life', tier: '', slotType: 'consumable' };
    if (objectType === 200) return { id: 200, name: 'T12 Sword', tier: '12', slotType: 'weapon' };
    if (objectType === 201) return { id: 201, name: 'T13 Sword', tier: '13', slotType: 'weapon' };
    if (objectType === 300) return { id: 300, name: 'Soulbound T12 Sword', tier: '12', slotType: 'weapon', tradeable: false };
    return { id: objectType, name: `Item ${objectType}`, tier: '', slotType: 'consumable' };
  },
} as unknown as GameDataLoader;

test('muling rules match potion families, equipment tiers, and exact item ids', () => {
  const rules = normalizeMulingRules({
    potions: ['attack', 'life', 'invalid'],
    weaponTiers: [12, '12', 99],
    itemTypes: [300, 999, '999', -1],
  });

  assert.deepEqual(rules.potions, ['attack', 'life']);
  assert.deepEqual(rules.weaponTiers, [12]);
  assert.deepEqual(rules.itemTypes, [300, 999]);
  assert.equal(classifyStatPotion(gameData, 100), 'attack');
  assert.equal(classifyStatPotion(gameData, 101), 'life');
  assert.equal(matchesMulingRules(gameData, 100, rules), true);
  assert.equal(matchesMulingRules(gameData, 200, rules), true);
  assert.equal(matchesMulingRules(gameData, 201, rules), false);
  assert.equal(matchesMulingRules(gameData, 999, rules), true);
  assert.equal(matchesMulingRules(gameData, 300, rules), false);
});

test('an already-running source is skipped without connecting or disconnecting it', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  let connectCalls = 0;
  let disconnectCalls = 0;
  const fleet: MulingFleet = {
    isBusy: () => true,
    connect: async () => {
      connectCalls += 1;
      return {} as Client;
    },
    disconnect: () => {
      disconnectCalls += 1;
      return true;
    },
  };

  try {
    const service = new MulingService(fleet, gameData, {
      stateFile: join(stateDir, 'report.json'),
      now: () => new Date('2026-07-22T12:00:00.000Z'),
    });
    const emptyRules = normalizeMulingRules({});
    const report = await service.runDue([
      { id: 'source', email: 'source@example.com', password: 'a', role: 'source', rules: emptyRules },
      { id: 'mule', email: 'mule@example.com', password: 'b', role: 'mule', rules: emptyRules },
    ], ['USWest'], true);

    assert.equal(report!.running, false);
    assert.equal(report!.accounts.source.status, 'skipped');
    assert.equal(report!.accounts.mule.status, 'skipped');
    assert.equal(connectCalls, 0);
    assert.equal(disconnectCalls, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a source connection keeps its proxy and uses the cycle randomized server', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const connected: FleetAccount[] = [];
  const disconnected: string[] = [];
  const emptyClient = {
    isInWorld: () => true,
    getInventory: () => new Array(28).fill(-1),
    isInNexus: () => true,
    getMapName: () => 'Nexus',
    getCarriedInventorySlotIds: () => [4, 5, 6, 7, 8, 9, 10, 11],
    getContainerSlot: () => ({ objectType: -1 }),
  } as unknown as Client;
  const fleet: MulingFleet = {
    isBusy: () => false,
    connect: async (account) => {
      connected.push(account);
      return emptyClient;
    },
    disconnect: (accountId) => {
      disconnected.push(accountId);
      return true;
    },
  };
  const proxy = { protocol: 'socks5', host: '127.0.0.1', port: 1080 } as ProxyConfig;

  try {
    const service = new MulingService(fleet, gameData, {
      stateFile: join(stateDir, 'report.json'),
      random: () => 0.99,
    });
    const t12Rules = normalizeMulingRules({ weaponTiers: [12] });
    await service.runDue([
      { id: 'source', email: 'source@example.com', password: 'a', role: 'source', rules: t12Rules, proxy },
      {
        id: 'mule', email: 'mule@example.com', password: 'b', role: 'mule', rules: t12Rules,
        configurationError: 'Mule intentionally disabled for this source-only test.',
      },
    ], ['USEast', 'USWest'], true);

    assert.equal(connected.length, 1);
    assert.equal(connected[0].serverName, 'USWest');
    assert.strictEqual(connected[0].proxy, proxy);
    assert.deepEqual(disconnected, ['source']);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an active muling cycle can be stopped and disconnects only its cycle account', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const disconnected: string[] = [];
  const waitingClient = {
    isInWorld: () => false,
  } as unknown as Client;
  const fleet: MulingFleet = {
    isBusy: () => false,
    connect: async () => waitingClient,
    disconnect: (accountId) => {
      disconnected.push(accountId);
      return true;
    },
  };

  try {
    const service = new MulingService(fleet, gameData, {
      stateFile: join(stateDir, 'report.json'),
      readyTimeoutMs: 5_000,
    });
    const rules = normalizeMulingRules({ weaponTiers: [12] });
    const running = service.runDue([
      { id: 'source', email: 'source@example.com', password: 'a', role: 'source', rules },
      { id: 'mule', email: 'mule@example.com', password: 'b', role: 'mule', rules },
    ], ['USWest'], true);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const stoppingReport = service.stop();
    assert.equal(stoppingReport!.stopping, true);
    const finalReport = await running;

    assert.equal(finalReport!.running, false);
    assert.equal(finalReport!.stopping, false);
    assert.ok(finalReport!.cancelledAt);
    assert.equal(finalReport!.accounts.source.status, 'cancelled');
    assert.equal(finalReport!.accounts.mule.status, 'cancelled');
    assert.ok(disconnected.includes('source'));
    assert.ok(!disconnected.includes('mule'));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('automated trade offers only matching source items and completes a one-way exchange', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const sourceItems = tradeItems({ 4: 200, 5: 201 });
  const muleItems = tradeItems({});
  const pair = createTradePair(sourceItems, muleItems);
  const fleet: MulingFleet = {
    isBusy: () => false,
    connect: async () => pair.source as unknown as Client,
    disconnect: () => true,
  };

  try {
    const service = new MulingService(fleet, gameData, {
      stateFile: join(stateDir, 'report.json'),
      tradeSettleMs: 0,
    });
    const tradeBatch = (service as unknown as {
      tradeBatch(source: Client, mule: Client, sourceRules: ReturnType<typeof normalizeMulingRules>,
        muleRules: ReturnType<typeof normalizeMulingRules>, receivingSlots: number): Promise<number>;
    }).tradeBatch.bind(service);
    const t12Rules = normalizeMulingRules({ weaponTiers: [12] });
    const moved = await tradeBatch(
      pair.source as unknown as Client,
      pair.mule as unknown as Client,
      t12Rules,
      t12Rules,
      8,
    );

    assert.equal(moved, 1);
    assert.deepEqual(pair.sourceOffer, sourceItems.map((_, index) => index === 4));
    assert.deepEqual(pair.muleOffer, muleItems.map(() => false));
    assert.equal(pair.sourceAccepted, true);
    assert.equal(pair.muleAccepted, true);
    assert.deepEqual(pair.tradeRequestTrace.slice(0, 3), [
      'send:SourcePlayer->MulePlayer',
      'receive:MulePlayer<-SourcePlayer',
      'send:MulePlayer->SourcePlayer',
    ]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('mule organization sends stat potions to potion storage and other items to the vault', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { objectType: number }>();
  for (let slot = 4; slot <= 11; slot++) inventory.set(slot, { objectType: -1 });
  inventory.get(4)!.objectType = 100;
  inventory.get(5)!.objectType = 200;
  const potionSlots = [{ objectType: -1 }];
  const vaultSlots = [{ objectType: -1 }];
  let inVault = false;
  let inNexus = true;
  let inventoryReady = true;
  let vaultRevision = 0;
  const client = {
    getVaultContent: () => vaultRevision ? { revision: vaultRevision, lastVaultPacket: true } : undefined,
    enterVault: () => { inVault = true; inNexus = false; vaultRevision += 1; },
    isInVault: () => inVault,
    isInNexus: () => inNexus,
    isInWorld: () => true,
    getInventory: () => inventoryReady
      ? Array.from({ length: 28 }, (_, slotId) => inventory.get(slotId)?.objectType ?? -1)
      : undefined,
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    getPotionVaultSlots: () => potionSlots,
    getVaultSlots: () => vaultSlots,
    transferBetweenContainers: async (from: { objectType: number }, to: { objectType: number }) => {
      to.objectType = from.objectType;
      from.objectType = -1;
      return true;
    },
    escape: () => {
      inVault = false;
      inNexus = true;
      inventoryReady = false;
      setTimeout(() => { inventoryReady = true; }, 75);
    },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, { stateFile: join(stateDir, 'report.json') });
    const organize = (service as unknown as { organizeMule(client: Client): Promise<{
      inventoryFree: number; vaultFree: number; potionFree: number; full: boolean;
    }> }).organizeMule.bind(service);
    const capacity = await organize(client);

    assert.equal(potionSlots[0].objectType, 100);
    assert.equal(vaultSlots[0].objectType, 200);
    assert.equal(capacity.inventoryFree, 8);
    assert.equal(capacity.vaultFree, 0);
    assert.equal(capacity.potionFree, 0);
    assert.equal(capacity.full, false);
    assert.equal(inventoryReady, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('mule organization reloads Vault state and continues after a storage-transfer reconnect', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { objectType: number }>();
  for (let slot = 4; slot <= 11; slot++) inventory.set(slot, { objectType: -1 });
  inventory.get(4)!.objectType = 100;
  inventory.get(5)!.objectType = 100;
  const potionSlots = [{ objectType: -1 }, { objectType: -1 }];
  const vaultSlots = [{ objectType: -1 }];
  let inVault = false;
  let inNexus = true;
  let inWorld = true;
  let inventoryReady = true;
  let vaultRevision = 0;
  let vaultVisits = 0;
  let transferCount = 0;
  const client = {
    getVaultContent: () => vaultRevision
      ? { revision: vaultRevision, lastVaultPacket: true, active: inVault }
      : undefined,
    enterVault: () => {
      vaultVisits += 1;
      inVault = true;
      inNexus = false;
      inWorld = true;
      inventoryReady = true;
      vaultRevision += 1;
    },
    isInVault: () => inVault,
    isInNexus: () => inNexus,
    isInWorld: () => inWorld,
    getInventory: () => inventoryReady
      ? Array.from({ length: 28 }, (_, slotId) => inventory.get(slotId)?.objectType ?? -1)
      : undefined,
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    getPotionVaultSlots: () => potionSlots,
    getVaultSlots: () => vaultSlots,
    transferBetweenContainers: async (from: { objectType: number }, to: { objectType: number }) => {
      transferCount += 1;
      to.objectType = from.objectType;
      from.objectType = -1;
      if (transferCount === 1) {
        inVault = false;
        inNexus = false;
        inWorld = false;
        inventoryReady = false;
        vaultRevision += 1;
        setTimeout(() => {
          inNexus = true;
          inWorld = true;
          inventoryReady = true;
        }, 25);
      }
      return true;
    },
    escape: () => {
      inVault = false;
      inNexus = true;
      inWorld = true;
      inventoryReady = true;
      vaultRevision += 1;
    },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, {
      stateFile: join(stateDir, 'report.json'),
      readyTimeoutMs: 2_000,
      vaultTimeoutMs: 2_000,
    });
    const organize = (service as unknown as { organizeMule(client: Client): Promise<{
      inventoryFree: number; vaultFree: number; potionFree: number; full: boolean;
    }> }).organizeMule.bind(service);
    const capacity = await organize(client);

    assert.equal(transferCount, 2);
    assert.equal(vaultVisits, 2);
    assert.deepEqual(potionSlots.map((slot) => slot.objectType), [100, 100]);
    assert.deepEqual([4, 5].map((slotId) => inventory.get(slotId)!.objectType), [-1, -1]);
    assert.equal(capacity.inventoryFree, 8);
    assert.equal(capacity.potionFree, 0);
    assert.equal(capacity.vaultFree, 1);
    assert.equal(inNexus, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('mule organization uses backpack space after account storage is full', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { objectType: number }>();
  for (let slot = 4; slot <= 13; slot++) inventory.set(slot, { objectType: -1 });
  inventory.get(4)!.objectType = 100;
  inventory.get(5)!.objectType = 100;
  const potionSlots = [{ objectType: 100 }];
  const vaultSlots = [{ objectType: 200 }];
  let inVault = false;
  let inNexus = true;
  let vaultRevision = 0;
  let transferCount = 0;
  const client = {
    getVaultContent: () => vaultRevision
      ? { revision: vaultRevision, lastVaultPacket: true, active: inVault }
      : undefined,
    enterVault: () => { inVault = true; inNexus = false; vaultRevision += 1; },
    isInVault: () => inVault,
    isInNexus: () => inNexus,
    isInWorld: () => true,
    getInventory: () => Array.from({ length: 28 }, (_, slotId) => inventory.get(slotId)?.objectType ?? -1),
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    getPotionVaultSlots: () => potionSlots,
    getVaultSlots: () => vaultSlots,
    transferBetweenContainers: async (from: { objectType: number }, to: { objectType: number }) => {
      transferCount += 1;
      const displaced = to.objectType;
      to.objectType = from.objectType;
      from.objectType = displaced;
      return true;
    },
    escape: () => { inVault = false; inNexus = true; vaultRevision += 1; },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, { stateFile: join(stateDir, 'report.json') });
    const organize = (service as unknown as { organizeMule(client: Client): Promise<{
      inventoryFree: number; vaultFree: number; potionFree: number; full: boolean;
    }> }).organizeMule.bind(service);
    const capacity = await organize(client);

    assert.equal(transferCount, 2);
    assert.deepEqual([4, 5].map((slotId) => inventory.get(slotId)!.objectType), [-1, -1]);
    assert.deepEqual([12, 13].map((slotId) => inventory.get(slotId)!.objectType), [100, 100]);
    assert.equal(capacity.inventoryFree, 8);
    assert.equal(capacity.vaultFree, 0);
    assert.equal(capacity.potionFree, 0);
    assert.equal(capacity.full, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('source staging withdraws matching items from potion storage and the vault', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { objectType: number }>();
  for (let slot = 4; slot <= 11; slot++) inventory.set(slot, { objectType: -1 });
  const potionSlots = [{ objectType: 100 }];
  const vaultSlots = [{ objectType: 200 }, { objectType: 201 }];
  let inVault = false;
  let inNexus = true;
  let vaultRevision = 0;
  const client = {
    getVaultContent: () => vaultRevision ? { revision: vaultRevision, lastVaultPacket: true } : undefined,
    enterVault: () => { inVault = true; inNexus = false; vaultRevision += 1; },
    isInVault: () => inVault,
    isInNexus: () => inNexus,
    isInWorld: () => true,
    getInventory: () => Array.from({ length: 28 }, (_, slotId) => inventory.get(slotId)?.objectType ?? -1),
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    getPotionVaultSlots: () => potionSlots,
    getVaultSlots: () => vaultSlots,
    transferBetweenContainers: async (from: { objectType: number }, to: { objectType: number }) => {
      to.objectType = from.objectType;
      from.objectType = -1;
      return true;
    },
    escape: () => { inVault = false; inNexus = true; },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, { stateFile: join(stateDir, 'report.json') });
    const stage = (service as unknown as {
      stageMatchingStoredItems(
        client: Client,
        sourceRules: ReturnType<typeof normalizeMulingRules>,
        muleRules: ReturnType<typeof normalizeMulingRules>,
      ): Promise<number>;
    }).stageMatchingStoredItems.bind(service);
    const rules = normalizeMulingRules({ potions: ['attack'], weaponTiers: [12] });
    const staged = await stage(client, rules, rules);

    assert.equal(staged, 2);
    assert.deepEqual([...inventory.values()].map((slot) => slot.objectType).filter((item) => item > 0).sort(), [100, 200]);
    assert.equal(potionSlots[0].objectType, -1);
    assert.deepEqual(vaultSlots.map((slot) => slot.objectType), [-1, 201]);
    assert.equal(inNexus, true);
    assert.equal(inVault, false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('source staging refreshes Vault slots and continues after a withdrawal reconnect', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { objectType: number }>();
  for (let slot = 4; slot <= 11; slot++) inventory.set(slot, { objectType: -1 });
  const potionSlots = [{ objectType: 100 }, { objectType: 100 }];
  const vaultSlots = [{ objectType: 200 }];
  let inVault = false;
  let inNexus = true;
  let inWorld = true;
  let vaultRevision = 0;
  let transferCount = 0;
  let vaultVisits = 0;
  const client = {
    getVaultContent: () => vaultRevision ? { revision: vaultRevision, lastVaultPacket: true } : undefined,
    enterVault: () => {
      vaultVisits += 1;
      inVault = true;
      inNexus = false;
      inWorld = true;
      vaultRevision += 1;
    },
    isInVault: () => inVault,
    isInNexus: () => inNexus,
    isInWorld: () => inWorld,
    getInventory: () => inWorld
      ? Array.from({ length: 28 }, (_, slotId) => inventory.get(slotId)?.objectType ?? -1)
      : undefined,
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    getPotionVaultSlots: () => potionSlots,
    getVaultSlots: () => vaultSlots,
    transferBetweenContainers: async (from: { objectType: number }, to: { objectType: number }) => {
      transferCount += 1;
      to.objectType = from.objectType;
      from.objectType = -1;
      if (transferCount === 1) {
        inVault = false;
        inNexus = false;
        inWorld = false;
        setTimeout(() => { inNexus = true; inWorld = true; }, 25);
        return false;
      }
      return true;
    },
    escape: () => { inVault = false; inNexus = true; inWorld = true; },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, { stateFile: join(stateDir, 'report.json') });
    const stage = (service as unknown as {
      stageMatchingStoredItems(
        client: Client,
        sourceRules: ReturnType<typeof normalizeMulingRules>,
        muleRules: ReturnType<typeof normalizeMulingRules>,
      ): Promise<number>;
    }).stageMatchingStoredItems.bind(service);
    const rules = normalizeMulingRules({ potions: ['attack'], weaponTiers: [12] });
    const staged = await stage(client, rules, rules);

    assert.equal(staged, 3);
    assert.equal(transferCount, 3);
    assert.equal(vaultVisits, 2);
    assert.deepEqual([...inventory.values()].map((slot) => slot.objectType).filter((item) => item > 0).sort(), [100, 100, 200]);
    assert.equal(inNexus, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('backpack staging resumes after a transient reconnect instead of reporting the source empty', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { slotId: number; objectType: number }>();
  for (let slotId = 4; slotId <= 13; slotId++) {
    inventory.set(slotId, { slotId, objectType: slotId >= 12 ? 100 : -1 });
  }
  let inWorld = true;
  let transferCount = 0;
  const client = {
    isInWorld: () => inWorld,
    isInNexus: () => inWorld,
    getInventory: () => inWorld
      ? Array.from({ length: 28 }, (_, slotId) => inventory.get(slotId)?.objectType ?? -1)
      : undefined,
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    transferBetweenContainers: async (
      from: { objectType: number },
      to: { objectType: number },
    ) => {
      transferCount += 1;
      to.objectType = from.objectType;
      from.objectType = -1;
      if (transferCount === 1) {
        inWorld = false;
        setTimeout(() => { inWorld = true; }, 25);
      }
      return true;
    },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, { stateFile: join(stateDir, 'report.json') });
    const stage = (service as unknown as {
      stageMatchingBackpackItems(
        client: Client,
        sourceRules: ReturnType<typeof normalizeMulingRules>,
        muleRules: ReturnType<typeof normalizeMulingRules>,
      ): Promise<void>;
    }).stageMatchingBackpackItems.bind(service);
    const rules = normalizeMulingRules({ potions: ['attack'] });
    await stage(client, rules, rules);

    assert.equal(transferCount, 2);
    assert.deepEqual(
      [4, 5].map((slotId) => inventory.get(slotId)!.objectType),
      [100, 100],
    );
    assert.deepEqual(
      [12, 13].map((slotId) => inventory.get(slotId)!.objectType),
      [-1, -1],
    );
    assert.equal(inWorld, true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('backpack staging swaps past unrelated main-inventory blockers without losing them', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const inventory = new Map<number, { slotId: number; objectType: number }>();
  for (let slotId = 4; slotId <= 13; slotId++) {
    inventory.set(slotId, {
      slotId,
      objectType: slotId >= 12 ? 100 : 200,
    });
  }
  let transferCount = 0;
  const client = {
    isInWorld: () => true,
    isInNexus: () => true,
    getInventory: () => Array.from(
      { length: 28 },
      (_, slotId) => inventory.get(slotId)?.objectType ?? -1,
    ),
    getCarriedInventorySlotIds: () => [...inventory.keys()],
    getContainerSlot: (_container: string, slotId: number) => inventory.get(slotId) ?? null,
    transferBetweenContainers: async (
      from: { objectType: number },
      to: { objectType: number },
    ) => {
      transferCount += 1;
      const displaced = to.objectType;
      to.objectType = from.objectType;
      from.objectType = displaced;
      return true;
    },
  } as unknown as Client;
  const fleet: MulingFleet = { isBusy: () => false, connect: async () => client, disconnect: () => true };

  try {
    const service = new MulingService(fleet, gameData, { stateFile: join(stateDir, 'report.json') });
    const stage = (service as unknown as {
      stageMatchingBackpackItems(
        client: Client,
        sourceRules: ReturnType<typeof normalizeMulingRules>,
        muleRules: ReturnType<typeof normalizeMulingRules>,
      ): Promise<void>;
    }).stageMatchingBackpackItems.bind(service);
    const rules = normalizeMulingRules({ potions: ['attack'] });
    await stage(client, rules, rules);

    assert.equal(transferCount, 2);
    assert.deepEqual([4, 5].map((slotId) => inventory.get(slotId)!.objectType), [100, 100]);
    assert.deepEqual([12, 13].map((slotId) => inventory.get(slotId)!.objectType), [200, 200]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('two sources route across three mules, reusing partial capacity and skipping full mules', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'hive-muling-'));
  const simulation = createFleetSimulation([
    { id: 'source-1', name: 'SourceOne', storedPotions: 7 },
    { id: 'source-2', name: 'SourceTwo', storedPotions: 6 },
    { id: 'mule-1', name: 'MuleOne', blockers: 6, potionCapacity: 2 },
    { id: 'mule-2', name: 'MuleTwo', blockers: 6, potionCapacity: 2 },
    { id: 'mule-3', name: 'MuleThree', blockers: 0, potionCapacity: 5 },
  ]);
  const rules = normalizeMulingRules({ potions: ['attack'] });
  const accounts = [
    simulatedCandidate('source-1', 'Source One', 'source', rules),
    simulatedCandidate('source-2', 'Source Two', 'source', rules),
    simulatedCandidate('mule-1', 'Mule One', 'mule', rules),
    simulatedCandidate('mule-2', 'Mule Two', 'mule', rules),
    simulatedCandidate('mule-3', 'Mule Three', 'mule', rules),
  ];

  try {
    const service = new MulingService(simulation.fleet, gameData, {
      stateFile: join(stateDir, 'report.json'),
      readyTimeoutMs: 2_000,
      tradeTimeoutMs: 2_000,
      tradeSettleMs: 0,
      vaultTimeoutMs: 2_000,
      random: () => 0,
    });
    const report = await service.runDue(accounts, ['USWest'], true);

    assert.equal(report!.accounts['source-1'].movedItems, 7);
    assert.equal(report!.accounts['source-2'].movedItems, 6);
    assert.equal(report!.accounts['mule-1'].movedItems, 4);
    assert.equal(report!.accounts['mule-2'].movedItems, 4);
    assert.equal(report!.accounts['mule-3'].movedItems, 5);
    assert.equal(report!.accounts['mule-1'].status, 'full');
    assert.equal(report!.accounts['mule-2'].status, 'full');
    assert.equal(report!.accounts['mule-3'].status, 'completed');
    assert.equal(simulation.clients.get('source-1')!.countItem(100), 0);
    assert.equal(simulation.clients.get('source-2')!.countItem(100), 0);
    assert.deepEqual(simulation.completedTrades, [
      'SourceOne->MuleOne:2',
      'SourceOne->MuleOne:2',
      'SourceOne->MuleTwo:2',
      'SourceOne->MuleTwo:1',
      'SourceTwo->MuleTwo:1',
      'SourceTwo->MuleThree:5',
    ]);
    assert.equal(simulation.activeAccountIds.size, 0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function simulatedCandidate(
  id: string,
  label: string,
  role: 'source' | 'mule',
  rules: ReturnType<typeof normalizeMulingRules>,
) {
  return { id, label, email: `${id}@example.com`, password: 'test', role, rules };
}

function createFleetSimulation(configs: Array<{
  id: string;
  name: string;
  storedPotions?: number;
  blockers?: number;
  potionCapacity?: number;
}>) {
  type Handler = (packet: any, context: any) => void;
  type Slot = { objectType: number; slotId: number };

  class SimulatedClient {
    readonly handlers = new Map<number, Set<Handler>>();
    readonly inventory = new Map<number, Slot>();
    readonly vaultSlots: Slot[] = [];
    readonly potionSlots: Slot[];
    inVault = false;
    inWorld = true;
    vaultRevision = 0;
    requestedTarget = '';
    tradePartner: SimulatedClient | null = null;
    tradeOffer: boolean[] = [];
    tradeAccepted = false;

    constructor(readonly id: string, readonly name: string, config: {
      storedPotions?: number; blockers?: number; potionCapacity?: number;
    }) {
      for (let slotId = 4; slotId <= 11; slotId++) {
        const blockerIndex = slotId - 4;
        this.inventory.set(slotId, { slotId, objectType: blockerIndex < (config.blockers ?? 0) ? 900 : -1 });
      }
      const potionSlotCount = Math.max(config.potionCapacity ?? 0, config.storedPotions ?? 0);
      this.potionSlots = Array.from({ length: potionSlotCount }, (_, slotId) => ({
        slotId,
        objectType: slotId < (config.storedPotions ?? 0) ? 100 : -1,
      }));
    }

    connect(): void {
      this.inVault = false;
      this.inWorld = true;
      this.requestedTarget = '';
      this.tradePartner = null;
      this.tradeOffer = [];
      this.tradeAccepted = false;
    }

    isInWorld(): boolean { return this.inWorld; }
    isInNexus(): boolean { return this.inWorld && !this.inVault; }
    isInVault(): boolean { return this.inWorld && this.inVault; }
    getMapName(): string { return this.inVault ? 'Vault' : 'Nexus'; }
    getPlayer() { return { name: this.name }; }
    getInventory(): number[] | undefined {
      if (!this.inWorld) return undefined;
      return Array.from({ length: 28 }, (_, slotId) => this.inventory.get(slotId)?.objectType ?? -1);
    }
    getCarriedInventorySlotIds(): number[] { return [...this.inventory.keys()]; }
    getContainerSlot(_container: string, slotId: number): Slot | null {
      return this.inventory.get(slotId) ?? null;
    }
    getVaultSlots(): Slot[] { return this.vaultSlots; }
    getPotionVaultSlots(): Slot[] { return this.potionSlots; }
    getVaultContent() {
      return this.vaultRevision > 0
        ? { revision: this.vaultRevision, lastVaultPacket: true }
        : undefined;
    }
    enterVault(): void {
      this.inVault = true;
      this.vaultRevision += 1;
    }
    escape(): void { this.inVault = false; }
    async transferBetweenContainers(from: Slot, to: Slot): Promise<boolean> {
      if (from.objectType <= 0 || to.objectType !== -1) return false;
      to.objectType = from.objectType;
      from.objectType = -1;
      return true;
    }
    onPacket(type: number, handler: Handler): this {
      const handlers = this.handlers.get(type) ?? new Set<Handler>();
      handlers.add(handler);
      this.handlers.set(type, handlers);
      return this;
    }
    offPacket(type: number, handler: Handler): this {
      this.handlers.get(type)?.delete(handler);
      return this;
    }
    emitPacket(type: number, packet: any): void {
      for (const handler of this.handlers.get(type) ?? []) handler(packet, { cancelled: false });
    }
    send(packet: any): void { hub.send(this, packet); }
    countItem(itemType: number): number {
      return [...this.inventory.values(), ...this.vaultSlots, ...this.potionSlots]
        .filter((slot) => slot.objectType === itemType).length;
    }
    tradeItems(): TradeItem[] {
      return Array.from({ length: 12 }, (_, index) => {
        const item = this.inventory.get(index)?.objectType ?? -1;
        return {
          item,
          slotType: 0,
          tradeable: item > 0,
          included: false,
          enchantment: '',
        } as TradeItem;
      });
    }
  }

  const clients = new Map<string, SimulatedClient>();
  const clientsByName = new Map<string, SimulatedClient>();
  const completedTrades: string[] = [];
  const activeAccountIds = new Set<string>();

  const hub = {
    send(client: SimulatedClient, packet: any): void {
      if (packet.type === PacketType.REQUESTTRADE) {
        const target = clientsByName.get(packet.name);
        assert.ok(target, `missing simulated trade target ${packet.name}`);
        client.requestedTarget = target.name;
        target.emitPacket(PacketType.TRADEREQUESTED, { name: client.name });
        if (target.requestedTarget === client.name) this.start(client, target);
        return;
      }
      if (packet.type === PacketType.CHANGETRADE) {
        client.tradeOffer = packet.offer.slice();
        client.tradePartner!.emitPacket(PacketType.TRADECHANGED, { offer: packet.offer.slice() });
        return;
      }
      if (packet.type === PacketType.ACCEPTTRADE) {
        client.tradeAccepted = true;
        client.tradePartner!.emitPacket(PacketType.TRADEACCEPTED, {
          clientOffer: client.tradePartner!.tradeOffer.slice(),
          partnerOffer: client.tradeOffer.slice(),
        });
        if (client.tradePartner?.tradeAccepted) this.finish(client, client.tradePartner);
      }
    },
    start(left: SimulatedClient, right: SimulatedClient): void {
      left.tradePartner = right;
      right.tradePartner = left;
      left.tradeAccepted = false;
      right.tradeAccepted = false;
      left.tradeOffer = [];
      right.tradeOffer = [];
      left.emitPacket(PacketType.TRADESTART, {
        clientItems: left.tradeItems(),
        partnerName: right.name,
        partnerItems: right.tradeItems(),
      });
      right.emitPacket(PacketType.TRADESTART, {
        clientItems: right.tradeItems(),
        partnerName: left.name,
        partnerItems: left.tradeItems(),
      });
    },
    finish(left: SimulatedClient, right: SimulatedClient): void {
      const move = (from: SimulatedClient, to: SimulatedClient): number => {
        let moved = 0;
        from.tradeOffer.forEach((included, slotId) => {
          if (!included) return;
          const sourceSlot = from.inventory.get(slotId);
          const destination = [...to.inventory.values()].find((slot) => slot.objectType === -1);
          assert.ok(sourceSlot && sourceSlot.objectType > 0 && destination, 'invalid simulated trade transfer');
          destination.objectType = sourceSlot.objectType;
          sourceSlot.objectType = -1;
          moved += 1;
        });
        return moved;
      };
      const leftToRight = move(left, right);
      const rightToLeft = move(right, left);
      const source = leftToRight > 0 ? left : right;
      const mule = leftToRight > 0 ? right : left;
      const moved = leftToRight + rightToLeft;
      completedTrades.push(`${source.name}->${mule.name}:${moved}`);
      left.emitPacket(PacketType.TRADEDONE, { code: 0, description: '' });
      right.emitPacket(PacketType.TRADEDONE, { code: 0, description: '' });
      left.tradeAccepted = false;
      right.tradeAccepted = false;
    },
  };

  for (const config of configs) {
    const client = new SimulatedClient(config.id, config.name, config);
    clients.set(config.id, client);
    clientsByName.set(config.name, client);
  }

  const fleet: MulingFleet = {
    isBusy: (accountId) => activeAccountIds.has(accountId),
    connect: async (account) => {
      const client = clients.get(account.id);
      assert.ok(client, `missing simulated account ${account.id}`);
      assert.equal(activeAccountIds.has(account.id), false);
      activeAccountIds.add(account.id);
      client.connect();
      return client as unknown as Client;
    },
    disconnect: (accountId) => activeAccountIds.delete(accountId),
  };

  return { fleet, clients, completedTrades, activeAccountIds };
}

function tradeItems(items: Record<number, number>): TradeItem[] {
  return Array.from({ length: 12 }, (_, index) => ({
    item: items[index] ?? -1,
    slotType: 0,
    tradeable: items[index] !== undefined,
    included: false,
  } as TradeItem));
}

function createTradePair(sourceItems: TradeItem[], muleItems: TradeItem[]) {
  type Handler = (packet: any, context: any) => void;
  const tradeRequestTrace: string[] = [];
  class FakeTradeClient {
    handlers = new Map<number, Set<Handler>>();
    requested = false;
    accepted = false;
    offer: boolean[] = [];
    peer!: FakeTradeClient;

    constructor(readonly name: string, readonly items: TradeItem[]) {}

    onPacket(type: number, handler: Handler): this {
      const handlers = this.handlers.get(type) ?? new Set<Handler>();
      handlers.add(handler);
      this.handlers.set(type, handlers);
      return this;
    }

    offPacket(type: number, handler: Handler): this {
      this.handlers.get(type)?.delete(handler);
      return this;
    }

    emitPacket(type: number, packet: any): void {
      if (type === PacketType.TRADEREQUESTED) {
        tradeRequestTrace.push(`receive:${this.name}<-${packet.name}`);
      }
      for (const handler of this.handlers.get(type) ?? []) handler(packet, { cancelled: false });
    }

    send(packet: any): void {
      if (packet.type === PacketType.REQUESTTRADE) {
        tradeRequestTrace.push(`send:${this.name}->${packet.name}`);
        this.requested = true;
        this.peer.emitPacket(PacketType.TRADEREQUESTED, { name: this.name });
        if (this.peer.requested) startTrade();
      } else if (packet.type === PacketType.CHANGETRADE) {
        this.offer = packet.offer.slice();
        this.peer.emitPacket(PacketType.TRADECHANGED, { offer: packet.offer.slice() });
      } else if (packet.type === PacketType.ACCEPTTRADE) {
        this.accepted = true;
        this.peer.emitPacket(PacketType.TRADEACCEPTED, {
          clientOffer: this.peer.offer.slice(),
          partnerOffer: this.offer.slice(),
        });
        if (this.peer.accepted) finishTrade();
      }
    }

    getPlayer() { return { name: this.name }; }
  }

  const source = new FakeTradeClient('SourcePlayer', sourceItems);
  const mule = new FakeTradeClient('MulePlayer', muleItems);
  source.peer = mule;
  mule.peer = source;
  let started = false;
  let finished = false;
  const startTrade = (): void => {
    if (started) return;
    started = true;
    source.emitPacket(PacketType.TRADESTART, {
      clientItems: sourceItems, partnerItems: muleItems, partnerName: mule.name,
    });
    mule.emitPacket(PacketType.TRADESTART, {
      clientItems: muleItems, partnerItems: sourceItems, partnerName: source.name,
    });
  };
  const finishTrade = (): void => {
    if (finished) return;
    finished = true;
    source.emitPacket(PacketType.TRADEDONE, { code: 0, description: '' });
    mule.emitPacket(PacketType.TRADEDONE, { code: 0, description: '' });
  };
  return {
    source,
    mule,
    get sourceOffer() { return source.offer; },
    get muleOffer() { return mule.offer; },
    get sourceAccepted() { return source.accepted; },
    get muleAccepted() { return mule.accepted; },
    tradeRequestTrace,
  };
}
