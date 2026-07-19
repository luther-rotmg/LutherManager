import {
  Combat,
  type AutoAbilityOptions,
  type AutoAimMode,
  type AutoAimOptions,
  type CombatAimTarget,
  type Enemy,
} from '@luthermanager/sdk';
import type { Client } from 'headless-client';
import type { BridgeDeps } from '../BridgeDeps.js';

function active(deps: BridgeDeps): Client {
  const client = deps.getHeadlessClient?.();
  if (!client) throw new Error('No headless client is bound to this script instance.');
  return client;
}

function optional(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

function objectId(target: CombatAimTarget): number {
  return typeof target === 'number' ? target : target.objectId;
}

export function installHeadlessCombatBridge(deps: BridgeDeps): void {
  Combat.shootAt = (x, y, weaponSlot = 0) => active(deps).shootAt({ x, y }, weaponSlot);
  Combat.aimAt = (target) => active(deps).aimAt(objectId(target));
  Combat.aimAtPosition = (x, y) => active(deps).aimAtPosition(x, y);
  Combat.stopAiming = () => active(deps).stopAiming();
  Combat.enableAutoAim = (options?: AutoAimOptions) => active(deps).enableAutoAim(options);
  Combat.setAutoAim = (options: AutoAimMode | AutoAimOptions) => active(deps).configureAutoAim(options);
  Combat.disableAutoAim = () => active(deps).stopAiming();
  Combat.autoAimOff = Combat.disableAutoAim;
  Combat.getAutoAimTarget = () => optional(deps)?.getAutoCombatState()?.targetObjectId ?? null;
  Combat.getAutomationState = () => optional(deps)?.getAutoCombatState() ?? null;

  Combat.useAbility = () => active(deps).useAbility();
  Combat.useAbilityAt = (x, y) => active(deps).useAbilityAt({ x, y });
  Combat.useAbilityOn = (enemy: Enemy) => active(deps).useAbilityAt({
    x: enemy.position.x,
    y: enemy.position.y,
  });
  Combat.enableAutoAbility = (options?: AutoAbilityOptions) => active(deps).enableAutoAbility(options);
  Combat.setAutoAbility = (options: AutoAbilityOptions) => active(deps).configureAutoAbility(options);
  Combat.disableAutoAbility = () => active(deps).disableAutoAbility();

  Combat.enableProjectileNoclip = () => active(deps).enableProjectileNoclip();
  Combat.disableProjectileNoclip = () => active(deps).disableProjectileNoclip();
  Combat.isProjectileNoclipEnabled = () => optional(deps)?.isProjectileNoclipEnabled() ?? false;

  Combat.accuracy = () => optional(deps)?.accuracy() ?? 0;
  Combat.recentAccuracy = (minutes) => optional(deps)?.recentAccuracy(minutes) ?? 0;
  Combat.resetAccuracy = () => active(deps).resetAccuracy();
}
