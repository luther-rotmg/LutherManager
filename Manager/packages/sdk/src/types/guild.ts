/** Standard RotMG guild rank values for use with `guild.setRank()`. */
export enum GuildRank {
  Initiate = 0,
  Member   = 10,
  Officer  = 20,
  Leader   = 30,
  Founder  = 40,
}

/** Fired when someone invites you to a guild (`guild.onInvited`). */
export interface GuildInviteEvent {
  /** Name of the player who sent the invite. */
  inviterName: string;
  /** Name of the guild the invite is for. */
  guildName: string;
}

/** Fired when the server responds to a guild action (`guild.onResult`). */
export interface GuildResultEvent {
  /** Whether the action succeeded. */
  success: boolean;
  /** Raw message from the server (JSON key-string from lineBuilderJSON). */
  message: string;
}

export type GuildHandler<T> = (event: T) => void;
export type Unsubscribe = () => void;
