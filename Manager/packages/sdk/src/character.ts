export const character = {
  create(_classType: number, _seasonal?: boolean): void { throw new Error('Must be run inside Hive client'); },
  delete(_characterId: number): Promise<void> { throw new Error('Must be run inside Hive client'); },
  convertSeasonal(): void { throw new Error('Must be run inside Hive client'); },
  isSeasonal(): boolean | undefined { throw new Error('Must be run inside Hive client'); },
};
