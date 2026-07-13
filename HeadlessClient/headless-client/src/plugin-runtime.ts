import { Client } from './client';
import { TimerBag, TimerHandle } from './timer-bag';

export interface PluginRuntime {
  readonly name: string;
  readonly client: Client;
  readonly isDisposed: boolean;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle | undefined): void;
  clearAllTimers(): void;
  sleep(ms: number): Promise<void>;
  waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs?: number, pollMs?: number): Promise<boolean>;
}

export interface PluginLifecycle {
  onLoad?(client: Client, runtime: PluginRuntime): void | Promise<void>;
  onUnload?(client: Client, runtime: PluginRuntime): void | Promise<void>;
  onError?(client: Client, runtime: PluginRuntime, error: unknown, context: string): void;
}

/** Runtime container for one plugin instance on one client. */
export class ManagedPluginRuntime implements PluginRuntime {
  private readonly timers = new TimerBag();
  private readonly sleepResolvers = new Set<() => void>();
  private disposedState = false;

  constructor(
    readonly name: string,
    readonly client: Client,
    private readonly lifecycle: PluginLifecycle,
  ) {}

  get isDisposed(): boolean {
    return this.disposedState;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    if (this.disposedState) {
      throw new Error(`plugin ${this.name} is unloaded`);
    }
    return this.timers.setTimeout(() => this.run('timer', fn), ms);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    if (this.disposedState) {
      throw new Error(`plugin ${this.name} is unloaded`);
    }
    return this.timers.setInterval(() => this.run('interval', fn), ms);
  }

  clearTimer(handle: TimerHandle | undefined): void {
    this.timers.clear(handle);
  }

  clearAllTimers(): void {
    this.timers.clearAll();
  }

  sleep(ms: number): Promise<void> {
    if (this.disposedState) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        this.sleepResolvers.delete(done);
        resolve();
      };
      this.sleepResolvers.add(done);
      this.setTimeout(done, ms);
    });
  }

  async waitUntil(
    predicate: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    pollMs = 100,
  ): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (!this.disposedState) {
      if (await predicate()) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())));
    }
    return false;
  }

  run(context: string, fn: () => void | Promise<void>): void {
    if (this.disposedState) {
      return;
    }
    try {
      const result = fn();
      if (result && typeof result === 'object' && 'then' in result) {
        void (result as Promise<void>).catch((error) => this.handleError(error, context));
      }
    } catch (error) {
      this.handleError(error, context);
    }
  }

  dispose(): void {
    this.disposedState = true;
    this.timers.clearAll();
    for (const resolve of this.sleepResolvers) {
      resolve();
    }
    this.sleepResolvers.clear();
  }

  private handleError(error: unknown, context: string): void {
    if (this.lifecycle.onError) {
      try {
        this.lifecycle.onError(this.client, this, error, context);
        return;
      } catch (onErrorFailure) {
        console.error(
          `[${this.client.alias}] plugin ${this.name} onError failed: ${formatError(onErrorFailure)}`,
        );
      }
    }
    console.error(`[${this.client.alias}] plugin ${this.name} ${context} failed: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
}
