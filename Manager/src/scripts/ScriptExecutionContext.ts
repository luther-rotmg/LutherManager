import { AsyncLocalStorage } from 'async_hooks';

export interface ScriptExecutionSession {
  scriptId: string;
  accountId?: string;
}

const storage = new AsyncLocalStorage<ScriptExecutionSession>();

export function getScriptExecutionSession(): ScriptExecutionSession | undefined {
  return storage.getStore();
}

export function runWithScriptExecutionSession<T>(session: ScriptExecutionSession, fn: () => T): T {
  return storage.run(session, fn);
}
