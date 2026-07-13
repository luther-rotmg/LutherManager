/**
 * Declarative UI panel that a script can show in the Hive dashboard.
 *
 * Scripts describe their UI as a tree of typed widgets — the dashboard
 * renders them inside a centered, themed popout (the same shape as the
 * Multi-Account popout). Interactive widgets carry handlers; the dashboard
 * dispatches events back over the existing script bridge.
 *
 * Usage:
 *
 *   const panel = Hive.ui.panel.define({
 *     title: 'My Bot',
 *     autoOpen: true,
 *     widgets: [
 *       Panel.heading('Combat'),
 *       Panel.toggle({ id: 'autoAttack', label: 'Auto-attack', value: true,
 *         onChange: (v) => settings.autoAttack = v }),
 *       Panel.slider({ id: 'hpPct', label: 'Heal at HP %', value: 40, min: 0, max: 100,
 *         onChange: (v) => settings.healHpPct = v }),
 *       Panel.button({ id: 'nexus', label: 'Nexus now', variant: 'danger',
 *         onClick: () => Hive.self.nexus() }),
 *       Panel.log({ id: 'feed', maxLines: 200 }),
 *     ],
 *   });
 *
 *   // Later
 *   panel.setValue('hpPct', 55);
 *   panel.appendLog('feed', 'Healed at 40 hp');
 *   panel.close();
 */

export type PanelButtonVariant = 'primary' | 'secondary' | 'danger';
export type PanelHeadingLevel = 1 | 2 | 3;

interface BaseWidget {
  /** Required for widgets that emit events or are targeted by `setValue`/`setText`/etc. */
  id?: string;
  visible?: boolean;
  enabled?: boolean;
  tooltip?: string;
}

export interface GroupWidget extends BaseWidget {
  type: 'group';
  title?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  children: PanelWidget[];
}

export interface RowWidget extends BaseWidget {
  type: 'row';
  /** Optional column gap in pixels. */
  gap?: number;
  children: PanelWidget[];
}

export interface PanelTab {
  id: string;
  label: string;
  children: PanelWidget[];
}

export interface TabsWidget extends BaseWidget {
  type: 'tabs';
  id: string;
  tabs: PanelTab[];
  /** Active tab id. Defaults to the first tab. */
  value?: string;
  onChange?: (tabId: string) => void;
}

export interface HeadingWidget extends BaseWidget {
  type: 'heading';
  text: string;
  level?: PanelHeadingLevel;
}

export interface LabelWidget extends BaseWidget {
  type: 'label';
  text: string;
  muted?: boolean;
}

export interface ImageWidget extends BaseWidget {
  type: 'image';
  /** Image URL or data URL. Keep local script assets relative to your built .mjs output. */
  src: string;
  alt?: string;
  caption?: string;
  /** Square image size in pixels. Defaults to 40. */
  size?: number;
  /** Pixel art / sprite-sheet images should stay crisp. Defaults to true. */
  pixelated?: boolean;
}

export interface ItemSprite {
  /** RotMG object type id. -1/null renders an empty slot. */
  objectType: number;
  name?: string;
  objectTypeHex?: string;
  enchantIds?: number[];
  quantity?: number;
  label?: string;
}

export interface ItemWidget extends BaseWidget {
  type: 'item';
  item: ItemSprite | number | null;
  label?: string;
  /** Square slot size in pixels. Defaults to 40. */
  size?: number;
  showName?: boolean;
  showQuantity?: boolean;
  onClick?: () => void;
}

export interface ItemGridWidget extends BaseWidget {
  type: 'itemGrid';
  items: (ItemSprite | number | null)[];
  /** Fixed column count. If omitted, the grid auto-fits. */
  columns?: number;
  /** Square slot size in pixels. Defaults to 40. */
  size?: number;
  gap?: number;
  showNames?: boolean;
  showQuantities?: boolean;
}

export interface ButtonWidget extends BaseWidget {
  type: 'button';
  id: string;
  label: string;
  variant?: PanelButtonVariant;
  onClick?: () => void;
}

export interface ToggleWidget extends BaseWidget {
  type: 'toggle';
  id: string;
  label: string;
  value: boolean;
  onChange?: (value: boolean) => void;
}

export interface SliderWidget extends BaseWidget {
  type: 'slider';
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown next to the slider — e.g. '%', 'ms'. */
  unit?: string;
  onChange?: (value: number) => void;
}

export interface NumberWidget extends BaseWidget {
  type: 'number';
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
}

export interface TextWidget extends BaseWidget {
  type: 'text';
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  onChange?: (value: string) => void;
}

export interface SelectWidget extends BaseWidget {
  type: 'select';
  id: string;
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange?: (value: string) => void;
}

export interface ProgressWidget extends BaseWidget {
  type: 'progress';
  id: string;
  label?: string;
  /** 0..1. Values outside the range are clamped by the renderer. */
  value: number;
  caption?: string;
}

export interface LogWidget extends BaseWidget {
  type: 'log';
  id: string;
  lines?: string[];
  /** Defaults to 200. Older lines are dropped from the rendered view. */
  maxLines?: number;
}

export interface SpacerWidget extends BaseWidget {
  type: 'spacer';
  /** Height in pixels (default 8). */
  size?: number;
}

export type PanelWidget =
  | GroupWidget
  | RowWidget
  | TabsWidget
  | HeadingWidget
  | LabelWidget
  | ImageWidget
  | ItemWidget
  | ItemGridWidget
  | ButtonWidget
  | ToggleWidget
  | SliderWidget
  | NumberWidget
  | TextWidget
  | SelectWidget
  | ProgressWidget
  | LogWidget
  | SpacerWidget;

export interface PanelDefinition {
  /** Title in the popout header. Defaults to the script's manifest name. */
  title?: string;
  /** Smaller subtitle line under the title. */
  subtitle?: string;
  /** Preferred popout width in pixels. Clamped by the dashboard. */
  width?: number;
  /** If true, the popout opens automatically when the script starts. */
  autoOpen?: boolean;
  widgets: PanelWidget[];
}

/** Handle returned by `Hive.ui.panel.define(...)`. */
export interface PanelHandle {
  /** Show the popout (no-op if already open). */
  open(): void;
  /** Hide the popout (no-op if already closed). */
  close(): void;
  /** Replace the panel definition. Handler registrations are merged in by widget id. */
  update(def: Partial<PanelDefinition>): void;
  /** Update a single widget's `value`. */
  setValue(id: string, value: unknown): void;
  /** Update a single image widget's `src`. */
  setImage(id: string, src: string): void;
  /** Update a single widget's text (`label` / `text` / `caption`). */
  setText(id: string, text: string): void;
  /** Toggle `enabled` on a single widget. */
  setEnabled(id: string, enabled: boolean): void;
  /** Toggle `visible` on a single widget. */
  setVisible(id: string, visible: boolean): void;
  /** Append a line to a `log` widget. */
  appendLog(id: string, line: string): void;
  /** Replace the lines on a `log` widget. */
  setLog(id: string, lines: string[]): void;
  /** True while the popout is rendered for this script. */
  readonly isOpen: boolean;
}

/** Convenience factory functions. All are pure — they just return widget objects. */
export const Panel = {
  group(title: string, children: PanelWidget[], opts: Omit<GroupWidget, 'type' | 'title' | 'children'> = {}): GroupWidget {
    return { type: 'group', title, children, ...opts };
  },
  row(children: PanelWidget[], opts: Omit<RowWidget, 'type' | 'children'> = {}): RowWidget {
    return { type: 'row', children, ...opts };
  },
  tabs(opts: Omit<TabsWidget, 'type'>): TabsWidget {
    return { type: 'tabs', ...opts };
  },
  heading(text: string, level: PanelHeadingLevel = 2): HeadingWidget {
    return { type: 'heading', text, level };
  },
  label(text: string, opts: Omit<LabelWidget, 'type' | 'text'> = {}): LabelWidget {
    return { type: 'label', text, ...opts };
  },
  image(opts: Omit<ImageWidget, 'type'>): ImageWidget {
    return { type: 'image', ...opts };
  },
  item(opts: Omit<ItemWidget, 'type'>): ItemWidget {
    return { type: 'item', ...opts };
  },
  itemGrid(opts: Omit<ItemGridWidget, 'type'>): ItemGridWidget {
    return { type: 'itemGrid', ...opts };
  },
  button(opts: Omit<ButtonWidget, 'type'>): ButtonWidget {
    return { type: 'button', ...opts };
  },
  toggle(opts: Omit<ToggleWidget, 'type'>): ToggleWidget {
    return { type: 'toggle', ...opts };
  },
  slider(opts: Omit<SliderWidget, 'type'>): SliderWidget {
    return { type: 'slider', ...opts };
  },
  number(opts: Omit<NumberWidget, 'type'>): NumberWidget {
    return { type: 'number', ...opts };
  },
  text(opts: Omit<TextWidget, 'type'>): TextWidget {
    return { type: 'text', ...opts };
  },
  select(opts: Omit<SelectWidget, 'type'>): SelectWidget {
    return { type: 'select', ...opts };
  },
  progress(opts: Omit<ProgressWidget, 'type'>): ProgressWidget {
    return { type: 'progress', ...opts };
  },
  log(opts: Omit<LogWidget, 'type'>): LogWidget {
    return { type: 'log', ...opts };
  },
  spacer(size = 8): SpacerWidget {
    return { type: 'spacer', size };
  },
};

/**
 * Stub — the real implementation is installed by the Hive client when the
 * script runs inside it. Calling these outside the client throws.
 */
function notInClient(): never {
  throw new Error('Hive.ui.panel must be run inside the Hive client');
}

export const panel = {
  define(_def: PanelDefinition): PanelHandle {
    notInClient();
  },
};
