import { Timing } from '@luthermanager/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';

export class BridgeTiming {
  static install(_deps: BridgeDeps): void {
    Timing.now = () => Date.now();
    Timing.timeSince = (timestamp: number) => Date.now() - timestamp;
    Timing.sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    Timing.every = (ms, fn) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    };

    Timing.after = (ms, fn) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    };

    Timing.debounce = (ms, fn) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      return ((...args: unknown[]) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
      }) as typeof fn;
    };
  }
}
