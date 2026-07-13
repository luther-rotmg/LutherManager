import type { Item } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { GiftChest } from '../sdkInternal.js';
import { warnUnimplemented } from '../stubWarn.js';

export class BridgeGiftChest {
  static install(_deps: BridgeDeps): void {
    GiftChest.getItems = (): Item[] => {
      warnUnimplemented('GiftChest.getItems');
      return [];
    };
    GiftChest.withdraw = (_name: string) => {
      warnUnimplemented('GiftChest.withdraw');
      return false;
    };
    GiftChest.withdrawAll = () => {
      warnUnimplemented('GiftChest.withdrawAll');
      return false;
    };
    GiftChest.contains = (_name: string) => {
      warnUnimplemented('GiftChest.contains');
      return false;
    };
  }
}
