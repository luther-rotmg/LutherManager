import { Packet, PacketType } from 'realmlib';
import { Client, PacketContext } from './client';
import { ManagedPluginRuntime, PluginLifecycle } from './plugin-runtime';
import { allPluginInfos, getEventHooks, getPacketHooks, getPluginClass, resolvePluginName } from './plugins';

interface Binding {
  event: string;
  fn: (...args: unknown[]) => void;
  kind: 'event' | 'packet';
}

interface Loaded {
  instance: object & PluginLifecycle;
  runtime: ManagedPluginRuntime;
  bindings: Binding[];
}

/**
 * Loads plugins onto clients by wiring their decorated `@PacketHook` /
 * `@EventHook` methods to the client's hooks, and tracks the wiring so a
 * plugin can be cleanly unloaded. Plugins are instantiated once per client,
 * so each client's plugins have independent state.
 */
export class PluginManager {
  private readonly byClient = new Map<Client, Map<string, Loaded>>();

  /** Instantiates a plugin and wires its hooks to the client. */
  load(client: Client, name: string): boolean {
    const canonicalName = resolvePluginName(name);
    if (!canonicalName) {
      console.warn(`[${client.alias}] unknown plugin: ${name}`);
      return false;
    }
    const cls = getPluginClass(canonicalName);
    if (!cls) {
      console.warn(`[${client.alias}] unknown plugin: ${name}`);
      return false;
    }
    let clientPlugins = this.byClient.get(client);
    if (!clientPlugins) {
      clientPlugins = new Map();
      this.byClient.set(client, clientPlugins);
    }
    if (clientPlugins.has(canonicalName)) {
      return true; // already loaded
    }

    const instance = new cls() as Record<string, (...args: unknown[]) => void> & PluginLifecycle;
    const runtime = new ManagedPluginRuntime(canonicalName, client, instance);
    const bindings: Binding[] = [];

    for (const hook of getPacketHooks(cls)) {
      const fn = (packet: Packet, ctx: PacketContext): void => {
        runtime.run(`${hook.method}(${hook.packetType})`, () => instance[hook.method](client, packet, ctx, runtime));
      };
      client.onPacket(hook.packetType, fn, { priority: hook.priority });
      bindings.push({ kind: 'packet', event: hook.packetType, fn: fn as (...args: unknown[]) => void });
    }
    for (const hook of getEventHooks(cls)) {
      const fn = (...args: unknown[]): void => {
        runtime.run(`${hook.method}(${hook.event})`, () => instance[hook.method](client, ...args, runtime));
      };
      client.on(hook.event, fn);
      bindings.push({ kind: 'event', event: hook.event, fn });
    }

    runtime.run('onLoad', () => instance.onLoad?.(client, runtime));
    clientPlugins.set(canonicalName, { instance, runtime, bindings });
    console.log(`[${client.alias}] plugin loaded: ${canonicalName}`);
    return true;
  }

  /** Removes a plugin's hooks from the client. */
  unload(client: Client, name: string): boolean {
    const canonicalName = resolvePluginName(name) ?? name;
    const loaded = this.byClient.get(client)?.get(canonicalName);
    if (!loaded) {
      return false;
    }
    for (const binding of loaded.bindings) {
      if (binding.kind === 'packet') {
        client.offPacket(binding.event as PacketType, binding.fn as (packet: Packet, ctx: PacketContext) => void);
      } else {
        client.off(binding.event, binding.fn);
      }
    }
    loaded.runtime.run('onUnload', () => loaded.instance.onUnload?.(client, loaded.runtime));
    loaded.runtime.dispose();
    this.byClient.get(client)?.delete(canonicalName);
    console.log(`[${client.alias}] plugin unloaded: ${canonicalName}`);
    return true;
  }

  /** Unloads every plugin attached to a client. */
  unloadAll(client: Client): void {
    for (const name of this.loaded(client)) {
      this.unload(client, name);
    }
    this.byClient.delete(client);
  }

  /** Plugins currently loaded on a client. */
  loaded(client: Client): string[] {
    return [...(this.byClient.get(client)?.keys() ?? [])];
  }

  /** Returns a loaded plugin instance for direct inspection/commands. */
  get<T extends object>(client: Client, name: string): T | undefined {
    const canonicalName = resolvePluginName(name) ?? name;
    return this.byClient.get(client)?.get(canonicalName)?.instance as T | undefined;
  }

  /** All registered plugins (name + description). */
  available(): { name: string; description: string }[] {
    return allPluginInfos().map((info) => ({ name: info.name, description: info.description }));
  }
}
