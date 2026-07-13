import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';
import { PlayerData } from './PlayerData.js';
import { Logger } from '../util/Logger.js';
import { normalizeMapDisplayName } from '../util/mapDisplayName.js';

/**
 * Hooks core packets to maintain PlayerData state.
 * Ported from KRelayBetter's StateManager.cs.
 */
export class StateManager {
  private proxy: Proxy | null = null;

  attach(proxy: Proxy): void {
    this.proxy = proxy;
    proxy.hookPacket('CREATESUCCESS', (c, p) => this.onCreateSuccess(c, p));
    proxy.hookPacket('MAPINFO', (c, p) => this.onMapInfo(c, p));
    proxy.hookPacket('UPDATE', (c, p) => this.onUpdate(c, p));
    proxy.hookPacket('NEWTICK', (c, p) => this.onNewTick(c, p));
    proxy.hookPacket('MOVE', (c, p) => this.onMove(c, p));
    proxy.hookPacket('TELEPORT', (c, p) => this.onTeleport(c, p));
    proxy.hookPacket('GOTO', (c, p) => this.onGoto(c, p));
    proxy.hookPacket('PLAYERSHOOT', (c, p) => this.onPlayerShoot(c, p));
    proxy.hookPacket('PONG', (c, p) => this.onPong(c, p));
    proxy.hookPacket('QUESTOBJECTID', (c, p) => this.onQuestObjectId(c, p));
  }

  private onQuestObjectId(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    const raw = Math.trunc(Number((packet.data as { objectId?: number }).objectId));
    client.playerData.questObjectId = Number.isFinite(raw) ? raw : -1;
  }

  private onCreateSuccess(client: ClientConnection, packet: Packet): void {
    client.playerData = new PlayerData();
    client.playerData.ownerObjectId = packet.data.objectId;
    client.lastTeleportSentAt = 0;
    client.lastTeleportGotoAt = 0;
    client.pendingTeleportSentAt = 0;
    client.pendingTeleportTargetObjectId = null;
    Logger.log('State', `Player created with objectId ${packet.data.objectId}`);
  }

  private onMapInfo(client: ClientConnection, packet: Packet): void {
    // RotmgPlayer uses displayName when present, falling back to name
    const displayName = packet.data.displayName ?? '';
    const name = packet.data.name ?? '';
    client.playerData.mapName = normalizeMapDisplayName(displayName, name);
    client.playerData.mapWidth = packet.data.width ?? 0;
    client.playerData.mapHeight = packet.data.height ?? 0;
    client.playerData.teleportAllowed = packet.data.allowPlayerTeleport ?? false;
    client.pendingTeleportSentAt = 0;
    client.pendingTeleportTargetObjectId = null;
    client.playerData.vaultContent = [];
    client.playerData.vaultChestObjectId = -1;
    client.playerData.questObjectId = -1;
    Logger.log('State', `Map: ${packet.data.name} (${packet.data.width}x${packet.data.height})`);
  }

  private onUpdate(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined || !packet.data.newObjs) return;

    for (const entity of packet.data.newObjs) {
      const status = entity.status;
      if (!status) continue;

      // Check if this entity is our player
      if (status.objectId === client.objectId) {
        const entityObjectType = Number(entity.objectType);
        if (Number.isFinite(entityObjectType) && entityObjectType > 0) {
          client.playerData.classType = Math.trunc(entityObjectType);
        }
        client.playerData.pos = { ...status.position };
        if (status.data) {
          client.playerData.parseStatus(status.data);

          // Account ID matching for state persistence across reconnects
          if (client.playerData.accountId && client.state) {
            if (!client.state.accountId) {
              client.state.accountId = client.playerData.accountId;
            }
          }
        }
      }
    }
  }

  private onNewTick(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined || !packet.data.statuses) return;

    if (packet.data.tickId !== undefined) {
      client.lastNewTickId = Number(packet.data.tickId) || 0;
    }
    if (packet.data.serverRealTimeMs !== undefined) {
      client.lastServerRealTimeMs = Number(packet.data.serverRealTimeMs) || 0;
    }

    for (const status of packet.data.statuses) {
      if (status.objectId === client.objectId) {
        // Update position
        if (status.position) {
          client.playerData.pos = { ...status.position };
        }
        // Update stats
        if (status.data) {
          client.playerData.parseStatus(status.data);
        }
      }
    }
  }

  private onMove(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    client.lastClientMoveAt = Date.now();
    client.previousTime = packet.data.serverRealTimeMSofLastNewTick ?? 0;
    client.lastServerRealTimeMs = Number(packet.data.serverRealTimeMSofLastNewTick ?? client.lastServerRealTimeMs) || 0;
    client.lastUpdate = Date.now();
    // Calibrate game time from first record's timestamp (MOVE records contain client game time)
    if (client.relativeTime === 0) {
      const records = packet.data.records as Array<{ time: number }> | undefined;
      if (records && records.length > 0 && records[0].time) {
        client.relativeTime = records[0].time - Date.now();
      }
    }

  }

  private onTeleport(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    client.lastTeleportSentAt = Date.now();
    client.pendingTeleportSentAt = client.lastTeleportSentAt;
    client.pendingTeleportTargetObjectId = Number(packet.data.objectId ?? 0) || null;
  }

  private onGoto(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    if (Number(packet.data.objectId ?? -1) !== client.objectId) return;

    if (packet.data.position) {
      client.playerData.pos = { ...packet.data.position };
    }

    const now = Date.now();
    if (client.pendingTeleportSentAt > 0 && (now - client.pendingTeleportSentAt) <= 5000) {
      client.lastTeleportGotoAt = now;
      client.pendingTeleportSentAt = 0;
      client.pendingTeleportTargetObjectId = null;
    } else if (client.pendingTeleportSentAt > 0 && (now - client.pendingTeleportSentAt) > 5000) {
      client.pendingTeleportSentAt = 0;
      client.pendingTeleportTargetObjectId = null;
    }
  }

  private onPong(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    // PONG is sent very early (in response to server PING) and carries the client's game time.
    // Use it as the earliest possible calibration point for client.time.
    if (client.relativeTime === 0 && packet.data.time) {
      client.relativeTime = (packet.data.time as number) - Date.now();
    }
  }

  private onPlayerShoot(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;

    // Time synchronization: calculate offset between server and client time
    if (client.relativeTime === 0) {
      client.relativeTime = (packet.data.time ?? 0) - Date.now();
    }

    // Infer player position from projectile origin
    // Projectile spawns 0.3 units from player center
    const projPos = packet.data.projectilePosition;
    const angle = packet.data.angle ?? 0;
    if (projPos) {
      client.playerData.pos = {
        x: projPos.x - Math.cos(angle) * 0.3,
        y: projPos.y - Math.sin(angle) * 0.3,
      };
    }

    client.lastUpdate = Date.now();
  }
}
