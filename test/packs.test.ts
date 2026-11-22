import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Delta3MaxPlus } from '../src/decode/delta3maxplus.js';
import { protoDescriptor } from '../src/packs/descriptor.js';
import { PackAdapter } from '../src/packs/interpreter.js';
import { decoderPackSchema, INDEX_FORMAT, type PackIndex } from '../src/packs/schema.js';
import { PackUpdater } from '../src/packs/updater.js';
import { choose, parsePack, sha256, verifyIndex, verifyPack } from '../src/packs/verify.js';
import { loadSession } from './helpers/fixtures.js';

const ROOT = join(import.meta.dirname, '..');
const PACK_FILE = join(ROOT, 'decoders/ecoflow/delta3maxplus.json');
const packBytes = readFileSync(PACK_FILE);
const session = loadSession();

describe('Delta 3 Max Plus pack', () => {
  it('is valid and carries exactly the proto in src/proto', () => {
    const pack = parsePack(packBytes);
    expect(pack.proto).toEqual(JSON.parse(JSON.stringify(protoDescriptor(join(ROOT, 'src/proto/delta3maxplus.proto')))));
  });

  it('reads the live recording exactly like the code adapter, after every message', () => {
    const code = new Delta3MaxPlus();
    const pack = new PackAdapter(parsePack(packBytes));
    let compared = 0;
    for (const m of session) {
      expect(pack.apply(m.payload, m.at), m.file).toEqual(code.apply(m.payload, m.at));
      expect(pack.reading(), m.file).toEqual(code.reading());
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
    expect(pack.state()).toEqual(code.state());
    expect(pack.lastMessageAt).toEqual(code.lastMessageAt);
    expect(pack.gridPresent).toBe(code.gridPresent);
  });
});

describe('pack schema', () => {
  const base = () => JSON.parse(packBytes.toString('utf8')) as Record<string, any>;

  it('refuses anything that is not plain data', () => {
    const p = base();
    p.telemetry.extra.evil = { from: 'display.x', op: 'eval' };
    expect(decoderPackSchema.safeParse(p).success).toBe(false);
    const q = base();
    q.telemetry.extra.evil = { from: 'display.x', code: 'process.exit()' };
    expect(decoderPackSchema.safeParse(q).success).toBe(false);
    const r = base();
    r.telemetry.socPct = { from: 'nosuch.field' };
    expect(decoderPackSchema.safeParse(r).success).toBe(false);
  });

  it('refuses a message type missing from the proto', () => {
    const p = base();
    p.messages['1/1'] = { type: 'NoSuchType' };
    expect(() => parsePack(Buffer.from(JSON.stringify(p)))).toThrow();
  });
});

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey, privateKey };
}

function makeIndex(over: Partial<PackIndex> = {}, bytes = packBytes): PackIndex {
  const pack = parsePack(bytes);
  return {
    format: INDEX_FORMAT,
    sequence: 100,
    channel: 'stable',
    published_at: new Date(1_000).toISOString(),
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    packs: [
      {
        id: pack.id,
        version: pack.version,
        vendor: 'ecoflow',
        productCodes: [],
        fallback: true,
        file: `${pack.id}-${pack.version}.json`,
        sha256: sha256(bytes),
        bytes: bytes.length,
        min_exporter_version: '0.1.0',
      },
    ],
    ...over,
  };
}

describe('index signature and choice', () => {
  it('accepts only a signature by a trusted key', () => {
    const a = keys();
    const b = keys();
    const body = Buffer.from(JSON.stringify(makeIndex()));
    const sig = sign(null, body, a.privateKey).toString('base64');
    expect(verifyIndex(body, sig, [a.publicKey]).sequence).toBe(100);
    expect(() => verifyIndex(body, sig, [b.publicKey])).toThrow(/signature/);
    expect(() => verifyIndex(Buffer.from(body.toString().replace('100', '101')), sig, [a.publicKey])).toThrow(/signature/);
    expect(() => verifyIndex(body, sig, [])).toThrow(/no trusted/);
  });

  it('checks a pack against its entry', () => {
    const entry = makeIndex().packs[0]!;
    expect(verifyPack(packBytes, entry).id).toBe('ecoflow-delta3maxplus');
    const tampered = Buffer.from(packBytes);
    tampered[tampered.length - 3] = 0x20;
    expect(() => verifyPack(tampered, entry)).toThrow(/hash/);
  });

  it('prefers an exact product code, then a fallback; skips packs for newer exporters', () => {
    const idx = makeIndex();
    const exact = { ...idx.packs[0]!, id: 'ecoflow-x', productCodes: ['ABCD'], fallback: false };
    const newer = { ...idx.packs[0]!, id: 'ecoflow-y', productCodes: ['EFGH'], fallback: false, min_exporter_version: '9.0.0' };
    const index = { ...idx, packs: [...idx.packs, exact, newer] };
    expect(choose(index, 'ecoflow', 'ABCD', '0.1.0')?.id).toBe('ecoflow-x');
    expect(choose(index, 'ecoflow', 'ZZZZ', '0.1.0')?.id).toBe('ecoflow-delta3maxplus');
    expect(choose(index, 'ecoflow', 'EFGH', '0.1.0')?.id).toBe('ecoflow-delta3maxplus');
    expect(choose(index, 'other', 'ABCD', '0.1.0')).toBeUndefined();
  });
});

describe('PackUpdater', () => {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

  function server(files: Record<string, Buffer | string>) {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      const name = url.split('/').pop() ?? '';
      const body = files[name];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(typeof body === 'string' ? body : new Uint8Array(body));
    }) as typeof fetch;
    return { fetchImpl, asked };
  }

  function published(k: ReturnType<typeof keys>, over: Partial<PackIndex> = {}) {
    const body = Buffer.from(JSON.stringify(makeIndex(over)));
    return { 'index.json': body, 'index.json.sig': sign(null, body, k.privateKey).toString('base64'), 'ecoflow-delta3maxplus-1.json': packBytes };
  }

  function updater(k: ReturnType<typeof keys>, files: Record<string, Buffer | string>, dir: string, mode: 'auto' | 'notify' = 'auto') {
    const s = server(files);
    const u = new PackUpdater({
      indexUrl: 'https://packs.example/decoders/index.json',
      mode,
      cacheDir: dir,
      keys: [k.publicKey],
      exporterVersion: '0.1.0',
      fetch: s.fetchImpl,
      log,
    });
    return { u, asked: s.asked };
  }

  it('fetches, verifies, caches and picks the pack; sends no identifiers', async () => {
    const k = keys();
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    const { u, asked } = updater(k, published(k), dir);
    await u.check('ecoflow', 'R651');
    expect(u.pick('ecoflow', 'R651')?.id).toBe('ecoflow-delta3maxplus');
    expect(asked.every((url) => !url.includes('R651') && !url.includes('?'))).toBe(true);
    // a fresh updater on the same volume works offline from the cache
    const offline = updater(k, {}, dir).u;
    offline.loadCached();
    expect(offline.pick('ecoflow', 'R651')?.version).toBe(1);
    expect(offline.status().sequence).toBe(100);
  });

  it('refuses a rollback to an older index and an expired one', async () => {
    const k = keys();
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    await updater(k, published(k), dir).u.check('ecoflow', 'R651');
    const old = updater(k, published(k, { sequence: 99 }), dir).u;
    old.loadCached();
    await old.check('ecoflow', 'R651');
    expect(old.status().error).toMatch(/older/);
    const expired = updater(k, published(k, { sequence: 200, expires_at: new Date(Date.now() - 1000).toISOString() }), dir).u;
    expired.loadCached();
    await expired.check('ecoflow', 'R651');
    expect(expired.status().error).toMatch(/expired/);
    expect(expired.status().sequence).toBe(100);
  });

  it('in notify mode reports the update but does not use it', async () => {
    const k = keys();
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    const { u } = updater(k, published(k), dir, 'notify');
    await u.check('ecoflow', 'R651');
    expect(u.pick('ecoflow', 'R651')).toBeUndefined();
    expect(u.status().available).toEqual([{ id: 'ecoflow-delta3maxplus', version: 1 }]);
  });

  it('a bad signature changes nothing', async () => {
    const k = keys();
    const other = keys();
    const dir = mkdtempSync(join(tmpdir(), 'packs-'));
    const { u } = updater(k, published(other), dir);
    await u.check('ecoflow', 'R651');
    expect(u.status().error).toMatch(/signature/);
    expect(u.pick('ecoflow', 'R651')).toBeUndefined();
  });
});
