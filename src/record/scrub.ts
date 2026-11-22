import type { HeaderInfo } from '../mqtt/header.js';

/**
 * Replaces identifying strings (device SN, userId, battery module serials) in raw payloads
 * with placeholders of the same length, so protobuf length prefixes stay valid and the
 * fixtures still decode. Payloads with `encType = 1` carry pdata XOR-ed with the low byte
 * of `seq` (see ioBroker lib/ecoflow_utils.js), so the XOR-ed form is replaced too.
 */
export class Scrubber {
  private readonly secrets = new Map<string, string>();

  constructor(entries: { value: string; fill: string }[] = []) {
    for (const e of entries) this.add(e.value, e.fill);
  }

  /** Register a secret; the placeholder is `fill` repeated to the secret's length. */
  add(value: string, fill = 'X'): boolean {
    if (value.length < 4 || this.secrets.has(value)) return false;
    if ([...this.secrets.values()].includes(value)) return false; // already a placeholder
    this.secrets.set(value, fill.repeat(Math.ceil(value.length / fill.length)).slice(0, value.length));
    return true;
  }

  /** Learn serials announced in message headers (module_sn / device_sn). Returns how many were new. */
  learnFromHeaders(headers: HeaderInfo[]): number {
    let added = 0;
    for (const h of headers) {
      for (const sn of [h.deviceSn, h.moduleSn]) {
        if (sn && /^[A-Z0-9]{8,}$/i.test(sn) && this.add(sn, 'X')) added++;
      }
    }
    return added;
  }

  /**
   * Learn serials that sit inside decoded pdata (`bmsSn`, `packSn`, `devSn`, ...): battery
   * modules report them there, not in the header. Returns how many were new.
   */
  learnFromDecoded(messages: readonly { data?: Record<string, unknown> | undefined }[] | null): number {
    let added = 0;
    const walk = (v: unknown, key: string): void => {
      if (typeof v === 'string') {
        if (/sn$/i.test(key) && /^[A-Z0-9]{8,}$/i.test(v) && !/^(.)\1*$/.test(v) && this.add(v, 'X')) added++;
      } else if (Array.isArray(v)) {
        for (const x of v) walk(x, key);
      } else if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) walk(x, k);
      }
    };
    for (const m of messages ?? []) walk(m.data, '');
    return added;
  }

  get size(): number {
    return this.secrets.size;
  }

  /** Placeholders only, safe to write to index.json. */
  placeholders(): string[] {
    return [...this.secrets.values()];
  }

  scrubText(text: string): string {
    let out = text;
    for (const [secret, placeholder] of this.secrets) out = out.split(secret).join(placeholder);
    return out;
  }

  /** Returns a scrubbed copy and the number of replacements. */
  scrubBytes(payload: Uint8Array, xorKeys: Iterable<number> = []): { bytes: Buffer; replaced: number } {
    const bytes = Buffer.from(payload);
    let replaced = 0;
    const keys = new Set<number>([0, ...[...xorKeys].map((k) => k & 0xff)]);
    for (const [secret, placeholder] of this.secrets) {
      for (const key of keys) {
        const needle = xor(Buffer.from(secret, 'utf8'), key);
        const repl = xor(Buffer.from(placeholder, 'utf8'), key);
        let at = bytes.indexOf(needle);
        while (at !== -1) {
          repl.copy(bytes, at);
          replaced++;
          at = bytes.indexOf(needle, at + needle.length);
        }
      }
    }
    return { bytes, replaced };
  }
}

/** XOR keys of the encrypted headers in a message. */
export function xorKeysOf(headers: HeaderInfo[] | null): number[] {
  return (headers ?? []).filter((h) => h.encType === 1 && h.seq !== undefined).map((h) => (h.seq ?? 0) & 0xff);
}

function xor(buf: Buffer, key: number): Buffer {
  if (key === 0) return buf;
  return Buffer.from(buf.map((b) => b ^ key));
}
