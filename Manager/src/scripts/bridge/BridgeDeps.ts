import type { StateManager } from '../../state/StateManager.js';
import type { ClientConnection } from '../../proxy/ClientConnection.js';
import type { GameWorldState } from '../../state/GameWorldState.js';
import type { PartyRosterState } from '../../state/PartyRosterState.js';
import type { GameDataLoader } from '../../game-data/GameDataLoader.js';
import type { Proxy } from '../../proxy/Proxy.js';
import type { Client as HeadlessClient } from 'headless-client';

/** Live client holder — `DevServer` assigns `.current` when a session attaches */
export type BridgeClientRef = { current: ClientConnection | undefined };

/** Dashboard Script log line styling (`Hive.log`, lifecycle lines). */
export type ScriptLogLevel = 'info' | 'warn' | 'error';

/**
 * Shared dependency bag for all SDK bridge install() methods.
 * Wire real values in one place; bridge modules read from `deps`.
 */
export interface BridgeDeps {
  /** Resolves the headless session currently bound to this script invocation. */
  getHeadlessClient?: () => HeadlessClient | undefined;
  stateManager: StateManager;
  clientRef: BridgeClientRef;
  worldState: GameWorldState;
  /**
   * Optional resolver for future multi-session routing. When absent, bridges
   * should use `worldState` directly.
   */
  getWorldStateForClient?: (client: ClientConnection | undefined) => GameWorldState;
  /** Live party roster from server party packets (per connection). */
  partyRoster: PartyRosterState;
  gameData: GameDataLoader;
  /** Packet hook bus + factory for outbound packets (e.g. chat bridge). */
  proxy: Proxy;
  /**
   * Set by `ScriptHost` while `onStart` / `onLoop` / `onStop` run so `Hive.log`
   * can attribute lines to the active script.
   */
  scriptSession: { scriptId: string | undefined };
  /** Forwards one line to dashboard WebSocket clients (Script log tab). */
  emitScriptLog: (scriptId: string, line: string, level: ScriptLogLevel) => void;
  /**
   * Wired by `ScriptHost`. Running scripts call `Hive.ui.status(...)` (or legacy
   * `ScriptUi.setActivity`) to publish a user-facing line on the dashboard.
   */
  setScriptActivityLabel?: (label: string | null) => void;
  /**
   * Wired by `DevServer`. The panel bridge calls this to push panel state /
   * incremental patches / open/close commands to dashboard WS clients.
   * The dashboard sends `scriptPanelEvent` messages back, which `DevServer`
   * forwards via `ScriptHost.dispatchPanelEvent`.
   */
  emitScriptPanelMessage?: (msg: ScriptPanelOutboundMessage) => void;
}

/** Outbound dashboard-bound messages produced by the panel bridge. */
export type ScriptPanelOutboundMessage =
  | { type: 'scriptPanelState'; scriptId: string; def: unknown | null; isOpen: boolean }
  | { type: 'scriptPanelPatches'; scriptId: string; patches: ScriptPanelPatch[] }
  | { type: 'scriptPanelOpen'; scriptId: string }
  | { type: 'scriptPanelClose'; scriptId: string };

export type ScriptPanelPatch =
  | { op: 'value'; id: string; value: unknown }
  | { op: 'image'; id: string; value: string }
  | { op: 'text'; id: string; value: string }
  | { op: 'enabled'; id: string; value: boolean }
  | { op: 'visible'; id: string; value: boolean }
  | { op: 'log-append'; id: string; value: string }
  | { op: 'log-set'; id: string; value: string[] };

/** Inbound dashboard → script-bridge event. */
export interface ScriptPanelInboundEvent {
  scriptId: string;
  widgetId: string;
  kind: 'click' | 'change' | 'closed-by-user';
  value?: unknown;
}
