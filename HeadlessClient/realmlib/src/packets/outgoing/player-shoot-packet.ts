import {WorldPosData} from '../../data';
import {Packet} from '../../packet';
import {PacketType} from '../../packet-type';
import {Reader} from '../../reader';
import {Writer} from '../../writer';

/**
 * Sent when the player shoots a projectile.
 */
export class PlayerShootPacket implements Packet {

    readonly type = PacketType.PLAYERSHOOT;

    //#region packet-specific members
    /**
     * The current client time.
     */
    time: number;
    /**
     * The id of the bullet which was fired.
     */
    bulletId: number;
    /**
     * The item id of the weapon used to fire the projectile.
     */
    containerType: number;
    /** Index of the selected weapon attack/subattack. */
    attackIndex: number;
    /**
     * The position of the starting point where the projectile was fired.
     */
    startingPos: WorldPosData;
    /**
     * The angle at which the projectile was fired.
     */
    angle: number;
    /** Attack kind used by the current weapon metadata. */
    attackType: number;
    /** Projectile-pattern index, or -1 for a basic weapon shot. */
    patternIndex: number;
    /** Index within a burst sequence. */
    burstIndex: number;
    /**
     * The Player Position 
     */
    playerPos: WorldPosData;

    //#endregion

    constructor() {
        this.time = 0;
        this.bulletId = 0;
        this.containerType = 0;
        this.attackIndex = 0;
        this.startingPos = new WorldPosData();
        this.angle = 0;
        this.attackType = 0;
        this.patternIndex = -1;
        this.burstIndex = 0;
        this.playerPos = new WorldPosData();
    }

    write(writer: Writer): void {
        writer.writeInt32(this.time);
        writer.writeUnsignedShort(this.bulletId);
        writer.writeShort(this.containerType);
        writer.writeByte(this.attackIndex);
        this.startingPos.write(writer);
        writer.writeFloat(this.angle);
        writer.writeByte(this.attackType);
        writer.writeByte(this.patternIndex);
        writer.writeByte(this.burstIndex);
        this.playerPos.write(writer);
    }

    read(reader: Reader): void {
        this.time = reader.readInt32();
        this.bulletId = reader.readUnsignedShort();
        this.containerType = reader.readShort();
        this.attackIndex = reader.readByte();
        this.startingPos.read(reader);
        this.angle = reader.readFloat();
        this.attackType = reader.readByte();
        this.patternIndex = reader.readByte();
        this.burstIndex = reader.readByte();
        this.playerPos.read(reader);
    }

    /** @deprecated Use {@link attackIndex}. */
    get unknownByte(): number { return this.attackIndex; }
    set unknownByte(value: number) { this.attackIndex = value; }

    /** @deprecated Use {@link attackType}. */
    get isBurst(): boolean { return this.attackType !== 0; }
    set isBurst(value: boolean) { this.attackType = value ? 1 : 0; }

    /** @deprecated Use {@link patternIndex} and {@link burstIndex}. */
    get unknownShort(): number {
        return ((this.patternIndex & 0xff) << 8) | (this.burstIndex & 0xff);
    }
    set unknownShort(value: number) {
        this.patternIndex = (value << 16) >> 24;
        this.burstIndex = value & 0xff;
    }
}
