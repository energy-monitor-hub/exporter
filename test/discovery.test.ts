import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { MessageCensus, productCode } from '../src/discovery/census.js';
import { SampleRecorder } from '../src/discovery/recorder.js';
import { DiscoveryService } from '../src/discovery/service.js';
import { CONSENT_TEXTS, consentSha256 } from '../src/discovery/texts.js';
import { ecoflowDiscovery } from '../src/sources/ecoflow.js';
import type { Source } from '../src/sources/types.js';
import { encodeHeaderMessage } from './helpers/proto.js';

const SN = 'R651ZTEST1234567';
const USER_ID = '1999999999999999999';
const EMAIL = 'someone@example.com';
const xor = (s: string, key: number) => Buffer.from(Buffer.from(s).map((b) => b ^ key));

function payload(cmdId = 21, extra = ''): Buffer {
  const seq = 0x1234_5600 + cmdId;
  return encodeHeaderMessage([
    {
      pdata: Buffer.concat([Buffer.from(`a${extra}`), xor(SN, seq & 0xff), Buffer.from(USER_ID)]),
      encType: 1,
      seq,
      cmdFunc: 254,
      cmdId,
      deviceSn: SN,
    },
  ]);
}

const meta = { vendor: 'ecoflow', productCode: 'R651', firmware: null, exporterVersion: '0.1.0' };

describe('census', () => {
  it('product code is the serial prefix', () => {
    expect(productCode('r651-ztest')).toBe('R651');
  });

  it('counts message types without values or serial', () => {
    const c = new MessageCensus('ecoflow', productCode(SN), ecoflowDiscovery);
    c.observe(payload(21));
    c.observe(payload(21));
    c.observe(payload(22));
    const fp = c.fingerprint('1.0.0');
    expect(fp.productCode).toBe('R651');
    expect(fp.msgIds.map((m) => [m.id, m.n])).toEqual([
      ['254/21', 2],
      ['254/22', 1],
    ]);
    expect(JSON.stringify(fp)).not.toContain(SN);
    expect(JSON.stringify(fp)).not.toContain(USER_ID);
  });
});

describe('SampleRecorder', () => {
  it('masks identifiers, also XOR-ed and serial-like, and compresses', () => {
    let now = 1_000;
    const r = new SampleRecorder(() => now);
    r.start(5, [SN, USER_ID, EMAIL], ecoflowDiscovery);
    r.observe(payload(21, 'OTHERSERIAL123'), () => meta);
    now += 2_000;
    r.observe(payload(22), () => meta);
    const s = r.stop(meta);
    expect(s.blocked).toBeUndefined();
    expect(s.messages).toBe(2);
    expect(s.durationS).toBe(2);
    expect(s.msgIds).toEqual(['254/21', '254/22']);
    const file = r.ready?.file;
    expect(file).toBeDefined();
    const body = JSON.parse(gunzipSync(file!).toString('utf8')) as { format: string; messages: { t: number; b: string }[] };
    expect(body.format).toBe('ecoflow-dashboard/sample/1');
    const all = Buffer.concat(body.messages.map((m) => Buffer.from(m.b, 'base64')));
    expect(all.includes(Buffer.from(SN))).toBe(false);
    expect(all.includes(Buffer.from(USER_ID))).toBe(false);
    expect(all.includes(Buffer.from('OTHERSERIAL123'))).toBe(false);
    expect(all.includes(xor(SN, (0x1234_5600 + 21) & 0xff))).toBe(false);
    expect(gunzipSync(file!).toString('utf8')).not.toContain(SN);
  });

  it('stops by itself when the time is up', () => {
    let now = 0;
    const r = new SampleRecorder(() => now);
    r.start(1, [SN], ecoflowDiscovery);
    r.observe(payload(), () => meta);
    now = 61_000;
    r.observe(payload(), () => meta);
    expect(r.state).toBe('ready');
  });

  it('blocks an empty recording and checks the duration', () => {
    const r = new SampleRecorder();
    expect(() => r.start(0, [SN], ecoflowDiscovery)).toThrow();
    r.start(1, [SN], ecoflowDiscovery);
    expect(r.stop(meta).blocked).toBe('nothing was recorded');
  });
});

describe('consent texts', () => {
  it('hash covers both languages', () => {
    expect(consentSha256('model_census')).toMatch(/^[0-9a-f]{64}$/);
    expect(consentSha256('model_census')).not.toBe(consentSha256('raw_sample_upload'));
    expect(CONSENT_TEXTS.raw_sample_upload.en).toContain('masked');
  });
});

/** Minimal stand-in for the Supabase client: records what was called. */
function fakeDb(opts: { consents?: string[]; reserve?: unknown }) {
  const consents = new Set(opts.consents ?? []);
  const calls: { op: string; args?: unknown }[] = [];
  const db = {
    from: (table: string) => {
      if (table !== 'consents') throw new Error(`unexpected table ${table}`);
      const q = {
        select: () => q,
        is: () => q,
        in: () => Promise.resolve({ data: [...consents].map((purpose) => ({ purpose })), error: null }),
        insert: (row: { purpose: string }) => {
          calls.push({ op: 'insert consent', args: row });
          consents.add(row.purpose);
          return Promise.resolve({ error: null });
        },
      };
      return q;
    },
    rpc: (name: string, args: unknown) => {
      calls.push({ op: name, args });
      if (name === 'reserve_sample') return Promise.resolve({ data: opts.reserve, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    storage: {
      from: () => ({
        upload: (path: string, file: Buffer) => {
          calls.push({ op: 'upload', args: { path, size: file.length } });
          return Promise.resolve({ error: null });
        },
      }),
    },
  };
  return { db, calls };
}

function fakeSource(): Source {
  return {
    sn: SN,
    productCode: productCode(SN),
    discovery: ecoflowDiscovery,
    adapter: { descriptor: { vendor: 'ecoflow', model: 'x' } },
    identifiers: () => [SN, USER_ID, EMAIL],
  } as unknown as Source;
}

function service(db: unknown) {
  return new DiscoveryService({
    db: db as never,
    signedIn: () => true,
    source: fakeSource,
    exporterVersion: '0.1.0',
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  });
}

describe('DiscoveryService', () => {
  it('sends nothing without consent', async () => {
    const { db, calls } = fakeDb({});
    const s = service(db);
    s.observe(payload());
    await expect(s.sendCensus()).rejects.toThrow(/consent/);
    expect(() => s.startRecording(5)).toThrow(/consent/);
    expect(calls.filter((c) => c.op !== 'insert consent')).toEqual([]);
  });

  it('stores a consent only for the text the page showed', async () => {
    const { db, calls } = fakeDb({});
    const s = service(db);
    await expect(s.grantConsent('model_census', 'deadbeef')).rejects.toThrow(/changed/);
    await s.grantConsent('model_census', consentSha256('model_census'));
    expect(calls).toEqual([
      {
        op: 'insert consent',
        args: { purpose: 'model_census', text_version: CONSENT_TEXTS.model_census.version, text_sha256: consentSha256('model_census'), source: 'exporter' },
      },
    ]);
    expect((await s.status()).consents.model_census).toBe(true);
  });

  it('census goes through submit_census, without the serial', async () => {
    const { db, calls } = fakeDb({ consents: ['model_census'] });
    const s = service(db);
    s.observe(payload());
    await s.sendCensus();
    const c = calls.find((x) => x.op === 'submit_census');
    expect(c?.args).toMatchObject({ p_vendor: 'ecoflow', p_product_code: 'R651' });
    expect(JSON.stringify(c)).not.toContain(SN);
  });

  it('does not upload when the server does not want the model', async () => {
    const { db, calls } = fakeDb({ consents: ['raw_sample_upload'], reserve: { status: 'supported' } });
    const s = service(db);
    await s.status();
    s.startRecording(5);
    s.observe(payload());
    s.stopRecording();
    expect(await s.sendSample()).toBe('supported');
    expect(calls.some((c) => c.op === 'upload')).toBe(false);
    expect((await s.status()).recorder.state).toBe('idle');
  });

  it('reserves, uploads and confirms a wanted sample', async () => {
    const path = 'u/id.json.gz';
    const { db, calls } = fakeDb({ consents: ['raw_sample_upload'], reserve: { status: 'wanted', id: 'id', path, max_bytes: 10485760 } });
    const s = service(db);
    await s.status();
    s.startRecording(5);
    s.observe(payload());
    s.stopRecording();
    expect(await s.sendSample()).toBe('sent');
    expect(calls.map((c) => c.op)).toEqual(['reserve_sample', 'upload', 'complete_sample']);
    expect(calls[2]?.args).toMatchObject({ p_id: 'id', p_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});
