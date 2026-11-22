import protobuf from 'protobufjs';
import { lookupType, MESSAGE_TYPES } from './proto.js';

/** One decoded `Header` of a HeaderMessage, with its pdata decoded when the type is known. */
export interface DecodedMessage {
  cmdFunc: number;
  cmdId: number;
  src: number | undefined;
  seq: number | undefined;
  /** Proto message name, undefined if the codec does not know cmdFunc/cmdId. */
  type: string | undefined;
  /** Decoded pdata as a plain object (camelCase keys, only fields present on the wire). */
  data: Record<string, unknown> | undefined;
  /** Set when pdata could not be decoded. */
  error?: string;
  /**
   * Wire fields the .proto does not know (all of them for an unknown type), by field number:
   * varints and fixed ints as numbers, fixed32 also as `f32:<float>`, length-delimited as hex.
   * Printable text is replaced by `text(<length>)`, since unknown strings may be serials.
   */
  unknown?: Record<string, number | string>;
}

/**
 * Which proto type a cmdFunc/cmdId carries, and the types themselves. The envelope
 * (HeaderMessage) is always the built-in one; the payload types can come from a decoder
 * pack (src/packs/).
 */
export interface Codec {
  typeName(cmdFunc: number, cmdId: number): string | undefined;
  lookupType(name: string): protobuf.Type;
}

/** Types compiled into the exporter (src/proto/delta3maxplus.proto). */
export const builtinCodec: Codec = {
  typeName: (cmdFunc, cmdId) => MESSAGE_TYPES[`${cmdFunc}/${cmdId}`],
  lookupType,
};

const TO_OBJECT = { longs: Number, enums: Number, bytes: String, defaults: false, arrays: true } as const;

/**
 * Decode an MQTT payload from the device. Returns null for non-protobuf payloads (JSON etc.).
 * Payloads with `encType = 1` (and src != 32) carry pdata XOR-ed with the low byte of `seq`
 * (ioBroker lib/ecoflow_utils.js).
 */
export function decodePayload(payload: Uint8Array, codec: Codec = builtinCodec): DecodedMessage[] | null {
  if (payload.length === 0 || payload[0] === 0x7b /* '{' */) return null;
  let envelope: { header?: Record<string, unknown>[] };
  try {
    envelope = lookupType('HeaderMessage').toObject(lookupType('HeaderMessage').decode(payload), {
      ...TO_OBJECT,
      bytes: Array,
    }) as typeof envelope;
  } catch {
    return null;
  }
  const headers = envelope.header ?? [];
  if (headers.length === 0) return null;
  return headers.map((h) => decodeHeader(h, codec));
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

function decodeHeader(h: Record<string, unknown>, codec: Codec): DecodedMessage {
  const cmdFunc = num(h.cmdFunc) ?? 0;
  const cmdId = num(h.cmdId) ?? 0;
  const src = num(h.src);
  const seq = num(h.seq);
  const type = codec.typeName(cmdFunc, cmdId);
  const out: DecodedMessage = { cmdFunc, cmdId, src, seq, type, data: undefined };
  const raw = h.pdata;
  if (!Array.isArray(raw)) return out;
  let pdata = Uint8Array.from(raw as number[]);
  if (num(h.encType) === 1 && src !== 32) {
    const key = (seq ?? 0) & 0xff;
    pdata = pdata.map((b) => b ^ key);
  }
  try {
    const t = type ? codec.lookupType(type) : undefined;
    if (t) out.data = t.toObject(t.decode(pdata), TO_OBJECT) as Record<string, unknown>;
    const unknown = unknownFields(pdata, t);
    if (unknown) out.unknown = unknown;
  } catch (err) {
    out.error = (err as Error).message;
  }
  return out;
}

/** Top-level wire fields of `pdata` that `type` does not define (every field if no type). */
export function unknownFields(pdata: Uint8Array, type?: protobuf.Type): Record<string, number | string> | undefined {
  const out: Record<string, number | string> = {};
  let found = false;
  try {
    const r = protobuf.Reader.create(pdata);
    while (r.pos < r.len) {
      const tag = r.uint32();
      const field = tag >>> 3;
      const wire = tag & 7;
      if (type?.fieldsById[field]) {
        r.skipType(wire);
        continue;
      }
      let v: number | string;
      if (wire === 0) v = Number(r.uint64());
      else if (wire === 5) {
        const b = r.fixed32();
        const f = new DataView(new Uint32Array([b]).buffer).getFloat32(0, true);
        v = Number.isFinite(f) && Math.abs(f) > 1e-6 && Math.abs(f) < 1e9 ? `f32:${+f.toPrecision(7)}` : b;
      } else if (wire === 2) v = hexOrText(r.bytes());
      else if (wire === 1) v = Number(r.fixed64());
      else {
        r.skipType(wire);
        continue;
      }
      // A repeated unknown field keeps its last value.
      out[String(field)] = v;
      found = true;
    }
  } catch {
    // Malformed tail: keep what was read.
  }
  return found ? out : undefined;
}

function hexOrText(b: Uint8Array): string {
  const printable = b.length >= 4 && b.every((c) => c >= 0x20 && c < 0x7f);
  return printable ? `text(${b.length})` : Buffer.from(b).toString('hex');
}
