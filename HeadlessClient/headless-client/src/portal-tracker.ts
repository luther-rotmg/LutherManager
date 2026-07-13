import { ObjectStatusData, PortalType, StatType } from 'realmlib';
import { RealmPortal, TrackedObject } from './models';

/** Tracks Nexus realm portals and parses their display/connect stats. */
export class PortalTracker {
  private readonly portals = new Map<number, RealmPortal>();

  all(): RealmPortal[] {
    return [...this.portals.values()];
  }

  has(objectId: number): boolean {
    return this.portals.has(objectId);
  }

  delete(objectId: number): void {
    this.portals.delete(objectId);
  }

  clear(): void {
    this.portals.clear();
  }

  trackRealmPortal(status: ObjectStatusData): { portal: RealmPortal; isNew: boolean } | undefined {
    let rawName: string | undefined;
    let openedAt: number | undefined;
    let connectId: number | undefined;
    let connectValueTwo: number | undefined;
    for (const stat of status.stats) {
      if (stat.statType === StatType.NAME_STAT) {
        rawName = stat.stringStatValue;
      } else if (stat.statType === StatType.OPENED_AT_TIMESTAMP) {
        openedAt = stat.statValue;
      } else if (stat.statType === StatType.CONNECT_STAT) {
        connectId = stat.statValue;
        connectValueTwo = stat.statValueTwo;
      }
    }
    if (rawName === undefined) {
      return undefined;
    }
    const parsed = PortalTracker.parseRealmPortal(rawName);
    if (!parsed) {
      return undefined;
    }
    const previous = this.portals.get(status.objectId);
    const portal: RealmPortal = {
      objectId: status.objectId,
      x: status.pos.x,
      y: status.pos.y,
      name: parsed.name,
      players: parsed.players,
      maxPlayers: parsed.maxPlayers,
      openedAt: openedAt ?? previous?.openedAt ?? 0,
      connectId: connectId ?? previous?.connectId,
      connectValueTwo: connectValueTwo ?? previous?.connectValueTwo,
    };
    this.portals.set(status.objectId, portal);
    return { portal, isNew: !previous };
  }

  /** Finds the first visible object whose type matches the given portal type. */
  findPortalByType(
    objects: Map<number, TrackedObject>,
    type: PortalType,
  ): { id: number; object: TrackedObject } | undefined {
    for (const [id, object] of objects) {
      if (object.type === type) {
        return { id, object };
      }
    }
    return undefined;
  }

  findVaultPortal(objects: Map<number, TrackedObject>): { id: number; object: TrackedObject } | undefined {
    return this.findPortalByType(objects, PortalType.Vault);
  }

  static parseRealmPortal(raw: string): { name: string; players: number; maxPlayers: number } | undefined {
    const match = /^(.*?)\s*\((\d+)\/(\d+)\)\s*$/.exec(raw);
    if (!match) {
      return undefined;
    }
    const label = match[1];
    const name = label.includes('.') ? label.slice(label.lastIndexOf('.') + 1) : label;
    return { name, players: Number(match[2]), maxPlayers: Number(match[3]) };
  }
}
