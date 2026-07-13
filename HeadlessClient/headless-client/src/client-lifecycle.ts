/** Coarse client lifecycle states used for logging, commands, and cleanup. */
export enum ClientLifecycleState {
  Idle = 'idle',
  Connecting = 'connecting',
  Connected = 'connected',
  InWorld = 'inWorld',
  Reconnecting = 'reconnecting',
  Disconnected = 'disconnected',
  Stopped = 'stopped',
}

/**
 * Small lifecycle state holder. Keeping this separate from Client makes socket
 * transitions explicit without turning every packet handler into lifecycle code.
 */
export class ClientLifecycle {
  private state = ClientLifecycleState.Idle;
  private generation = 0;

  get current(): ClientLifecycleState {
    return this.state;
  }

  nextGeneration(): number {
    this.generation++;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  transition(next: ClientLifecycleState): void {
    this.state = next;
  }
}
