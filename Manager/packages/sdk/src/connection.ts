export const connection = {
  isConnected(): boolean { throw new Error('Must be run inside Hive client'); },
  isInWorld(): boolean { throw new Error('Must be run inside Hive client'); },
  getLifecycleState(): string { throw new Error('Must be run inside Hive client'); },
  getServerHost(): string { throw new Error('Must be run inside Hive client'); },
  isStalled(): boolean { throw new Error('Must be run inside Hive client'); },
  stall(_milliseconds?: number): boolean { throw new Error('Must be run inside Hive client'); },
  resume(): number { throw new Error('Must be run inside Hive client'); },
  reconnect(_host?: string): void { throw new Error('Must be run inside Hive client'); },
  stop(): void { throw new Error('Must be run inside Hive client'); },
  getTickInfo(): { tickId: number; tickCount: number; tickTimeMs: number; msSinceTick: number } {
    throw new Error('Must be run inside Hive client');
  },
  getStallInfo(): { stalled: boolean; elapsedMs: number; remainingMs?: number; queuedPackets: number; droppedPackets: number } {
    throw new Error('Must be run inside Hive client');
  },
  getKnownServers(): Array<{ name: string; address: string }> { throw new Error('Must be run inside Hive client'); },
  getReconnectTickets(): Array<{ id: number; name: string; host: string; gameId: number; capturedAt: string }> {
    throw new Error('Must be run inside Hive client');
  },
};
