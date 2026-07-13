import { EventEmitter } from 'events';
import { PacketReader } from '../../packets/PacketReader.js';
import type { CapturedPacket } from './PacketInspector.js';

// ── Hardcoded name table ───────────────────────────────────────────────────────

const HARDCODED: Record<number, string> = {
  82:  'QUESTOBJID',
  84:  'REALMHEROESRESPONSE',
  95:  'INVRESULT',
  114: 'EXALTATIONUPDATE',
  120: 'BLUEPRINTINFO',
  122: 'SHOWALLYSHOOT',
  139: 'STATS',
  165: 'UNKNOWN165',
  169: 'REALMSCORE',
  182: 'CRUCIBLEREQUEST',
  183: 'CRUCIBLERESPONSE',
};

const MAX_SAMPLES = 50;

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ByteDiffEntry {
  isConst:  boolean;
  value:    number | null;   // set only when isConst=true
  min:      number;
  max:      number;
  distinct: number;
}

export interface AnalysisResult {
  id:              number;
  hardCodedName:    string;
  count:           number;
  sizes:           { size: number; count: number }[];
  byteDiff:        ByteDiffEntry[];
  strings:         { offset: number; value: string }[];
  compressedInts:  (number[] | null)[];   // first 5 payloads decoded
  hexSamples:      string[];              // first 5 payloads as hex
}

export interface ProbeExample {
  fields:   string[];
  hex:      string;
  leftover?: number;
  error?:   string;
}

export interface ProbeResult {
  samplesTotal:  number;   // payloads actually tested
  trueCount:     number;   // total packets captured (may exceed stored samples)
  pass:          number;
  warn:          number;
  error:         number;
  passExamples:  ProbeExample[];
  warnExamples:  ProbeExample[];
  errorExamples: ProbeExample[];
}

export interface UnknownTypeSummary {
  id:          number;
  hardCodedName: string;
  count:       number;
  sizeMap:     Record<number, number>;
}

// ── Field spec parser ─────────────────────────────────────────────────────────

type FieldOp =
  | { kind: 'single'; type: string }
  | { kind: 'repeat'; type: string; n: number }
  | { kind: 'array';  type: string };

function parseSpec(spec: string): FieldOp[] {
  const ops: FieldOp[] = [];
  for (const token of spec.trim().split(/\s+/)) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (lower.includes('*')) {
      const [base, nStr] = lower.split('*');
      ops.push({ kind: 'repeat', type: base.trim(), n: parseInt(nStr, 10) });
    } else if (lower.endsWith('[]')) {
      ops.push({ kind: 'array', type: lower.slice(0, -2) });
    } else {
      ops.push({ kind: 'single', type: lower });
    }
  }
  return ops;
}

function readOne(r: PacketReader, type: string): unknown {
  switch (type) {
    case 'byte':          return r.readByte();
    case 'sbyte':         return r.readSByte();
    case 'bool':          return r.readBool();
    case 'int16':         return r.readInt16();
    case 'uint16':        return r.readUInt16();
    case 'int32':         return r.readInt32();
    case 'uint32':        return r.readUInt32();
    case 'float':         return r.readFloat();
    case 'string':        return r.readString();
    case 'utf32string':   return r.readUtf32String();
    case 'compressedint': return r.readCompressedInt();
    case 'bytearray16':   return r.readBytes(r.readInt16());
    case 'bytearray32':   return r.readBytes(r.readInt32());
    case 'bytes:rest':    return r.readRemainingBytes();
    default:
      if (type.startsWith('bytes:')) return r.readBytes(parseInt(type.slice(6), 10));
      throw new Error(`Unknown type: ${type}`);
  }
}

function applySpec(payload: Buffer, ops: FieldOp[]): { values: unknown[]; leftover: number } {
  const r = new PacketReader(payload, 0);
  const values: unknown[] = [];
  for (const op of ops) {
    if (op.kind === 'single') {
      values.push(readOne(r, op.type));
    } else if (op.kind === 'repeat') {
      values.push(Array.from({ length: op.n }, () => readOne(r, op.type)));
    } else {
      const count = r.readCompressedInt();
      values.push(Array.from({ length: count }, () => readOne(r, op.type)));
    }
  }
  return { values, leftover: r.remaining };
}

function fmtValue(v: unknown): string {
  if (Buffer.isBuffer(v)) {
    const h = v.toString('hex');
    return `<${v.length}B: ${h.slice(0, 20)}${v.length > 10 ? '…' : ''}>`;
  }
  if (Array.isArray(v)) {
    const inner = v.slice(0, 8).map(fmtValue).join(', ');
    return `[${inner}${v.length > 8 ? `,…+${v.length - 8}` : ''}]`;
  }
  if (typeof v === 'number') return v.toString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

// ── PacketLab ─────────────────────────────────────────────────────────────────

interface StoredType {
  id:          number;
  hardCodedName: string;
  count:       number;
  payloads:    string[];          // hex, max MAX_SAMPLES
  sizeMap:     Record<number, number>;
}

export class PacketLab extends EventEmitter {
  private store = new Map<number, StoredType>();
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called for every captured packet; ignores defined ones. */
  capture(pkt: CapturedPacket): void {
    if (pkt.isDefined) return;

    const raw = Buffer.from(pkt.rawHex, 'hex');
    if (raw.length < 5) return;
    const id      = raw[4];
    const payload = raw.slice(5);

    let entry = this.store.get(id);
    if (!entry) {
      entry = {
        id,
        hardCodedName: HARDCODED[id] ?? `UNKNOWN_${id}`,
        count:   0,
        payloads: [],
        sizeMap:  {},
      };
      this.store.set(id, entry);
    }

    entry.count++;
    const sz = payload.length;
    entry.sizeMap[sz] = (entry.sizeMap[sz] ?? 0) + 1;
    if (entry.payloads.length < MAX_SAMPLES) {
      entry.payloads.push(payload.toString('hex'));
    }

    // Debounce WS broadcast — emit at most every 500ms
    if (!this.updateTimer) {
      this.updateTimer = setTimeout(() => {
        this.updateTimer = null;
        this.emit('update');
      }, 500);
    }
  }

  /** Serialisable summary list (no raw payloads). */
  getUnknowns(): UnknownTypeSummary[] {
    return [...this.store.values()].map(({ payloads: _, ...rest }) => rest);
  }

  /** Clear unknown-packet samples (frees RAM from hex payloads + lab store). */
  clear(): void {
    this.store.clear();
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    this.emit('update');
  }

  /** Full byte-level analysis of a single packet type. */
  analyze(id: number): AnalysisResult | null {
    const entry = this.store.get(id);
    if (!entry) return null;

    const payloads = entry.payloads.map(h => Buffer.from(h, 'hex'));

    // Size distribution
    const sizes = Object.entries(entry.sizeMap)
      .map(([s, c]) => ({ size: Number(s), count: c }))
      .sort((a, b) => a.size - b.size);

    // Byte diff
    const maxLen   = Math.max(0, ...payloads.map(p => p.length));
    const byteDiff: ByteDiffEntry[] = [];
    for (let i = 0; i < maxLen; i++) {
      const vals = payloads.filter(p => i < p.length).map(p => p[i]);
      const s    = new Set(vals);
      byteDiff.push({
        isConst:  s.size === 1,
        value:    s.size === 1 ? vals[0] : null,
        min:      Math.min(...vals),
        max:      Math.max(...vals),
        distinct: s.size,
      });
    }

    // String scan
    const strings: { offset: number; value: string }[] = [];
    const seen = new Set<string>();
    for (const payload of payloads.slice(0, 5)) {
      for (let i = 0; i <= payload.length - 3; i++) {
        const len = payload.readUInt16BE(i);
        if (len >= 1 && len <= 200 && i + 2 + len <= payload.length) {
          const s = payload.slice(i + 2, i + 2 + len).toString('utf8');
          if (/^[\x20-\x7e\t\r\n]+$/.test(s) && !seen.has(s)) {
            strings.push({ offset: i, value: s });
            seen.add(s);
          }
        }
      }
    }

    // CompressedInt stream probe
    const compressedInts: (number[] | null)[] = payloads.slice(0, 5).map(payload => {
      try {
        const r      = new PacketReader(payload, 0);
        const values: number[] = [];
        while (r.remaining > 0) values.push(r.readCompressedInt());
        return values;
      } catch {
        return null;
      }
    });

    return {
      id,
      hardCodedName:   entry.hardCodedName,
      count:          entry.count,
      sizes,
      byteDiff,
      strings,
      compressedInts,
      hexSamples:     entry.payloads.slice(0, 5),
    };
  }

  /** Test a field-type spec string against all stored samples. */
  probe(id: number, specString: string): ProbeResult {
    const empty: ProbeResult = {
      samplesTotal: 0, trueCount: 0, pass: 0, warn: 0, error: 0,
      passExamples: [], warnExamples: [], errorExamples: [],
    };

    const entry = this.store.get(id);
    if (!entry) return empty;

    let ops: FieldOp[];
    try {
      ops = parseSpec(specString);
    } catch (e) {
      return {
        ...empty,
        error: 1,
        errorExamples: [{ fields: [], hex: '', error: `Spec parse error: ${(e as Error).message}` }],
      };
    }

    const result: ProbeResult = {
      samplesTotal: entry.payloads.length,
      trueCount:    entry.count,
      pass: 0, warn: 0, error: 0,
      passExamples: [], warnExamples: [], errorExamples: [],
    };

    for (const hexPayload of entry.payloads) {
      const payload = Buffer.from(hexPayload, 'hex');
      try {
        const { values, leftover } = applySpec(payload, ops);
        const decoded = values.map(fmtValue);
        if (leftover === 0) {
          result.pass++;
          if (result.passExamples.length < 5)
            result.passExamples.push({ fields: decoded, hex: hexPayload });
        } else {
          result.warn++;
          if (result.warnExamples.length < 3)
            result.warnExamples.push({ fields: decoded, hex: hexPayload, leftover });
        }
      } catch (e) {
        result.error++;
        if (result.errorExamples.length < 3)
          result.errorExamples.push({ fields: [], hex: hexPayload, error: (e as Error).message });
      }
    }

    return result;
  }
}
