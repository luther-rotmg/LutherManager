import type { GuildInviteEvent, GuildResultEvent, GuildHandler, Unsubscribe } from './types/guild';
export { GuildRank } from './types/guild';

/**
 * Guild management through the named `guild` export from `@luthermanager/sdk`.
 *
 * Outgoing actions (invite, remove, leave, join, setRank) send the corresponding
 * server packets. Incoming hooks (onInvited, onResult) fire when the server notifies you.
 *
 * Leader/Founder-only actions (invite, remove, setRank) will silently fail server-side
 * if you don't have the required rank.
 */
export const guild = {
  /** Invite a player to your guild by character name. */
  invite(_name: string): void { void _name; },

  /**
   * Remove/kick a player from your guild by character name.
   * Requires Leader or Founder rank.
   */
  remove(_name: string): void { void _name; },

  /**
   * Leave your current guild.
   * Sends GUILDREMOVE with your own character name.
   */
  leave(): void {},

  /**
   * Accept a pending guild invite.
   * `guildName` must match the name from the `onInvited` event exactly.
   */
  join(_guildName: string): void { void _guildName; },

  /**
   * Change a guild member's rank. Requires Leader or Founder rank.
   * Use `GuildRank` enum for the `rank` value.
   */
  setRank(_name: string, _rank: number): void { void _name; void _rank; },

  /**
   * Called when you receive a guild invite.
   * Returns an unsubscribe function.
   */
  onInvited(_handler: GuildHandler<GuildInviteEvent>): Unsubscribe {
    void _handler;
    return () => {};
  },

  /**
   * Called when the server sends a result for a guild action (success or failure).
   * Returns an unsubscribe function.
   */
  onResult(_handler: GuildHandler<GuildResultEvent>): Unsubscribe {
    void _handler;
    return () => {};
  },
};
