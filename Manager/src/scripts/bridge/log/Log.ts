import { Log } from '@hive/sdk';
import type { BridgeDeps, ScriptLogLevel } from '../BridgeDeps.js';

function emit(deps: BridgeDeps, level: ScriptLogLevel, message: string): void {
  const id = deps.scriptSession.scriptId;
  const text = String(message);
  if (!id) {
    if (level === 'error') console.error(`[SCRIPT] ${text}`);
    else if (level === 'warn') console.warn(`[SCRIPT] ${text}`);
    else console.log(`[SCRIPT] ${text}`);
    return;
  }
  const line = `[${id}] ${text}`;
  deps.emitScriptLog(id, line, level);
}

export class BridgeLog {
  static install(deps: BridgeDeps): void {
    Log.info = (message: string) => emit(deps, 'info', message);
    Log.warn = (message: string) => emit(deps, 'warn', message);
    Log.error = (message: string) => emit(deps, 'error', message);
  }
}
