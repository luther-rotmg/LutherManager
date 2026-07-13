import { expect } from 'chai';
import {
  CreatePartyMessagePacket,
  IncomingPartyMemberInfoPacket,
  PacketType,
  PartyListMessagePacket,
  Reader,
  Writer,
  createPacket,
} from '../src';

function roundTrip<T extends { write(writer: Writer): void; read(reader: Reader): void }>(source: T, target: T): T {
  const writer = new Writer();
  source.write(writer);
  const reader = new Reader(writer.index);
  writer.buffer.copy(reader.buffer, 0, 0, writer.index);
  target.read(reader);
  return target;
}

describe('party packets', () => {
  it('round-trips party creation fields', () => {
    const packet = new CreatePartyMessagePacket();
    packet.description = 'Realm clearing';
    packet.minPowerLevel = 42;
    packet.maxPartySize = 6;
    packet.activity = 2;
    packet.maxedStatReq = 4;
    packet.privacy = 1;
    packet.serverIndex = 9;

    expect(roundTrip(packet, new CreatePartyMessagePacket())).to.deep.include({
      description: 'Realm clearing',
      minPowerLevel: 42,
      maxPartySize: 6,
      activity: 2,
      maxedStatReq: 4,
      privacy: 1,
      serverIndex: 9,
    });
  });

  it('round-trips party roster and finder rows', () => {
    const roster = new IncomingPartyMemberInfoPacket();
    roster.partyId = 1234;
    roster.maxSize = 6;
    roster.description = 'testing';
    roster.partyPlayers = [{ playerId: 7, name: 'RotmgLife', classId: 775, skinId: 0 }];
    expect(roundTrip(roster, new IncomingPartyMemberInfoPacket()).partyPlayers).to.deep.equal(roster.partyPlayers);

    const list = new PartyListMessagePacket();
    list.parties = [{
      name: 'Nexus group', partyId: 44, powerLevelMin: 10, partySizeCurrent: 2,
      partySizeMax: 6, activity: 1, privacy: 0, statsMin: 3, serverIndex: 5,
    }];
    expect(roundTrip(list, new PartyListMessagePacket()).parties).to.deep.equal(list.parties);
  });

  it('constructs every party packet used by Hive', () => {
    for (const type of [
      PacketType.CREATE_PARTY_MESSAGE,
      PacketType.PARTY_ACTION_RESULT,
      PacketType.PARTY_ACTION,
      PacketType.INCOMING_PARTY_MEMBER_INFO,
      PacketType.PARTY_MEMBER_ADDED,
      PacketType.PARTY_LIST_MESSAGE,
      PacketType.PARTY_JOIN_REQUEST,
    ]) {
      expect(createPacket(type).type).to.equal(type);
    }
  });
});
