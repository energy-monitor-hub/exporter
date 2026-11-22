import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UpdateChecker } from '../src/update/checker.js';
import { compareVersions, newestRelease, RELEASES_FORMAT, type Release, type ReleaseManifest } from '../src/update/schema.js';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const rel = (version: string, over: Partial<Release> = {}): Release => ({
  version,
  digest: D('a'),
  channel: 'stable',
  published_at: '2026-11-22T00:00:00.000Z',
  min_db_migration: '20261122172000',
  notes: `v${version}`,
  revoked: false,
  ...over,
});

function manifest(releases: Release[], over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    format: RELEASES_FORMAT,
    sequence: 10,
    published_at: '2026-11-22T00:00:00.000Z',
    expires_at: new Date(Date.now() + 86400_000).toISOString(),
    image: 'ghcr.io/example/exporter',
    releases,
    ...over,
  };
}

describe('release choice', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('newest non-revoked release on the channel', () => {
    const m = manifest([rel('0.2.0'), rel('0.3.0', { channel: 'beta' }), rel('0.4.0', { revoked: true }), rel('0.1.0')]);
    expect(newestRelease(m, '0.1.0', 'stable')?.version).toBe('0.2.0');
    expect(newestRelease(m, '0.1.0', 'beta')?.version).toBe('0.3.0');
    expect(newestRelease(m, '0.2.0', 'stable')).toBeUndefined();
  });
});

describe('UpdateChecker', () => {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');

  function checker(m: ReleaseManifest, current = '0.1.0', key = privateKey) {
    const body = Buffer.from(JSON.stringify(m));
    const files: Record<string, string | Buffer> = { 'releases.json': body, 'releases.json.sig': sign(null, body, key).toString('base64') };
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      const f = files[url.split('/').pop() ?? ''];
      return f === undefined ? new Response('', { status: 404 }) : new Response(typeof f === 'string' ? f : new Uint8Array(f));
    }) as typeof fetch;
    const c = new UpdateChecker({
      manifestUrl: 'https://site.example/releases/releases.json',
      mode: 'notify',
      channel: 'stable',
      keys: [publicKey],
      currentVersion: current,
      log,
      fetch: fetchImpl,
    });
    return { c, asked };
  }

  it('shows a newer release as an image pinned by digest; no identifiers sent', async () => {
    const { c, asked } = checker(manifest([rel('0.2.0', { digest: D('b') })]));
    await c.check();
    expect(c.status().latest).toMatchObject({ version: '0.2.0', image: `ghcr.io/example/exporter@${D('b')}` });
    expect(asked).toEqual(['https://site.example/releases/releases.json', 'https://site.example/releases/releases.json.sig']);
  });

  it('flags a revoked current version', async () => {
    const { c } = checker(manifest([rel('0.1.0', { revoked: true })]));
    await c.check();
    expect(c.status().revoked).toBe(true);
  });

  it('refuses a wrong signature and an expired list', async () => {
    const other = generateKeyPairSync('ed25519').privateKey;
    const bad = checker(manifest([rel('0.2.0')]), '0.1.0', other).c;
    await bad.check();
    expect(bad.status().error).toMatch(/signature/);
    expect(bad.status().latest).toBeUndefined();
    const old = checker(manifest([rel('0.2.0')], { expires_at: new Date(Date.now() - 1000).toISOString() })).c;
    await old.check();
    expect(old.status().error).toMatch(/expired/);
  });

  it('does nothing when off or not configured', async () => {
    const c = new UpdateChecker({ manifestUrl: undefined, mode: 'notify', channel: 'stable', keys: [publicKey], currentVersion: '0.1.0', log });
    await c.check();
    expect(c.status()).toMatchObject({ configured: false, current: '0.1.0' });
  });
});
