import type { Proxy } from '../proxy/Proxy.js';
import type { ClientConnection } from '../proxy/ClientConnection.js';
import type { Packet } from '../packets/Packet.js';

/**
 * One party member row kept for scripts / dashboard (no skinId).
 * Updated from INCOMINGPARTYMEMBERINFO, PARTYMEMBERADDED, PARTYACTION (leave).
 */
export interface PartyMemberSnapshot {
  playerId: number;
  playerName: string;
  classId: number;
}

interface PartySession {
  partyId: number | null;
  /** True once we have a non-empty roster or a snapshot that implies party UI. */
  inParty: boolean;
  members: Map<number, PartyMemberSnapshot>;
  /**
   * Our wire party member id (uint16) from INCOMINGPARTYMEMBERINFO / PARTYMEMBERADDED,
   * resolved by matching {@link ClientConnection.playerData.name} to roster names.
   */
  localPartyPlayerId: number | null;
}

function newSession(): PartySession {
  return { partyId: null, inParty: false, members: new Map(), localPartyPlayerId: null };
}

/**
 * In-memory party roster per {@link ClientConnection}, driven by server packets.
 * Not persisted to disk.
 */
export class PartyRosterState {
  private readonly sessions = new WeakMap<ClientConnection, PartySession>();

  private session(client: ClientConnection): PartySession {
    let s = this.sessions.get(client);
    if (!s) {
      s = newSession();
      this.sessions.set(client, s);
    }
    return s;
  }

  attach(proxy: Proxy): void {
    proxy.hookPacket('INCOMINGPARTYMEMBERINFO', (c, p) => this.onIncomingPartyMemberInfo(c, p));
    proxy.hookPacket('PARTYMEMBERADDED', (c, p) => this.onPartyMemberAdded(c, p));
    proxy.hookPacket('PARTYACTION', (c, p) => this.onPartyAction(c, p));
    proxy.hookPacket('CREATESUCCESS', (c) => {
      this.sessions.set(c, newSession());
    });
    proxy.on('clientDisconnected', (client: ClientConnection) => {
      this.sessions.set(client, newSession());
    });
  }

  /** Whether the session currently has at least one party member recorded. */
  isInParty(client: ClientConnection | undefined | null): boolean {
    if (!client) return false;
    return this.sessions.get(client)?.inParty ?? false;
  }

  /**
   * Stable-ordered copy of the current roster (by playerId). Empty if not connected
   * or no members tracked.
   */
  getMembersSnapshot(client: ClientConnection | undefined | null): PartyMemberSnapshot[] {
    if (!client) return [];
    const s = this.sessions.get(client);
    if (!s || s.members.size === 0) return [];
    return [...s.members.values()].sort((a, b) => a.playerId - b.playerId);
  }

  /** Wire party `playerId` for the local character, or null if unknown / not in roster. */
  getLocalPartyPlayerId(client: ClientConnection | undefined | null): number | null {
    if (!client) return null;
    return this.sessions.get(client)?.localPartyPlayerId ?? null;
  }

  /** Drop all party state for this connection (e.g. after sending leave). */
  clearParty(client: ClientConnection | undefined | null): void {
    if (!client) return;
    this.sessions.set(client, newSession());
  }

  private syncLocalPartyPlayerIdFromMembers(client: ClientConnection, s: PartySession): void {
    const selfName = (client.playerData.name || '').trim().toLowerCase();
    if (!selfName) {
      s.localPartyPlayerId = null;
      return;
    }
    for (const m of s.members.values()) {
      if (m.playerName.trim().toLowerCase() === selfName) {
        s.localPartyPlayerId = m.playerId;
        return;
      }
    }
    s.localPartyPlayerId = null;
  }

  private onIncomingPartyMemberInfo(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    const s = this.session(client);
    const data = packet.data as {
      partyId?: number;
      partyPlayers?: Array<{ playerId?: number; name?: string; classId?: number }>;
    };
    const pid = Number(data.partyId);
    s.partyId = Number.isFinite(pid) ? pid >>> 0 : null;
    s.members.clear();
    const players = Array.isArray(data.partyPlayers) ? data.partyPlayers : [];
    for (const row of players) {
      const playerId = Math.trunc(Number(row.playerId));
      if (!Number.isFinite(playerId) || playerId < 0 || playerId > 65535) continue;
      const id = playerId & 0xffff;
      s.members.set(id, {
        playerId: id,
        playerName: typeof row.name === 'string' ? row.name : '',
        classId: Math.trunc(Number(row.classId)) & 0xffff,
      });
    }
    s.inParty = s.members.size > 0;
    this.syncLocalPartyPlayerIdFromMembers(client, s);
  }

  private onPartyMemberAdded(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    const s = this.session(client);
    const d = packet.data as { playerId?: number; name?: string; classId?: number };
    const playerId = Math.trunc(Number(d.playerId));
    if (!Number.isFinite(playerId) || playerId < 0 || playerId > 65535) return;
    const id = playerId & 0xffff;
    s.members.set(id, {
      playerId: id,
      playerName: typeof d.name === 'string' ? d.name : '',
      classId: Math.trunc(Number(d.classId)) & 0xffff,
    });
    s.inParty = true;
    this.syncLocalPartyPlayerIdFromMembers(client, s);
  }

  /** PARTYACTION S→C: actionId 6 = member left. */
  private onPartyAction(client: ClientConnection, packet: Packet): void {
    if (!packet.isDefined) return;
    const d = packet.data as { playerId?: number; actionId?: number };
    if (Number(d.actionId) !== 6) return;
    const playerId = Math.trunc(Number(d.playerId));
    if (!Number.isFinite(playerId) || playerId < 0 || playerId > 65535) return;
    const s = this.session(client);
    const leftId = playerId & 0xffff;
    const selfId = s.localPartyPlayerId;
    if (selfId !== null && leftId === selfId) {
      this.sessions.set(client, newSession());
      return;
    }
    s.members.delete(leftId);
    if (s.members.size === 0) {
      s.inParty = false;
      s.partyId = null;
      s.localPartyPlayerId = null;
    }
  }
}
