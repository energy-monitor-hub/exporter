import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { open, type Sealed, seal } from './crypto.js';

/** What the setup page stores: the EcoFlow app account and the station to read. */
export const ecoflowCredentialsSchema = z.object({
  username: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
  sn: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,40}$/, 'serial number: 6-40 letters and digits'),
  apiHost: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+\.ecoflow\.com$/, 'API host must be an ecoflow.com host name')
    .optional(),
});

export type EcoflowCredentials = z.infer<typeof ecoflowCredentialsSchema>;

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

  read(key: Uint8Array, clientId: string): EcoflowCredentials {
    const f = this.readFile();
    if (f.client_id !== clientId) throw new Error('credentials were saved by another exporter login: enter them again');
    return ecoflowCredentialsSchema.parse(open(key, aad(clientId), f.sealed as Sealed));
  }

  /** Atomic write (tmp + rename), 0600. */
  write(key: Uint8Array, clientId: string, creds: EcoflowCredentials): void {
    const body = { format: 'ecoflow-dashboard/credentials/1', client_id: clientId, sealed: seal(key, aad(clientId), ecoflowCredentialsSchema.parse(creds)) };
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
