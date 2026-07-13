import { Packet } from '../../packet';
import { PacketType } from '../../packet-type';
import { Reader } from '../../reader';
import { Writer } from '../../writer';

/**
 * Sent to acknowledge an `EnemyShootPacket`.
 */
export class ShootAckPacket implements Packet {

  type = PacketType.SHOOTACK;

  //#region packet-specific members
  /**
   * The current client time.
   */
  time: number;
  /** Number of shoot events acknowledged by this packet. */
  ackCount: number;
  //#endregion

  constructor() {
    this.time = 0;
    this.ackCount = 1;
  }

  write(writer: Writer): void {
    writer.writeInt32(this.time);
    writer.writeShort(this.ackCount);
  }

  read(reader: Reader): void {
    this.time = reader.readInt32();
    this.ackCount = reader.readShort();
  }

  /** @deprecated Use {@link ackCount}. */
  get unknownShort(): number {
    return this.ackCount;
  }

  set unknownShort(value: number) {
    this.ackCount = value;
  }
}
