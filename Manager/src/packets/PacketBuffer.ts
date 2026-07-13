/**
 * Streaming packet accumulator for TCP data.
 * Reads the 4-byte length header, then accumulates body bytes.
 * Ported from KRelayBetter's PacketBuffer.cs.
 */
export class PacketBuffer {
  private static readonly MAX_PACKET_SIZE = 1_048_576; // 1MB safety cap

  private _bytes: Buffer = Buffer.alloc(4);
  private _index = 0;

  get bytes(): Buffer {
    return this._bytes;
  }

  get index(): number {
    return this._index;
  }

  /** Advance the write cursor by numBytes. */
  advance(numBytes: number): void {
    this._index += numBytes;
  }

  /** Resize the internal buffer to the full packet length (from the 4-byte header). */
  resize(newSize: number): void {
    if (newSize <= 0 || newSize > PacketBuffer.MAX_PACKET_SIZE) {
      throw new Error(`Invalid packet size: ${newSize}`);
    }
    const newBuf = Buffer.alloc(newSize);
    this._bytes.copy(newBuf, 0, 0, Math.min(this._bytes.length, newSize));
    this._bytes = newBuf;
  }

  /** Reset buffer back to 4-byte header reading state. */
  reset(): void {
    this._bytes = Buffer.alloc(4);
    this._index = 0;
  }

  /** How many bytes remain to complete the current packet. */
  bytesRemaining(): number {
    return this._bytes.length - this._index;
  }

  /** Return the completed packet bytes as a new buffer. */
  getBytes(): Buffer {
    return Buffer.from(this._bytes);
  }

  dispose(): void {
    this._bytes = Buffer.alloc(0);
    this._index = 0;
  }
}
