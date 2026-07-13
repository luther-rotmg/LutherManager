import { EventEmitter } from 'events';
import { ClientConnection } from './ClientConnection.js';
import { PacketFactory } from '../packets/PacketFactory.js';
import { type Packet } from '../packets/Packet.js';
import { State } from '../state/State.js';
import { Logger } from '../util/Logger.js';

export type PacketHandler = (client: ClientConnection, packet: Packet) => void;
export type CommandHandler = (client: ClientConnection, command: string, args: string[]) => boolean | void;

/**
 * Packet hook bus + factory for the SDK bridges.
 *
 * The old MITM TCP listener on 127.0.0.1:2050 (Exalt ↔ Deca) has been removed.
 * Headless clients will replace that feed; until then hooks simply never fire.
 */
export class Proxy extends EventEmitter {
  static DEFAULT_SERVER = '54.241.208.233'; // USWest

  private states = new Map<string, State>();

  // Hook registries
  private packetHooks = new Map<string, PacketHandler[]>();   // packetName -> handlers
  private commandHooks = new Map<string, CommandHandler[]>(); // command -> handlers

  // Track which hooks belong to which plugin for unloading
  private pluginHooks = new Map<string, { packets: Map<string, PacketHandler[]>; commands: Map<string, CommandHandler[]> }>();


  constructor(
    public readonly packetFactory: PacketFactory,
  ) {
    super();
  }

  // ─── State Management ─────────────────────────────────────────

  /** Get or create state for a connection by key (GUID from reconnect flow). */
  getState(client: ClientConnection, key: Buffer): State {
    const guid = key.length === 0 ? 'n/a' : key.toString('utf8');

    const newState = new State(client);
    this.states.set(newState.guid, newState);

    Logger.log('State', `Lookup — guid from key: "${guid.slice(0, 40)}", states count: ${this.states.size}, found: ${guid !== 'n/a' && this.states.has(guid)}`);

    if (guid !== 'n/a' && this.states.has(guid)) {
      const lastState = this.states.get(guid)!;
      newState.conTargetAddress = lastState.conTargetAddress;
      newState.conTargetPort = lastState.conTargetPort;
      newState.conRealKey = lastState.conRealKey;
      newState.pendingKeyRestore = true;
      newState.copyStoreFrom(lastState);
      Logger.log('State', `Restored from previous — address: ${lastState.conTargetAddress}, port: ${lastState.conTargetPort}, keyLen: ${lastState.conRealKey.length}`);
    }

    return newState;
  }

  // ─── Hook Registration ────────────────────────────────────────

  /**
   * Register a packet handler.
   * @param prepend - if true, handler runs before all other hooks for this packet (safety‑critical, e.g. autonexus).
   */
  hookPacket(packetName: string, handler: PacketHandler, pluginId?: string, prepend = false): void {
    if (!this.packetHooks.has(packetName)) {
      this.packetHooks.set(packetName, []);
    }
    const list = this.packetHooks.get(packetName)!;
    if (prepend) list.unshift(handler);
    else list.push(handler);

    // Track for plugin unloading
    if (pluginId) {
      if (!this.pluginHooks.has(pluginId)) {
        this.pluginHooks.set(pluginId, { packets: new Map(), commands: new Map() });
      }
      const ph = this.pluginHooks.get(pluginId)!;
      if (!ph.packets.has(packetName)) ph.packets.set(packetName, []);
      ph.packets.get(packetName)!.push(handler);
    }
  }

  /** Register a command handler (e.g., /nexus). */
  hookCommand(command: string, handler: CommandHandler, pluginId?: string): void {
    const cmd = command.startsWith('/') ? command.slice(1).toLowerCase() : command.toLowerCase();
    if (!this.commandHooks.has(cmd)) {
      this.commandHooks.set(cmd, []);
    }
    this.commandHooks.get(cmd)!.push(handler);

    if (pluginId) {
      if (!this.pluginHooks.has(pluginId)) {
        this.pluginHooks.set(pluginId, { packets: new Map(), commands: new Map() });
      }
      const ph = this.pluginHooks.get(pluginId)!;
      if (!ph.commands.has(cmd)) ph.commands.set(cmd, []);
      ph.commands.get(cmd)!.push(handler);
    }
  }

  /** Unregister all hooks for a plugin. */
  unhookPlugin(pluginId: string): void {
    const hooks = this.pluginHooks.get(pluginId);
    if (!hooks) return;

    for (const [name, handlers] of hooks.packets) {
      const list = this.packetHooks.get(name);
      if (list) {
        this.packetHooks.set(name, list.filter(h => !handlers.includes(h)));
      }
    }
    for (const [cmd, handlers] of hooks.commands) {
      const list = this.commandHooks.get(cmd);
      if (list) {
        this.commandHooks.set(cmd, list.filter(h => !handlers.includes(h)));
      }
    }

    this.pluginHooks.delete(pluginId);
  }

  // ─── Event Firing ─────────────────────────────────────────────

  /** Fire hooks for a packet from the server. */
  fireServerPacket(client: ClientConnection, packet: Packet): void {
    if (this.listenerCount('serverPacket') > 0) {
      this.emit('serverPacket', client, packet);
    }
    this.firePacketHooks(client, packet);
    // Keep UPDATE free-flowing by default, but preserve plugin rewrites.
    // If a plugin marks the packet modified, ClientConnection will reserialize it
    // before sending to the client instead of forwarding the original raw bytes.
    if (packet.name === 'UPDATE') {
      packet.send = true;
    }
  }

  /** Fire hooks for a packet from the client. */
  fireClientPacket(client: ClientConnection, packet: Packet): void {
    // Check for command interception
    if (packet.name === 'PLAYERTEXT' && packet.isDefined && this.commandHooks.size > 0) {
      const text = (packet.data.text as string).replace('/', '').toLowerCase();
      const parts = text.split(' ');
      const command = parts[0];
      const args = parts.slice(1);

      const handlers = this.commandHooks.get(command);
      if (handlers && handlers.length > 0) {
        let consumed = false;
        for (const handler of handlers) {
          try {
            const result = handler(client, command, args);
            // Legacy handlers return void; treat that as consumed.
            // Handlers can return false to explicitly not consume.
            if (result !== false) consumed = true;
          } catch (err) {
            Logger.error('Proxy', `Command handler error for /${command}`, err as Error);
          }
        }
        if (consumed) {
          packet.send = false; // Consume command only when a handler actively handled it.
        }
      }
    }

    if (this.listenerCount('clientPacket') > 0) {
      this.emit('clientPacket', client, packet);
    }
    this.firePacketHooks(client, packet);
  }

  fireClientConnected(client: ClientConnection): void {
    this.emit('clientConnected', client);
  }

  fireClientDisconnected(client: ClientConnection): void {
    this.emit('clientDisconnected', client);
  }

  private firePacketHooks(client: ClientConnection, packet: Packet): void {
    const handlers = this.packetHooks.get(packet.name);
    if (!handlers || handlers.length === 0) return;

    for (const handler of handlers) {
      try {
        handler(client, packet);
      } catch (err) {
        Logger.error('Proxy', `Packet hook error for ${packet.name}`, err as Error);
      }
    }
  }
}
