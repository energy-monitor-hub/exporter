import type { SupabaseClient } from '@supabase/supabase-js';
import { ZodError } from 'zod';
import type { Logger } from './mqtt/client.js';
import type { OAuthSession } from './oauth/session.js';
import { type CredentialFile, type EcoflowCredentials, ecoflowCredentialsSchema } from './secrets/credentials.js';
import { fetchExporterKey, forgetExporterKey } from './secrets/keys.js';

/**
 * Where the EcoFlow credentials come from, as the status page shows it:
 * - `env`: ECOFLOW_USERNAME / ECOFLOW_PASSWORD / DEVICE_SN in .env (the setup page is read-only);
 * - `needs-setup`: nothing stored yet, the page asks for them;
 * - `locked`: stored encrypted, waiting for the exporter login to fetch the key;
 * - `ready`: decrypted (in memory only) and handed to the device source;
 * - `error`: stored, but they cannot be opened (another exporter login, key deleted).
 */
export type SetupState = 'env' | 'needs-setup' | 'locked' | 'ready' | 'error';

export interface SetupStatus {
  state: SetupState;
  /** Set for `locked` / `error`. */
  reason?: string;
  /** Masked serial number of the stored device, when known. */
  sn?: string;
  /** The setup form may be used (loopback host, Supabase configured, logged in). */
  canEdit: boolean;
}

export interface SetupDeps {
  file: CredentialFile;
  db: SupabaseClient | undefined;
  session: OAuthSession | undefined;
  /** True when .env has the credentials: they win, the page cannot change them. */
  fromEnv: boolean;
  /** Checks the account with EcoFlow before anything is stored (throws on bad credentials). */
  verify: (c: EcoflowCredentials) => Promise<void>;
  /** Start (or restart) the device source with these credentials. */
  apply: (c: EcoflowCredentials) => Promise<void>;
  /** Stop the device source (credentials forgotten). */
  stop: () => Promise<void>;
  log: Logger;
  fetchKey?: (db: SupabaseClient) => Promise<Buffer>;
  forgetKey?: (db: SupabaseClient) => Promise<void>;
}

const maskSn = (sn: string) => (sn.length > 4 ? `…${sn.slice(-4)}` : sn);

/** First Zod issue as one readable line. */
function describe(err: unknown): string {
  if (err instanceof ZodError) {
    const i = err.issues[0];
    return i ? `${i.path.join('.') || 'input'}: ${i.message}` : 'invalid input';
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Credentials from the setup page: verify with EcoFlow, encrypt with this exporter's
 * server-held key, store on the data volume, start the source. On restart: log in to
 * Supabase first, fetch the key, decrypt, then connect.
 */
export class CredentialSetup {
  private current: SetupStatus;
  private sn: string | undefined;
  private busy: Promise<void> | undefined;

  constructor(private readonly d: SetupDeps) {
    if (d.fromEnv) this.current = { state: 'env', canEdit: false };
    else if (d.file.exists()) this.current = { state: 'locked', reason: 'waiting for the exporter login', canEdit: false };
    else this.current = { state: 'needs-setup', canEdit: false };
  }

  status(): SetupStatus {
    const canEdit = !this.d.fromEnv && this.d.db !== undefined && this.d.session?.state.state === 'ok';
    return { ...this.current, ...(this.sn ? { sn: maskSn(this.sn) } : {}), canEdit };
  }

  /**
   * Opens stored credentials and starts the source. Safe to call often (start, after a login,
   * on a timer while locked): it does nothing unless the state is `locked`.
   */
  unlock(): Promise<void> {
    if (this.current.state !== 'locked' && this.current.state !== 'error') return Promise.resolve();
    this.busy ??= this.doUnlock().finally(() => (this.busy = undefined));
    return this.busy;
  }

  private async doUnlock(): Promise<void> {
    const { db, session, file } = this.d;
    if (!file.exists()) {
      this.current = { state: 'needs-setup', canEdit: false };
      return;
    }
    if (!db || !session) {
      this.current = { state: 'error', reason: 'the dashboard has not answered yet: stored credentials cannot be opened', canEdit: false };
      return;
    }
    const clientId = session.state.clientId;
    if (session.state.state !== 'ok' || !clientId) {
      // getAccessToken() refreshes the token and fills in the client id
      await session.getAccessToken().catch(() => undefined);
    }
    const auth = session.state;
    if (auth.state !== 'ok' || !auth.clientId) {
      this.current = { state: 'locked', reason: 'waiting for the exporter login', canEdit: false };
      return;
    }
    let creds: EcoflowCredentials;
    try {
      const key = await (this.d.fetchKey ?? fetchExporterKey)(db);
      creds = file.read(key, auth.clientId);
    } catch (err) {
      this.current = { state: 'error', reason: describe(err), canEdit: false };
      this.d.log.warn(`setup: stored credentials cannot be opened: ${describe(err)}`);
      return;
    }
    this.sn = creds.sn;
    await this.d.apply(creds);
    this.current = { state: 'ready', canEdit: false };
    this.d.log.info('setup: credentials decrypted, connecting to the device');
  }

  /** From the setup form: validate, check with EcoFlow, encrypt, store, connect. */
  async save(input: unknown): Promise<void> {
    if (this.d.fromEnv) throw new Error('credentials come from .env; remove them there to use this page');
    const { db, session, file } = this.d;
    if (!db || !session) throw new Error('the dashboard has not answered yet (no Supabase project): try again in a minute');
    const clientId = session.state.clientId;
    if (session.state.state !== 'ok' || !clientId) throw new Error('log in first: the encryption key is kept with your exporter login');
    let creds: EcoflowCredentials;
    try {
      creds = ecoflowCredentialsSchema.parse(input);
    } catch (err) {
      throw new Error(describe(err));
    }
    await this.d.verify(creds);
    const key = await (this.d.fetchKey ?? fetchExporterKey)(db);
    file.write(key, clientId, creds);
    this.sn = creds.sn;
    await this.d.apply(creds);
    this.current = { state: 'ready', canEdit: false };
    this.d.log.info('setup: credentials saved (encrypted), connecting to the device');
  }

  /** "Forget": stop the source, delete the file and this exporter's key on the server. */
  async forget(): Promise<void> {
    if (this.d.fromEnv) throw new Error('credentials come from .env; remove them there');
    await this.d.stop();
    this.d.file.remove();
    this.sn = undefined;
    this.current = { state: 'needs-setup', canEdit: false };
    if (this.d.db) {
      await (this.d.forgetKey ?? forgetExporterKey)(this.d.db).catch((err: unknown) => this.d.log.warn(`setup: could not delete the key on the server: ${describe(err)}`));
    }
    this.d.log.info('setup: credentials forgotten');
  }
}
