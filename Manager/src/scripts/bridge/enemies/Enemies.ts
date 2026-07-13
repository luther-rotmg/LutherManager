import { Enemies } from '@hive/sdk';
import type { Enemy } from '@hive/sdk';
import type { Position } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { warnUnimplemented } from '../stubWarn.js';

export class BridgeEnemies {
  static install(_deps: BridgeDeps): void {
    Enemies.getAll = (): Enemy[] => {
      warnUnimplemented('Enemies.getAll');
      return [];
    };
    Enemies.getNearest = (): Enemy | null => {
      warnUnimplemented('Enemies.getNearest');
      return null;
    };
    Enemies.getNearestTo = (_position: Position): Enemy | null => {
      warnUnimplemented('Enemies.getNearestTo');
      return null;
    };
    Enemies.getBoss = (): Enemy | null => {
      warnUnimplemented('Enemies.getBoss');
      return null;
    };
    Enemies.getTargetingMe = (): Enemy[] => {
      warnUnimplemented('Enemies.getTargetingMe');
      return [];
    };
    Enemies.find = (_name: string): Enemy | null => {
      warnUnimplemented('Enemies.find');
      return null;
    };
    Enemies.count = () => {
      warnUnimplemented('Enemies.count');
      return 0;
    };
    Enemies.getById = (_objectId: number) => {
      warnUnimplemented('Enemies.getById');
      return null;
    };
    Enemies.getByType = (_objectType: number): Enemy[] => {
      warnUnimplemented('Enemies.getByType');
      return [];
    };
  }
}
