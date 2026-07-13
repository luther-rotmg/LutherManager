import type { BridgeDeps } from '../BridgeDeps.js';
import { ScriptPanelRegistry } from './ScriptPanels.js';

/**
 * Wired to ScriptHost activity → dashboard script cards (`Hive.ui.status`,
 * legacy `ScriptUi.setActivity`). Also installs `Hive.ui.panel` so
 * scripts can declare a centered popout UI rendered by the dashboard.
 */
export function installScriptUiBridge(deps: BridgeDeps): ScriptPanelRegistry {
  const registry = new ScriptPanelRegistry(deps);

  const bag = (globalThis as unknown as { __hiveSDK?: Record<string, unknown> }).__hiveSDK;
  if (!bag) {
    console.error('[ScriptUiBridge] DIAG: globalThis.__hiveSDK missing — cannot patch Hive.ui');
    return registry;
  }

  function applyActivityLabel(label: string | null | undefined): void {
    const normalized =
      label == null || typeof label !== 'string' ? null : label.trim();
    deps.setScriptActivityLabel?.(!normalized ? null : normalized);
  }

  bag.ScriptUi = {
    setActivity: applyActivityLabel,
  };

  const re = bag.Hive as Record<string, unknown> | undefined;
  console.error('[ScriptUiBridge] DIAG: bag.Hive present=%s typeof=%s sameAsBagChat=%s',
    !!re, typeof re, bag.chat != null);
  if (re && typeof re === 'object') {
    // Patch in-place on the existing `ui` object rather than replacing it.
    // Replacing would leave any caller that captured `Hive.ui` before
    // the bridge ran holding a stale reference; mutating ensures all reads
    // (now or later) see the patched methods.
    const existingUi = re.ui as Record<string, unknown> | undefined;
    const ui = (existingUi && typeof existingUi === 'object') ? existingUi : (re.ui = {} as Record<string, unknown>);

    ui.status = function status(label: string | null | undefined): void {
      applyActivityLabel(label);
    };
    ui.setStatus = function setStatus(label: string | null | undefined): void {
      applyActivityLabel(label);
    };

    const existingPanel = ui.panel as Record<string, unknown> | undefined;
    const panel = (existingPanel && typeof existingPanel === 'object') ? existingPanel : (ui.panel = {} as Record<string, unknown>);
    panel.define = (def: Parameters<ScriptPanelRegistry['define']>[0]) => registry.define(def);

    // DIAG: verify the patch landed on the object the script will read.
    const readBack = (bag.Hive as { ui?: { status?: unknown; panel?: { define?: unknown } } }).ui;
    console.error('[ScriptUiBridge] DIAG: patched. readBack ui.status patched=%s panel.define patched=%s sameObj=%s',
      typeof readBack?.status === 'function' && readBack.status === ui.status,
      typeof readBack?.panel?.define === 'function' && readBack.panel.define === panel.define,
      readBack === ui);
  } else {
    console.error('[ScriptUiBridge] DIAG: bag.Hive not an object — ui NOT patched');
  }

  return registry;
}
