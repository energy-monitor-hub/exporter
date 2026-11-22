import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorizeUrl, discover, exchangeCode, type FetchFn, parseCallback, pkcePair, registerClient } from '../src/oauth/client.js';
import { OAuthSession, readStoredAuth, type StoredAuth, writeStoredAuth } from '../src/oauth/session.js';

const URL_ = 'https://proj.supabase.co';
const meta = {
  authorization_endpoint: `${URL_}/auth/v1/oauth/authorize`,
  token_endpoint: `${URL_}/auth/v1/oauth/token`,
  registration_endpoint: `${URL_}/auth/v1/oauth/clients/register`,
};

type Call = { url: string; init: RequestInit | undefined };
function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): { fetchFn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as FetchFn;
  return { fetchFn, calls };
}

describe('OAuth client', () => {
  it('uses discovery metadata when the server has it', async () => {
    const { fetchFn, calls } = fakeFetch((url) => (url.endsWith('/.well-known/oauth-authorization-server/auth/v1') ? { status: 200, body: { ...meta, issuer: 'x' } } : { status: 404, body: {} }));
    expect((await discover(URL_, fetchFn)).token_endpoint).toBe(meta.token_endpoint);
    expect(calls).toHaveLength(1);
  });

  it('falls back to the fixed Supabase paths', async () => {
    const { fetchFn } = fakeFetch(() => ({ status: 404, body: {} }));
    expect(await discover(`${URL_}/`, fetchFn)).toEqual(meta);
  });

  it('registers a public client', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 201, body: { client_id: 'cid' } }));
    expect(await registerClient(meta, 'Mac mini', 'http://127.0.0.1:9102/callback', fetchFn)).toBe('cid');
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ client_name: 'Mac mini', redirect_uris: ['http://127.0.0.1:9102/callback'], token_endpoint_auth_method: 'none' });
  });

  it('builds an S256 PKCE authorize URL', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const u = new URL(authorizeUrl(meta, { clientId: 'cid', redirectUri: 'http://127.0.0.1:9102/callback', challenge, state: 'st' }));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:9102/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st',
    });
  });

  it('exchanges the code with the verifier', async () => {
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { access_token: 'a', refresh_token: 'r', expires_in: 3600 } }));
    const t = await exchangeCode(meta, { clientId: 'cid', code: 'c', redirectUri: 'http://127.0.0.1:9102/callback', verifier: 'v' }, fetchFn, () => 1_000_000);
    expect(t).toEqual({ access_token: 'a', refresh_token: 'r', expires_at: 1000 + 3600 });
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init!.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      redirect_uri: 'http://127.0.0.1:9102/callback',
      client_id: 'cid',
      code_verifier: 'v',
    });
  });

  it('parses the callback (pasted or loopback)', () => {
    expect(parseCallback('http://127.0.0.1:9102/callback?code=abc&state=st', 'st')).toEqual({ code: 'abc' });
    expect(parseCallback('  http://127.0.0.1:9102/callback?code=abc&state=st \n', 'st')).toEqual({ code: 'abc' });
    expect(parseCallback('http://127.0.0.1:9102/callback?code=abc&state=other', 'st')).toHaveProperty('error');
    expect(parseCallback('http://127.0.0.1:9102/callback?error=access_denied&state=st', 'st')).toEqual({ error: 'Access was denied on the consent page' });
    expect(parseCallback('abc', 'st')).toHaveProperty('error');
  });
});

describe('OAuthSession', () => {
  const stored = (over: Partial<StoredAuth> = {}): StoredAuth => ({
    supabase_url: URL_,
    client_id: 'cid',
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    redirect_uri: 'http://127.0.0.1:9102/callback',
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: 2000,
    ...over,
  });
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'oauth-')), 'oauth.json');

  it('is logged out without a token file, then picks up a login', async () => {
    const path = tmp();
    const s = new OAuthSession(path, URL_, fakeFetch(() => ({ status: 500, body: {} })).fetchFn, () => 1_000_000);
    await expect(s.getAccessToken()).rejects.toThrow('not logged in');
    expect(s.state.state).toBe('logged-out');
    writeStoredAuth(path, stored());
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await s.getAccessToken()).toBe('a1');
    expect(s.state.state).toBe('ok');
  });

  it('refreshes before expiry and saves the rotated refresh token', async () => {
    const path = tmp();
    writeStoredAuth(path, stored({ expires_at: 1000 + 60 }));
    const { fetchFn, calls } = fakeFetch(() => ({ status: 200, body: { access_token: 'a2', refresh_token: 'r2', expires_in: 3600 } }));
    const s = new OAuthSession(path, URL_, fetchFn, () => 1_000_000);
    const [x, y] = await Promise.all([s.getAccessToken(), s.getAccessToken()]);
    expect([x, y]).toEqual(['a2', 'a2']);
    expect(calls).toHaveLength(1); // single flight
    expect(Object.fromEntries(new URLSearchParams(String(calls[0]!.init!.body)))).toEqual({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: 'cid' });
    expect(readStoredAuth(path)).toMatchObject({ access_token: 'a2', refresh_token: 'r2', expires_at: 4600 });
    expect(JSON.parse(readFileSync(path, 'utf8')).client_id).toBe('cid');
  });

  it('reports a revoked grant and recovers after a new login', async () => {
    const path = tmp();
    writeStoredAuth(path, stored({ expires_at: 0 }));
    const { fetchFn, calls } = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh Token Not Found' } }));
    const s = new OAuthSession(path, URL_, fetchFn, () => 1_000_000);
    await expect(s.getAccessToken()).rejects.toThrow('revoked');
    await expect(s.getAccessToken()).rejects.toThrow('revoked');
    expect(calls).toHaveLength(1); // the dead token is not retried
    expect(s.state.state).toBe('revoked');
    writeStoredAuth(path, stored({ access_token: 'new', refresh_token: 'r9', expires_at: 9999 }));
    expect(await s.getAccessToken()).toBe('new');
  });

  it('keeps the refresh token on a network error', async () => {
    const path = tmp();
    writeStoredAuth(path, stored({ expires_at: 0 }));
    let fail = true;
    const { fetchFn } = fakeFetch(() => (fail ? { status: 503, body: {} } : { status: 200, body: { access_token: 'a3', refresh_token: 'r3', expires_in: 3600 } }));
    const s = new OAuthSession(path, URL_, fetchFn, () => 1_000_000);
    await expect(s.getAccessToken()).rejects.toThrow('HTTP 503');
    expect(s.state.state).toBe('error');
    fail = false;
    expect(await s.getAccessToken()).toBe('a3');
  });

  it('refuses tokens of another project', async () => {
    const path = tmp();
    writeStoredAuth(path, stored({ supabase_url: 'https://other.supabase.co' }));
    await expect(new OAuthSession(path, URL_, fetch, () => 1_000_000).getAccessToken()).rejects.toThrow('not SUPABASE_URL');
  });
});
