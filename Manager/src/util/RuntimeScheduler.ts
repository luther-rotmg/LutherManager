type Task = {
  id: number;
  intervalMs: number;
  nextRunAt: number;
  fn: () => void;
};

/**
 * Central lightweight scheduler used to replace scattered intervals.
 * Uses one timer and runs due tasks in timestamp order.
 */
export class RuntimeScheduler {
  private tasks = new Map<number, Task>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;

  scheduleRepeating(intervalMs: number, fn: () => void): () => void {
    const safeInterval = Math.max(10, Math.trunc(intervalMs));
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      intervalMs: safeInterval,
      nextRunAt: Date.now() + safeInterval,
      fn,
    });
    this.scheduleNextTick();
    return () => {
      this.tasks.delete(id);
      this.scheduleNextTick();
    };
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tasks.clear();
  }

  private scheduleNextTick(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.tasks.size === 0) return;
    const now = Date.now();
    let nextAt = Number.POSITIVE_INFINITY;
    for (const task of this.tasks.values()) {
      if (task.nextRunAt < nextAt) nextAt = task.nextRunAt;
    }
    const delay = Math.max(0, nextAt - now);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private tick(): void {
    this.timer = null;
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (now < task.nextRunAt) continue;
      try {
        task.fn();
      } catch {
        // Scheduler must be resilient; task-level errors are intentionally swallowed.
      }
      task.nextRunAt = now + task.intervalMs;
    }
    this.scheduleNextTick();
  }
}
