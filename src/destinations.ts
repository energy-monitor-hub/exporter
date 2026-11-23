import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Where the exporter sends things besides EcoFlow: the dashboard it belongs to, and through it
 * the Supabase project (data and login), decoder packs and the release list.
 *
 * This is the project's own hosted dashboard, so `docker compose up` needs no settings. The
 * dashboard publishes `<dashboard>/exporter.json` with its Supabase URL and public anon key.
 * For development, .env can point elsewhere: DASHBOARD_URL, or SUPABASE_URL + SUPABASE_ANON_KEY,
 * DECODER_INDEX_URL and EXPORTER_RELEASES_URL one by one. The status page shows what is in use
 * ("Where data goes") but cannot change it.
 */
export const DEFAULT_DASHBOARD_URL = 'https://energy-monitor-hub.web.app';

/** What `<dashboard>/exporter.json` says. The anon key is public by design (RLS applies). */
export interface DashboardInfo {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

/** Last good exporter.json (DASHBOARD_CACHE_PATH), so a restart without network still knows where to write. */
export interface DashboardCache {
  dashboard?: DashboardInfo & { url: string };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * `https://host[:port][/path]` without a trailing slash. Plain http only when `allowHttp`
 * (a local dashboard while developing) or for loopback hosts.
 */
export function normalizeDashboardUrl(raw: string, opts: { allowHttp?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`not a valid address: ${raw}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && (opts.allowHttp || LOOPBACK.has(u.hostname)))) {
    throw new Error('the dashboard address must start with https://');
  }
  if (u.username || u.password) throw new Error('the dashboard address must not contain a user name or password');
  if (u.search || u.hash) throw new Error('the dashboard address must not contain ? or #');
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
}

function isHttpUrl(v: unknown, https: boolean): v is string {
  if (typeof v !== 'string' || v.length > 500) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || (!https && u.protocol === 'http:')) && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** Checks exporter.json. Supabase over https unless the dashboard itself is plain http (local). */
export function parseDashboardInfo(body: unknown, dashboardUrl: string): DashboardInfo {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const https = dashboardUrl.startsWith('https:');
  if (!isHttpUrl(b.supabaseUrl, https)) throw new Error('exporter.json: supabaseUrl is missing or not an https address');
  const key = b.supabaseAnonKey;
  if (typeof key !== 'string' || !/^[\w.-]{10,1000}$/.test(key)) throw new Error('exporter.json: supabaseAnonKey is missing or malformed');
  return { supabaseUrl: b.supabaseUrl.replace(/\/+$/, ''), supabaseAnonKey: key };
}

const MAX_BYTES = 16 * 1024;

/** GET `<dashboard>/exporter.json` (no redirects, 10 s, 16 KB). Sends no identifiers. */
export async function fetchDashboardInfo(dashboardUrl: string, fetchFn: typeof fetch = fetch): Promise<DashboardInfo> {
  const url = `${dashboardUrl}/exporter.json`;
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
  } catch (err) {
    throw new Error(`${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`${url}: response too large`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${url}: not JSON (is this an Energy Monitor Hub dashboard?)`);
  }
  return parseDashboardInfo(body, dashboardUrl);
}

/** DASHBOARD_CACHE_PATH on the data volume. Not secret (the anon key is public), still 0600 like the rest. */
export class DashboardCacheFile {
  constructor(readonly path: string) {}

  read(): DashboardCache {
    if (!existsSync(this.path)) return {};
    try {
      const s = JSON.parse(readFileSync(this.path, 'utf8')) as DashboardCache;
      return s && typeof s === 'object' ? s : {};
    } catch {
      return {};
    }
  }

  write(s: DashboardCache): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}

export interface DestinationEnv {
  dashboardUrl: string;
  dashboardUrlFromEnv: boolean;
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  decoderIndexUrlFromEnv: string | undefined;
}

export interface Destinations {
  dashboardUrl: string;
  /** Where the dashboard address comes from. */
  dashboardSource: 'default' | 'env';
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  /** env: SUPABASE_URL + SUPABASE_ANON_KEY; dashboard: its exporter.json (fresh or cached). */
  supabaseSource: 'env' | 'dashboard' | undefined;
  decoderIndexUrl: string;
  /** Why Supabase is unknown (exporter.json could not be read and nothing is cached). */
  error?: string;
}

/**
 * Works out every destination at start. Fetches exporter.json unless .env names Supabase; on a
 * network error it uses the last good copy for the same dashboard.
 */
export async function resolveDestinations(
  env: DestinationEnv,
  file: DashboardCacheFile,
  fetchFn: typeof fetch = fetch,
): Promise<Destinations> {
  const cache = file.read();
  const url = env.dashboardUrl;
  const base = {
    dashboardUrl: url,
    dashboardSource: env.dashboardUrlFromEnv ? ('env' as const) : ('default' as const),
    decoderIndexUrl: env.decoderIndexUrlFromEnv ?? `${url}/decoders/index.json`,
  };
  if (env.supabaseUrl && env.supabaseAnonKey) {
    return { ...base, supabaseUrl: env.supabaseUrl, supabaseAnonKey: env.supabaseAnonKey, supabaseSource: 'env' };
  }
  try {
    const info = await fetchDashboardInfo(url, fetchFn);
    const cached = cache.dashboard;
    if (!cached || cached.url !== url || cached.supabaseUrl !== info.supabaseUrl || cached.supabaseAnonKey !== info.supabaseAnonKey) {
      file.write({ dashboard: { url, ...info } });
    }
    return { ...base, ...info, supabaseSource: 'dashboard' };
  } catch (err) {
    const cached = cache.dashboard;
    if (cached && cached.url === url) {
      return { ...base, supabaseUrl: cached.supabaseUrl, supabaseAnonKey: cached.supabaseAnonKey, supabaseSource: 'dashboard' };
    }
    return { ...base, supabaseUrl: undefined, supabaseAnonKey: undefined, supabaseSource: undefined, error: (err as Error).message };
  }
}
