import { readFields, WireError } from './wire.js';

/**
 * Outer envelope every Delta 3 series message uses (ioBroker `HeaderMessage` / `Header`):
 *   message HeaderMessage { repeated Header header = 1; }
 *   message Header { bytes pdata = 1; int32 src = 2; int32 dest = 3; ... int32 cmd_func = 8;
 *                    int32 cmd_id = 9; ... int32 seq = 14; ... string module_sn = 24; string device_sn = 25; }
 */
export interface HeaderInfo {
  cmdFunc: number;
  cmdId: number;
  src?: number;
  dest?: number;
  encType?: number;
  seq?: number;
  dataLen?: number;
  /** pdata length in bytes. */
  pdataBytes: number;
  deviceSn?: string;
  moduleSn?: string;
}

const INT_FIELDS: Record<number, keyof HeaderInfo> = {
  2: 'src',
  3: 'dest',
  6: 'encType',
  8: 'cmdFunc',
  9: 'cmdId',
  10: 'dataLen',
  14: 'seq',
};

const decoder = new TextDecoder('utf-8', { fatal: false });

function parseHeader(bytes: Uint8Array): HeaderInfo {
  const info: Record<string, unknown> = { cmdFunc: 0, cmdId: 0, pdataBytes: 0 };
  for (const f of readFields(bytes)) {
    if (f.wireType === 0) {
      const key = INT_FIELDS[f.field];
      if (key) info[key] = Number(BigInt.asIntN(32, f.value));
    } else if (f.wireType === 2) {
      if (f.field === 1) info.pdataBytes = f.value.length;
      else if (f.field === 24) info.moduleSn = decoder.decode(f.value);
      else if (f.field === 25) info.deviceSn = decoder.decode(f.value);
    }
  }
  return info as unknown as HeaderInfo;
}

/**
 * Headers of a protobuf payload, or `null` if the payload is not a HeaderMessage
 * (for example JSON from older devices or status topics).
 */
export function peekHeaders(payload: Uint8Array): HeaderInfo[] | null {
  if (payload.length === 0 || payload[0] === 0x7b /* '{' */) return null;
  try {
    const fields = readFields(payload);
    const headers = fields.filter((f) => f.field === 1 && f.wireType === 2);
    if (headers.length === 0 || headers.length !== fields.length) return null;
    return headers.map((h) => parseHeader(h.value as Uint8Array));
  } catch (err) {
    if (err instanceof WireError) return null;
    throw err;
  }
}
