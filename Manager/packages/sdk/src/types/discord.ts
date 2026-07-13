export interface DiscordWebhookOptions {
  url: string;
  username?: string;
  avatarUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  minIntervalMs?: number;
  allowedMentions?: DiscordAllowedMentions;
}

export interface DiscordMessageOptions {
  content?: string;
  username?: string;
  avatarUrl?: string;
  embeds?: DiscordEmbedOptions[];
  allowedMentions?: DiscordAllowedMentions;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: DiscordEmbedColor;
  fields?: DiscordEmbedField[];
  footer?: string | DiscordEmbedFooter;
  timestamp?: boolean | string | Date;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export type DiscordAllowedMentionType = 'roles' | 'users' | 'everyone';

export interface DiscordAllowedMentions {
  parse?: DiscordAllowedMentionType[];
  roles?: string[];
  users?: string[];
  repliedUser?: boolean;
}

export interface DiscordEmbedFooter {
  text: string;
  iconUrl?: string;
}

export type DiscordEmbedColor =
  | number
  | 'red'
  | 'green'
  | 'blue'
  | 'gold'
  | 'white'
  | 'purple'
  | 'orange'
  | 'gray';

export interface DiscordEmbedOptions extends Omit<DiscordEmbed, 'fields'> {
  fields?: DiscordEmbedField[] | Record<string, unknown>;
}
