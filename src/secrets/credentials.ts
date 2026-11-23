import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { open, type Sealed, seal } from './crypto.js';

/**
 * What the setup page stores: the device plugin's id (src/sources/) and its credentials,
 * still unvalidated (the plugin's own schema checks them). Files written before plugins
 * existed hold EcoFlow credentials without a `device` field.
 */
export interface StoredCredentials {
  device: string;
  credentials: Record<string, unknown>;
}

/** Plugin of files that predate the `device` field. */
const LEGACY_DEVICE = 'ecoflow-mqtt';

const bodySchema = z.record(z.string(), z.unknown());

const sealedSchema = z.object({
  v: z.literal(1),
  alg: z.literal('A256GCM'),
  iv: z.string(),
  tag: z.string(),
  ct: z.string(),
});

const fileSchema = z.object({
  format: z.literal('ecoflow-dashboard/credentials/1'),
  /** OAuth client id of the exporter whose server-side key encrypts this file. */
  client_id: z.string().min(1),
  sealed: sealedSchema,
});

const aad = (clientId: string) => `ecoflow-dashboard/credentials/1|${clientId}`;

/**
 * Encrypted credentials on the data volume (CREDENTIALS_PATH, mode 0600). The key is not on
 * the volume: it is held by Supabase per exporter (public.exporter_key), so a copy of the
 * volume is useless once the exporter is revoked.
 */
export class CredentialFile {
  constructor(readonly path: string) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /** The exporter (OAuth client) the file belongs to, without decrypting it. */
  clientId(): string | undefined {
    return this.exists() ? this.readFile().client_id : undefined;
  }

  read(key: Uint8Array, clientId: string): StoredCredentials {
    const f = this.readFile();
    if (f.client_id !== clientId) throw new Error('credentials were saved by another exporter login: enter them again');
    const { device, ...credentials } = bodySchema.parse(open(key, aad(clientId), f.sealed as Sealed));
    return { device: typeof device === 'string' ? device : LEGACY_DEVICE, credentials };
  }

  /** Atomic write (tmp + rename), 0600. */
  /** Flat body (`device` next to the fields), so an older exporter can still read EcoFlow files. */
  write(key: Uint8Array, clientId: string, stored: StoredCredentials): void {
    const body = { format: 'ecoflow-dashboard/credentials/1', client_id: clientId, sealed: seal(key, aad(clientId), { ...stored.credentials, device: stored.device }) };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }

  private readFile() {
    return fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8')));
  }
}
