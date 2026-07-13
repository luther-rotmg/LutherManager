import type { BridgeDeps } from '../BridgeDeps.js';
import type { VaultItem } from '@hive/sdk';
import { VaultChest } from '../sdkInternal.js';
import { warnUnimplemented } from '../stubWarn.js';

export class BridgeVaultChest {
  static install(_deps: BridgeDeps): void {
    VaultChest.prototype.getItems = function (): (VaultItem | null)[] {
      void this;
      warnUnimplemented('VaultChest.getItems');
      return [];
    };
    VaultChest.prototype.withdraw = function (_name: string): boolean {
      void this;
      warnUnimplemented('VaultChest.withdraw');
      return false;
    };
    VaultChest.prototype.deposit = function (_name: string): boolean {
      void this;
      warnUnimplemented('VaultChest.deposit');
      return false;
    };
    VaultChest.prototype.contains = function (_name: string): boolean {
      void this;
      warnUnimplemented('VaultChest.contains');
      return false;
    };
    VaultChest.prototype.getFreeSlots = function (): number {
      void this;
      warnUnimplemented('VaultChest.getFreeSlots');
      return 0;
    };
    VaultChest.prototype.isFull = function (): boolean {
      void this;
      warnUnimplemented('VaultChest.isFull');
      return false;
    };
  }
}
