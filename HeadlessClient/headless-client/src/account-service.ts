import { Classes } from 'realmlib';
import axios from 'axios';
import { createHash } from 'crypto';
import { ENDPOINTS, UNITY_HEADERS } from './constants';
import { getCachedToken, setCachedToken } from './token-cache';

/**
 * Resolves a class name ("Wizard", case-insensitive) or numeric class object
 * type to its numeric object type. Falls back to Wizard for unknown/missing
 * values.
 */
export function resolveClassType(value?: string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const match = Object.entries(Classes).find(
      ([name, id]) => typeof id === 'number' && name.toLowerCase() === value.toLowerCase(),
    );
    if (match) {
      return match[1] as number;
    }
  }
  return Classes.Wizard;
}

export interface Account {
  guid: string;
  password: string;
  alias?: string;
  /** Automatically walk into the vault once in the nexus. Defaults to false. */
  enterVault?: boolean;
  /** Names of plugins to load for this account (from the plugin registry). */
  plugins?: string[];
  /**
   * Character-creation settings, used when the account has no character. The
   * `class` field accepts a class name ("Wizard") or its numeric object type;
   * defaults to Wizard, non-seasonal.
   */
  createChar?: CreateCharOptions;
}

/** Options for creating a new character. */
export interface CreateCharOptions {
  /** Class name (e.g. "Wizard") or numeric class object type. Default Wizard. */
  class?: string | number;
  /** Skin id. Default 0. */
  skin?: number;
  /** Create a seasonal character. Default false. */
  seasonal?: boolean;
  /** Create a challenger character. Default false. */
  challenger?: boolean;
}

export interface Credentials {
  accessToken: string;
  /** md5(guid + password) — sent as Hello.userToken. */
  clientToken: string;
}

export interface CharInfo {
  charId: number;
  needsNewChar: boolean;
  /** Seasonal flag from the character-list XML, when present. */
  seasonal?: boolean;
}

export interface ServerInfo {
  name: string;
  address: string;
}

export type AppEngineErrorKind = 'credentials' | 'account_in_use' | 'token_invalid' | 'unknown';

/**
 * An error returned by the AppEngine HTTP API, classified into a known kind.
 */
export class AppEngineError extends Error {
  constructor(
    message: string,
    readonly kind: AppEngineErrorKind,
    /** The raw `<Error>` text from the server. */
    readonly detail: string,
    /** Seconds until the account-in-use lock clears, if known. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'AppEngineError';
  }
}

function form(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

const UNITY_FIELDS = { game_net: 'Unity', play_platform: 'Unity', game_net_user_id: '' };
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const MAX_HTTP_ATTEMPTS = 4;

/** Per-request options, e.g. an AbortSignal to cancel in-flight auth calls. */
export interface RequestOptions {
  signal?: AbortSignal;
}

function appEngineTimeoutMs(): number {
  const value = Number(process.env.APPENGINE_TIMEOUT_MS ?? DEFAULT_HTTP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_HTTP_TIMEOUT_MS;
}

/** Exponential backoff with jitter for transient HTTP retries. */
function httpBackoffMs(attempt: number): number {
  const base = Math.min(500 * 2 ** (attempt - 1), 8000);
  return base + Math.floor(Math.random() * 250);
}

function isAbort(err: unknown): boolean {
  return axios.isCancel(err) || (err as { code?: string })?.code === 'ERR_CANCELED';
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POSTs a form to the AppEngine and returns the body, without throwing on
 * non-2xx. Transient failures (network errors, timeouts, 5xx) are retried with
 * exponential backoff + jitter; a caller-supplied AbortSignal cancels both the
 * request and the backoff wait. Semantic errors (`<Error>` bodies) are returned
 * as-is for the caller to classify — they are never retried.
 */
async function postForm(
  url: string,
  data: Record<string, string>,
  options: RequestOptions = {},
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_HTTP_ATTEMPTS; attempt++) {
    try {
      const res = await axios.post<string>(url, form(data), {
        headers: UNITY_HEADERS,
        responseType: 'text',
        timeout: appEngineTimeoutMs(),
        validateStatus: () => true,
        signal: options.signal,
      });
      if (res.status >= 500 && attempt < MAX_HTTP_ATTEMPTS) {
        lastError = new Error(`AppEngine returned HTTP ${res.status}`);
        await sleep(httpBackoffMs(attempt), options.signal);
        continue;
      }
      return typeof res.data === 'string' ? res.data : String(res.data);
    } catch (err) {
      if (isAbort(err)) {
        throw err;
      }
      lastError = err;
      if (attempt < MAX_HTTP_ATTEMPTS) {
        await sleep(httpBackoffMs(attempt), options.signal);
        continue;
      }
      throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('AppEngine request failed');
}

/** Classifies an `<Error>...</Error>` response, or returns undefined if there is none. */
export function classifyError(xml: string): AppEngineError | undefined {
  const raw = /<Error[^>]*>([\s\S]*?)<\/Error>/.exec(xml)?.[1]?.trim();
  if (!raw) {
    return undefined;
  }
  const lower = raw.toLowerCase();
  if (lower.includes('account in use')) {
    const secs = /(\d+)/.exec(raw)?.[1];
    return new AppEngineError(
      `account in use${secs ? ` (locked ~${secs}s)` : ''}`,
      'account_in_use',
      raw,
      secs ? Number(secs) : undefined,
    );
  }
  if (
    lower.includes('credentials not valid') ||
    lower.includes('passworderror') ||
    lower.includes('incorrect')
  ) {
    return new AppEngineError('invalid email or password', 'credentials', raw);
  }
  return new AppEngineError(raw, 'unknown', raw);
}

/**
 * Validates an access token against the dedicated verification endpoint.
 * Returns true on "Success", false if the token is not valid. Throws on an
 * account-in-use lock.
 */
async function verifyAccessToken(
  accessToken: string,
  clientToken: string,
  options: RequestOptions = {},
): Promise<boolean> {
  const xml = await postForm(ENDPOINTS.VERIFY_TOKEN, { clientToken, accessToken, ...UNITY_FIELDS }, options);
  if (xml.includes('Success')) {
    return true;
  }
  const error = classifyError(xml);
  if (error && error.kind === 'account_in_use') {
    throw error;
  }
  return false;
}

/**
 * Authenticates with the AppEngine and returns a verified access token. A
 * cached token is reused (and re-validated against the verify endpoint) until
 * it expires; otherwise /account/verify is called and the resulting token is
 * verified before use.
 *
 * @throws {AppEngineError} for bad credentials, account-in-use, or token issues.
 */
export async function login(acc: Account, options: RequestOptions = {}): Promise<Credentials> {
  const tag = acc.alias ?? acc.guid;
  const clientToken = createHash('md5').update(acc.guid + acc.password).digest('hex');

  const cached = getCachedToken(acc.guid);
  if (cached && (await verifyAccessToken(cached.accessToken, clientToken, options))) {
    const minsLeft = Math.round((cached.expiresAt - Date.now()) / 60000);
    console.log(`[${tag}] using cached access token (verified, expires in ${minsLeft}m)`);
    return { accessToken: cached.accessToken, clientToken: cached.clientToken };
  }
  if (cached) {
    console.log(`[${tag}] cached token rejected — re-authenticating`);
  }

  const xml = await postForm(
    ENDPOINTS.VERIFY,
    {
      guid: acc.guid,
      password: acc.password,
      clientToken,
      ...UNITY_FIELDS,
    },
    options,
  );
  const verifyError = classifyError(xml);
  if (verifyError) {
    throw verifyError;
  }
  const match = /<AccessToken>(.+?)<\/AccessToken>/.exec(xml);
  if (!match) {
    throw new AppEngineError('no access token in verify response', 'unknown', xml.slice(0, 200));
  }
  const accessToken = match[1];

  // Verify the freshly issued token via the dedicated endpoint before using it.
  if (!(await verifyAccessToken(accessToken, clientToken, options))) {
    throw new AppEngineError('access token failed verification', 'token_invalid', '');
  }

  // Token lifetime comes from the response; fall back to ~50 minutes.
  const issued = Number(/<AccessTokenTimestamp>(\d+)<\/AccessTokenTimestamp>/.exec(xml)?.[1] ?? '0');
  const lifetime = Number(/<AccessTokenExpiration>(\d+)<\/AccessTokenExpiration>/.exec(xml)?.[1] ?? '0');
  const expiresAt = issued > 0 && lifetime > 0 ? (issued + lifetime) * 1000 : Date.now() + 50 * 60 * 1000;
  setCachedToken(acc.guid, { accessToken, clientToken, expiresAt });
  console.log(`[${tag}] authenticated (token verified)`);

  return { accessToken, clientToken };
}

/**
 * Fetches the character list and the embedded server list in one call.
 *
 * @throws {AppEngineError} for account-in-use, invalid credentials, etc.
 */
export async function getCharAndServers(
  accessToken: string,
  options: RequestOptions = {},
): Promise<{
  char: CharInfo;
  characters: CharInfo[];
  nextCharId: number;
  maxNumChars: number;
  servers: ServerInfo[];
}> {
  const xml = await postForm(ENDPOINTS.CHAR_LIST, { do_login: 'true', accessToken, ...UNITY_FIELDS }, options);
  const error = classifyError(xml);
  if (error) {
    throw error;
  }

  const nextCharId = Number(/<Chars nextCharId="(\d+)"/.exec(xml)?.[1] ?? '1');
  const characters = [...xml.matchAll(/<Char id="(\d+)">([\s\S]*?)<\/Char>/g)].map((match) => ({
    charId: Number(match[1]),
    needsNewChar: false,
    seasonal: /<Seasonal>\s*true\s*<\/Seasonal>/i.test(match[2]),
  }));
  const maxNumChars = Number(/maxNumChars="(\d+)"/.exec(xml)?.[1] ?? String(characters.length));
  const char: CharInfo =
    characters.length > 0
      ? characters[0]
      : { charId: nextCharId, needsNewChar: true };

  const servers: ServerInfo[] = [];
  for (const block of xml.matchAll(/<Server>([\s\S]*?)<\/Server>/g)) {
    const name = /<Name>(.*?)<\/Name>/.exec(block[1])?.[1];
    const dns = /<DNS>(.*?)<\/DNS>/.exec(block[1])?.[1];
    if (name && dns) {
      servers.push({ name, address: dns });
    }
  }

  return { char, characters, nextCharId, maxNumChars, servers };
}

/**
 * Permanently deletes a character via `/char/delete`. Resolves on success and
 * throws an {@link AppEngineError} if the server rejects it (e.g. the character
 * doesn't exist or the account is in use).
 *
 * This is irreversible — the character and its equipped items are gone.
 */
export async function deleteCharacter(
  accessToken: string,
  charId: number,
  options: RequestOptions = {},
): Promise<void> {
  const xml = await postForm(
    ENDPOINTS.CHAR_DELETE,
    { charId: String(charId), accessToken, ...UNITY_FIELDS },
    options,
  );
  const error = classifyError(xml);
  if (error) {
    throw error;
  }
  if (!xml.includes('Success')) {
    throw new AppEngineError(`unexpected /char/delete response`, 'unknown', xml.slice(0, 200));
  }
}
