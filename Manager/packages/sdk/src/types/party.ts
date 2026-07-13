/** Settings for a new party-finder listing (`Hive.party.createParty`). */
export interface CreatePartyParams {
  /** Short text shown on the listing. */
  description: string;
  /** Minimum power level required to join. */
  minPowerLevel: number;
  /** Maximum players in the party. */
  maxPartySize: number;
  /** Activity filter for the listing. */
  activity: number;
  /** Maxed-stat requirement for the listing. */
  maxedStatReq: number;
  /** Privacy / visibility mode for the listing. */
  privacy: number;
  /** Optional advanced compatibility field; omit unless you know you need it (even-length hex string). */
  unreadTrailingHex?: string;
}

/** One row from `Hive.party.getPartyList()`. */
export interface PartyFinderParty {
  name: string;
  partyId: number;
  powerLevelMin: number;
  partySizeCurrent: number;
  partySizeMax: number;
  activity: number;
  privacy: number;
  statsMin: number;
  serverIndex: number;
}

/** Someone in your current party (`Hive.party.getPartyMembers()`). */
export interface PartyMember {
  /** Pass to `Hive.party.kick` to remove this player. */
  playerId: number;
  playerName: string;
  classId: number;
}
