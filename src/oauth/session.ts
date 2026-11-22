import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type FetchFn, type OAuthMetadata, OAuthError, refreshTokens, type TokenSet } from './client.js';

/** What `npm run login` leaves on disk (OAUTH_TOKEN_PATH). Secret: mode 0600, never commit. */
export interface StoredAuth extends TokenSet {
  supabase_url: string;
  client_id: string;
  token_endpoint: string;
  authorization_endpoint: string;
  /** Registered with the client; a login on another port registers a new client. */
  redirect_uri: string;
}

export function readStoredAuth(path: string): StoredAuth | undefined {
  if (!existsSync(path)) return undefined;
  const s = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredAuth>;
  if (!s.client_id || !s.refresh_token || !s.token_endpoint || !s.supabase_url) throw new Error(`${path}: incomplete OAuth state, run the login again`);
  return s as StoredAuth;
}

/** Atomic write (tmp + rename), so a crash never leaves half a refresh token behind. */
export function writeStoredAuth(path: string, auth: StoredAuth): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export type AuthState = 'logged-out' | 'ok' | 'revoked' | 'error';

/** Refresh this long before expiry. */
const EARLY_S = 120;

/**
 * Access token for Supabase requests, refreshed from the stored refresh token. Supabase
 * rotates refresh tokens, so every refresh is written back to disk at once.
 *
 * The file is re-read while logged out or revoked, so a fresh login (same volume) is picked
 * up without restarting the exporter.
 */
export class OAuthSession {
  private auth: StoredAuth | undefined;
  private inflight: Promise<string> | undefined;
  private deadRefreshToken: string | undefined;
  private lastState: AuthState = 'logged-out';
  private lastError: string | undefined;

  constructor(
    private readonly path: string,
    private readonly supabaseUrl: string,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): { state: AuthState; error?: string; clientId?: string; expiresAt?: string } {
    return {
      state: this.lastState,
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(this.auth ? { clientId: this.auth.client_id, expiresAt: new Date(this.auth.expires_at * 1000).toISOString() } : {}),
    };
  }

  /** Drop the cached tokens, so the next request reads the token file again (after a new login). */
  reload(): void {
    this.auth = undefined;
    this.lastError = undefined;
  }

  /** Throws while not logged in or revoked; the flusher keeps rows queued and retries. */
  getAccessToken(): Promise<string> {
    this.inflight ??= this.token().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private load(): StoredAuth {
    const a = readStoredAuth(this.path);
    if (!a) {
      this.lastState = 'logged-out';
      throw new Error(`not logged in: no ${this.path}. Run the exporter login (README, "Exporter login")`);
    }
    if (a.supabase_url.replace(/\/+$/, '') !== this.supabaseUrl.replace(/\/+$/, '')) {
      this.lastState = 'error';
      throw new Error(`${this.path} is for ${a.supabase_url}, not SUPABASE_URL=${this.supabaseUrl}: run the login again`);
    }
    if (a.refresh_token === this.deadRefreshToken) {
      this.lastState = 'revoked';
      throw new Error('exporter access was revoked or expired: run the login again');
    }
    return a;
  }

  private async token(): Promise<string> {
    this.auth ??= this.load();
    const nowS = Math.floor(this.now() / 1000);
    if (this.auth.expires_at - EARLY_S > nowS) {
      this.lastState = 'ok';
      return this.auth.access_token;
    }
    const meta: OAuthMetadata = { authorization_endpoint: this.auth.authorization_endpoint, token_endpoint: this.auth.token_endpoint };
    try {
      const t = await refreshTokens(meta, this.auth.client_id, this.auth.refresh_token, this.fetchFn, this.now);
      this.auth = { ...this.auth, ...t };
      writeStoredAuth(this.path, this.auth);
      this.lastState = 'ok';
      this.lastError = undefined;
      return t.access_token;
    } catch (err) {
      this.lastError = (err as Error).message;
      if (err instanceof OAuthError && err.isRevoked) {
        this.deadRefreshToken = this.auth.refresh_token;
        this.auth = undefined;
        this.lastState = 'revoked';
        throw new Error(`exporter access was revoked or expired (${err.message}): run the login again`);
      }
      // Network / 5xx: keep the refresh token, try again on the next flush.
      this.lastState = 'error';
      throw err;
    }
  }
}
