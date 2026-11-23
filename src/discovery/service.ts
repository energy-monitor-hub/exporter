import type { SupabaseClient } from '@supabase/supabase-js';
import type { Logger } from '../mqtt/client.js';
import type { Source } from '../sources/types.js';
import { MessageCensus, type Fingerprint } from './census.js';
import { SampleRecorder, type SampleMeta, type SampleSummary } from './recorder.js';
import { CONSENT_TEXTS, consentSha256, type DiscoveryPurpose } from './texts.js';

/** Below this share of decoded messages the page suggests sharing a sample. */
export const WELL_SUPPORTED_SHARE = 0.9;

export interface DiscoveryStatus {
  /** Signed in to Supabase and a device is connected: the buttons can work. */
  available: boolean;
  reason?: string;
  vendor?: string;
  productCode?: string;
  messages: number;
  decodedShare: number | null;
  msgTypes: number;
  consents: Record<DiscoveryPurpose, boolean | null>;
  /** Consent texts to show, with the hash the page sends back when the box is ticked. */
  texts: Record<DiscoveryPurpose, { version: string; en: string; uk: string; sha256: string }>;
  census: { sentAt?: string };
  recorder: {
    state: SampleRecorder['state'];
    messages: number;
    elapsedS: number;
    remainingS: number;
    summary?: SampleSummary;
  };
  /** Result of the last Send: what the server said. */
  lastSample?: { at: string; result: SampleResult };
}

export type SampleResult = 'sent' | 'supported' | 'enough' | 'limit';

export interface DiscoveryDeps {
  db: SupabaseClient | undefined;
  /** Whether the exporter login is valid now (the server checks again anyway). */
  signedIn: () => boolean;
  source: () => Source | undefined;
  exporterVersion: string;
  log: Logger;
  now?: () => number;
}

const CONSENT_TTL_MS = 60_000;

function errorText(e: { message: string } | null | undefined): string {
  return e?.message ?? 'unknown error';
}

/**
 * Model census and opt-in samples for models this exporter does not know well (issue #42).
 * Nothing leaves this machine unless the user consented (stored in public.consents, checked
 * again on the server) and pressed the button for it on the local status page.
 */
export class DiscoveryService {
  private census: MessageCensus | undefined;
  private censusSn: string | undefined;
  private readonly recorder: SampleRecorder;
  private consents: Record<DiscoveryPurpose, boolean | null> = { model_census: null, raw_sample_upload: null };
  private consentsAt = 0;
  private consentsInflight: Promise<void> | undefined;
  private censusSentAt: string | undefined;
  private lastSample: DiscoveryStatus['lastSample'];
  private busy = false;

  constructor(private readonly d: DiscoveryDeps) {
    this.recorder = new SampleRecorder(d.now);
  }

  private get now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** Every device payload, before or after the exporter has handled it. */
  observe(payload: Uint8Array): void {
    const s = this.d.source();
    if (!s) return;
    if (this.censusSn !== s.sn) {
      this.census = s.discovery ? new MessageCensus(s.adapter.descriptor.vendor, s.productCode, s.discovery) : undefined;
      this.censusSn = s.sn;
      this.censusSentAt = undefined;
    }
    try {
      this.census?.observe(payload);
      this.recorder.observe(payload, () => this.meta());
    } catch (err) {
      this.d.log.warn(`discovery: ${(err as Error).message}`);
    }
  }

  private meta(): SampleMeta {
    const s = this.d.source();
    const d = s?.adapter.descriptor;
    return {
      vendor: d?.vendor ?? 'unknown',
      productCode: s?.productCode ?? '',
      firmware: d?.firmware ?? null,
      exporterVersion: this.d.exporterVersion,
    };
  }

  fingerprint(): Fingerprint | undefined {
    const s = this.d.source();
    return this.census?.fingerprint(s?.adapter.descriptor.firmware ?? null);
  }

  private unavailable(): string | undefined {
    if (!this.d.db) return 'Supabase is not configured';
    if (!this.d.signedIn()) return 'log in first';
    if (!this.d.source()) return 'no device connected';
    return undefined;
  }

  async status(): Promise<DiscoveryStatus> {
    const reason = this.unavailable();
    if (!reason) await this.refreshConsents().catch(() => undefined);
    const fp = this.fingerprint();
    const p = this.recorder.progress;
    const ready = this.recorder.ready;
    return {
      available: reason === undefined,
      ...(reason ? { reason } : {}),
      ...(fp ? { vendor: fp.vendor, productCode: fp.productCode } : {}),
      messages: this.census?.total ?? 0,
      decodedShare: fp?.decodedShare ?? null,
      msgTypes: fp?.msgIds.length ?? 0,
      consents: { ...this.consents },
      texts: {
        model_census: { ...CONSENT_TEXTS.model_census, sha256: consentSha256('model_census') },
        raw_sample_upload: { ...CONSENT_TEXTS.raw_sample_upload, sha256: consentSha256('raw_sample_upload') },
      },
      census: this.censusSentAt ? { sentAt: this.censusSentAt } : {},
      recorder: { state: this.recorder.state, ...p, ...(ready ? { summary: ready.summary } : {}) },
      ...(this.lastSample ? { lastSample: this.lastSample } : {}),
    };
  }

  private refreshConsents(force = false): Promise<void> {
    if (!force && this.now - this.consentsAt < CONSENT_TTL_MS) return Promise.resolve();
    this.consentsInflight ??= this.loadConsents().finally(() => (this.consentsInflight = undefined));
    return this.consentsInflight;
  }

  private async loadConsents(): Promise<void> {
    const db = this.requireDb();
    const { data, error } = await db.from('consents').select('purpose').is('withdrawn_at', null).in('purpose', Object.keys(CONSENT_TEXTS));
    if (error) throw new Error(`reading consents failed: ${errorText(error)}`);
    const active = new Set((data ?? []).map((r) => r.purpose as string));
    this.consents = { model_census: active.has('model_census'), raw_sample_upload: active.has('raw_sample_upload') };
    this.consentsAt = this.now;
  }

  private requireDb(): SupabaseClient {
    const reason = this.unavailable();
    if (reason || !this.d.db) throw new Error(reason ?? 'Supabase is not configured');
    return this.d.db;
  }

  /** The user ticked the consent on the status page after reading the text shown there. */
  async grantConsent(purpose: unknown, textSha256: unknown): Promise<void> {
    if (purpose !== 'model_census' && purpose !== 'raw_sample_upload') throw new Error('unknown consent purpose');
    // The page sends back the hash of the text it showed: an outdated page cannot consent to a newer text.
    if (textSha256 !== consentSha256(purpose)) throw new Error('the consent text has changed: reload the page and read it again');
    const db = this.requireDb();
    await this.refreshConsents(true);
    if (this.consents[purpose]) return;
    const { error } = await db.from('consents').insert({
      purpose,
      text_version: CONSENT_TEXTS[purpose].version,
      text_sha256: consentSha256(purpose),
      source: 'exporter',
    });
    if (error) throw new Error(`storing the consent failed: ${errorText(error)}`);
    await this.refreshConsents(true);
    this.d.log.info(`discovery: consent "${purpose}" given on the status page`);
  }

  /** Sends the census: vendor, serial prefix, firmware, message ids with counts. No values. */
  async sendCensus(): Promise<void> {
    const db = this.requireDb();
    await this.refreshConsents();
    if (!this.consents.model_census) throw new Error('give the consent for the model census first');
    const fp = this.fingerprint();
    if (!fp || fp.msgIds.length === 0) throw new Error('no messages from the device yet');
    const { error } = await db.rpc('submit_census', {
      p_vendor: fp.vendor,
      p_product_code: fp.productCode,
      p_firmware: fp.firmware,
      p_msg_ids: fp.msgIds,
      p_exporter: this.d.exporterVersion,
    });
    if (error) throw new Error(`sending the census failed: ${errorText(error)}`);
    this.censusSentAt = new Date(this.now).toISOString();
    this.d.log.info(`discovery: model census sent (${fp.vendor} ${fp.productCode}, ${fp.msgIds.length} message types)`);
  }

  startRecording(minutes: unknown): void {
    const s = this.d.source();
    if (!s) throw new Error('no device connected');
    if (!s.discovery) throw new Error('this kind of device cannot record samples yet');
    if (!this.consents.raw_sample_upload) throw new Error('give the consent for samples first');
    const m = typeof minutes === 'number' ? minutes : Number(minutes);
    this.recorder.start(m, s.identifiers(), s.discovery);
    this.lastSample = undefined;
    this.d.log.info(`discovery: recording a sample for ${m} min`);
  }

  stopRecording(): SampleSummary {
    return this.recorder.stop(this.meta());
  }

  discard(): void {
    this.recorder.discard();
  }

  /** Reserve with the server (it may not want this model), upload, confirm. */
  async sendSample(): Promise<SampleResult> {
    if (this.busy) throw new Error('already sending');
    const ready = this.recorder.ready;
    if (!ready) throw new Error('nothing recorded');
    if (ready.summary.blocked) throw new Error(ready.summary.blocked);
    const db = this.requireDb();
    this.busy = true;
    try {
      const meta = this.meta();
      const { data, error } = await db.rpc('reserve_sample', {
        p_vendor: meta.vendor,
        p_product_code: meta.productCode,
        p_firmware: meta.firmware,
      });
      if (error) throw new Error(`reserving the upload failed: ${errorText(error)}`);
      const r = (data ?? {}) as { status?: string; id?: string; path?: string; max_bytes?: number };
      if (r.status !== 'wanted' || !r.id || !r.path) {
        const result: SampleResult = r.status === 'supported' || r.status === 'enough' || r.status === 'limit' ? r.status : 'enough';
        this.lastSample = { at: new Date(this.now).toISOString(), result };
        // Not wanted: nothing is kept.
        this.recorder.discard();
        return result;
      }
      if (r.max_bytes !== undefined && ready.file.length > r.max_bytes) throw new Error('the sample is bigger than the server accepts');
      const up = await db.storage.from('samples').upload(r.path, ready.file, { contentType: 'application/gzip', upsert: false });
      if (up.error) throw new Error(`uploading failed: ${up.error.message}`);
      const done = await db.rpc('complete_sample', { p_id: r.id, p_size: ready.file.length, p_sha256: ready.sha256 });
      if (done.error) throw new Error(`confirming the upload failed: ${errorText(done.error)}`);
      this.lastSample = { at: new Date(this.now).toISOString(), result: 'sent' };
      this.recorder.discard();
      this.d.log.info(`discovery: sample sent (${ready.file.length} bytes, ${ready.summary.messages} messages)`);
      return 'sent';
    } finally {
      this.busy = false;
    }
  }

  /** One entry point for the status page's POST /api/discovery/<action>. */
  async act(action: string, body: Record<string, unknown>): Promise<unknown> {
    switch (action) {
      case 'consent':
        return this.grantConsent(body.purpose, body.sha256);
      case 'census':
        return this.sendCensus();
      case 'record':
        return this.startRecording(body.minutes);
      case 'stop':
        return this.stopRecording();
      case 'discard':
        return this.discard();
      case 'send':
        return { result: await this.sendSample() };
      default:
        throw new Error(`unknown action ${action}`);
    }
  }
}
