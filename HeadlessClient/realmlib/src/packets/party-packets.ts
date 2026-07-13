import { Packet } from '../packet';
import { PacketType } from '../packet-type';
import { Reader } from '../reader';
import { Writer } from '../writer';

export interface PartyPlayerData {
  playerId: number;
  name: string;
  classId: number;
  skinId: number;
}

export interface PartyInfoData {
  name: string;
  partyId: number;
  powerLevelMin: number;
  partySizeCurrent: number;
  partySizeMax: number;
  activity: number;
  privacy: number;
  statsMin: number;
  serverIndex: number;
}

function readPartyPlayer(reader: Reader): PartyPlayerData {
  return {
    playerId: reader.readUnsignedShort(),
    name: reader.readString(),
    classId: reader.readUnsignedShort(),
    skinId: reader.readUnsignedShort(),
  };
}

function readPartyInfo(reader: Reader): PartyInfoData {
  return {
    name: reader.readString(),
    partyId: reader.readUInt32(),
    powerLevelMin: reader.readUnsignedShort(),
    partySizeCurrent: reader.readUnsignedByte(),
    partySizeMax: reader.readUnsignedByte(),
    activity: reader.readUnsignedByte(),
    privacy: reader.readUnsignedByte(),
    statsMin: reader.readUnsignedByte(),
    serverIndex: reader.readUnsignedByte(),
  };
}

export class CreatePartyMessagePacket implements Packet {
  readonly type = PacketType.CREATE_PARTY_MESSAGE;
  description = '';
  minPowerLevel = 0;
  maxPartySize = 0;
  activity = 0;
  maxedStatReq = 0;
  privacy = 0;
  serverIndex = 0;

  read(reader: Reader): void {
    this.description = reader.readString();
    this.minPowerLevel = reader.readShort();
    this.maxPartySize = reader.readByte();
    this.activity = reader.readByte();
    this.maxedStatReq = reader.readByte();
    this.privacy = reader.readByte();
    this.serverIndex = reader.readUnsignedByte();
  }

  write(writer: Writer): void {
    writer.writeString(this.description);
    writer.writeShort(this.minPowerLevel);
    writer.writeByte(this.maxPartySize);
    writer.writeByte(this.activity);
    writer.writeByte(this.maxedStatReq);
    writer.writeByte(this.privacy);
    writer.writeUnsignedByte(this.serverIndex);
  }
}

export class PartyActionResultPacket implements Packet {
  readonly type = PacketType.PARTY_ACTION_RESULT;
  playerId = 0xffff;
  actionId = 0;

  read(reader: Reader): void {
    this.playerId = reader.readUnsignedShort();
    this.actionId = reader.readUnsignedByte();
  }

  write(writer: Writer): void {
    writer.writeUnsignedShort(this.playerId);
    writer.writeUnsignedByte(this.actionId);
  }
}

export class PartyActionPacket implements Packet {
  readonly type = PacketType.PARTY_ACTION;
  playerId = 0;
  actionId = 0;

  read(reader: Reader): void {
    this.playerId = reader.readUnsignedShort();
    this.actionId = reader.readUnsignedByte();
  }

  write(writer: Writer): void {
    writer.writeUnsignedShort(this.playerId);
    writer.writeUnsignedByte(this.actionId);
  }
}

export class IncomingPartyMemberInfoPacket implements Packet {
  readonly type = PacketType.INCOMING_PARTY_MEMBER_INFO;
  partyId = 0;
  unknownShort = 0;
  maxSize = 0;
  partyPlayers: PartyPlayerData[] = [];
  description = '';

  read(reader: Reader): void {
    this.partyId = reader.readUInt32();
    this.unknownShort = reader.readUnsignedShort();
    this.maxSize = reader.readUnsignedByte();
    const count = reader.readShort();
    this.partyPlayers = Array.from({ length: Math.max(0, count) }, () => readPartyPlayer(reader));
    this.description = reader.readString();
  }

  write(writer: Writer): void {
    writer.writeUInt32(this.partyId);
    writer.writeUnsignedShort(this.unknownShort);
    writer.writeUnsignedByte(this.maxSize);
    writer.writeShort(this.partyPlayers.length);
    for (const player of this.partyPlayers) {
      writer.writeUnsignedShort(player.playerId);
      writer.writeString(player.name);
      writer.writeUnsignedShort(player.classId);
      writer.writeUnsignedShort(player.skinId);
    }
    writer.writeString(this.description);
  }
}

export class PartyMemberAddedPacket implements Packet {
  readonly type = PacketType.PARTY_MEMBER_ADDED;
  playerId = 0;
  name = '';
  classId = 0;
  skinId = 0;

  read(reader: Reader): void {
    this.playerId = reader.readUnsignedShort();
    this.name = reader.readString();
    this.classId = reader.readUnsignedShort();
    this.skinId = reader.readUnsignedShort();
  }

  write(writer: Writer): void {
    writer.writeUnsignedShort(this.playerId);
    writer.writeString(this.name);
    writer.writeUnsignedShort(this.classId);
    writer.writeUnsignedShort(this.skinId);
  }
}

export class PartyListMessagePacket implements Packet {
  readonly type = PacketType.PARTY_LIST_MESSAGE;
  packetNumber = 0;
  parties: PartyInfoData[] = [];

  read(reader: Reader): void {
    this.packetNumber = reader.readUnsignedByte();
    const count = reader.readShort();
    this.parties = Array.from({ length: Math.max(0, count) }, () => readPartyInfo(reader));
  }

  write(writer: Writer): void {
    writer.writeUnsignedByte(this.packetNumber);
    writer.writeShort(this.parties.length);
    for (const party of this.parties) {
      writer.writeString(party.name);
      writer.writeUInt32(party.partyId);
      writer.writeUnsignedShort(party.powerLevelMin);
      writer.writeUnsignedByte(party.partySizeCurrent);
      writer.writeUnsignedByte(party.partySizeMax);
      writer.writeUnsignedByte(party.activity);
      writer.writeUnsignedByte(party.privacy);
      writer.writeUnsignedByte(party.statsMin);
      writer.writeUnsignedByte(party.serverIndex);
    }
  }
}

export class PartyJoinRequestPacket implements Packet {
  readonly type = PacketType.PARTY_JOIN_REQUEST;
  partyId = 0;
  unknownByte = 0;

  read(reader: Reader): void {
    this.partyId = reader.readUInt32();
    this.unknownByte = reader.readUnsignedByte();
  }

  write(writer: Writer): void {
    writer.writeUInt32(this.partyId);
    writer.writeUnsignedByte(this.unknownByte);
  }
}
