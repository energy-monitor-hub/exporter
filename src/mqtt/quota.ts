import { writeBytesField, writeIntField } from './wire.js';

/**
 * "Send me everything now" request for Delta 3 Max Plus, as ioBroker builds it
 * (lib/dict_data/ef_delta3maxplus_data.js, state `latestQuotas`):
 *   setMessage { header: { src: 32, dest: 32, seq: <now>, from: "ios" } }
 * Published to `/app/<userId>/<SN>/thing/property/get`; the device answers on `get_reply`.
 */
export function encodeLatestQuotasRequest(seq: number = Date.now()): Uint8Array {
  const header: number[] = [];
  writeIntField(2, 32, header); // src
  writeIntField(3, 32, header); // dest
  writeIntField(14, seq % 0x80000000, header); // seq (int32 in the .proto)
  writeBytesField(23, new TextEncoder().encode('ios'), header); // from
  const msg: number[] = [];
  writeBytesField(1, Uint8Array.from(header), msg);
  return Uint8Array.from(msg);
}
