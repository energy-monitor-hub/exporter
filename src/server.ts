import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { readAsset } from './assets.js';

export interface HealthState {
  /** false → 503, so the container health check shows "unhealthy". Defaults to true. */
  ok?: boolean;
  dbConfigured: boolean;
  [key: string]: unknown;
}

/** What the local status page can ask the exporter for (src/status.ts, wired in index.ts). */
export interface UiApi {
  status(): Promise<unknown>;
  /** Starts the exporter login; resolves with the authorization URL to open. */
  startLogin?(): Promise<{ url: string }>;
  /** Finishes the login from the URL the browser came back to (or that the user pasted). */
  finishLogin?(callbackUrl: string): Promise<void>;
  /** Drop the device connection and connect again. */
  reconnect?(): void;
  /** Setup page: check, encrypt and store the EcoFlow credentials, then connect. */
  saveCredentials?(body: unknown): Promise<void>;
  /** Setup page: stop, delete the stored credentials and their key. */
  forgetCredentials?(): Promise<void>;
  /** Unknown models: census and opt-in samples (src/discovery/). Loopback only. */
  discovery?: {
    status(): Promise<unknown>;
    act(action: string, body: Record<string, unknown>): Promise<unknown>;
  };
}

export interface ServerOptions {
  health: () => HealthState;
  ui?: UiApi;
  /** Static files of the status page; defaults to src/ui (dist/ui after the build). */
  assetsDir?: URL;
  /** Host names accepted besides localhost and IP literals (UI_ALLOWED_HOSTS). */
  allowedHosts?: readonly string[];
}

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

/** POSTs must carry this header: a cross-site page cannot set it without a CORS preflight, which we never allow. */
export const UI_HEADER = 'x-exporter-ui';

function loadAssets(dir: (() => URL) | undefined): Map<string, { type: string; body: Buffer }> {
  const out = new Map<string, { type: string; body: Buffer }>();
  for (const [path, a] of Object.entries(ASSETS)) {
    const body = dir
      ? existsSync(new URL(a.file, dir()))
        ? readFileSync(new URL(a.file, dir()))
        : undefined
      : readAsset(`ui/${a.file}`, () => new URL(`./ui/${a.file}`, import.meta.url));
    if (body) out.set(path, { type: a.type, body });
  }
  return out;
}

/**
 * The status page is meant for this computer only (the port is published to 127.0.0.1).
 * Checking Host also stops DNS rebinding: a web page whose domain points at 127.0.0.1
 * would otherwise be able to read the status and start logins.
 */
export function isAllowedHost(host: string | undefined, extra: readonly string[] = []): boolean {
  if (!host) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  return name === 'localhost' || name.endsWith('.localhost') || name === 'host.docker.internal' || isIP(name) !== 0 || extra.includes(name);
}

/**
 * Credentials may only be changed from this computer: when UI_ALLOWED_HOSTS opens the
 * status page to the LAN, the setup endpoints still answer only to loopback host names.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (name.startsWith('[') && name.endsWith(']')) name = name.slice(1, -1);
  return name === 'localhost' || name.endsWith('.localhost') || name === 'host.docker.internal' || name === '::1' || /^127\.\d+\.\d+\.\d+$/.test(name);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The exporter's HTTP server: `/healthz` for container health checks, and a small local
 * status page at `/` (plain HTML + JS from src/ui, no build step) backed by `/api/*`.
 */
export function createHttpServer(opts: ServerOptions): Server {
  const assetsDir = opts.assetsDir;
  const assets = opts.ui ? loadAssets(assetsDir ? () => assetsDir : undefined) : new Map();
  const ui = opts.ui;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && path === '/healthz') {
      const s = opts.health();
      const ok = s.ok ?? true;
      res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...s, ok }));
      return;
    }

    if (!ui) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found\n');
      return;
    }
    if (!isAllowedHost(req.headers.host, opts.allowedHosts)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden host (add it to UI_ALLOWED_HOSTS)\n');
      return;
    }

    if (req.method === 'GET') {
      const asset = assets.get(path);
      if (asset) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': asset.type });
        res.end(asset.body);
        return;
      }
      if (path === '/api/status') {
        json(res, 200, await ui.status());
        return;
      }
      if (path === '/api/discovery' && ui.discovery) {
        json(res, 200, await ui.discovery.status());
        return;
      }
      if (path === '/callback' && ui.finishLogin) {
        // The browser comes back here from the consent page.
        let target = '/?login=ok';
        try {
          await ui.finishLogin(url.toString());
        } catch (err) {
          target = `/?login_error=${encodeURIComponent(message(err))}`;
        }
        res.writeHead(303, { ...SECURITY_HEADERS, Location: target });
        res.end();
        return;
      }
    }

    if (req.method === 'POST' && path.startsWith('/api/')) {
      if (req.headers[UI_HEADER] !== '1') {
        json(res, 403, { error: `missing ${UI_HEADER} header` });
        return;
      }
      try {
        if (path === '/api/login' && ui.startLogin) {
          json(res, 200, await ui.startLogin());
          return;
        }
        if (path === '/api/login/finish' && ui.finishLogin) {
          const body = (await readJson(req)) as { url?: unknown };
          if (typeof body.url !== 'string') throw new Error('url is required');
          await ui.finishLogin(body.url);
          json(res, 200, { ok: true });
          return;
        }
        if (path === '/api/credentials' || path === '/api/credentials/forget') {
          if (!isLoopbackHost(req.headers.host)) {
            json(res, 403, { error: 'credentials can only be changed from this computer (open the page via 127.0.0.1)' });
            return;
          }
          if (path === '/api/credentials' && ui.saveCredentials) {
            await ui.saveCredentials(await readJson(req));
            json(res, 200, { ok: true });
            return;
          }
          if (path === '/api/credentials/forget' && ui.forgetCredentials) {
            await ui.forgetCredentials();
            json(res, 200, { ok: true });
            return;
          }
        }
        if (path.startsWith('/api/discovery/') && ui.discovery) {
          // Sends data off this machine: only from the computer the exporter runs on.
          if (!isLoopbackHost(req.headers.host)) {
            json(res, 403, { error: 'sharing can only be started from this computer (open the page via 127.0.0.1)' });
            return;
          }
          const body = await readJson(req).catch(() => ({}));
          const result = await ui.discovery.act(path.slice('/api/discovery/'.length), (body && typeof body === 'object' ? body : {}) as Record<string, unknown>);
          json(res, 200, result ?? { ok: true });
          return;
        }
        if (path === '/api/reconnect' && ui.reconnect) {
          ui.reconnect();
          json(res, 202, { ok: true });
          return;
        }
      } catch (err) {
        json(res, 400, { error: message(err) });
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  };

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) json(res, 500, { error: message(err) });
      else res.end();
    });
  });
}

/** Health endpoint only (no status page). */
export function createHealthServer(state: () => HealthState): Server {
  return createHttpServer({ health: state });
}
