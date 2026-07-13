export type TimerHandle = ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>;

/**
 * Owns timers created by a runtime component so they can all be cancelled
 * during unload, reconnect, or shutdown.
 */
export class TimerBag {
  private readonly timers = new Set<TimerHandle>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, ms);
    this.timers.add(handle);
    return handle;
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const handle = setInterval(fn, ms);
    this.timers.add(handle);
    return handle;
  }

  clear(handle: TimerHandle | undefined): void {
    if (!handle) {
      return;
    }
    clearTimeout(handle as ReturnType<typeof setTimeout>);
    clearInterval(handle as ReturnType<typeof setInterval>);
    this.timers.delete(handle);
  }

  clearAll(): void {
    for (const handle of this.timers) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      clearInterval(handle as ReturnType<typeof setInterval>);
    }
    this.timers.clear();
  }

  get size(): number {
    return this.timers.size;
  }
}
