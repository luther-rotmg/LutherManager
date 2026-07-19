import { Projectile } from '../../types/world/Projectile';

export class Projectiles {
    static getAll(): Projectile[] {
        throw new Error('Must be run inside LutherManager client');
    }

    static getNearby(radius: number): Projectile[] {
        throw new Error('Must be run inside LutherManager client');
    }

    static getIncoming(): Projectile[] {
        throw new Error('Must be run inside LutherManager client');
    }

    static count(): number {
        throw new Error('Must be run inside LutherManager client');
    }
}
