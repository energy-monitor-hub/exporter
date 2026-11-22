import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FetchFn } from '../src/oauth/client.js';
import { beginLogin } from '../src/oauth/flow.js';
import { readStoredAuth, writeStoredAuth } from '../src/oauth/session.js';
import { createHttpServer, isAllowedHost, isLoopbackHost, type UiApi } from '../src/server.js';
import { maskSn, OutageHistory, packSummary } from '../src/status.js';

const URL_ = 'https://proj.supabase.co';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: string[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as FetchFn;
  return { fetchFn, calls };
}

describe('status page server', () => {
  let server: Server;
  let base: string;
  const ui = {
    status: vi.fn(async () => ({ hello: 'world' })),
    startLogin: vi.fn(async () => ({ url: 'https://example.test/authorize' })),
    finishLogin: vi.fn(async (u: string) => {
      if (u.includes('error=')) throw new Error('Доступ відхилено');
    }),
    reconnect: vi.fn(),
    saveCredentials: vi.fn(async () => undefined),
    forgetCredentials: vi.fn(async () => undefined),
    discovery: {
      status: vi.fn(async () => ({ available: false })),
      act: vi.fn(async (_action: string, _body: Record<string, unknown>) => ({ result: 'sent' }) as unknown),
    },
  } satisfies UiApi;

  beforeAll(async () => {
    server = createHttpServer({ health: () => ({ dbConfigured: true }), ui });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves the page and its assets', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await res.text()).toContain('/app.js');
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/app.css`)).status).toBe(200);
  });

  it('serves the status JSON', async () => {
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ hello: 'world' });
  });

  it('still serves /healthz', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, dbConfigured: true });
  });

  it('refuses POSTs without the page header (no cross-site form posts)', async () => {
    const res = await fetch(`${base}/api/reconnect`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(ui.reconnect).not.toHaveBeenCalled();
  });

  it('starts a login, reconnects', async () => {
    const h = { 'x-exporter-ui': '1' };
    expect(await (await fetch(`${base}/api/login`, { method: 'POST', headers: h })).json()).toEqual({ url: 'https://example.test/authorize' });
    expect((await fetch(`${base}/api/reconnect`, { method: 'POST', headers: h })).status).toBe(202);
    expect(ui.reconnect).toHaveBeenCalledOnce();
  });

  it('finishes a login from a pasted URL', async () => {
    const res = await fetch(`${base}/api/login/finish`, {
      method: 'POST',
      headers: { 'x-exporter-ui': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:9101/callback?code=c&state=s' }),
    });
    expect(res.status).toBe(200);
    expect(ui.finishLogin).toHaveBeenLastCalledWith('http://127.0.0.1:9101/callback?code=c&state=s');
  });

  it('redirects the consent callback back to the page', async () => {
    const ok = await fetch(`${base}/callback?code=c&state=s`, { redirect: 'manual' });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/?login=ok');
    const bad = await fetch(`${base}/callback?error=access_denied&state=s`, { redirect: 'manual' });
    expect(decodeURIComponent(bad.headers.get('location') ?? '')).toBe('/?login_error=Доступ відхилено');
  });

  it('changes credentials only through a loopback host name', async () => {
    const post = (path: string, host: string, body = '{}') =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'x-exporter-ui': '1', host, 'content-type': 'application/json' }, body });
    expect((await post('/api/credentials', `127.0.0.1`, JSON.stringify({ sn: 'X' }))).status).toBe(200);
    expect(ui.saveCredentials).toHaveBeenCalledWith({ sn: 'X' });
    expect((await post('/api/credentials/forget', 'localhost')).status).toBe(200);
    expect(ui.forgetCredentials).toHaveBeenCalledOnce();
    expect(isLoopbackHost('192.168.1.5:9101')).toBe(false);
    expect(isLoopbackHost('[::1]:9101')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:9101')).toBe(true);
  });

  it('serves discovery status and actions (loopback, with the UI header)', async () => {
    expect(await (await fetch(`${base}/api/discovery`)).json()).toEqual({ available: false });
    const res = await fetch(`${base}/api/discovery/send`, { method: 'POST', headers: { 'x-exporter-ui': '1', 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(res.status).toBe(200);
    expect(ui.discovery.act).toHaveBeenCalledWith('send', { a: 1 });
    expect((await fetch(`${base}/api/discovery/send`, { method: 'POST' })).status).toBe(403);
  });

  it('answers only to local host names (DNS rebinding)', () => {
    for (const h of ['127.0.0.1:9101', 'localhost:9101', '[::1]:9101', '192.168.1.20:9101', 'host.docker.internal:9101', 'app.localhost']) expect(isAllowedHost(h), h).toBe(true);
    for (const h of [undefined, 'evil.example', 'evil.example:9101', '127.0.0.1.evil.example']) expect(isAllowedHost(h), String(h)).toBe(false);
    expect(isAllowedHost('nas.lan:9101', ['nas.lan'])).toBe(true);
  });
});

describe('login flow (shared by npm run login and the status page)', () => {
  const meta = {
    authorization_endpoint: `${URL_}/auth/v1/oauth/authorize`,
    token_endpoint: `${URL_}/auth/v1/oauth/token`,
    registration_endpoint: `${URL_}/auth/v1/oauth/clients/register`,
  };
  const handler = (url: string) => {
    if (url.includes('.well-known')) return { status: 200, body: meta };
    if (url.endsWith('/register')) return { status: 201, body: { client_id: 'new-client' } };
    if (url.endsWith('/token')) return { status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } };
    return { status: 404, body: {} };
  };
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'flow-')), 'oauth.json');

  it('registers once, then reuses the client for the same redirect URI', async () => {
    const path = tmp();
    const redirectUri = 'http://127.0.0.1:9101/callback';
    const { fetchFn, calls } = fakeFetch(handler);
    const first = await beginLogin({ supabaseUrl: URL_, tokenPath: path, clientName: 'Home', redirectUri, fetchFn, now: () => 0 });
    expect(first.registered).toBe(true);
    await first.finishFromUrl(`${redirectUri}?code=c1&state=${first.state}`);
    expect(readStoredAuth(path)).toMatchObject({ client_id: 'new-client', redirect_uri: redirectUri, refresh_token: 'r', expires_at: 3600 });

    const second = await beginLogin({ supabaseUrl: URL_, tokenPath: path, clientName: 'Home', redirectUri, fetchFn });
    expect(second.registered).toBe(false);
    expect(new URL(second.url).searchParams.get('client_id')).toBe('new-client');
    expect(calls.filter((c) => c.endsWith('/register'))).toHaveLength(1);
  });

  it('registers a new client for another redirect URI', async () => {
    const path = tmp();
    writeStoredAuth(path, { supabase_url: URL_, client_id: 'cli', ...meta, redirect_uri: 'http://127.0.0.1:9102/callback', access_token: 'a', refresh_token: 'r', expires_at: 1 });
    const login = await beginLogin({ supabaseUrl: URL_, tokenPath: path, clientName: 'Home', redirectUri: 'http://127.0.0.1:9101/callback', fetchFn: fakeFetch(handler).fetchFn });
    expect(login.registered).toBe(true);
  });

  it('rejects a callback for another request', async () => {
    const login = await beginLogin({ supabaseUrl: URL_, tokenPath: tmp(), clientName: 'Home', redirectUri: 'http://127.0.0.1:9101/callback', fetchFn: fakeFetch(handler).fetchFn });
    await expect(login.finishFromUrl('http://127.0.0.1:9101/callback?code=c&state=other')).rejects.toThrow('state');
  });
});

describe('status summary', () => {
  it('masks the serial number', () => {
    expect(maskSn('ABCDEF123456')).toBe('…3456');
  });

  it('summarizes a pack', () => {
    const p = packSummary({
      pack: 0,
      socPct: 80,
      sohPct: 100,
      cycles: 12,
      cellVoltagesMv: [3300, 3312, 3305],
      cellTempsC: [21, 23],
      minMosTempC: null,
      maxMosTempC: null,
      balanceState: null,
      extra: {},
    });
    expect(p).toMatchObject({ cells: 3, cellMinMv: 3300, cellMaxMv: 3312, cellSpreadMv: 12, tempMinC: 21, tempMaxC: 23 });
  });

  it('caches recent outages and keeps the last rows on an error', async () => {
    let now = 0;
    let fail = false;
    const limit = vi.fn(async () =>
      fail ? { data: null, error: { message: 'JWT expired' } } : { data: [{ started_at: 't0', ended_at: null, soc_start_pct: 90, soc_end_pct: null, energy_out_wh: null, devices: { sn: 'x' } }], error: null },
    );
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit };
    const db = { from: () => chain } as unknown as SupabaseClient;
    const h = new OutageHistory(db, () => 'SN', { ttlMs: 60_000, now: () => now });

    expect((await h.get()).rows).toEqual([{ started_at: 't0', ended_at: null, soc_start_pct: 90, soc_end_pct: null, energy_out_wh: null }]);
    now = 30_000;
    await h.get();
    expect(limit).toHaveBeenCalledOnce();
    now = 61_000;
    fail = true;
    const r = await h.get();
    expect(r.error).toBe('JWT expired');
    expect(r.rows).toHaveLength(1);
  });
});
