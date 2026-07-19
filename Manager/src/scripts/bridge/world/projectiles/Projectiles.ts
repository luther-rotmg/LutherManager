import { Projectiles } from '@luthermanager/sdk';
import type { Projectile } from '@luthermanager/sdk';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { warnUnimplemented } from '../../stubWarn.js';

export class BridgeProjectiles {
  static install(_deps: BridgeDeps): void {
    Projectiles.getAll = (): Projectile[] => {
      warnUnimplemented('Projectiles.getAll');
      return [];
    };
    Projectiles.getNearby = (_radius: number): Projectile[] => {
      warnUnimplemented('Projectiles.getNearby');
      return [];
    };
    Projectiles.getIncoming = (): Projectile[] => {
      warnUnimplemented('Projectiles.getIncoming');
      return [];
    };
    Projectiles.count = () => {
      warnUnimplemented('Projectiles.count');
      return 0;
    };
  }
}
