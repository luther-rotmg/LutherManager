import { AutoNexus } from '@luthermanager/sdk';
import type { Client } from 'headless-client';
import type { BridgeDeps } from '../BridgeDeps.js';

function active(deps: BridgeDeps): Client {
  const client = deps.getHeadlessClient?.();
  if (!client) throw new Error('No headless account is connected to Luther.');
  return client;
}

/** Routes the SDK autonexus controls to the account selected for this script run. */
export class BridgeAutoNexus {
  static install(deps: BridgeDeps): void {
    AutoNexus.enable = (thresholdPercent?: number): void => {
      const client = active(deps);
      if (thresholdPercent !== undefined) client.setAutoNexusThreshold(thresholdPercent);
      client.setAutoNexusEnabled(true);
    };

    AutoNexus.disable = (): void => {
      active(deps).setAutoNexusEnabled(false);
    };

    AutoNexus.setEnabled = (enabled: boolean): void => {
      active(deps).setAutoNexusEnabled(enabled);
    };

    AutoNexus.isEnabled = (): boolean => active(deps).getAutoNexusState().enabled;

    AutoNexus.setThreshold = (thresholdPercent: number): void => {
      active(deps).setAutoNexusThreshold(thresholdPercent);
    };

    AutoNexus.getThreshold = (): number => active(deps).getAutoNexusState().thresholdPercent;

    AutoNexus.configure = (options): void => {
      active(deps).configureAutoNexus(options);
    };

    AutoNexus.getState = () => active(deps).getAutoNexusState();
  }
}
