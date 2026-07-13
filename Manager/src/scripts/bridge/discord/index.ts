import { DiscordWebhook, Log, Hive } from '@hive/sdk';
import type {
  DiscordAllowedMentions,
  DiscordEmbed,
  DiscordEmbedColor,
  DiscordEmbedField,
  DiscordEmbedOptions,
  DiscordMessageOptions,
} from '@hive/sdk';
import type { LootDropEvent, LootItemEvent, PlayerDiedEvent } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';

type QueueEntry = { promise: Promise<void>; inFlight: number };

const queues = new Map<string, QueueEntry>();
const lastSendAt = new Map<string, number>();

/** How long a `lastSendAt` entry lingers after the queue drains before being pruned. */
const QUEUE_IDLE_GC_MS = 5 * 60 * 1000;

const COLOR_NAMES: Record<Exclude<DiscordEmbedColor, number>, number> = {
  red: 0xff3333,
  green: 0x3fbf63,
  blue: 0x3498db,
  gold: 0xf1c40f,
  white: 0xffffff,
  purple: 0x9b59b6,
  orange: 0xe67e22,
  gray: 0x95a5a6,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toColor(value: DiscordEmbedColor | undefined): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : COLOR_NAMES[value];
}

function toTimestamp(value: DiscordEmbed['timestamp']): string | undefined {
  if (!value) return undefined;
  if (value === true) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toAllowedMentions(value: DiscordAllowedMentions | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return {
    parse: value.parse ?? [],
    roles: value.roles,
    users: value.users,
    replied_user: value.repliedUser ?? false,
  };
}

function toFields(fields: DiscordEmbedOptions['fields']): DiscordEmbedField[] | undefined {
  if (!fields) return undefined;
  if (Array.isArray(fields)) return fields;
  return Object.entries(fields).map(([name, value]) => ({
    name,
    value: value === undefined || value === null ? '' : String(value),
    inline: true,
  }));
}

function toEmbed(embed: DiscordEmbedOptions): Record<string, unknown> {
  const footer = typeof embed.footer === 'string' ? { text: embed.footer } : embed.footer;
  return {
    title: embed.title,
    description: embed.description,
    color: toColor(embed.color),
    fields: toFields(embed.fields)?.map((field) => ({
      name: field.name,
      value: field.value,
      inline: field.inline ?? false,
    })),
    footer: footer ? { text: footer.text, icon_url: footer.iconUrl } : undefined,
    timestamp: toTimestamp(embed.timestamp),
  };
}

function buildBody(webhook: DiscordWebhook, options: DiscordMessageOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (options.content) body.content = options.content;
  if (options.username ?? webhook.options.username) body.username = options.username ?? webhook.options.username;
  if (options.avatarUrl ?? webhook.options.avatarUrl) body.avatar_url = options.avatarUrl ?? webhook.options.avatarUrl;

  body.allowed_mentions = toAllowedMentions(options.allowedMentions ?? webhook.options.allowedMentions ?? { parse: [] });

  if (options.embeds?.length) {
    body.embeds = options.embeds.map((embed) => toEmbed(embed));
  }

  return body;
}

async function readResponseBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function retryDelayFromBody(body: string, fallbackMs: number): number {
  try {
    const parsed = JSON.parse(body) as { retry_after?: unknown };
    const retryAfter = Number(parsed.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return retryAfter < 100 ? Math.ceil(retryAfter * 1000) : Math.ceil(retryAfter);
    }
  } catch {
    // use fallback
  }
  return fallbackMs;
}

async function postDiscord(webhook: DiscordWebhook, body: Record<string, unknown>): Promise<void> {
  const timeoutMs = webhook.options.timeoutMs ?? 10_000;
  const retries = webhook.options.retries ?? 2;
  const retryDelayMs = webhook.options.retryDelayMs ?? 1_000;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(webhook.options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.ok) return;

      const responseBody = await readResponseBody(response);
      const canRetry = response.status === 429 || response.status >= 500;
      if (canRetry && attempt < retries) {
        const delay = response.status === 429 ? retryDelayFromBody(responseBody, retryDelayMs) : retryDelayMs;
        await sleep(delay);
        continue;
      }

      const details = responseBody ? `: ${responseBody.slice(0, 500)}` : '';
      throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}${details}`);
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        if (attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        throw new Error(`Discord webhook timed out after ${timeoutMs}ms`);
      }
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function enqueue(webhook: DiscordWebhook, task: () => Promise<void>): Promise<void> {
  const key = webhook.options.url;
  const existing = queues.get(key);
  const prev = existing?.promise ?? Promise.resolve();
  const entry: QueueEntry = existing ?? { promise: Promise.resolve(), inFlight: 0 };
  entry.inFlight++;
  queues.set(key, entry);

  const next = prev.catch(() => undefined).then(async () => {
    const minIntervalMs = webhook.options.minIntervalMs ?? 250;
    const elapsed = Date.now() - (lastSendAt.get(key) ?? 0);
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    await task();
    lastSendAt.set(key, Date.now());
  });

  entry.promise = next.catch(() => undefined);

  void entry.promise.then(() => {
    entry.inFlight--;
    if (entry.inFlight <= 0 && queues.get(key) === entry) {
      queues.delete(key);
      const last = lastSendAt.get(key);
      if (last !== undefined) {
        setTimeout(() => {
          if (queues.has(key)) return;
          if (lastSendAt.get(key) === last) lastSendAt.delete(key);
        }, QUEUE_IDLE_GC_MS).unref?.();
      }
    }
  });

  return next;
}

function itemNames(event: LootDropEvent | LootItemEvent): string {
  const maybeItem = (event as LootItemEvent).item;
  if (maybeItem) return maybeItem.itemName ?? `ID:${maybeItem.objectType}`;
  return event.bag.items.map((item) => item.itemName ?? `ID:${item.objectType}`).join(', ') || '(empty)';
}

export function install(_deps: BridgeDeps): void {
  DiscordWebhook.prototype.send = async function (
    this: DiscordWebhook,
    options: DiscordMessageOptions,
  ): Promise<void> {
    const body = buildBody(this, options);
    await enqueue(this, () => postDiscord(this, body));
  };

  DiscordWebhook.prototype.sendSafe = async function (
    this: DiscordWebhook,
    options: DiscordMessageOptions,
  ): Promise<boolean> {
    try {
      await this.send(options);
      return true;
    } catch (err) {
      Log.warn(`Discord webhook send failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  DiscordWebhook.prototype.sendText = async function (
    this: DiscordWebhook,
    content: string,
  ): Promise<void> {
    return this.send({ content });
  };

  DiscordWebhook.prototype.sendEmbed = async function (
    this: DiscordWebhook,
    embed: DiscordEmbedOptions,
    message: Omit<DiscordMessageOptions, 'embeds'> = {},
  ): Promise<void> {
    return this.send({ ...message, embeds: [embed] });
  };

  DiscordWebhook.prototype.sendDeath = async function (
    this: DiscordWebhook,
    event: PlayerDiedEvent,
  ): Promise<void> {
    return this.sendEmbed({
      title: event.isLocal ? 'You Died' : `${event.playerName} Died`,
      description: `Killed by: ${event.killedBy ?? 'unknown'}`,
      color: 'red',
      fields: {
        Player: event.playerName,
        Map: Hive.world.getName(),
      },
      timestamp: true,
    });
  };

  DiscordWebhook.prototype.sendLoot = async function (
    this: DiscordWebhook,
    event: LootDropEvent | LootItemEvent,
  ): Promise<void> {
    return this.sendEmbed({
      title: `${event.bag.rarity.toUpperCase()} bag`,
      description: itemNames(event),
      color: event.bag.rarity === 'white' ? 'white' : event.bag.rarity === 'purple' ? 'purple' : 'blue',
      fields: {
        Map: Hive.world.getName(),
        Owner: event.bag.ownerName ?? 'unknown',
        Position: `${event.bag.position.x.toFixed(1)}, ${event.bag.position.y.toFixed(1)}`,
      },
      timestamp: true,
    });
  };

  DiscordWebhook.prototype.sendFameSnapshot = async function (
    this: DiscordWebhook,
  ): Promise<void> {
    return this.sendEmbed({
      title: 'Fame Snapshot',
      color: 'gold',
      fields: {
        Player: Hive.self.getName(),
        Class: Hive.self.getClass(),
        CharacterFame: Hive.self.getCharacterFame(),
        AccountFame: Hive.self.getAccountFame(),
        PowerLevel: Hive.self.getPowerLevel(),
        Map: Hive.world.getName(),
      },
      timestamp: true,
    });
  };

  DiscordWebhook.prototype.sendPartyStatus = async function (
    this: DiscordWebhook,
  ): Promise<void> {
    const members = Hive.party.getPartyMembers();
    return this.sendEmbed({
      title: 'Party Status',
      color: 'blue',
      description: members.length
        ? members.map((member) => `${member.playerName} (${member.classId})`).join('\n')
        : 'No current party members.',
      fields: {
        Count: members.length,
        Map: Hive.world.getName(),
      },
      timestamp: true,
    });
  };
}
