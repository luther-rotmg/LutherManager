import { Settings } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { warnUnimplemented } from '../stubWarn.js';

export class BridgeSettings {
  static install(_deps: BridgeDeps): void {
    Settings.get = (_key: string): string | number | boolean | null => {
      warnUnimplemented('Settings.get');
      return null;
    };
    Settings.getString = (_key: string, defaultValue?: string): string => {
      warnUnimplemented('Settings.getString');
      return defaultValue ?? '';
    };
    Settings.getNumber = (_key: string, defaultValue?: number): number => {
      warnUnimplemented('Settings.getNumber');
      return defaultValue ?? 0;
    };
    Settings.getBoolean = (_key: string, defaultValue?: boolean): boolean => {
      warnUnimplemented('Settings.getBoolean');
      return defaultValue ?? false;
    };
  }
}
