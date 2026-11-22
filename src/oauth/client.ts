import { createHash, randomBytes } from 'node:crypto';

/**
 * Minimal OAuth 2.1 client for the Supabase Auth OAuth server: discovery, dynamic client
 * registration (RFC 7591), authorization code + PKCE, refresh. The exporter is a public
 * client (no secret); Supabase issues normal user JWTs, so RLS sees auth.uid() = the user
 * who approved the exporter on the dashboard's consent page.
 */

export type FetchFn = typeof fetch;

export interface OAuthMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  /** Unix seconds. */
  expires_at: number;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** OAuth `error` code, e.g. invalid_grant (revoked or expired refresh token). */
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'OAuthError';
  }

  /** The grant is gone (revoked on /exporters, or expired): only a new login helps. */
  get isRevoked(): boolean {
    return this.code === 'invalid_grant' || this.code === 'unauthorized_client' || this.code === 'invalid_client';
  }
}

const trim = (url: string) => url.replace(/\/+$/, '');

/** Where the Supabase Auth server lives: `<project>/auth/v1`. */
export const authBase = (supabaseUrl: string) => `${trim(supabaseUrl)}/auth/v1`;

/**
 * RFC 8414 metadata. Supabase serves it both at the path-inserted well-known URL and under
 * /auth/v1; if neither answers, fall back to Supabase's fixed endpoint paths.
 */
export async function discover(supabaseUrl: string, fetchFn: FetchFn = fetch): Promise<OAuthMetadata> {
  const base = trim(supabaseUrl);
  for (const url of [`${base}/.well-known/oauth-authorization-server/auth/v1`, `${base}/auth/v1/.well-known/oauth-authorization-server`]) {
    try {
      const res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const meta = (await res.json()) as Partial<OAuthMetadata>;
      if (meta.authorization_endpoint && meta.token_endpoint) return meta as OAuthMetadata;
    } catch {
      // try the next one
    }
  }
  const auth = authBase(base);
  return {
    authorization_endpoint: `${auth}/oauth/authorize`,
    token_endpoint: `${auth}/oauth/token`,
    registration_endpoint: `${auth}/oauth/clients/register`,
  };
}

async function readError(res: Response, what: string): Promise<OAuthError> {
  let code: string | undefined;
  let desc = '';
  try {
    const body = (await res.json()) as { error?: string; error_description?: string; msg?: string; message?: string };
    code = body.error;
    desc = body.error_description ?? body.msg ?? body.message ?? '';
  } catch {
    // not JSON
  }
  return new OAuthError(`${what}: HTTP ${res.status}${code ? ` ${code}` : ''}${desc ? `: ${desc}` : ''}`, res.status, code);
}

/** Registers this exporter as its own public client; the dashboard lists it by `name`. */
export async function registerClient(meta: OAuthMetadata, name: string, redirectUri: string, fetchFn: FetchFn = fetch): Promise<string> {
  if (!meta.registration_endpoint) throw new Error('OAuth server has no dynamic client registration (oauth_server_allow_dynamic_registration)');
  const res = await fetchFn(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok) throw await readError(res, 'Client registration');
  const body = (await res.json()) as { client_id?: string };
  if (!body.client_id) throw new Error('Client registration: no client_id in the response');
  return body.client_id;
}

const b64url = (buf: Buffer) => buf.toString('base64url');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export const randomState = () => b64url(randomBytes(16));

export function authorizeUrl(meta: OAuthMetadata, p: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state);
  return u.toString();
}

async function tokenRequest(meta: OAuthMetadata, form: Record<string, string>, what: string, fetchFn: FetchFn, now: () => number): Promise<TokenSet> {
  const res = await fetchFn(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw await readError(res, what);
  const body = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number };
  if (!body.access_token || !body.refresh_token) throw new Error(`${what}: no access_token / refresh_token in the response`);
  const expiresAt = body.expires_at ?? Math.floor(now() / 1000) + (body.expires_in ?? 3600);
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: expiresAt };
}

export function exchangeCode(
  meta: OAuthMetadata,
  p: { clientId: string; code: string; redirectUri: string; verifier: string },
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<TokenSet> {
  return tokenRequest(
    meta,
    { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier },
    'Code exchange',
    fetchFn,
    now,
  );
}

export function refreshTokens(meta: OAuthMetadata, clientId: string, refreshToken: string, fetchFn: FetchFn = fetch, now: () => number = Date.now): Promise<TokenSet> {
  return tokenRequest(meta, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, 'Token refresh', fetchFn, now);
}

/** Pulls code / error out of the URL the browser was sent to after the consent page. */
export function parseCallback(url: string, expectedState: string): { code: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { error: 'Not a URL: paste the full address from the browser\'s address bar' };
  }
  const p = u.searchParams;
  if (p.get('state') !== expectedState) return { error: 'state does not match: this is the answer to another login request' };
  const err = p.get('error');
  if (err) return { error: err === 'access_denied' ? 'Access was denied on the consent page' : `${err}: ${p.get('error_description') ?? ''}`.trim() };
  const code = p.get('code');
  return code ? { code } : { error: 'The address has no code' };
}
