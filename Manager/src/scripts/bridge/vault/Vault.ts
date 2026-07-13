import { Vault } from '@hive/sdk';
import type { Item } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { VaultChest } from '../sdkInternal.js';
import { warnUnimplemented } from '../stubWarn.js';

export class BridgeVault {
  static install(_deps: BridgeDeps): void {
    const V = Vault as Record<string, unknown>;

    V.get = (index: number) => {
      warnUnimplemented('Vault.get');
      return new VaultChest(index);
    };

    const vaultChest = V.vaultChest as Record<string, unknown>;
    vaultChest.get = (index: number) => {
      warnUnimplemented('Vault.vaultChest.get');
      return new VaultChest(index);
    };
    vaultChest.findChestWith = (_itemName: string) => {
      warnUnimplemented('Vault.vaultChest.findChestWith');
      return null;
    };
    vaultChest.getAll = () => {
      warnUnimplemented('Vault.vaultChest.getAll');
      return [];
    };

    V.findItem = (_name: string): Item | null => {
      warnUnimplemented('Vault.findItem');
      return null;
    };
    V.getAllItems = (): Item[] => {
      warnUnimplemented('Vault.getAllItems');
      return [];
    };
  }
}
