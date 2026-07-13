import { chat, type ChatChannel, type ChatEvent, type ChatHandler, type ChatOutgoingBlockMode } from '@hive/sdk';
import { PacketType, type Client, type TextPacket } from 'headless-client';
import type { BridgeDeps } from '../BridgeDeps.js';

type ChatFilter = { words: string[]; minStars?: number };
type OutgoingRule = { mode: ChatOutgoingBlockMode; patterns: string[] };
type ChatState = {
  handlers: Set<ChatHandler>;
  filters: Set<ChatFilter>;
  outgoingRules: Set<OutgoingRule>;
};

const states = new WeakMap<Client, ChatState>();

function classify(packet: TextPacket, client: Client): ChatChannel {
  const text = String(packet.text ?? '');
  const name = String(packet.name ?? '');
  const recipient = String(packet.recipient ?? '');
  const self = client.getPlayer()?.name ?? '';
  if (recipient && self && recipient.toLowerCase() === self.toLowerCase() && name.toLowerCase() !== self.toLowerCase()) return 'tell';
  if (text.startsWith('Party>') || name.toLowerCase().includes('party')) return 'party';
  if (text.startsWith('Guild>') || name.toLowerCase().includes('guild')) return 'guild';
  if (text.startsWith('Tell>') || text.startsWith('[Tell]')) return 'tell';
  if (/\[.*global.*\]/i.test(text)) return 'global';
  if (packet.numStars === 65535 || packet.objectId <= 0 || name === '*' || name === '#') return 'system';
  return 'say';
}

function stateFor(client: Client): ChatState {
  let state = states.get(client);
  if (state) return state;
  state = { handlers: new Set(), filters: new Set(), outgoingRules: new Set() };
  states.set(client, state);
  client.onPacket<TextPacket>(PacketType.TEXT, (packet, context) => {
    const current = states.get(client);
    if (!current) return;
    const text = String(packet.cleanText || packet.text || '');
    const lower = text.toLowerCase();
    for (const filter of current.filters) {
      if (!filter.words.some((word) => lower.includes(word))) continue;
      if (filter.minStars !== undefined && packet.numStars >= filter.minStars) continue;
      context.cancel('filtered by Hive.chat.filter');
      return;
    }
    const sender = String(packet.name || 'System');
    const self = client.getPlayer()?.name ?? '';
    const isLocal = !!self && sender.toLowerCase() === self.toLowerCase();
    const event: ChatEvent = {
      sender,
      message: text,
      channel: classify(packet, client),
      isLocal,
      isEcho: isLocal,
      timestamp: Date.now(),
    };
    for (const handler of [...current.handlers]) {
      try { handler(event); } catch (error) { console.error('[Hive.chat] listener failed:', error); }
    }
  }, { priority: 10_000 });
  return state;
}

function current(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

function subscribe(deps: BridgeDeps, handler: ChatHandler): (() => void) {
  const client = current(deps);
  if (!client) return () => {};
  const state = stateFor(client);
  const session = deps.getScriptSession?.() ?? deps.scriptSession;
  const bound: ChatHandler = session.scriptId && deps.runInScriptSession
    ? (event) => deps.runInScriptSession!({ scriptId: session.scriptId!, accountId: session.accountId }, () => handler(event))
    : handler;
  state.handlers.add(bound);
  return () => state.handlers.delete(bound);
}

function outgoingLine(message: string, channel: ChatChannel, recipient?: string): string | null {
  switch (channel) {
    case 'say':
    case 'unknown': return message;
    case 'yell': return `/yell ${message}`;
    case 'party': return `/party ${message}`;
    case 'guild': return `/guild ${message}`;
    case 'tell': return recipient?.trim() ? `/tell ${recipient.trim()} ${message}` : null;
    default: return null;
  }
}

function send(deps: BridgeDeps, message: string, channel: ChatChannel, recipient?: string): boolean {
  const client = current(deps);
  if (!client) return false;
  const line = outgoingLine(String(message ?? ''), channel, recipient);
  if (line == null) return false;
  const lower = line.trim().toLowerCase();
  for (const rule of stateFor(client).outgoingRules) {
    const blocked = rule.patterns.some((pattern) => rule.mode === 'equals' ? lower === pattern : lower.includes(pattern));
    if (blocked) return false;
  }
  client.say(line);
  return true;
}

export function installHeadlessChatBridge(deps: BridgeDeps): void {
  chat.onMessage = (handler) => subscribe(deps, handler);
  chat.onMessageFrom = (playerName, handler) => {
    const query = playerName.trim().toLowerCase();
    return subscribe(deps, (event) => { if (event.sender.trim().toLowerCase() === query) handler(event); });
  };
  chat.onMessageContaining = (match, handler) => subscribe(deps, (event) => {
    if (match instanceof RegExp) match.lastIndex = 0;
    const hit = typeof match === 'string' ? event.message.toLowerCase().includes(match.toLowerCase()) : match.test(event.message);
    if (hit) handler(event);
  });
  chat.onChannelMessage = (channel, handler) => subscribe(deps, (event) => { if (event.channel === channel) handler(event); });
  chat.onWhisper = (handler) => chat.onChannelMessage('tell', handler);
  chat.onSystemMessage = (handler) => chat.onChannelMessage('system', handler);
  chat.send = (message, channel = 'say') => { send(deps, message, channel); };
  chat.say = (message) => { send(deps, message, 'say'); };
  chat.yell = (message) => { send(deps, message, 'yell'); };
  chat.party = (message) => { send(deps, message, 'party'); };
  chat.guild = (message) => { send(deps, message, 'guild'); };
  chat.tell = (playerName, message) => { send(deps, message, 'tell', playerName); };
  chat.notify = (message, sender = 'Hive') => {
    const client = current(deps);
    if (!client) return;
    const event: ChatEvent = {
      sender: sender.trim() || 'Hive',
      message: String(message ?? ''),
      channel: 'system',
      isLocal: true,
      isEcho: false,
      timestamp: Date.now(),
    };
    for (const handler of [...stateFor(client).handlers]) handler(event);
    const scriptId = deps.getScriptSession?.().scriptId ?? deps.scriptSession.scriptId;
    if (scriptId) deps.emitScriptLog(scriptId, `[${scriptId}] ${event.sender}: ${event.message}`, 'info');
  };
  (chat as unknown as Record<string, unknown>).filter = (words: string | string[], minStars?: number) => {
    const client = current(deps);
    if (!client) return () => {};
    const list = (Array.isArray(words) ? words : [words]).map((word) => String(word).trim().toLowerCase()).filter(Boolean);
    if (!list.length) return () => {};
    const filter: ChatFilter = { words: list, minStars: Number.isFinite(minStars) ? Number(minStars) : undefined };
    const state = stateFor(client);
    state.filters.add(filter);
    return () => state.filters.delete(filter);
  };
  chat.blockOutgoing = (mode, ...patterns) => {
    const client = current(deps);
    if (!client) return () => {};
    const normalized = patterns.map((pattern) => String(pattern).trim().toLowerCase()).filter(Boolean);
    if (!normalized.length || (mode !== 'equals' && mode !== 'contains')) return () => {};
    const rule: OutgoingRule = { mode, patterns: normalized };
    const state = stateFor(client);
    state.outgoingRules.add(rule);
    return () => state.outgoingRules.delete(rule);
  };
}

export function subscribeHeadlessChat(deps: BridgeDeps, client: Client, handler: ChatHandler): () => void {
  const state = stateFor(client);
  state.handlers.add(handler);
  return () => state.handlers.delete(handler);
}
