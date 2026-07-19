/** Account character returned by {@link character.getAll}. */
export interface CharacterInfo {
  /** Persistent account character id used by `switchTo` and `delete`. */
  id: number;
  /** Numeric player class object type. */
  classType: number;
  /** Game-data display name for the player class. */
  className: string;
  level: number;
  experience: number;
  /** Alive fame earned by this character. */
  fame: number;
  seasonal: boolean;
  /** Equipped and carried item object types, with `-1` for empty slots. */
  equipment: number[];
  /** Whether this is the character currently selected by the client. */
  isCurrent: boolean;
}

export const character = {
  /** Character id currently selected by this account client. */
  getCurrentId(): number { throw new Error('Must be run inside LutherManager client'); },
  /** Fetches every existing character on the account. */
  getAll(): Promise<CharacterInfo[]> { throw new Error('Must be run inside LutherManager client'); },
  /** Reconnects the account using an existing character id. */
  switchTo(_characterId: number): Promise<void> { throw new Error('Must be run inside LutherManager client'); },
  create(_classType: number, _seasonal?: boolean): void { throw new Error('Must be run inside LutherManager client'); },
  delete(_characterId: number): Promise<void> { throw new Error('Must be run inside LutherManager client'); },
  convertSeasonal(): void { throw new Error('Must be run inside LutherManager client'); },
  isSeasonal(): boolean | undefined { throw new Error('Must be run inside LutherManager client'); },
};
