import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { peekHeaders } from '../mqtt/header.js';
import { decodePayload } from '../decode/envelope.js';
import { Scrubber, xorKeysOf } from '../record/scrub.js';

/** Upper limit of one upload (the Storage bucket's file_size_limit). */
export const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
/** Stop recording past this many raw bytes, whatever the duration. */
const MAX_RAW_BYTES = 64 * 1024 * 1024;

export interface SampleMeta {
  vendor: string;
  productCode: string;
  firmware: string | null;
  exporterVersion: string;
}

/** What the user sees before pressing Send. */
export interface SampleSummary {
  messages: number;
  durationS: number;
  rawBytes: number;
  gzBytes: number;
  msgIds: string[];
  /** Distinct identifiers masked (serials, account id, e-mail, serial-like strings). */
  masked: number;
  /** Set when the sample must not be sent (an identifier survived, or it is too big). */
  blocked?: string;
}

export type RecorderState = 'idle' | 'recording' | 'ready';

/** Runs of 10+ capital letters / digits look like serial numbers: mask them too. */
const SERIAL_LIKE = /[A-Z0-9]{10,}/g;

/**
 * Records raw device messages for a shared sample (issue #42), masking identifiers as it
 * goes and once more at the end with everything learned. Kept in memory only; nothing is
 * written to disk or sent until the user presses Send (see DiscoveryService).
 */
export class SampleRecorder {
  private messages: { at: number; payload: Uint8Array }[] = [];
  private rawBytes = 0;
  private startedAt = 0;
  private endsAt = 0;
  private scrubber = new Scrubber();
  private identifiers: string[] = [];
  private result: { file: Buffer; summary: SampleSummary; sha256: string } | undefined;
  state: RecorderState = 'idle';

  constructor(private readonly now: () => number = Date.now) {}

  start(minutes: number, identifiers: readonly string[]): void {
    if (this.state === 'recording') throw new Error('already recording');
    if (!(minutes >= 1 && minutes <= 60)) throw new Error('minutes: 1 to 60');
    this.discard();
    this.identifiers = identifiers.filter((s) => s.length >= 4);
    this.scrubber = new Scrubber(this.identifiers.map((value) => ({ value, fill: /^\d+$/.test(value) ? '0' : 'X' })));
    this.startedAt = this.now();
    this.endsAt = this.startedAt + minutes * 60_000;
    this.state = 'recording';
  }

  /** Progress while recording. */
  get progress(): { messages: number; elapsedS: number; remainingS: number } {
    const t = this.now();
    return {
      messages: this.messages.length,
      elapsedS: this.state === 'idle' ? 0 : Math.round((Math.min(t, this.endsAt) - this.startedAt) / 1000),
      remainingS: this.state === 'recording' ? Math.max(0, Math.round((this.endsAt - t) / 1000)) : 0,
    };
  }

  /** Feed every device payload; ends the recording by itself when the time or size is up. */
  observe(payload: Uint8Array, meta: () => SampleMeta): void {
    if (this.state !== 'recording') return;
    const headers = peekHeaders(payload);
    if (headers) {
      this.scrubber.learnFromHeaders(headers);
      this.scrubber.learnFromDecoded(decodePayload(payload));
    }
    this.messages.push({ at: this.now(), payload: Uint8Array.from(payload) });
    this.rawBytes += payload.length;
    if (this.now() >= this.endsAt || this.rawBytes >= MAX_RAW_BYTES) this.stop(meta());
  }

  /** Ends the recording and builds the compressed, masked sample. */
  stop(meta: SampleMeta): SampleSummary {
    if (this.state !== 'recording') throw new Error('not recording');
    // First the identifiers we know (in clear and XOR-ed), then serial-like strings that are
    // still visible anywhere in the bytes (unknown models may carry serials in fields we
    // cannot decode yet). Two passes: a known serial inside a longer run would otherwise
    // stop the run from matching.
    const first = this.messages.map((m) => ({
      t: m.at - this.startedAt,
      b: this.scrubber.scrubBytes(m.payload, xorKeysOf(peekHeaders(m.payload))).bytes,
    }));
    const serialLike = new Scrubber();
    for (const m of first) {
      for (const run of m.b.toString('latin1').match(SERIAL_LIKE) ?? []) {
        if (!/^(.)\1*$/.test(run)) serialLike.add(run, 'X');
      }
    }
    const scrubbed = first.map((m) => ({ t: m.t, b: serialLike.scrubBytes(m.b).bytes }));
    // Verify: no identifier may survive, in clear or XOR-ed form.
    const verify = new Scrubber(this.identifiers.map((value) => ({ value, fill: '#' })));
    const leaked = scrubbed.some((m) => verify.scrubBytes(m.b, xorKeysOf(peekHeaders(m.b))).replaced > 0);
    const endedAt = this.messages.at(-1)?.at ?? this.now();
    const body = {
      format: 'ecoflow-dashboard/sample/1',
      vendor: meta.vendor,
      product_code: meta.productCode,
      firmware: meta.firmware,
      exporter_version: meta.exporterVersion,
      started_at: new Date(this.startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      // ms since start + base64 payload; topics are left out (they contain the serial and account id)
      messages: scrubbed.map((m) => ({ t: m.t, b: m.b.toString('base64') })),
    };
    const file = gzipSync(Buffer.from(JSON.stringify(body), 'utf8'), { level: 9 });
    const ids = new Set<string>();
    for (const m of this.messages) for (const h of peekHeaders(m.payload) ?? []) ids.add(`${h.cmdFunc}/${h.cmdId}`);
    const summary: SampleSummary = {
      messages: this.messages.length,
      durationS: Math.round((endedAt - this.startedAt) / 1000),
      rawBytes: this.rawBytes,
      gzBytes: file.length,
      msgIds: [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
      masked: this.scrubber.size + serialLike.size,
      ...(leaked
        ? { blocked: 'an identifier was still found after masking; this sample will not be sent' }
        : file.length > MAX_SAMPLE_BYTES
          ? { blocked: `too big (${file.length} bytes compressed, the limit is ${MAX_SAMPLE_BYTES}); record a shorter sample` }
          : this.messages.length === 0
            ? { blocked: 'nothing was recorded' }
            : {}),
    };
    this.messages = [];
    this.result = { file, summary, sha256: createHash('sha256').update(file).digest('hex') };
    this.state = 'ready';
    return summary;
  }

  get ready(): { file: Buffer; summary: SampleSummary; sha256: string } | undefined {
    return this.state === 'ready' ? this.result : undefined;
  }

  discard(): void {
    this.messages = [];
    this.rawBytes = 0;
    this.result = undefined;
    this.state = 'idle';
  }
}
