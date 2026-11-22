/**
 * Just enough protobuf wire format to peek at the EcoFlow envelope (cmdFunc/cmdId, serials)
 * and to build the tiny "latest quotas" request. Full decoding with the ioBroker .proto files is M3.
 */

export type WireValue =
  | { field: number; wireType: 0; value: bigint }
  | { field: number; wireType: 2; value: Uint8Array }
  | { field: number; wireType: 1 | 5; value: Uint8Array };

export class WireError extends Error {}

export function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < 10; i++) {
    const byte = buf[pos + i];
    if (byte === undefined) throw new WireError('truncated varint');
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos + i + 1];
    shift += 7n;
  }
  throw new WireError('varint too long');
}

/** Decode the top level fields of one message. Throws WireError if the bytes are not protobuf. */
export function readFields(buf: Uint8Array): WireValue[] {
  const out: WireValue[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, afterKey] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (field === 0) throw new WireError('field number 0');
    pos = afterKey;
    switch (wireType) {
      case 0: {
        const [value, next] = readVarint(buf, pos);
        out.push({ field, wireType, value });
        pos = next;
        break;
      }
      case 2: {
        const [len, next] = readVarint(buf, pos);
        const end = next + Number(len);
        if (end > buf.length) throw new WireError('truncated length-delimited field');
        out.push({ field, wireType, value: buf.subarray(next, end) });
        pos = end;
        break;
      }
      case 1:
      case 5: {
        const size = wireType === 1 ? 8 : 4;
        if (pos + size > buf.length) throw new WireError('truncated fixed field');
        out.push({ field, wireType, value: buf.subarray(pos, pos + size) });
        pos += size;
        break;
      }
      default:
        throw new WireError(`unsupported wire type ${wireType}`);
    }
  }
  return out;
}

export function writeVarint(value: bigint | number, out: number[]): void {
  let v = BigInt.asUintN(64, BigInt(value));
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
}

export function writeIntField(field: number, value: number, out: number[]): void {
  writeVarint((field << 3) | 0, out);
  writeVarint(value, out);
}

export function writeBytesField(field: number, value: Uint8Array, out: number[]): void {
  writeVarint((field << 3) | 2, out);
  writeVarint(value.length, out);
  for (const b of value) out.push(b);
}
