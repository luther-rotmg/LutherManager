import type {
  BridgeDeps,
  ScriptPanelInboundEvent,
  ScriptPanelOutboundMessage,
  ScriptPanelPatch,
} from '../BridgeDeps.js';
import type {
  PanelConfigInfo,
  PanelConfigScope,
  PanelDefinition,
  PanelHandle,
  PanelPersistenceOptions,
  SearchOption,
  PanelWidget,
} from '@luthermanager/sdk';
import { ScriptPanelConfigStore } from './ScriptPanelConfigStore.js';

interface WidgetHandlers {
  onClick?: () => void;
  onChange?: (value: unknown) => void;
  onSubmit?: (value: string) => void;
  onSelect?: (value: string) => void;
}

/**
 * Walks a widget tree, strips function-valued fields, and collects per-id
 * handlers so the dashboard can dispatch widget events back to the script.
 */
function extractHandlers(
  widgets: PanelWidget[],
  handlers: Map<string, WidgetHandlers>,
): PanelWidget[] {
  return widgets.map((w) => {
    const next: Record<string, unknown> = { ...(w as unknown as Record<string, unknown>) };
    const id = typeof (w as { id?: unknown }).id === 'string' ? String((w as { id: string }).id) : undefined;
    if (id) {
      const entry = handlers.get(id) ?? {};
      if (typeof (next as { onClick?: unknown }).onClick === 'function') {
        entry.onClick = (next as { onClick: () => void }).onClick;
        delete (next as { onClick?: unknown }).onClick;
      }
      if (typeof (next as { onChange?: unknown }).onChange === 'function') {
        entry.onChange = (next as { onChange: (v: unknown) => void }).onChange;
        delete (next as { onChange?: unknown }).onChange;
      }
      if (typeof (next as { onSubmit?: unknown }).onSubmit === 'function') {
        entry.onSubmit = (next as { onSubmit: (v: string) => void }).onSubmit;
        delete (next as { onSubmit?: unknown }).onSubmit;
      }
      if (typeof (next as { onSelect?: unknown }).onSelect === 'function') {
        entry.onSelect = (next as { onSelect: (v: string) => void }).onSelect;
        delete (next as { onSelect?: unknown }).onSelect;
      }
      if (entry.onClick || entry.onChange || entry.onSubmit || entry.onSelect) handlers.set(id, entry);
    }
    const children = (w as { children?: PanelWidget[] }).children;
    if (Array.isArray(children)) {
      (next as { children?: PanelWidget[] }).children = extractHandlers(children, handlers);
    }
    const tabs = (w as unknown as { tabs?: { children?: PanelWidget[] }[] }).tabs;
    if (Array.isArray(tabs)) {
      (next as unknown as { tabs?: { children?: PanelWidget[] }[] }).tabs = tabs.map((tab) => ({
        ...tab,
        children: Array.isArray(tab.children) ? extractHandlers(tab.children, handlers) : [],
      }));
    }
    return next as unknown as PanelWidget;
  });
}

function findWidget(widgets: PanelWidget[] | undefined, id: string): PanelWidget | undefined {
  if (!widgets) return undefined;
  for (const w of widgets) {
    if ((w as { id?: unknown }).id === id) return w;
    const children = (w as { children?: PanelWidget[] }).children;
    if (children) {
      const hit = findWidget(children, id);
      if (hit) return hit;
    }
    const tabs = (w as unknown as { tabs?: { children?: PanelWidget[] }[] }).tabs;
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        const hit = findWidget(tab.children, id);
        if (hit) return hit;
      }
    }
  }
  return undefined;
}

const DEFAULT_PERSISTED_WIDGET_TYPES = new Set(['toggle', 'slider', 'number', 'text', 'select']);

function visitWidgets(widgets: PanelWidget[] | undefined, visit: (widget: PanelWidget) => void): void {
  for (const widget of widgets ?? []) {
    visit(widget);
    const children = (widget as { children?: PanelWidget[] }).children;
    if (Array.isArray(children)) visitWidgets(children, visit);
    const tabs = (widget as unknown as { tabs?: { children?: PanelWidget[] }[] }).tabs;
    if (Array.isArray(tabs)) {
      for (const tab of tabs) visitWidgets(tab.children, visit);
    }
  }
}

function isPersistedWidget(widget: PanelWidget): boolean {
  const record = widget as unknown as Record<string, unknown>;
  if (record.persist === false || typeof record.id !== 'string' || !('value' in record)) return false;
  return record.persist === true || DEFAULT_PERSISTED_WIDGET_TYPES.has(String(record.type));
}

function safeConfigValue(value: unknown): unknown | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined;
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || serialized.length > 262_144) return undefined;
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}

function collectConfigValues(widgets: PanelWidget[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  visitWidgets(widgets, (widget) => {
    if (!isPersistedWidget(widget)) return;
    const record = widget as unknown as Record<string, unknown>;
    const value = safeConfigValue(record.value);
    if (value !== undefined) values[String(record.id)] = value;
  });
  return values;
}

interface NormalizedPersistence {
  enabled: boolean;
  autoSave: boolean;
  autoLoad: boolean;
  config: string;
  scope: PanelConfigScope;
}

function normalizePersistence(options?: PanelPersistenceOptions): NormalizedPersistence {
  return {
    enabled: options !== undefined,
    autoSave: options?.autoSave === true,
    autoLoad: options?.autoLoad !== false,
    config: String(options?.config || '').trim() || 'default',
    scope: options?.scope === 'account' ? 'account' : 'script',
  };
}

interface StoredPanel {
  scriptId: string;
  accountId?: string;
  def: PanelDefinition;
  handlers: Map<string, WidgetHandlers>;
  persistence: NormalizedPersistence;
  activeConfig: string;
  autoSaveTimer?: NodeJS.Timeout;
  isOpen: boolean;
}

/**
 * Process-wide registry of script panels. Account-bound runs of the same
 * script each own a panel; unbound runs retain the legacy script-id identity.
 */
export class ScriptPanelRegistry {
  private deps: BridgeDeps;
  private panels = new Map<string, StoredPanel>();
  private configStore: ScriptPanelConfigStore;

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.configStore = new ScriptPanelConfigStore(deps.scriptPanelConfigDir);
  }

  private panelKey(scriptId: string, accountId?: string): string {
    const account = String(accountId ?? '').trim();
    return account ? `${scriptId}\u0000${account}` : scriptId;
  }

  private panelsForScript(scriptId: string): StoredPanel[] {
    return [...this.panels.values()].filter((stored) => stored.scriptId === scriptId);
  }

  private currentSession(): { scriptId: string; accountId?: string } | undefined {
    const session = this.deps.getScriptSession?.() ?? this.deps.scriptSession;
    const scriptId = String(session.scriptId || '').trim();
    return scriptId ? { scriptId, accountId: session.accountId } : undefined;
  }

  private emit(msg: ScriptPanelOutboundMessage): void {
    try {
      this.deps.emitScriptPanelMessage?.(msg);
    } catch {
      /* DevServer not attached yet — drop silently. */
    }
  }

  private reportConfigError(stored: StoredPanel, action: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.deps.emitScriptLog(stored.scriptId, `Panel config ${action} failed: ${detail}`, 'error');
  }

  private applyConfigValues(stored: StoredPanel, values: Record<string, unknown>): Record<string, unknown> {
    const applied: Record<string, unknown> = {};
    for (const [id, rawValue] of Object.entries(values)) {
      const widget = findWidget(stored.def.widgets, id);
      if (!widget || !isPersistedWidget(widget)) continue;
      const value = safeConfigValue(rawValue);
      if (value === undefined) continue;
      (widget as unknown as { value?: unknown }).value = value;
      applied[id] = value;
    }
    return applied;
  }

  private invokeConfigHandlers(stored: StoredPanel, values: Record<string, unknown>): void {
    const invoke = () => {
      for (const [id, value] of Object.entries(values)) {
        try {
          stored.handlers.get(id)?.onChange?.(value);
        } catch (error) {
          const detail = error instanceof Error ? error.stack || error.message : String(error);
          this.deps.emitScriptLog(stored.scriptId, `Panel config handler error: ${detail}`, 'error');
        }
      }
    };
    const session = { scriptId: stored.scriptId, accountId: stored.accountId };
    if (this.deps.runInScriptSession) this.deps.runInScriptSession(session, invoke);
    else invoke();
  }

  private readConfig(stored: StoredPanel, name: string): Record<string, unknown> | null {
    const config = this.configStore.load(
      stored.scriptId,
      stored.persistence.scope,
      stored.accountId,
      name,
    );
    if (!config) return null;
    stored.activeConfig = config.name;
    return this.applyConfigValues(stored, config.values);
  }

  private saveStoredConfig(stored: StoredPanel, name = stored.activeConfig): PanelConfigInfo {
    const info = this.configStore.save(
      stored.scriptId,
      stored.persistence.scope,
      stored.accountId,
      name,
      collectConfigValues(stored.def.widgets),
    );
    stored.activeConfig = info.name;
    return info;
  }

  private scheduleAutoSave(stored: StoredPanel): void {
    if (!stored.persistence.enabled || !stored.persistence.autoSave) return;
    if (stored.autoSaveTimer) clearTimeout(stored.autoSaveTimer);
    stored.autoSaveTimer = setTimeout(() => {
      stored.autoSaveTimer = undefined;
      try {
        this.saveStoredConfig(stored);
      } catch (error) {
        this.reportConfigError(stored, 'autosave', error);
      }
    }, 150);
  }

  private flushAutoSave(stored: StoredPanel): void {
    if (!stored.autoSaveTimer) return;
    clearTimeout(stored.autoSaveTimer);
    stored.autoSaveTimer = undefined;
    try {
      this.saveStoredConfig(stored);
    } catch (error) {
      this.reportConfigError(stored, 'autosave', error);
    }
  }

  private serializableDef(stored: StoredPanel): unknown {
    return {
      title: stored.def.title,
      subtitle: stored.def.subtitle,
      width: stored.def.width,
      maxHeight: stored.def.maxHeight,
      density: stored.def.density,
      theme: stored.def.theme,
      autoOpen: stored.def.autoOpen,
      widgets: stored.def.widgets,
    };
  }

  /** Implementation of `Luther.ui.panel.define`. */
  define(def: PanelDefinition): PanelHandle {
    const session = this.currentSession();
    if (!session) {
      throw new Error(
        'Luther.ui.panel.define must be called from a script (onStart/onLoop/onStop).',
      );
    }
    const { scriptId, accountId } = session;
    const panelKey = this.panelKey(scriptId, accountId);

    const previous = this.panels.get(panelKey);
    if (previous) this.flushAutoSave(previous);

    const handlers = new Map<string, WidgetHandlers>();
    const widgets = extractHandlers(def.widgets ?? [], handlers);

    const stored: StoredPanel = {
      scriptId,
      accountId,
      def: { ...def, widgets },
      handlers,
      persistence: normalizePersistence(def.persistence),
      activeConfig: String(def.persistence?.config || '').trim() || 'default',
      isOpen: false,
    };
    this.panels.set(panelKey, stored);

    const restoredValues = stored.persistence.enabled && stored.persistence.autoLoad
      ? this.readConfig(stored, stored.activeConfig)
      : null;

    this.emit({
      type: 'scriptPanelState',
      scriptId,
      accountId,
      def: this.serializableDef(stored),
      isOpen: stored.isOpen,
    });

    if (def.autoOpen) {
      stored.isOpen = true;
      this.emit({ type: 'scriptPanelOpen', scriptId, accountId });
    }

    if (restoredValues && Object.keys(restoredValues).length > 0) {
      queueMicrotask(() => {
        if (this.panels.get(panelKey) === stored) this.invokeConfigHandlers(stored, restoredValues);
      });
    }

    const self = this;
    const handle: PanelHandle = {
      get isOpen() { return stored.isOpen; },
      get activeConfig() { return stored.activeConfig; },
      open() {
        if (stored.isOpen) return;
        stored.isOpen = true;
        self.emit({ type: 'scriptPanelOpen', scriptId, accountId });
      },
      close() {
        if (!stored.isOpen) return;
        stored.isOpen = false;
        self.emit({ type: 'scriptPanelClose', scriptId, accountId });
      },
      update(patch: Partial<PanelDefinition>) {
        const merged: PanelDefinition = { ...stored.def, ...patch };
        if (patch.persistence !== undefined) {
          stored.persistence = normalizePersistence(patch.persistence);
          stored.activeConfig = stored.persistence.config;
        }
        if (patch.widgets) {
          // Re-extract handlers from the new tree; preserve existing ones for ids
          // that still exist (entries get overwritten naturally by extractHandlers).
          const newHandlers = new Map(stored.handlers);
          merged.widgets = extractHandlers(patch.widgets, newHandlers);
          stored.handlers = newHandlers;
        }
        stored.def = merged;
        self.emit({
          type: 'scriptPanelState',
          scriptId,
          accountId,
          def: self.serializableDef(stored),
          isOpen: stored.isOpen,
        });
        self.scheduleAutoSave(stored);
      },
      setValue(id, value) {
        const w = findWidget(stored.def.widgets, id) as { value?: unknown } | undefined;
        if (w) {
          if ((w as { type?: unknown }).type === 'item') {
            (w as unknown as { item?: unknown }).item = value;
          } else if ((w as { type?: unknown }).type === 'itemGrid') {
            (w as unknown as { items?: unknown }).items = value;
          } else {
            w.value = value;
          }
        }
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'value', id, value } as ScriptPanelPatch] });
        if (w && isPersistedWidget(w as unknown as PanelWidget)) self.scheduleAutoSave(stored);
      },
      getValue<T = unknown>(id: string): T | undefined {
        const w = findWidget(stored.def.widgets, id) as unknown as Record<string, unknown> | undefined;
        if (!w) return undefined;
        if (w.type === 'item') return w.item as T;
        if (w.type === 'itemGrid') return w.items as T;
        return w.value as T | undefined;
      },
      setOptions(id, options) {
        const normalized = Array.isArray(options)
          ? options.map((option) => ({ ...option })) as SearchOption[]
          : [];
        const w = findWidget(stored.def.widgets, id) as unknown as { options?: unknown[] } | undefined;
        if (w) w.options = normalized;
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'options', id, value: normalized }] });
      },
      setProps(id, props) {
        const safe: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(props ?? {})) {
          if (key === 'id' || key === 'type' || key.startsWith('on') || typeof value === 'function') continue;
          safe[key] = value;
        }
        const w = findWidget(stored.def.widgets, id) as unknown as Record<string, unknown> | undefined;
        if (w) Object.assign(w, safe);
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'props', id, value: safe }] });
        if (w && 'value' in safe && isPersistedWidget(w as unknown as PanelWidget)) self.scheduleAutoSave(stored);
      },
      setImage(id, src) {
        const w = findWidget(stored.def.widgets, id) as { src?: string } | undefined;
        if (w) w.src = String(src);
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'image', id, value: String(src) } as ScriptPanelPatch] });
      },
      setText(id, text) {
        const w = findWidget(stored.def.widgets, id) as unknown as Record<string, unknown> | undefined;
        if (w) {
          // Apply to whichever text-bearing field the widget has.
          if ('text' in w) (w as { text?: unknown }).text = text;
          if ('label' in w) (w as { label?: unknown }).label = text;
          if ('caption' in w) (w as { caption?: unknown }).caption = text;
        }
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'text', id, value: String(text) }] });
      },
      setEnabled(id, enabled) {
        const w = findWidget(stored.def.widgets, id) as { enabled?: boolean } | undefined;
        if (w) w.enabled = !!enabled;
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'enabled', id, value: !!enabled }] });
      },
      setVisible(id, visible) {
        const w = findWidget(stored.def.widgets, id) as { visible?: boolean } | undefined;
        if (w) w.visible = !!visible;
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'visible', id, value: !!visible }] });
      },
      appendLog(id, line) {
        const w = findWidget(stored.def.widgets, id) as { type?: string; lines?: string[]; maxLines?: number } | undefined;
        if (w && w.type === 'log') {
          const lines = Array.isArray(w.lines) ? w.lines : (w.lines = []);
          lines.push(String(line));
          const cap = typeof w.maxLines === 'number' && w.maxLines > 0 ? w.maxLines : 200;
          if (lines.length > cap) lines.splice(0, lines.length - cap);
        }
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'log-append', id, value: String(line) }] });
      },
      setLog(id, lines) {
        const arr = Array.isArray(lines) ? lines.map((s) => String(s)) : [];
        const w = findWidget(stored.def.widgets, id) as { type?: string; lines?: string[] } | undefined;
        if (w && w.type === 'log') w.lines = arr.slice();
        self.emit({ type: 'scriptPanelPatches', scriptId, accountId, patches: [{ op: 'log-set', id, value: arr }] });
      },
      saveConfig(name) {
        try {
          return self.saveStoredConfig(stored, String(name || '').trim() || stored.activeConfig);
        } catch (error) {
          self.reportConfigError(stored, 'save', error);
          throw error;
        }
      },
      loadConfig(name) {
        const requested = String(name || '').trim() || stored.activeConfig;
        try {
          const values = self.readConfig(stored, requested);
          if (!values) return false;
          self.emit({
            type: 'scriptPanelState',
            scriptId,
            accountId,
            def: self.serializableDef(stored),
            isOpen: stored.isOpen,
          });
          self.invokeConfigHandlers(stored, values);
          return true;
        } catch (error) {
          self.reportConfigError(stored, 'load', error);
          return false;
        }
      },
      deleteConfig(name) {
        const requested = String(name || '').trim();
        if (!requested) return false;
        try {
          const deleted = self.configStore.delete(
            stored.scriptId,
            stored.persistence.scope,
            stored.accountId,
            requested,
          );
          if (deleted && stored.activeConfig === requested) stored.activeConfig = stored.persistence.config;
          return deleted;
        } catch (error) {
          self.reportConfigError(stored, 'delete', error);
          return false;
        }
      },
      listConfigs() {
        try {
          return self.configStore.list(stored.scriptId, stored.persistence.scope, stored.accountId);
        } catch (error) {
          self.reportConfigError(stored, 'list', error);
          return [];
        }
      },
    };
    return handle;
  }

  /** DevServer routes widget events back into the right script handler. */
  dispatchEvent(
    evt: ScriptPanelInboundEvent,
    runInScript: (id: string, accountId: string | undefined, fn: () => void) => void,
  ): void {
    const accountId = String(evt.accountId ?? '').trim() || undefined;
    const exact = this.panels.get(this.panelKey(evt.scriptId, accountId));
    const candidates = accountId ? [] : this.panelsForScript(evt.scriptId);
    const stored = exact ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!stored) return;

    if (evt.kind === 'closed-by-user') {
      if (stored.isOpen) stored.isOpen = false;
      return;
    }

    // Mirror the value into the cached widget so future open() reflects it.
    if (evt.kind === 'change' || evt.kind === 'select') {
      const w = findWidget(stored.def.widgets, evt.widgetId);
      if (w) {
        (w as unknown as { value?: unknown }).value = evt.value;
        if (isPersistedWidget(w)) this.scheduleAutoSave(stored);
      }
    }

    const entry = stored.handlers.get(evt.widgetId);
    if (!entry) return;

    runInScript(stored.scriptId, stored.accountId, () => {
      try {
        if (evt.kind === 'click') entry.onClick?.();
        else if (evt.kind === 'change') entry.onChange?.(evt.value);
        else if (evt.kind === 'submit') entry.onSubmit?.(String(evt.value ?? ''));
        else if (evt.kind === 'select') entry.onSelect?.(String(evt.value ?? ''));
      } catch (err) {
        // Don't let widget handlers tear down the bridge — surface via script log.
        const line = err instanceof Error ? err.stack || err.message : String(err);
        this.deps.emitScriptLog(evt.scriptId, `Panel handler error: ${line}`, 'error');
      }
    });
  }

  /** Called when a script stops — removes its panel and notifies the dashboard. */
  destroyForScript(scriptId: string, accountId?: string): void {
    const account = String(accountId ?? '').trim() || undefined;
    const targets = account
      ? [this.panels.get(this.panelKey(scriptId, account))].filter((panel): panel is StoredPanel => !!panel)
      : this.panelsForScript(scriptId);
    for (const stored of targets) {
      this.flushAutoSave(stored);
      this.panels.delete(this.panelKey(stored.scriptId, stored.accountId));
      this.emit({
        type: 'scriptPanelState',
        scriptId: stored.scriptId,
        accountId: stored.accountId,
        def: null,
        isOpen: false,
      });
    }
  }

  /** Snapshot of a panel (for dashboard reconnects). */
  snapshot(scriptId: string, accountId?: string): { def: unknown; isOpen: boolean } | undefined {
    const stored = this.panels.get(this.panelKey(scriptId, accountId));
    if (!stored) return undefined;
    return { def: this.serializableDef(stored), isOpen: stored.isOpen };
  }

  /** All account-bound panel identities currently registered. */
  instances(): Array<{ scriptId: string; accountId?: string }> {
    return [...this.panels.values()].map(({ scriptId, accountId }) => ({ scriptId, accountId }));
  }
}
