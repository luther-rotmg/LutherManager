import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Account, AppEngineError, deleteCharacter, getCharAndServers, login, resolveClassType } from '../src/account-service';
import { Client } from '../src/client';
import { ClientEvent } from '../src/events';

const TEST_ALIAS = process.env.CHAR_TEST_ACCOUNT;
const CLEANUP_ID = process.env.CHAR_TEST_CLEANUP_ID ? Number(process.env.CHAR_TEST_CLEANUP_ID) : undefined;
const CLASS_TYPE = resolveClassType(process.env.CHAR_TEST_CLASS ?? 'Wizard');
const SEASONAL = !/^(0|false|no)$/i.test(process.env.CHAR_TEST_SEASONAL ?? 'true');
const TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const accounts = JSON.parse(fs.readFileSync(path.resolve('accounts.json'), 'utf8')) as Account[];
  const eligible = TEST_ALIAS ? accounts.filter((account) => account.alias === TEST_ALIAS) : accounts;
  if (eligible.length === 0) throw new Error(`no configured account matches ${TEST_ALIAS}`);

  for (const account of eligible) {
    const alias = account.alias ?? 'account';
    const credentials = await login(account);
    const before = await retryAccountRequest(() => getCharAndServers(credentials.accessToken));
    if (CLEANUP_ID !== undefined) {
      if (!Number.isInteger(CLEANUP_ID)) throw new Error(`invalid CHAR_TEST_CLEANUP_ID`);
      if (!before.characters.some((character) => character.charId === CLEANUP_ID)) {
        throw new Error(`[${alias}] cleanup char ${CLEANUP_ID} does not exist; refusing deletion`);
      }
      console.log(`[${alias}] cleanup: verified disposable char ${CLEANUP_ID}; deleting exact id`);
      await retryAccountRequest(async () => {
        await deleteCharacter(credentials.accessToken, CLEANUP_ID);
        return undefined;
      });
      const cleaned = await retryAccountRequest(() => getCharAndServers(credentials.accessToken));
      if (cleaned.characters.some((character) => character.charId === CLEANUP_ID)) {
        throw new Error(`[${alias}] cleanup char ${CLEANUP_ID} still exists after deletion`);
      }
      console.log(`[${alias}] PASS cleanup deletion for disposable char ${CLEANUP_ID}`);
      return;
    }
    console.log(
      `[${alias}] lifecycle preflight: ${before.characters.length}/${before.maxNumChars} characters, ` +
        `nextCharId=${before.nextCharId}`,
    );
    if (before.characters.length >= before.maxNumChars) continue;
    const server = before.servers[0];
    if (!server) throw new Error(`[${alias}] no game server available`);
    const createdId = before.nextCharId;
    const client = new Client({
      alias: `${alias}-char-lifecycle`,
      accessToken: credentials.accessToken,
      clientToken: credentials.clientToken,
      charId: createdId,
      needsNewChar: true,
      host: server.address,
      servers: before.servers,
      createClassType: CLASS_TYPE,
      createSeasonal: SEASONAL,
      refreshCredentials: () => login(account),
    });

    console.log(`[${alias}] creating disposable char ${createdId}: classType=${CLASS_TYPE} seasonal=${SEASONAL}`);
    try {
      await connectUntilReady(client);
      await sleep(1500);
    } finally {
      client.stop('disposable character created');
    }

    const createdList = await retryAccountRequest(() => getCharAndServers(credentials.accessToken));
    const created = createdList.characters.find((character) => character.charId === createdId);
    if (!created) throw new Error(`[${alias}] created char ${createdId} not found in /char/list; refusing deletion`);
    if (created.seasonal !== SEASONAL) {
      throw new Error(`[${alias}] char ${createdId} seasonal=${created.seasonal}, expected ${SEASONAL}; refusing deletion`);
    }
    console.log(`[${alias}] verified disposable char ${createdId}; deleting that exact id`);
    await retryAccountRequest(async () => {
      await deleteCharacter(credentials.accessToken, createdId);
      return undefined;
    });
    const after = await retryAccountRequest(() => getCharAndServers(credentials.accessToken));
    if (after.characters.some((character) => character.charId === createdId)) {
      throw new Error(`[${alias}] char ${createdId} still present after /char/delete`);
    }
    console.log(`[${alias}] PASS create/list/delete/list lifecycle for disposable char ${createdId}`);
    return;
  }
  throw new Error('no configured account has an open character slot');
}

function connectUntilReady(client: Client): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for CreateSuccess')), TIMEOUT_MS);
    client.once(ClientEvent.Ready, () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once(ClientEvent.Failure, (packet) => {
      clearTimeout(timeout);
      reject(new Error(`game server rejected CREATE: ${packet.errorDescription}`));
    });
    client.connect();
  });
}

async function retryAccountRequest<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retryable = error instanceof AppEngineError &&
        (error.kind === 'account_in_use' || /wait.*reconnect|try again/i.test(error.detail));
      if (!retryable) throw error;
      console.log(`account still locked after game disconnect; retry ${attempt}/12`);
      await sleep(5000);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  console.error(`live character lifecycle FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
