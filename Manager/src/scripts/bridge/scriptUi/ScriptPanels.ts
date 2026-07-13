import type {
  BridgeDeps,
  ScriptPanelInboundEvent,
  ScriptPanelOutboundMessage,
  ScriptPanelPatch,
} from '../BridgeDeps.js';
import type {
  PanelDefinition,
  PanelHandle,
  PanelWidget,
} from '@hive/sdk';

/**
 * Walks a widget tree, strips function-valued fields, and collects per-id
 * handlers so the dashboard can dispatch widget events back to the script.
 */
function extractHandlers(
  widgets: PanelWidget[],
  handlers: Map<string, { onClick?: () => void; onChange?: (v: unknown) => void }>,
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
      if (entry.onClick || entry.onChange) handlers.set(id, entry);
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

interface StoredPanel {
  scriptId: string;
  def: PanelDefinition;
  handlers: Map<string, { onClick?: () => void; onChange?: (v: unknown) => void }>;
  isOpen: boolean;
}

/**
 * Process-wide registry of script panels. One panel per script id.
 * Re-calling `define` for the same script replaces the existing panel.
 */
export class ScriptPanelRegistry {
  private deps: BridgeDeps;
  private panels = new Map<string, StoredPanel>();

  constructor(deps: BridgeDeps) {
    this.deps = deps;
  }

  /** Resolve the script id at the moment the SDK call runs. */
  private currentScriptId(): string | undefined {
    const sid = this.deps.scriptSession.scriptId;
    return sid && String(sid).trim() ? String(sid).trim() : undefined;
  }

  private emit(msg: ScriptPanelOutboundMessage): void {
    try {
      this.deps.emitScriptPanelMessage?.(msg);
    } catch {
      /* DevServer not attached yet — drop silently. */
    }
  }

  private serializableDef(stored: StoredPanel): unknown {
    return {
      title: stored.def.title,
      subtitle: stored.def.subtitle,
      width: stored.def.width,
      autoOpen: stored.def.autoOpen,
      widgets: stored.def.widgets,
    };
  }

  /** Implementation of `Hive.ui.panel.define`. */
  define(def: PanelDefinition): PanelHandle {
    const scriptId = this.currentScriptId();
    if (!scriptId) {
      throw new Error(
        'Hive.ui.panel.define must be called from a script (onStart/onLoop/onStop).',
      );
    }

    const handlers = new Map<string, { onClick?: () => void; onChange?: (v: unknown) => void }>();
    const widgets = extractHandlers(def.widgets ?? [], handlers);

    const stored: StoredPanel = {
      scriptId,
      def: { ...def, widgets },
      handlers,
      isOpen: false,
    };
    this.panels.set(scriptId, stored);

    this.emit({
      type: 'scriptPanelState',
      scriptId,
      def: this.serializableDef(stored),
      isOpen: stored.isOpen,
    });

    if (def.autoOpen) {
      stored.isOpen = true;
      this.emit({ type: 'scriptPanelOpen', scriptId });
    }

    const self = this;
    const handle: PanelHandle = {
      get isOpen() { return stored.isOpen; },
      open() {
        if (stored.isOpen) return;
        stored.isOpen = true;
        self.emit({ type: 'scriptPanelOpen', scriptId });
      },
      close() {
        if (!stored.isOpen) return;
        stored.isOpen = false;
        self.emit({ type: 'scriptPanelClose', scriptId });
      },
      update(patch: Partial<PanelDefinition>) {
        const merged: PanelDefinition = { ...stored.def, ...patch };
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
          def: self.serializableDef(stored),
          isOpen: stored.isOpen,
        });
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
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'value', id, value } as ScriptPanelPatch] });
      },
      setImage(id, src) {
        const w = findWidget(stored.def.widgets, id) as { src?: string } | undefined;
        if (w) w.src = String(src);
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'image', id, value: String(src) } as ScriptPanelPatch] });
      },
      setText(id, text) {
        const w = findWidget(stored.def.widgets, id) as unknown as Record<string, unknown> | undefined;
        if (w) {
          // Apply to whichever text-bearing field the widget has.
          if ('text' in w) (w as { text?: unknown }).text = text;
          if ('label' in w) (w as { label?: unknown }).label = text;
          if ('caption' in w) (w as { caption?: unknown }).caption = text;
        }
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'text', id, value: String(text) }] });
      },
      setEnabled(id, enabled) {
        const w = findWidget(stored.def.widgets, id) as { enabled?: boolean } | undefined;
        if (w) w.enabled = !!enabled;
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'enabled', id, value: !!enabled }] });
      },
      setVisible(id, visible) {
        const w = findWidget(stored.def.widgets, id) as { visible?: boolean } | undefined;
        if (w) w.visible = !!visible;
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'visible', id, value: !!visible }] });
      },
      appendLog(id, line) {
        const w = findWidget(stored.def.widgets, id) as { type?: string; lines?: string[]; maxLines?: number } | undefined;
        if (w && w.type === 'log') {
          const lines = Array.isArray(w.lines) ? w.lines : (w.lines = []);
          lines.push(String(line));
          const cap = typeof w.maxLines === 'number' && w.maxLines > 0 ? w.maxLines : 200;
          if (lines.length > cap) lines.splice(0, lines.length - cap);
        }
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'log-append', id, value: String(line) }] });
      },
      setLog(id, lines) {
        const arr = Array.isArray(lines) ? lines.map((s) => String(s)) : [];
        const w = findWidget(stored.def.widgets, id) as { type?: string; lines?: string[] } | undefined;
        if (w && w.type === 'log') w.lines = arr.slice();
        self.emit({ type: 'scriptPanelPatches', scriptId, patches: [{ op: 'log-set', id, value: arr }] });
      },
    };
    return handle;
  }

  /** DevServer routes widget events back into the right script handler. */
  dispatchEvent(evt: ScriptPanelInboundEvent, runInScript: (id: string, fn: () => void) => void): void {
    const stored = this.panels.get(evt.scriptId);
    if (!stored) return;

    if (evt.kind === 'closed-by-user') {
      if (stored.isOpen) stored.isOpen = false;
      return;
    }

    const entry = stored.handlers.get(evt.widgetId);
    if (!entry) return;

    // Mirror the value into the cached widget so future open() reflects it.
    if (evt.kind === 'change') {
      const w = findWidget(stored.def.widgets, evt.widgetId) as { value?: unknown } | undefined;
      if (w) w.value = evt.value;
    }

    runInScript(evt.scriptId, () => {
      try {
        if (evt.kind === 'click') entry.onClick?.();
        else if (evt.kind === 'change') entry.onChange?.(evt.value);
      } catch (err) {
        // Don't let widget handlers tear down the bridge — surface via script log.
        const line = err instanceof Error ? err.stack || err.message : String(err);
        this.deps.emitScriptLog(evt.scriptId, `Panel handler error: ${line}`, 'error');
      }
    });
  }

  /** Called when a script stops — removes its panel and notifies the dashboard. */
  destroyForScript(scriptId: string): void {
    if (!this.panels.has(scriptId)) return;
    this.panels.delete(scriptId);
    this.emit({ type: 'scriptPanelState', scriptId, def: null, isOpen: false });
  }

  /** Snapshot of a panel (for dashboard reconnects). */
  snapshot(scriptId: string): { def: unknown; isOpen: boolean } | undefined {
    const stored = this.panels.get(scriptId);
    if (!stored) return undefined;
    return { def: this.serializableDef(stored), isOpen: stored.isOpen };
  }

  /** All script ids that currently have a panel registered. */
  scriptIds(): string[] {
    return [...this.panels.keys()];
  }
}
