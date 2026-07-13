import { party } from '@hive/sdk';
import type { CreatePartyParams, PartyFinderParty, PartyMember, PlayerNameMatchMode } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import type { ClientConnection } from '../../../proxy/ClientConnection.js';
import type { Packet } from '../../../packets/Packet.js';
import { Logger } from '../../../util/Logger.js';

function clampInt16(n: number): number {
  const v = Math.trunc(Number(n)) || 0;
  return Math.max(-32768, Math.min(32767, v));
}

function clampSByte(n: number): number {
  const v = Math.trunc(Number(n)) || 0;
  return Math.max(-128, Math.min(127, v));
}

function parseTrailingHex(s: string): Buffer | null {
  const t = s.replace(/\s+/g, '').replace(/^0x/i, '');
  if (t.length === 0) return Buffer.alloc(0);
  if (t.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]*$/.test(t)) return null;
  return Buffer.from(t, 'hex');
}

type PendingGetPartyList = {
  resolve: (rows: PartyFinderParty[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingGetPartyListByClient = new WeakMap<ClientConnection, PendingGetPartyList>();

let partyListHookInstalled = false;

function normalizePartyInfo(raw: unknown): PartyFinderParty {
  const o = raw as Record<string, unknown>;
  return {
    name: typeof o.name === 'string' ? o.name : '',
    partyId: Number(o.partyId) >>> 0,
    powerLevelMin: Number(o.powerLevelMin) & 0xffff,
    partySizeCurrent: Number(o.partySizeCurrent) & 0xff,
    partySizeMax: Number(o.partySizeMax) & 0xff,
    activity: Number(o.activity) & 0xff,
    privacy: Number(o.privacy) & 0xff,
    statsMin: Number(o.statsMin) & 0xff,
    serverIndex: Number(o.serverIndex) & 0xff,
  };
}

function onPartyListMessage(client: ClientConnection, packet: Packet): void {
  const pending = pendingGetPartyListByClient.get(client);
  if (!pending) return;
  if (!packet.isDefined) return;
  const data = packet.data as { packetNumber?: number; parties?: unknown[] };
  /** Server may send two chunks (e.g. packetNumber 255 then 0); only the `0` row carries the finder list. */
  if (Number(data.packetNumber) !== 0) return;
  const rawParties = Array.isArray(data.parties) ? data.parties : [];
  clearTimeout(pending.timer);
  pendingGetPartyListByClient.delete(client);
  try {
    pending.resolve(rawParties.map(normalizePartyInfo));
  } catch (err) {
    pending.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function ensurePartyListHook(deps: BridgeDeps): void {
  if (partyListHookInstalled) return;
  partyListHookInstalled = true;
  deps.proxy.hookPacket('PARTYLISTMESSAGE', (client, packet) => {
    try {
      onPartyListMessage(client, packet);
    } catch (err) {
      Logger.error('ScriptParty', 'PARTYLISTMESSAGE hook failed', err as Error);
    }
  });
}

export function install(deps: BridgeDeps): void {
  party.getPartyMembers = (): PartyMember[] => {
    const c = deps.clientRef.current;
    return deps.partyRoster.getMembersSnapshot(c ?? undefined);
  };

  party.getId = (name: string, match: PlayerNameMatchMode = 'equals'): number | null => {
    const c = deps.clientRef.current;
    if (!c?.connected) return null;
    const q = String(name).trim().toLowerCase();
    if (!q) return null;
    for (const m of deps.partyRoster.getMembersSnapshot(c)) {
      const pn = m.playerName.trim().toLowerCase();
      const hit = match === 'contains' ? pn.includes(q) : pn === q;
      if (hit) return m.playerId;
    }
    return null;
  };

  party.createParty = (params: CreatePartyParams): void => {
    const c = deps.clientRef.current;
    if (!c?.connected) return;

    let trailing: Buffer = Buffer.alloc(0);
    if (params.unreadTrailingHex != null && String(params.unreadTrailingHex).trim() !== '') {
      const parsed = parseTrailingHex(String(params.unreadTrailingHex));
      if (parsed === null) {
        Logger.warn('ScriptParty', 'createParty: invalid unreadTrailingHex (use even-length hex)');
        return;
      }
      trailing = parsed;
    }

    try {
      const pkt = deps.proxy.packetFactory.createByName('CREATEPARTYMESSAGE');
      const serverIndex =
        'serverIndex' in params && typeof (params as { serverIndex?: unknown }).serverIndex === 'number'
          ? clampSByte((params as { serverIndex: number }).serverIndex)
          : 0;
      pkt.data = {
        description: params.description ?? '',
        minPowerLevel: clampInt16(params.minPowerLevel),
        maxPartySize: clampSByte(params.maxPartySize),
        activity: clampSByte(params.activity),
        maxedStatReq: clampSByte(params.maxedStatReq),
        privacy: clampSByte(params.privacy),
        serverIndex,
      };
      pkt.unreadData = trailing;
      pkt.modified = true;
      c.sendToServer(pkt);
    } catch (err) {
      Logger.warn('ScriptParty', `createParty failed: ${(err as Error).message}`);
    }
  };

  party.getPartyList = (): Promise<PartyFinderParty[]> => {
    const c = deps.clientRef.current;
    if (!c?.connected) {
      return Promise.reject(new Error('Not connected'));
    }

    const existing = pendingGetPartyListByClient.get(c);
    if (existing) {
      clearTimeout(existing.timer);
      pendingGetPartyListByClient.delete(c);
      existing.reject(new Error('getPartyList superseded by a new call'));
    }

    ensurePartyListHook(deps);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pendingGetPartyListByClient.get(c) === entry) {
          pendingGetPartyListByClient.delete(c);
        }
        reject(new Error('getPartyList timed out waiting for PARTYLISTMESSAGE (packetNumber 0)'));
      }, 15000);
      const entry: PendingGetPartyList = { resolve, reject, timer };
      pendingGetPartyListByClient.set(c, entry);
      try {
        const pkt = deps.proxy.packetFactory.createByName('PARTYACTIONRESULT');
        pkt.data = { playerId: 65535, actionId: 5 };
        pkt.modified = true;
        c.sendToServer(pkt);
      } catch (err) {
        clearTimeout(timer);
        pendingGetPartyListByClient.delete(c);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  party.join = (partyId: number): void => {
    const c = deps.clientRef.current;
    if (!c?.connected) return;

    const pid = Math.trunc(Number(partyId));
    if (!Number.isFinite(pid) || pid < 1 || pid > 4294967295) {
      Logger.warn('ScriptParty', 'join: partyId must be between 1 and 4294967295');
      return;
    }

    try {
      const pkt = deps.proxy.packetFactory.createByName('PARTYJOINREQUEST');
      pkt.data = {
        partyId: pid >>> 0,
        unknownByte: 0,
      };
      pkt.modified = true;
      c.sendToServer(pkt);
    } catch (err) {
      Logger.warn('ScriptParty', `join failed: ${(err as Error).message}`);
    }
  };

  party.kick = (playerId: number): void => {
    const c = deps.clientRef.current;
    if (!c?.connected) return;

    const pid = Math.trunc(Number(playerId));
    if (!Number.isFinite(pid) || pid < 0 || pid > 65535) {
      Logger.warn('ScriptParty', 'kick: playerId must be between 0 and 65535');
      return;
    }

    try {
      const pkt = deps.proxy.packetFactory.createByName('PARTYACTIONRESULT');
      pkt.data = {
        playerId: pid,
        actionId: 2,
      };
      pkt.modified = true;
      c.sendToServer(pkt);
    } catch (err) {
      Logger.warn('ScriptParty', `kick failed: ${(err as Error).message}`);
    }
  };

  party.leave = (): void => {
    const c = deps.clientRef.current;
    if (!c?.connected) return;

    const myId = deps.partyRoster.getLocalPartyPlayerId(c);
    if (myId === null) {
      Logger.warn('ScriptParty', 'leave: local party player id not known yet (join a party or wait for roster)');
      return;
    }

    try {
      const pkt = deps.proxy.packetFactory.createByName('PARTYACTIONRESULT');
      pkt.data = {
        playerId: myId,
        actionId: 6,
      };
      pkt.modified = true;
      c.sendToServer(pkt);
      deps.partyRoster.clearParty(c);
    } catch (err) {
      Logger.warn('ScriptParty', `leave failed: ${(err as Error).message}`);
    }
  };
}
