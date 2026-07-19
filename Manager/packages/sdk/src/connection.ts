export const connection = {
  isConnected(): boolean { throw new Error('Must be run inside LutherManager client'); },
  isInWorld(): boolean { throw new Error('Must be run inside LutherManager client'); },
  getLifecycleState(): string { throw new Error('Must be run inside LutherManager client'); },
  getServerHost(): string { throw new Error('Must be run inside LutherManager client'); },
  isStalled(): boolean { throw new Error('Must be run inside LutherManager client'); },
  stall(_milliseconds?: number): boolean { throw new Error('Must be run inside LutherManager client'); },
  resume(): number { throw new Error('Must be run inside LutherManager client'); },
  reconnect(_host?: string): void { throw new Error('Must be run inside LutherManager client'); },
  stop(): void { throw new Error('Must be run inside LutherManager client'); },
  getTickInfo(): { tickId: number; tickCount: number; tickTimeMs: number; msSinceTick: number } {
    throw new Error('Must be run inside LutherManager client');
  },
  getStallInfo(): { stalled: boolean; elapsedMs: number; remainingMs?: number; queuedPackets: number; droppedPackets: number } {
    throw new Error('Must be run inside LutherManager client');
  },
  getKnownServers(): Array<{ name: string; address: string }> { throw new Error('Must be run inside LutherManager client'); },
  getReconnectTickets(): Array<{ id: number; name: string; host: string; gameId: number; capturedAt: string }> {
    throw new Error('Must be run inside LutherManager client');
  },
};
