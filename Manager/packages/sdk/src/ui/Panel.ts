/**
 * Declarative UI panel that a script can show in the Luther dashboard.
 *
 * Scripts describe their UI as a tree of typed widgets — the dashboard
 * renders them inside a centered, themed popout (the same shape as the
 * Multi-Account popout). Interactive widgets carry handlers; the dashboard
 * dispatches events back over the existing script bridge.
 *
 * Usage:
 *
 *   const panel = Luther.ui.panel.define({
 *     title: 'My Bot',
 *     autoOpen: true,
 *     widgets: [
 *       Panel.heading('Combat'),
 *       Panel.toggle({ id: 'autoAttack', label: 'Auto-attack', value: true,
 *         onChange: (v) => settings.autoAttack = v }),
 *       Panel.slider({ id: 'hpPct', label: 'Heal at HP %', value: 40, min: 0, max: 100,
 *         onChange: (v) => settings.healHpPct = v }),
 *       Panel.button({ id: 'nexus', label: 'Nexus now', variant: 'danger',
 *         onClick: () => Luther.walking.nexus() }),
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
export type PanelTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type PanelDensity = 'compact' | 'comfortable';
export type PanelConfigScope = 'script' | 'account';
export type PanelAlign = 'start' | 'center' | 'end' | 'stretch';
export type PanelJustify = 'start' | 'center' | 'end' | 'between';
export type PanelTextAlign = 'left' | 'center' | 'right';
export type PanelFontWeight = 400 | 500 | 600 | 700;

export interface PanelTheme {
  /** Primary interactive color used by focus rings, toggles, tabs, and progress. */
  accentColor?: string;
  textColor?: string;
  mutedTextColor?: string;
  backgroundColor?: string;
  /** Optional surface color for groups, metrics, and search results. */
  surfaceColor?: string;
  borderColor?: string;
}

export interface PanelWidgetStyle {
  /** Overrides text within this widget, including its children. */
  textColor?: string;
  mutedTextColor?: string;
  backgroundColor?: string;
  /** Recolors an existing border; it does not add a border. */
  borderColor?: string;
  /** Overrides interactive accents within this widget. */
  accentColor?: string;
  fontSize?: number;
  fontWeight?: PanelFontWeight;
  textAlign?: PanelTextAlign;
  padding?: number;
  borderRadius?: number;
  opacity?: number;
}

export interface BaseWidget {
  /** Required for widgets that emit events or are targeted by `setValue`/`setText`/etc. */
  id?: string;
  visible?: boolean;
  enabled?: boolean;
  tooltip?: string;
  /** Fixed preferred width in pixels, or a responsive sizing mode. */
  width?: number | 'auto' | 'full';
  minWidth?: number;
  /** Allow this widget to consume remaining room when placed in a row. */
  grow?: boolean;
  /** Include or exclude this widget from saved panel configurations. */
  persist?: boolean;
  /** Optional visual overrides. Invalid CSS colors are ignored by the dashboard. */
  style?: PanelWidgetStyle;
}

export interface GroupWidget extends BaseWidget {
  type: 'group';
  title?: string;
  collapsible?: boolean;
  collapsed?: boolean;
  appearance?: 'subtle' | 'outlined' | 'plain';
  children: PanelWidget[];
}

export interface RowWidget extends BaseWidget {
  type: 'row';
  /** Optional column gap in pixels. */
  gap?: number;
  wrap?: boolean;
  align?: PanelAlign;
  justify?: PanelJustify;
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

export interface SearchOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
}

export interface SearchWidget extends BaseWidget {
  type: 'search';
  id: string;
  label?: string;
  value?: string;
  placeholder?: string;
  options?: SearchOption[];
  /** Maximum visible matches. Defaults to 8. */
  maxResults?: number;
  /** Delay before onChange runs. Defaults to 120ms. */
  debounceMs?: number;
  emptyText?: string;
  showResultCount?: boolean;
  clearable?: boolean;
  onChange?: (query: string) => void;
  onSubmit?: (query: string) => void;
  onSelect?: (value: string) => void;
}

export interface BadgeWidget extends BaseWidget {
  type: 'badge';
  text: string;
  tone?: PanelTone;
}

export interface MetricWidget extends BaseWidget {
  type: 'metric';
  label: string;
  value: string | number;
  detail?: string;
  tone?: PanelTone;
}

export interface DividerWidget extends BaseWidget {
  type: 'divider';
  label?: string;
}

export interface CodeWidget extends BaseWidget {
  type: 'code';
  code: string;
  label?: string;
  wrap?: boolean;
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
  | SearchWidget
  | BadgeWidget
  | MetricWidget
  | DividerWidget
  | CodeWidget
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
  /** Preferred maximum popout height in pixels. Clamped by the dashboard. */
  maxHeight?: number;
  /** Compact reduces panel spacing without changing the visual language. */
  density?: PanelDensity;
  /** Optional panel-wide color theme. Unspecified values retain Luther defaults. */
  theme?: PanelTheme;
  /** If true, the popout opens automatically when the script starts. */
  autoOpen?: boolean;
  /** Optional persistence for input widget values. No settings are stored when omitted. */
  persistence?: PanelPersistenceOptions;
  widgets: PanelWidget[];
}

export interface PanelPersistenceOptions {
  /** Save input changes automatically. Defaults to false. */
  autoSave?: boolean;
  /** Restore `config` when the panel is defined. Defaults to true. */
  autoLoad?: boolean;
  /** Initial named configuration. Defaults to `default`. */
  config?: string;
  /** Share settings across accounts or keep one set per account. Defaults to `script`. */
  scope?: PanelConfigScope;
}

export interface PanelConfigInfo {
  name: string;
  updatedAt: number;
}

/** Handle returned by `Luther.ui.panel.define(...)`. */
export interface PanelHandle {
  /** Show the popout (no-op if already open). */
  open(): void;
  /** Hide the popout (no-op if already closed). */
  close(): void;
  /** Replace the panel definition. Handler registrations are merged in by widget id. */
  update(def: Partial<PanelDefinition>): void;
  /** Update a single widget's `value`. */
  setValue(id: string, value: unknown): void;
  /** Read the bridge's latest cached value for a widget. */
  getValue<T = unknown>(id: string): T | undefined;
  /** Replace options for a search or select widget. */
  setOptions(id: string, options: SearchOption[] | { label: string; value: string }[]): void;
  /** Merge serializable properties into one widget without replacing the panel tree. */
  setProps(id: string, props: Record<string, unknown>): void;
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
  /** Save the current input widget values as a named configuration. */
  saveConfig(name?: string): PanelConfigInfo;
  /** Load a named configuration and run the affected widgets' change handlers. */
  loadConfig(name?: string): boolean;
  /** Delete a named configuration. */
  deleteConfig(name: string): boolean;
  /** List configurations available to this script and persistence scope. */
  listConfigs(): PanelConfigInfo[];
  /** Configuration currently targeted by autosave. */
  readonly activeConfig: string;
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
  search(opts: Omit<SearchWidget, 'type'>): SearchWidget {
    return { type: 'search', ...opts };
  },
  badge(text: string, opts: Omit<BadgeWidget, 'type' | 'text'> = {}): BadgeWidget {
    return { type: 'badge', text, ...opts };
  },
  metric(opts: Omit<MetricWidget, 'type'>): MetricWidget {
    return { type: 'metric', ...opts };
  },
  divider(label?: string): DividerWidget {
    return { type: 'divider', ...(label ? { label } : {}) };
  },
  code(code: string, opts: Omit<CodeWidget, 'type' | 'code'> = {}): CodeWidget {
    return { type: 'code', code, ...opts };
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
 * Stub — the real implementation is installed by the Luther client when the
 * script runs inside it. Calling these outside the client throws.
 */
function notInClient(): never {
  throw new Error('Luther.ui.panel must be run inside the Luther client');
}

export const panel = {
  define(_def: PanelDefinition): PanelHandle {
    notInClient();
  },
};
