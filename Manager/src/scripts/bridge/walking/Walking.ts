import { Walking } from '@hive/sdk';
import type { Position } from '@hive/sdk';
import type { Enemy } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { warnUnimplemented } from '../stubWarn.js';
import { Logger } from '../../../util/Logger.js';
import { resolveTeleportBeacon } from './TeleportBeacon.js';

export class BridgeWalking {
  static install(deps: BridgeDeps): void {
    Walking.walkTo = (_x, _y) => {
      warnUnimplemented('Walking.walkTo');
      return false;
    };

    Walking.pathfindingWalkTo = (_x, _y, _arriveThreshold) => {
      warnUnimplemented('Walking.pathfindingWalkTo');
      return false;
    };

    Walking.walkToPosition = (_position: Position) => {
      warnUnimplemented('Walking.walkToPosition');
      return false;
    };

    Walking.walkToEnemy = () => {
      warnUnimplemented('Walking.walkToEnemy');
      return false;
    };

    Walking.pathfindingWalkToEnemy = () => {
      warnUnimplemented('Walking.pathfindingWalkToEnemy');
      return false;
    };

    Walking.walkToPortal = (_name: string) => {
      warnUnimplemented('Walking.walkToPortal');
      return false;
    };

    Walking.walkToNearestPortal = () => {
      warnUnimplemented('Walking.walkToNearestPortal');
      return false;
    };

    Walking.walkToNexusPortal = () => {
      warnUnimplemented('Walking.walkToNexusPortal');
      return false;
    };

    Walking.walkToLeftWall = () => {
      warnUnimplemented('Walking.walkToLeftWall');
      return false;
    };

    Walking.walkToRightWall = () => {
      warnUnimplemented('Walking.walkToRightWall');
      return false;
    };

    Walking.walkToTopWall = () => {
      warnUnimplemented('Walking.walkToTopWall');
      return false;
    };

    Walking.walkToBottomWall = () => {
      warnUnimplemented('Walking.walkToBottomWall');
      return false;
    };

    Walking.followPlayer = (_name: string) => {
      warnUnimplemented('Walking.followPlayer');
      return false;
    };

    Walking.stopMoving = () => {
      warnUnimplemented('Walking.stopMoving');
    };

    Walking.isMoving = () => {
      warnUnimplemented('Walking.isMoving');
      return false;
    };

    Walking.hasReached = (_position: Position, _tolerance = 0.5) => {
      warnUnimplemented('Walking.hasReached');
      return false;
    };

    Walking.nexus = () => {
      const c = deps.clientRef.current;
      if (!c?.connected) return;
      try {
        const packet = deps.proxy.packetFactory.createByName('ESCAPE');
        packet.modified = true;
        c.sendToServer(packet);
      } catch {
        // void API — ignore factory/send errors (e.g. no connection mid-send)
      }
    };

    Walking.enableAutoDodge = () => {
      warnUnimplemented('Walking.enableAutoDodge');
      return false;
    };

    Walking.disableAutoDodge = () => {
      warnUnimplemented('Walking.disableAutoDodge');
    };

    Walking.isAutoDodgeEnabled = () => false;

    Walking.getAutoDodgeState = () => null;

    Walking.getDodgePosition = (): Position | null => {
      warnUnimplemented('Walking.getDodgePosition');
      return null;
    };

    Walking.dodge = () => {
      warnUnimplemented('Walking.dodge');
      return false;
    };

    Walking.dodgeFrom = (_enemy: Enemy) => {
      warnUnimplemented('Walking.dodgeFrom');
      return false;
    };

    Walking.canTeleport = (): boolean => {
      return deps.clientRef.current?.playerData.teleportAllowed ?? false;
    };

    Walking.teleportToPlayer = (name: string): boolean => {
      const c = deps.clientRef.current;
      if (!c?.connected) return false;
      if (!c.playerData.teleportAllowed) {
        Logger.warn('Walking', 'teleportToPlayer: teleport not allowed in this map');
        return false;
      }
      const q = name.trim().toLowerCase();
      const rows = deps.worldState.getAllPlayersRawStatsForDashboard(deps.gameData);
      let row = rows.find(r => r.name.trim().toLowerCase() === q);
      if (!row) row = rows.find(r => r.name.toLowerCase().includes(q));
      if (!row) {
        Logger.warn('Walking', `teleportToPlayer: player "${name}" not found in world state`);
        return false;
      }
      try {
        const pkt = deps.proxy.packetFactory.createByName('TELEPORT');
        pkt.data.objectId = row.objectId;
        pkt.modified = true;
        c.sendToServer(pkt);
        return true;
      } catch (err) {
        Logger.warn('Walking', `teleportToPlayer: send failed — ${(err as Error).message}`);
        return false;
      }
    };

    Walking.teleportBeacon = (destination: string): boolean => {
      const c = deps.clientRef.current;
      if (!c?.connected) return false;
      if (!c.playerData.teleportAllowed) {
        Logger.warn('Walking', 'teleportBeacon: teleport not allowed in this map');
        return false;
      }
      const worldState = deps.getWorldStateForClient?.(c) ?? deps.worldState;
      const candidates = worldState.getObjectsForDashboard(deps.gameData).beacons.flatMap((group) => (
        group.entities.map((entity) => ({ ...entity, type: group.objectType }))
      ));
      const beacon = resolveTeleportBeacon(destination, candidates, deps.gameData, c.playerData.pos);
      if (!beacon) {
        Logger.warn('Walking', `teleportBeacon: no live teleport beacon matches "${destination}"`);
        return false;
      }
      try {
        const pkt = deps.proxy.packetFactory.createByName('TELEPORT');
        pkt.data.objectId = beacon.objectId;
        pkt.modified = true;
        c.sendToServer(pkt);
        return true;
      } catch (err) {
        Logger.warn('Walking', `teleportBeacon: send failed — ${(err as Error).message}`);
        return false;
      }
    };

    Walking.teleportToBeacon = (objectId: number): boolean => {
      const c = deps.clientRef.current;
      if (!c?.connected) return false;
      if (!c.playerData.teleportAllowed) {
        Logger.warn('Walking', 'teleportToBeacon: teleport not allowed in this map');
        return false;
      }
      const id = Math.trunc(objectId);
      const worldState = deps.getWorldStateForClient?.(c) ?? deps.worldState;
      const entity = worldState.getEntity(id);
      if (!entity || !deps.gameData.isTeleportBeacon(entity.objectType)) {
        Logger.warn('Walking', `teleportToBeacon: object ${objectId} is not a live teleport beacon`);
        return false;
      }
      try {
        const pkt = deps.proxy.packetFactory.createByName('TELEPORT');
        pkt.data.objectId = id;
        pkt.modified = true;
        c.sendToServer(pkt);
        return true;
      } catch (err) {
        Logger.warn('Walking', `teleportToBeacon: send failed — ${(err as Error).message}`);
        return false;
      }
    };
  }
}
