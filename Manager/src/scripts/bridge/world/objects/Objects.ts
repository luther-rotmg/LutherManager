import { Objects, Position } from '@hive/sdk';
import type {
  GameObject,
  Enemy,
  PlayerEntity,
  Portal,
  Container,
  ObjectCategory,
} from '@hive/sdk';
import type { BridgeDeps } from '../../BridgeDeps.js';
import { warnUnimplemented } from '../../stubWarn.js';

export class BridgeObjects {
  static install(deps: BridgeDeps): void {
    // ─── Basic lookup ─────────────────────────────────────────────────────
    Objects.getAll = (): GameObject[] => {
      warnUnimplemented('Objects.getAll');
      return [];
    };
    Objects.getById = (_objectId: number): GameObject | null => {
      warnUnimplemented('Objects.getById');
      return null;
    };
    Objects.getByType = (_objectType: number): GameObject[] => {
      warnUnimplemented('Objects.getByType');
      return [];
    };
    Objects.count = (): number => {
      warnUnimplemented('Objects.count');
      return 0;
    };
    Objects.exists = (_objectId: number): boolean => {
      warnUnimplemented('Objects.exists');
      return false;
    };

    // ─── By category ──────────────────────────────────────────────────────
    Objects.getByCategory = (_category: ObjectCategory): GameObject[] => {
      warnUnimplemented('Objects.getByCategory');
      return [];
    };
    Objects.getEnemies = (): Enemy[] => {
      warnUnimplemented('Objects.getEnemies');
      return [];
    };
    Objects.getPlayers = (): PlayerEntity[] => {
      warnUnimplemented('Objects.getPlayers');
      return [];
    };
    Objects.getPortals = (): Portal[] => {
      warnUnimplemented('Objects.getPortals');
      return [];
    };
    Objects.getContainers = (): Container[] => {
      warnUnimplemented('Objects.getContainers');
      return [];
    };
    Objects.getPets = (): GameObject[] => {
      warnUnimplemented('Objects.getPets');
      return [];
    };
    Objects.getBeacons = (): GameObject[] => {
      warnUnimplemented('Objects.getBeacons');
      return [];
    };

    Objects.getQuestObject = (): GameObject | null => {
      const c = deps.clientRef.current;
      if (!c) return null;
      const questOid = c.playerData.questObjectId;
      if (questOid <= 0) return null;
      const entity = deps.worldState.getEntity(questOid);
      if (!entity) return null;
      const def = deps.gameData.getObject(entity.objectType);
      return {
        objectId: entity.objectId,
        objectType: entity.objectType,
        name: def?.displayId ?? def?.id ?? '',
        position: new Position(entity.pos.x, entity.pos.y),
      };
    };

    Objects.getQuestTargetId = (): number => {
      const c = deps.clientRef.current;
      const raw = c?.playerData?.questObjectId;
      const id = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(id) && id > 0 ? Math.trunc(id) : -1;
    };

    Objects.getQuestTargetType = (): number => {
      const c = deps.clientRef.current;
      if (!c) return -1;
      const qid = Number(c.playerData.questObjectId);
      if (!(qid > 0)) return -1;
      const resolved = deps.worldState.resolveQuestTargetObjectType(qid, deps.gameData);
      return resolved != null && resolved > 0 ? resolved : -1;
    };

    Objects.getQuestId = Objects.getQuestTargetId;
    Objects.getQuestType = Objects.getQuestTargetType;

    // ─── Spatial ──────────────────────────────────────────────────────────
    Objects.getNearest = (): GameObject | null => {
      warnUnimplemented('Objects.getNearest');
      return null;
    };
    Objects.getNearestTo = (_position: Position): GameObject | null => {
      warnUnimplemented('Objects.getNearestTo');
      return null;
    };
    Objects.getNearestOfType = (_objectType: number): GameObject | null => {
      warnUnimplemented('Objects.getNearestOfType');
      return null;
    };
    Objects.getNearestOfCategory = (_category: ObjectCategory): GameObject | null => {
      warnUnimplemented('Objects.getNearestOfCategory');
      return null;
    };
    Objects.getWithinRadius = (_radius: number): GameObject[] => {
      warnUnimplemented('Objects.getWithinRadius');
      return [];
    };
    Objects.getWithinRadiusFrom = (_position: Position, _radius: number): GameObject[] => {
      warnUnimplemented('Objects.getWithinRadiusFrom');
      return [];
    };
    Objects.getWithinBounds = (
      _minX: number,
      _minY: number,
      _maxX: number,
      _maxY: number,
    ): GameObject[] => {
      warnUnimplemented('Objects.getWithinBounds');
      return [];
    };
    Objects.sortByDistance = (): GameObject[] => {
      warnUnimplemented('Objects.sortByDistance');
      return [];
    };
    Objects.sortByDistanceFrom = (_position: Position): GameObject[] => {
      warnUnimplemented('Objects.sortByDistanceFrom');
      return [];
    };

    // ─── Name lookups ─────────────────────────────────────────────────────
    Objects.findByName = (_name: string): GameObject | null => {
      warnUnimplemented('Objects.findByName');
      return null;
    };
    Objects.findAllByName = (_name: string): GameObject[] => {
      warnUnimplemented('Objects.findAllByName');
      return [];
    };

    // ─── Portal helpers ───────────────────────────────────────────────────
    Objects.findPortal = (_name: string): Portal | null => {
      warnUnimplemented('Objects.findPortal');
      return null;
    };
    Objects.getNearestPortal = (): Portal | null => {
      warnUnimplemented('Objects.getNearestPortal');
      return null;
    };
    Objects.getOpenPortals = (): Portal[] => {
      warnUnimplemented('Objects.getOpenPortals');
      return [];
    };

    // ─── Container helpers ────────────────────────────────────────────────
    Objects.getNearestContainer = (): Container | null => {
      warnUnimplemented('Objects.getNearestContainer');
      return null;
    };
    Objects.findContainer = (_name: string): Container | null => {
      warnUnimplemented('Objects.findContainer');
      return null;
    };

    // ─── Introspection ────────────────────────────────────────────────────
    Objects.getCategory = (_objectType: number): ObjectCategory | null => {
      warnUnimplemented('Objects.getCategory');
      return null;
    };
    Objects.getTypeName = (_objectType: number): string => {
      warnUnimplemented('Objects.getTypeName');
      return '';
    };
    Objects.isEnemy = (_objectType: number): boolean => {
      warnUnimplemented('Objects.isEnemy');
      return false;
    };
    Objects.isPortal = (_objectType: number): boolean => {
      warnUnimplemented('Objects.isPortal');
      return false;
    };
    Objects.isContainer = (_objectType: number): boolean => {
      warnUnimplemented('Objects.isContainer');
      return false;
    };
    Objects.isBoss = (_objectType: number): boolean => {
      warnUnimplemented('Objects.isBoss');
      return false;
    };

    // ─── Presence ─────────────────────────────────────────────────────────
    Objects.hasType = (_objectType: number): boolean => {
      warnUnimplemented('Objects.hasType');
      return false;
    };
  }
}
