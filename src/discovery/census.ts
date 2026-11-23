import type { DiscoveryCodec } from '../sources/types.js';

/** One message type the device sends, without any values. */
export interface MessageStat {
  /** Message type as the device plugin names it (EcoFlow: `cmdFunc/cmdId`). */
  id: string;
  /** How many arrived since the exporter started. */
  n: number;
  /** Largest pdata seen, bytes. */
  bytes: number;
  /** Whether this exporter's decoder knows the message type. */
  decoded: boolean;
}

/** What the model census sends: no values, no serial number. */
export interface Fingerprint {
  vendor: string;
  /** Model family code (EcoFlow: the first characters of the serial number). */
  productCode: string;
  firmware: string | null;
  msgIds: MessageStat[];
  /** Share of messages (by count) the decoder understood, 0..1; null before any arrived. */
  decodedShare: number | null;
}

/** Length of the serial-number prefix used as the model family code (EcoFlow). */
export const PRODUCT_CODE_LENGTH = 4;

export function productCode(sn: string): string {
  return sn.replace(/[^A-Za-z0-9]/g, '').slice(0, PRODUCT_CODE_LENGTH).toUpperCase();
}

/** Counts message types as they arrive (cheap: the plugin's codec only looks at the envelope). */
export class MessageCensus {
  private readonly stats = new Map<string, MessageStat>();

  constructor(
    private readonly vendor: string,
    private readonly productCode: string,
    private readonly codec: DiscoveryCodec,
  ) {}

  observe(payload: Uint8Array): void {
    for (const m of this.codec.messages(payload) ?? []) {
      const s = this.stats.get(m.id) ?? { id: m.id, n: 0, bytes: 0, decoded: false };
      s.n++;
      s.bytes = Math.max(s.bytes, payload.length);
      s.decoded ||= m.decoded;
      this.stats.set(m.id, s);
    }
  }

  get total(): number {
    let n = 0;
    for (const s of this.stats.values()) n += s.n;
    return n;
  }

  fingerprint(firmware: string | null = null): Fingerprint {
    const msgIds = [...this.stats.values()].map((s) => ({ ...s })).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    const total = this.total;
    const decoded = msgIds.filter((s) => s.decoded).reduce((a, s) => a + s.n, 0);
    return { vendor: this.vendor, productCode: this.productCode, firmware, msgIds, decodedShare: total ? decoded / total : null };
  }
}
