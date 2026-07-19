import {
  party,
  trade,
  type CreatePartyParams,
  type PartyFinderParty,
  type PartyMember,
  type PlayerNameMatchMode,
  type TradeItem,
} from '@luthermanager/sdk';
import {
  AcceptTradePacket,
  CancelTradePacket,
  ChangeTradePacket,
  ClientEvent,
  CreatePartyMessagePacket,
  IncomingPartyMemberInfoPacket,
  PacketType,
  PartyActionPacket,
  PartyActionResultPacket,
  PartyJoinRequestPacket,
  PartyListMessagePacket,
  PartyMemberAddedPacket,
  RequestTradePacket,
  TradeAcceptedPacket,
  TradeChangedPacket,
  TradeDonePacket,
  TradeStartPacket,
  type Client,
} from 'headless-client';
import type { BridgeDeps } from '../BridgeDeps.js';

type PartyJoinListener = (member: PartyMember) => void;
type PendingPartyList = { resolve: (rows: PartyFinderParty[]) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type PartyState = {
  members: Map<number, PartyMember>;
  localPlayerId: number | null;
  partyId: number | null;
  pendingList?: PendingPartyList;
  joinListeners: Set<PartyJoinListener>;
};

type TradeState = {
  active: boolean;
  partnerName: string;
  ourItems: TradeItem[];
  partnerItems: TradeItem[];
  ourOffer: boolean[];
  partnerOffer: boolean[];
  partnerOfferFromChanged: boolean[];
};

const partyStates = new WeakMap<Client, PartyState>();
const tradeStates = new WeakMap<Client, TradeState>();

function active(deps: BridgeDeps): Client | undefined {
  return deps.getHeadlessClient?.();
}

function emptyTrade(): TradeState {
  return { active: false, partnerName: '', ourItems: [], partnerItems: [], ourOffer: [], partnerOffer: [], partnerOfferFromChanged: [] };
}

function normalizeOffer(values: readonly boolean[] | undefined, count: number): boolean[] {
  return Array.from({ length: Math.max(1, count || 12) }, (_, index) => Boolean(values?.[index]));
}

function tradeItem(item: { item: number; slotType: number; tradeable: boolean; included: boolean }): TradeItem {
  return { item: item.item, slotType: item.slotType, tradeable: item.tradeable, included: item.included, enchantment: '' };
}

function syncLocalPartyId(client: Client, state: PartyState): void {
  state.localPlayerId = client.getLocalPartyPlayerId();
}

function partyState(client: Client): PartyState {
  let state = partyStates.get(client);
  if (state) return state;
  state = {
    members: new Map(client.getPartyMembers().map((member) => [member.playerId, { ...member }])),
    localPlayerId: client.getLocalPartyPlayerId(),
    partyId: client.getPartyId(),
    joinListeners: new Set(),
  };
  partyStates.set(client, state);

  client.onPacket<IncomingPartyMemberInfoPacket>(PacketType.INCOMING_PARTY_MEMBER_INFO, (packet) => {
    const current = partyState(client);
    current.partyId = packet.partyId;
    current.members.clear();
    for (const row of packet.partyPlayers) {
      current.members.set(row.playerId, { playerId: row.playerId, playerName: row.name, classId: row.classId });
    }
    syncLocalPartyId(client, current);
  });
  client.onPacket<PartyMemberAddedPacket>(PacketType.PARTY_MEMBER_ADDED, (packet) => {
    const current = partyState(client);
    const member = { playerId: packet.playerId, playerName: packet.name, classId: packet.classId };
    current.members.set(member.playerId, member);
    syncLocalPartyId(client, current);
    for (const listener of [...current.joinListeners]) listener({ ...member });
  });
  client.onPacket<PartyActionPacket>(PacketType.PARTY_ACTION, (packet) => {
    if (packet.actionId !== 6) return;
    const current = partyState(client);
    if (packet.playerId === current.localPlayerId) {
      current.members.clear();
      current.partyId = null;
      current.localPlayerId = null;
    } else {
      current.members.delete(packet.playerId);
    }
  });
  client.onPacket<PartyListMessagePacket>(PacketType.PARTY_LIST_MESSAGE, (packet) => {
    if (packet.packetNumber !== 0) return;
    const current = partyState(client);
    const pending = current.pendingList;
    if (!pending) return;
    clearTimeout(pending.timer);
    current.pendingList = undefined;
    pending.resolve(packet.parties.map((row) => ({ ...row })));
  });
  client.on(ClientEvent.Disconnect, () => {
    const current = partyStates.get(client);
    if (current?.pendingList) {
      clearTimeout(current.pendingList.timer);
      current.pendingList.reject(new Error('Disconnected while waiting for the party list.'));
    }
    if (current) {
      current.pendingList = undefined;
      current.members.clear();
      current.localPlayerId = null;
      current.partyId = null;
    }
    if (tradeStates.has(client)) tradeStates.set(client, emptyTrade());
  });
  return state;
}

function tradeState(client: Client): TradeState {
  let state = tradeStates.get(client);
  if (state) return state;
  state = emptyTrade();
  tradeStates.set(client, state);
  client.onPacket<TradeStartPacket>(PacketType.TRADESTART, (packet) => {
    const current = tradeState(client);
    current.active = true;
    current.partnerName = packet.partnerName;
    current.ourItems = packet.clientItems.map(tradeItem);
    current.partnerItems = packet.partnerItems.map(tradeItem);
    current.ourOffer = normalizeOffer(packet.clientItems.map((item) => item.included), packet.clientItems.length);
    current.partnerOffer = normalizeOffer(packet.partnerItems.map((item) => item.included), packet.partnerItems.length);
    current.partnerOfferFromChanged = current.partnerOffer.slice();
  });
  client.onPacket<TradeChangedPacket>(PacketType.TRADECHANGED, (packet) => {
    const current = tradeState(client);
    current.active = true;
    current.partnerOffer = normalizeOffer(packet.offer, current.partnerItems.length);
    current.partnerOfferFromChanged = current.partnerOffer.slice();
  });
  client.onPacket<TradeAcceptedPacket>(PacketType.TRADEACCEPTED, (packet) => {
    const current = tradeState(client);
    current.active = true;
    current.ourOffer = normalizeOffer(packet.clientOffer, current.ourItems.length);
    current.partnerOffer = normalizeOffer(packet.partnerOffer, current.partnerItems.length);
  });
  client.onPacket<TradeDonePacket>(PacketType.TRADEDONE, () => tradeStates.set(client, emptyTrade()));
  return state;
}

function sendOffer(client: Client, state: TradeState, offer: boolean[]): boolean {
  if (!state.active) return false;
  const packet = new ChangeTradePacket();
  packet.offer = normalizeOffer(offer, state.ourItems.length);
  client.send(packet);
  state.ourOffer = packet.offer.slice();
  return true;
}

export function installHeadlessSocialBridge(deps: BridgeDeps): void {
  party.getPartyMembers = () => {
    const client = active(deps);
    return client ? [...partyState(client).members.values()].sort((a, b) => a.playerId - b.playerId).map((member) => ({ ...member })) : [];
  };
  party.getId = (name, match: PlayerNameMatchMode = 'equals') => {
    const query = name.trim().toLowerCase();
    const member = party.getPartyMembers().find((candidate) => match === 'contains'
      ? candidate.playerName.toLowerCase().includes(query)
      : candidate.playerName.trim().toLowerCase() === query);
    return member?.playerId ?? null;
  };
  party.createParty = (params: CreatePartyParams) => {
    const client = active(deps);
    if (!client) return;
    partyState(client);
    const packet = new CreatePartyMessagePacket();
    packet.description = String(params.description ?? '');
    packet.minPowerLevel = Math.max(-32768, Math.min(32767, Math.trunc(params.minPowerLevel)));
    packet.maxPartySize = Math.max(-128, Math.min(127, Math.trunc(params.maxPartySize)));
    packet.activity = Math.max(-128, Math.min(127, Math.trunc(params.activity)));
    packet.maxedStatReq = Math.max(-128, Math.min(127, Math.trunc(params.maxedStatReq)));
    packet.privacy = Math.max(-128, Math.min(127, Math.trunc(params.privacy)));
    client.send(packet);
  };
  party.getPartyList = () => {
    const client = active(deps);
    if (!client) return Promise.reject(new Error('No headless account is connected to Hive.'));
    const state = partyState(client);
    if (state.pendingList) return Promise.reject(new Error('A party-list request is already pending for this account.'));
    return new Promise<PartyFinderParty[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.pendingList?.timer === timer) state.pendingList = undefined;
        reject(new Error('Timed out waiting for PARTY_LIST_MESSAGE.'));
      }, 15_000);
      state.pendingList = { resolve, reject, timer };
      const packet = new PartyActionResultPacket();
      packet.playerId = 0xffff;
      packet.actionId = 5;
      client.send(packet);
    });
  };
  party.join = (partyId) => {
    const client = active(deps);
    if (!client || !Number.isInteger(partyId) || partyId <= 0) return;
    partyState(client);
    const packet = new PartyJoinRequestPacket();
    packet.partyId = partyId >>> 0;
    packet.unknownByte = 0;
    client.send(packet);
  };
  party.kick = (playerId) => {
    const client = active(deps);
    if (!client || !Number.isInteger(playerId) || playerId < 0 || playerId > 0xffff) return;
    partyState(client);
    const packet = new PartyActionResultPacket();
    packet.playerId = playerId;
    packet.actionId = 2;
    client.send(packet);
  };
  party.leave = () => {
    const client = active(deps);
    if (!client) return;
    const state = partyState(client);
    if (state.localPlayerId == null) return;
    const packet = new PartyActionResultPacket();
    packet.playerId = state.localPlayerId;
    packet.actionId = 6;
    client.send(packet);
    state.members.clear();
    state.partyId = null;
    state.localPlayerId = null;
  };

  trade.start = (playerName) => {
    const client = active(deps);
    const name = playerName.trim();
    if (!client || !name) return false;
    tradeState(client);
    const packet = new RequestTradePacket();
    packet.name = name;
    client.send(packet);
    return true;
  };
  trade.startTrade = (playerName) => trade.start(playerName);
  trade.isActive = () => {
    const client = active(deps);
    return client ? tradeState(client).active : false;
  };
  trade.getPartnerName = () => {
    const client = active(deps);
    return client ? tradeState(client).partnerName : '';
  };
  trade.getOurItems = () => {
    const client = active(deps);
    return client ? tradeState(client).ourItems.map((item) => ({ ...item })) : [];
  };
  trade.getPartnerItems = () => {
    const client = active(deps);
    return client ? tradeState(client).partnerItems.map((item) => ({ ...item })) : [];
  };
  trade.getOurOffer = () => {
    const client = active(deps);
    return client ? tradeState(client).ourOffer.slice() : [];
  };
  trade.getPartnerOffer = () => {
    const client = active(deps);
    return client ? tradeState(client).partnerOffer.slice() : [];
  };
  trade.offer = (slotIndexes) => {
    const client = active(deps);
    if (!client) return false;
    const state = tradeState(client);
    if (!state.active) return false;
    const offer = new Array(Math.max(1, state.ourItems.length || 12)).fill(false);
    for (const value of Array.isArray(slotIndexes) ? slotIndexes : [slotIndexes]) {
      const index = Math.trunc(Number(value));
      if (!Number.isFinite(index) || index < 0 || index >= offer.length || state.ourItems[index]?.tradeable === false) return false;
      offer[index] = true;
    }
    return sendOffer(client, state, offer);
  };
  trade.offerAll = () => {
    const client = active(deps);
    if (!client) return false;
    const state = tradeState(client);
    return sendOffer(client, state, state.ourItems.map((item) => item.tradeable));
  };
  trade.clearOffer = () => {
    const client = active(deps);
    if (!client) return false;
    const state = tradeState(client);
    return sendOffer(client, state, new Array(Math.max(1, state.ourItems.length || 12)).fill(false));
  };
  trade.accept = () => {
    const client = active(deps);
    if (!client) return false;
    const state = tradeState(client);
    if (!state.active) return false;
    const packet = new AcceptTradePacket();
    packet.clientOffer = normalizeOffer(state.ourOffer, state.ourItems.length);
    packet.partnerOffer = normalizeOffer(state.partnerOfferFromChanged.length ? state.partnerOfferFromChanged : state.partnerOffer, state.partnerItems.length);
    client.send(packet);
    return true;
  };
  trade.acceptTrade = () => trade.accept();
  trade.cancel = () => {
    const client = active(deps);
    if (!client) return false;
    client.send(new CancelTradePacket());
    tradeStates.set(client, emptyTrade());
    return true;
  };
  trade.cancelTrade = () => trade.cancel();
}

export function subscribeHeadlessPartyJoin(client: Client, listener: PartyJoinListener): () => void {
  const state = partyState(client);
  state.joinListeners.add(listener);
  return () => state.joinListeners.delete(listener);
}
