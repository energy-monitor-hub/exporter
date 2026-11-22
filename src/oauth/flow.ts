import { authorizeUrl, discover, exchangeCode, type FetchFn, parseCallback, pkcePair, randomState, registerClient } from './client.js';
import { readStoredAuth, writeStoredAuth } from './session.js';

export interface LoginOptions {
  supabaseUrl: string;
  tokenPath: string;
  /** Shown on the dashboard's "Exporters" page when a new client is registered. */
  clientName: string;
  /** Where the browser comes back after the consent page. */
  redirectUri: string;
  fetchFn?: FetchFn;
  now?: () => number;
}

/** One authorization request: open `url`, then hand the code (or the callback URL) back. */
export interface PendingLogin {
  url: string;
  state: string;
  /** True when this login registered a new OAuth client (not reused from the token file). */
  registered: boolean;
  /** Exchanges the code for tokens and writes them to the token file. */
  finish(code: string): Promise<void>;
  /** Same, from the URL the browser was sent to (loopback callback or pasted). */
  finishFromUrl(callbackUrl: string): Promise<void>;
}

/**
 * Starts the exporter login (OAuth 2.1 + PKCE). Shared by `npm run login` and the local
 * status page. The client registered earlier is reused when it is for the same project and
 * redirect URI, so the dashboard keeps one row per exporter.
 */
export async function beginLogin(o: LoginOptions): Promise<PendingLogin> {
  const fetchFn = o.fetchFn ?? fetch;
  const meta = await discover(o.supabaseUrl, fetchFn);
  let previous;
  try {
    previous = readStoredAuth(o.tokenPath);
  } catch {
    previous = undefined;
  }
  let clientId = previous && previous.supabase_url === o.supabaseUrl && previous.redirect_uri === o.redirectUri ? previous.client_id : undefined;
  const registered = !clientId;
  clientId ??= await registerClient(meta, o.clientName, o.redirectUri, fetchFn);

  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const url = authorizeUrl(meta, { clientId, redirectUri: o.redirectUri, challenge, state });
  const cid = clientId;

  const finish = async (code: string) => {
    const tokens = await exchangeCode(meta, { clientId: cid, code, redirectUri: o.redirectUri, verifier }, fetchFn, o.now);
    writeStoredAuth(o.tokenPath, {
      supabase_url: o.supabaseUrl,
      client_id: cid,
      authorization_endpoint: meta.authorization_endpoint,
      token_endpoint: meta.token_endpoint,
      redirect_uri: o.redirectUri,
      ...tokens,
    });
  };
  return {
    url,
    state,
    registered,
    finish,
    finishFromUrl: (callbackUrl) => {
      const r = parseCallback(callbackUrl, state);
      return 'code' in r ? finish(r.code) : Promise.reject(new Error(r.error));
    },
  };
}
