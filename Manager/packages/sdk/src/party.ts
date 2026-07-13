import type { PlayerNameMatchMode } from './players/Players';
import type { CreatePartyParams, PartyFinderParty, PartyMember } from './types/party';

/**
 * Party finder listings and current party roster. Stubs only; Hive’s
 * `ScriptHost.installBridge()` supplies real implementations.
 */
export const party = {
  /**
   * Publish a new party-finder listing. **Params:** listing settings (`CreatePartyParams`).
   * Outside the client, no-op.
   */
  createParty(_params: CreatePartyParams): void {
    void _params;
  },

  /**
   * Refresh the party-finder list. **Params:** none. **Returns:** promise of rows, or rejects
   * if unavailable or timed out. Outside the client, rejects immediately.
   */
  getPartyList(): Promise<PartyFinderParty[]> {
    return Promise.reject(new Error('Hive.party.getPartyList is only available in Hive'));
  },

  /**
   * Ask to join a listing. **Params:** party id from a `getPartyList()` row. Outside the client, no-op.
   */
  join(_partyId: number): void {
    void _partyId;
  },

  /**
   * Remove someone from your party. **Params:** roster member id from `getPartyMembers()`, `getId()`,
   * or join callbacks. Outside the client, no-op.
   */
  kick(_playerId: number): void {
    void _playerId;
  },

  /**
   * Who is in your party right now. **Params:** none. Outside the client, empty array.
   */
  getPartyMembers(): PartyMember[] {
    return [];
  },

  /**
   * Find a roster member id by display name for use with **`kick`**. **Params:** name;
   * optional **`'equals'`** (default, case-insensitive) or **`'contains'`** (first match).
   * **Returns:** id or **`null`**. Outside the client, **`null`**.
   */
  getId(_name: string, _match?: PlayerNameMatchMode): number | null {
    void _name;
    void _match;
    return null;
  },

  /**
   * Leave the current party. **Params:** none. Outside the client, no-op.
   */
  leave(): void {
    // stub
  },
};
