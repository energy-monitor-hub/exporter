import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  DashboardCacheFile,
  DEFAULT_DASHBOARD_URL,
  normalizeDashboardUrl,
  parseDashboardInfo,
  resolveDestinations,
  type DestinationEnv,
} from '../src/destinations.js';

const INFO = { supabaseUrl: 'https://proj.supabase.example', supabaseAnonKey: 'anon.public.key' };

function fakeFetch(answers: Record<string, unknown>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    expect(init?.redirect).toBe('error');
    if (!(String(url) in answers)) throw new Error('getaddrinfo ENOTFOUND');
    return new Response(JSON.stringify(answers[String(url)]), { status: 200 });
  }) as typeof fetch;
  return { fn, calls };
}

const env = (over: Partial<DestinationEnv> = {}): DestinationEnv => ({
  dashboardUrl: DEFAULT_DASHBOARD_URL,
  dashboardUrlFromEnv: false,
  supabaseUrl: undefined,
  supabaseAnonKey: undefined,
  decoderIndexUrlFromEnv: undefined,
  ...over,
});

const tmpFile = () => new DashboardCacheFile(join(mkdtempSync(join(tmpdir(), 'dest-')), 'dashboard.json'));

describe('config defaults', () => {
  it('needs no environment: the project dashboard and its release list', () => {
    const c = loadConfig({});
    expect(c.dashboardUrl).toBe(DEFAULT_DASHBOARD_URL);
    expect(c.dashboardUrlFromEnv).toBe(false);
    expect(c.exporterReleasesUrl).toBe(`${DEFAULT_DASHBOARD_URL}/releases/releases.json`);
    expect(c.supabaseUrl).toBeUndefined();
  });

  it('DASHBOARD_URL moves the release list too; EXPORTER_RELEASES_URL still wins', () => {
    expect(loadConfig({ DASHBOARD_URL: 'http://localhost:5173/' }).exporterReleasesUrl).toBe('http://localhost:5173/releases/releases.json');
    expect(loadConfig({ DASHBOARD_URL: 'https://d.example', EXPORTER_RELEASES_URL: 'https://r.example/x.json' }).exporterReleasesUrl).toBe('https://r.example/x.json');
  });
});

describe('normalizeDashboardUrl', () => {
  it('accepts https and strips the trailing slash', () => {
    expect(normalizeDashboardUrl(' https://Dash.Example/sub/ ')).toBe('https://dash.example/sub');
  });
  it('refuses plain http (except loopback), credentials, query and junk', () => {
    expect(() => normalizeDashboardUrl('http://dash.example')).toThrow('https://');
    expect(normalizeDashboardUrl('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeDashboardUrl('http://dash.example', { allowHttp: true })).toBe('http://dash.example');
    expect(() => normalizeDashboardUrl('https://u:p@dash.example')).toThrow('password');
    expect(() => normalizeDashboardUrl('https://dash.example/?x=1')).toThrow('?');
    expect(() => normalizeDashboardUrl('javascript:alert(1)')).toThrow();
    expect(() => normalizeDashboardUrl('file:///etc/passwd')).toThrow();
    expect(() => normalizeDashboardUrl('nope')).toThrow('not a valid address');
  });
});

describe('parseDashboardInfo', () => {
  it('wants an https Supabase and a plausible key', () => {
    expect(parseDashboardInfo({ ...INFO, supabaseUrl: 'https://proj.supabase.example/' }, 'https://d.example')).toEqual(INFO);
    expect(() => parseDashboardInfo({ ...INFO, supabaseUrl: 'http://proj.supabase.example' }, 'https://d.example')).toThrow('supabaseUrl');
    expect(() => parseDashboardInfo({ ...INFO, supabaseAnonKey: '<script>' }, 'https://d.example')).toThrow('supabaseAnonKey');
    expect(() => parseDashboardInfo('x', 'https://d.example')).toThrow();
  });
  it('lets a local (http) dashboard name a local Supabase', () => {
    expect(parseDashboardInfo({ ...INFO, supabaseUrl: 'http://127.0.0.1:54321' }, 'http://localhost:5173').supabaseUrl).toBe('http://127.0.0.1:54321');
  });
});

describe('resolveDestinations', () => {
  it('reads exporter.json from the default dashboard and caches it', async () => {
    const file = tmpFile();
    const { fn, calls } = fakeFetch({ [`${DEFAULT_DASHBOARD_URL}/exporter.json`]: INFO });
    const d = await resolveDestinations(env(), file, fn);
    expect(calls).toEqual([`${DEFAULT_DASHBOARD_URL}/exporter.json`]);
    expect(d).toMatchObject({ dashboardSource: 'default', supabaseSource: 'dashboard', ...INFO, decoderIndexUrl: `${DEFAULT_DASHBOARD_URL}/decoders/index.json` });
    expect(file.read().dashboard).toEqual({ url: DEFAULT_DASHBOARD_URL, ...INFO });
    expect(statSync(file.path).mode & 0o777).toBe(0o600);
  });

  it('uses the cached copy without network, but only for the same dashboard', async () => {
    const file = tmpFile();
    file.write({ dashboard: { url: DEFAULT_DASHBOARD_URL, ...INFO } });
    const offline = fakeFetch({}).fn;
    expect(await resolveDestinations(env(), file, offline)).toMatchObject({ ...INFO, supabaseSource: 'dashboard' });
    const d = await resolveDestinations(env({ dashboardUrl: 'https://other.example', dashboardUrlFromEnv: true }), file, offline);
    expect(d.supabaseUrl).toBeUndefined();
    expect(d.error).toContain('ENOTFOUND');
  });

  it('.env wins: SUPABASE_* skip the fetch, DASHBOARD_URL and DECODER_INDEX_URL apply', async () => {
    const file = tmpFile();
    const { fn, calls } = fakeFetch({});
    const d = await resolveDestinations(
      env({ supabaseUrl: 'http://host.docker.internal:54321', supabaseAnonKey: 'k', dashboardUrl: 'https://env.example', dashboardUrlFromEnv: true, decoderIndexUrlFromEnv: 'https://dec.example/index.json' }),
      file,
      fn,
    );
    expect(calls).toEqual([]);
    expect(d).toMatchObject({ dashboardUrl: 'https://env.example', dashboardSource: 'env', supabaseSource: 'env', decoderIndexUrl: 'https://dec.example/index.json' });
  });
});
