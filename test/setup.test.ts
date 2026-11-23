import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { OAuthSession } from '../src/oauth/session.js';
import { CredentialFile } from '../src/secrets/credentials.js';
import { newKey } from '../src/secrets/crypto.js';
import { CredentialSetup, type DeviceSetup, type SetupDeps } from '../src/setup.js';
import { ecoflowPlugin } from '../src/sources/ecoflow.js';
import type { AnyDevicePlugin, DeviceCredentials } from '../src/sources/types.js';

const creds = { username: 'me@example.org', password: 'secret', sn: 'TESTSN0001' };
const stored = (c: Record<string, unknown> = creds) => ({ device: 'ecoflow-mqtt', credentials: c });
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function fakeSession(state: 'ok' | 'logged-out', clientId = 'client-1') {
  const s = { state: state === 'ok' ? { state, clientId } : { state }, getAccessToken: vi.fn(async () => 'token') };
  return s as unknown as OAuthSession & { state: { state: string; clientId?: string } };
}

function deps(over: Partial<SetupDeps> = {}, verify: AnyDevicePlugin['verify'] = vi.fn(async () => undefined)) {
  const key = newKey();
  const applied: DeviceCredentials[] = [];
  // The EcoFlow plugin, without its network check.
  const plugin: AnyDevicePlugin = { ...ecoflowPlugin, verify };
  const d: SetupDeps = {
    file: new CredentialFile(join(mkdtempSync(join(tmpdir(), 'setup-')), 'credentials.json')),
    db: {} as SupabaseClient,
    session: fakeSession('ok'),
    fromEnv: false,
    plugin,
    pluginById: (id) => (id === plugin.id ? plugin : undefined),
    apply: vi.fn(async (d: DeviceSetup) => void applied.push(d.credentials)),
    stop: vi.fn(async () => undefined),
    log,
    fetchKey: vi.fn(async () => key),
    forgetKey: vi.fn(async () => undefined),
    ...over,
  };
  return { d, key, applied, plugin };
}

describe('CredentialSetup', () => {
  it('starts in needs-setup, saves encrypted and applies', async () => {
    const { d, applied } = deps();
    const s = new CredentialSetup(d);
    expect(s.status()).toMatchObject({ state: 'needs-setup', canEdit: true });
    await s.save({ ...creds, username: '  me@example.org ' });
    expect(d.plugin.verify).toHaveBeenCalledOnce();
    expect(applied).toEqual([creds]);
    expect(d.file.exists()).toBe(true);
    expect(s.status()).toMatchObject({ state: 'ready', sn: '…0001' });
  });

  it('does not store credentials EcoFlow rejects', async () => {
    const { d } = deps({}, async () => Promise.reject(new Error('EcoFlow: wrong password')));
    await expect(new CredentialSetup(d).save(creds)).rejects.toThrow('wrong password');
    expect(d.file.exists()).toBe(false);
  });

  it('rejects invalid input with a readable message', async () => {
    const { d } = deps();
    await expect(new CredentialSetup(d).save({ ...creds, sn: 'x' })).rejects.toThrow('sn:');
  });

  it('needs the exporter login before saving', async () => {
    const { d } = deps({ session: fakeSession('logged-out') });
    const s = new CredentialSetup(d);
    expect(s.status().canEdit).toBe(false);
    await expect(s.save(creds)).rejects.toThrow('log in first');
  });

  it('unlocks stored credentials after a restart', async () => {
    const { d, key, applied } = deps();
    d.file.write(key, 'client-1', stored());
    const s = new CredentialSetup(d);
    expect(s.status().state).toBe('locked');
    await s.unlock();
    expect(applied).toEqual([creds]);
    expect(s.status().state).toBe('ready');
    await s.unlock(); // no-op once ready
    expect(applied).toHaveLength(1);
  });

  it('stays locked while logged out and errors on a deleted key', async () => {
    const { d, key } = deps({ session: fakeSession('logged-out') });
    d.file.write(key, 'client-1', stored());
    const s = new CredentialSetup(d);
    await s.unlock();
    expect(s.status().state).toBe('locked');

    const other = deps({ fetchKey: async () => newKey() });
    other.d.file.write(key, 'client-1', stored());
    const s2 = new CredentialSetup(other.d);
    await s2.unlock();
    expect(s2.status()).toMatchObject({ state: 'error' });
    expect(other.d.apply).not.toHaveBeenCalled();
  });

  it('forgets: stops, deletes the file and the server key', async () => {
    const { d } = deps();
    const s = new CredentialSetup(d);
    await s.save(creds);
    await s.forget();
    expect(d.stop).toHaveBeenCalled();
    expect(d.forgetKey).toHaveBeenCalled();
    expect(d.file.exists()).toBe(false);
    expect(s.status().state).toBe('needs-setup');
  });

  it('is read-only when .env has the credentials', async () => {
    const { d } = deps({ fromEnv: true });
    const s = new CredentialSetup(d);
    expect(s.status()).toMatchObject({ state: 'env', canEdit: false });
    await expect(s.save(creds)).rejects.toThrow('.env');
    await expect(s.forget()).rejects.toThrow('.env');
  });

  it('describes the form from the plugin', () => {
    const { d } = deps();
    const form = new CredentialSetup(d).status().form;
    expect(form.device).toBe('ecoflow-mqtt');
    expect(form.fields.map((f) => f.name)).toEqual(['username', 'password', 'sn', 'apiHost']);
    expect(form.envVars).toContain('DEVICE_SN');
  });

  it('refuses a stored file of an unknown kind of device', async () => {
    const { d, key } = deps();
    d.file.write(key, 'client-1', { device: 'nope', credentials: creds });
    const s = new CredentialSetup(d);
    await s.unlock();
    expect(s.status()).toMatchObject({ state: 'error', reason: expect.stringContaining('unknown kind of device') });
    expect(d.apply).not.toHaveBeenCalled();
  });

  it('validates stored credentials with the plugin schema', async () => {
    const { d, key } = deps();
    d.file.write(key, 'client-1', stored({ ...creds, apiHost: 'evil.example.org' }));
    const s = new CredentialSetup(d);
    await s.unlock();
    expect(s.status()).toMatchObject({ state: 'error', reason: expect.stringContaining('apiHost') });
  });
});
