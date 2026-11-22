import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHealthServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createDbClient } from '../src/db/client.js';

describe('health server', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createHealthServer(() => ({ dbConfigured: false }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('serves /healthz', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, dbConfigured: false });
  });

  it('404s on anything else', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});

describe('config', () => {
  it('has no db client without Supabase env', () => {
    expect(createDbClient(loadConfig({}), async () => 't')).toBeUndefined();
  });

  it('creates a db client when Supabase env is set', () => {
    const config = loadConfig({ SUPABASE_URL: 'http://localhost:54321', SUPABASE_ANON_KEY: 'x' });
    expect(createDbClient(config, async () => 't')).toBeDefined();
  });

  it('rejects an unknown SOURCE', () => {
    expect(() => loadConfig({ SOURCE: 'nope' })).toThrow('Invalid SOURCE');
  });
});
