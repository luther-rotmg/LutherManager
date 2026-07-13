import type {
  DiscordEmbedOptions,
  DiscordWebhookOptions,
  DiscordMessageOptions,
} from './types/discord';
import type { PlayerDiedEvent } from './types/events';
import type { LootDropEvent, LootItemEvent } from './types/loot';

export const discord = {
  createWebhook(options: DiscordWebhookOptions): DiscordWebhook {
    return new DiscordWebhook(options);
  },
};

export class DiscordWebhook {
  constructor(public readonly options: DiscordWebhookOptions) {}

  send(_message: DiscordMessageOptions): Promise<void> {
    return Promise.resolve();
  }

  async sendSafe(message: DiscordMessageOptions): Promise<boolean> {
    try {
      await this.send(message);
      return true;
    } catch {
      return false;
    }
  }

  sendText(_content: string): Promise<void> {
    return Promise.resolve();
  }

  sendEmbed(_embed: DiscordEmbedOptions, _message?: Omit<DiscordMessageOptions, 'embeds'>): Promise<void> {
    return Promise.resolve();
  }

  sendDeath(_event: PlayerDiedEvent): Promise<void> {
    return Promise.resolve();
  }

  sendLoot(_event: LootDropEvent | LootItemEvent): Promise<void> {
    return Promise.resolve();
  }

  sendFameSnapshot(): Promise<void> {
    return Promise.resolve();
  }

  sendPartyStatus(): Promise<void> {
    return Promise.resolve();
  }
}

export type {
  DiscordAllowedMentions,
  DiscordEmbedColor,
  DiscordEmbedOptions,
  DiscordWebhookOptions,
  DiscordMessageOptions,
  DiscordEmbed,
  DiscordEmbedField,
  DiscordEmbedFooter,
} from './types/discord';
