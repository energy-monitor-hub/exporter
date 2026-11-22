import { writeBytesField, writeIntField } from '../../src/mqtt/wire.js';

export interface FakeHeader {
  pdata?: Uint8Array;
  src?: number;
  dest?: number;
  encType?: number;
  cmdFunc: number;
  cmdId: number;
  seq?: number;
  deviceSn?: string;
  moduleSn?: string;
}

/** Build a HeaderMessage the way the device would. */
export function encodeHeaderMessage(headers: FakeHeader[]): Buffer {
  const out: number[] = [];
  for (const h of headers) {
    const hb: number[] = [];
    if (h.pdata) writeBytesField(1, h.pdata, hb);
    if (h.src !== undefined) writeIntField(2, h.src, hb);
    if (h.dest !== undefined) writeIntField(3, h.dest, hb);
    if (h.encType !== undefined) writeIntField(6, h.encType, hb);
    writeIntField(8, h.cmdFunc, hb);
    writeIntField(9, h.cmdId, hb);
    if (h.seq !== undefined) writeIntField(14, h.seq, hb);
    if (h.moduleSn) writeBytesField(24, new TextEncoder().encode(h.moduleSn), hb);
    if (h.deviceSn) writeBytesField(25, new TextEncoder().encode(h.deviceSn), hb);
    writeBytesField(1, Uint8Array.from(hb), out);
  }
  return Buffer.from(out);
}
