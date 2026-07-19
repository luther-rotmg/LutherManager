import type { TradeItem } from './types/trade';

/**
 * Trading API. Stub implementations; Luther's ScriptHost patches these at runtime.
 */
export const trade = {
  /**
   * Send a trade request to a player by name.
   */
  start(_playerName: string): boolean {
    void _playerName;
    return false;
  },

  /**
   * Alias for `start`.
   */
  startTrade(playerName: string): boolean {
    return trade.start(playerName);
  },

  /**
   * Whether a trade window is currently active.
   */
  isActive(): boolean {
    return false;
  },

  /**
   * Name of the player on the other side of the active trade.
   */
  getPartnerName(): string {
    return '';
  },

  /**
   * Items available from your side of the active trade.
   */
  getOurItems(): TradeItem[] {
    return [];
  },

  /**
   * Items available from the other player's side of the active trade.
   */
  getPartnerItems(): TradeItem[] {
    return [];
  },

  /**
   * Current boolean offer array for your side of the trade.
   */
  getOurOffer(): boolean[] {
    return [];
  },

  /**
   * Current boolean offer array for the other player's side of the trade.
   */
  getPartnerOffer(): boolean[] {
    return [];
  },

  /**
   * Set your offered trade slots by index. Indexes map to `getOurItems()`.
   */
  offer(_slotIndexes: number | number[]): boolean {
    void _slotIndexes;
    return false;
  },

  /**
   * Offer every currently tradeable item in `getOurItems()`.
   */
  offerAll(): boolean {
    return false;
  },

  /**
   * Clear your current offer.
   */
  clearOffer(): boolean {
    return false;
  },

  /**
   * Accept the current trade with the latest known offers.
   */
  accept(): boolean {
    return false;
  },

  /**
   * Alias for `accept`.
   */
  acceptTrade(): boolean {
    return trade.accept();
  },

  /**
   * Cancel the current trade.
   */
  cancel(): boolean {
    return false;
  },

  /**
   * Alias for `cancel`.
   */
  cancelTrade(): boolean {
    return trade.cancel();
  },
};

export type { TradeItem } from './types/trade';
