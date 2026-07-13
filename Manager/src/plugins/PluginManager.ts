/**
 * No-op PluginManager stub.
 * Bundled plugins and DLL-backed features were removed from the Manager.
 * DevServer still expects this surface for login/plan gates and empty plugin lists.
 */
import type { Proxy } from '../proxy/Proxy.js';

export type PluginCategory =
  | 'combat'
  | 'movement'
  | 'automation'
  | 'visual'
  | 'network'
  | 'utility'
  | 'admin';

export class PluginManager {
  loginGateActive = false;
  activePlans = new Set<string>();
  adminMode = false;

  constructor(
    _proxy: Proxy,
    _bundledPluginDir?: string,
    _userPluginDir?: string,
    _allowLocalDiskPlugins = true,
    ..._rest: unknown[]
  ) {}

  getPlugins(): {
    id: string;
    name: string;
    enabled: boolean;
    category: PluginCategory;
    settings: any[];
    source: 'bundled' | 'user';
    requiredPlan: string | null;
  }[] {
    return [];
  }

  getRequiredPlan(_pluginId: string): string | null {
    return null;
  }

  setActivePlans(_planNames: string[]): void {
    this.activePlans = new Set();
  }

  togglePlugin(_pluginId: string, _enabled: boolean): { ok: boolean; reason?: string; requiredPlan?: string } {
    return { ok: false, reason: 'Plugins have been removed from this build.' };
  }

  disableAllPlugins(): void {}
  disableAdminGatedPlugins(): void {}
  enforceNonAdminSettingCaps(): void {}
  disableGemGatedPlugins(): void {}

  onDashboardLog(_listener: (pluginName: string, message: string) => void): () => void {
    return () => {};
  }

  getPluginData<T = any>(_pluginId: string, _key: string): T | undefined {
    return undefined;
  }

  onBroadcastData(_listener: (pluginId: string, type: string, data: any) => void): () => void {
    return () => {};
  }

  updateSetting(_pluginId: string, _key: string, _value: any): boolean {
    return false;
  }

  resetPluginSettings(_pluginId: string): string[] {
    return [];
  }

  async loadAll(): Promise<void> {}
  async loadPlugin(_filePath: string, _source: 'bundled' | 'user' = 'bundled'): Promise<void> {}
  async unloadPlugin(_pluginId: string): Promise<void> {}
  async loadPluginFromCode(_id: string, _code: string): Promise<void> {}
  async loadFromApi(_apiBaseUrl: string, _accessToken: string): Promise<number> {
    return 0;
  }
  async startWatching(): Promise<void> {}
  stopWatching(): void {}
}
