import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CredentialFile } from '../src/secrets/credentials.js';
import { newKey, open, seal } from '../src/secrets/crypto.js';

const creds = { username: 'me@example.org', password: 'pa55 wörd', sn: 'TESTSN0001' };

describe('seal / open', () => {
  it('round-trips and rejects a wrong key, another context or tampering', () => {
    const key = newKey();
    const s = seal(key, 'ctx', creds);
    expect(open(key, 'ctx', s)).toEqual(creds);
    expect(() => open(newKey(), 'ctx', s)).toThrow('cannot decrypt');
    expect(() => open(key, 'other', s)).toThrow('cannot decrypt');
    const ct = Buffer.from(s.ct, 'base64');
    ct[0] = ct[0]! ^ 1;
    expect(() => open(key, 'ctx', { ...s, ct: ct.toString('base64') })).toThrow('cannot decrypt');
  });

  it('uses a fresh nonce every time', () => {
    const key = newKey();
    expect(seal(key, 'a', creds).iv).not.toBe(seal(key, 'a', creds).iv);
  });
});

describe('CredentialFile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'));

  it('writes 0600 without the password in clear text and reads it back', () => {
    const f = new CredentialFile(join(dir, 'a', 'credentials.json'));
    const key = newKey();
    f.write(key, 'client-1', creds);
    const raw = readFileSync(f.path, 'utf8');
    expect(raw).not.toContain('pa55');
    expect(raw).not.toContain('TESTSN0001');
    expect(raw).not.toContain('example.org');
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(f.clientId()).toBe('client-1');
    expect(f.read(key, 'client-1')).toEqual(creds);
  });

  it('refuses a file of another exporter login, and the wrong key', () => {
    const f = new CredentialFile(join(dir, 'b.json'));
    const key = newKey();
    f.write(key, 'client-1', creds);
    expect(() => f.read(key, 'client-2')).toThrow('another exporter login');
    expect(() => f.read(newKey(), 'client-1')).toThrow('cannot decrypt');
  });

  it('cannot be moved to another exporter by editing client_id', () => {
    const f = new CredentialFile(join(dir, 'c.json'));
    const key = newKey();
    f.write(key, 'client-1', creds);
    writeFileSync(f.path, readFileSync(f.path, 'utf8').replace('client-1', 'client-2'));
    expect(() => f.read(key, 'client-2')).toThrow('cannot decrypt');
  });

  it('validates what it stores', () => {
    const f = new CredentialFile(join(dir, 'd.json'));
    expect(() => f.write(newKey(), 'c', { ...creds, sn: 'bad sn!' })).toThrow();
    expect(() => f.write(newKey(), 'c', { ...creds, apiHost: 'evil.example.org' })).toThrow();
    f.remove();
    expect(f.exists()).toBe(false);
  });
});
