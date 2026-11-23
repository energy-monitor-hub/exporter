import type { SupabaseClient } from '@supabase/supabase-js';
import { ZodError } from 'zod';
import type { Logger } from './mqtt/client.js';
import type { OAuthSession } from './oauth/session.js';
import type { CredentialFile } from './secrets/credentials.js';
import { fetchExporterKey, forgetExporterKey } from './secrets/keys.js';
import type { AnyDevicePlugin, DeviceCredentials, FormField, Texts } from './sources/index.js';

/**
 * Where the device credentials come from, as the status page shows it:
 * - `env`: the plugin's variables in .env, e.g. ECOFLOW_USERNAME (the setup page is read-only);
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
  /** The form the page builds, from the device plugin (src/sources/). */
  form: SetupForm;
}

export interface SetupForm {
  device: string;
  title: Texts;
  hint: Texts;
  privacy: Texts;
  fields: FormField[];
  envVars: string[];
}

/** Credentials and the plugin that reads them. */
export interface DeviceSetup {
  plugin: AnyDevicePlugin;
  credentials: DeviceCredentials;
}

export interface SetupDeps {
  file: CredentialFile;
  db: SupabaseClient | undefined;
  session: OAuthSession | undefined;
  /** True when .env has the credentials: they win, the page cannot change them. */
  fromEnv: boolean;
  /** Plugin the setup form is for (SOURCE). */
  plugin: AnyDevicePlugin;
  /** Finds the plugin a stored file names. */
  pluginById: (id: string) => AnyDevicePlugin | undefined;
  /** Start (or restart) the device source with these credentials. */
  apply: (d: DeviceSetup) => Promise<void>;
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
 * Credentials from the setup page: verify with the device plugin, encrypt with this exporter's
 * server-held key, store on the data volume, start the source. On restart: log in to
 * Supabase first, fetch the key, decrypt, then connect.
 */
export class CredentialSetup {
  private current: Omit<SetupStatus, 'form'>;
  private sn: string | undefined;
  private busy: Promise<void> | undefined;

  constructor(private readonly d: SetupDeps) {
    if (d.fromEnv) this.current = { state: 'env', canEdit: false };
    else if (d.file.exists()) this.current = { state: 'locked', reason: 'waiting for the exporter login', canEdit: false };
    else this.current = { state: 'needs-setup', canEdit: false };
  }

  status(): SetupStatus {
    const canEdit = !this.d.fromEnv && this.d.db !== undefined && this.d.session?.state.state === 'ok';
    const p = this.d.plugin;
    const form: SetupForm = { device: p.id, ...p.setup };
    return { ...this.current, ...(this.sn ? { sn: maskSn(this.sn) } : {}), canEdit, form };
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
    let device: DeviceSetup;
    try {
      const key = await (this.d.fetchKey ?? fetchExporterKey)(db);
      const stored = file.read(key, auth.clientId);
      const plugin = this.d.pluginById(stored.device);
      if (!plugin) throw new Error(`stored for an unknown kind of device (${stored.device}): update the exporter, or forget them`);
      device = { plugin, credentials: plugin.credentials.parse(stored.credentials) };
    } catch (err) {
      this.current = { state: 'error', reason: describe(err), canEdit: false };
      this.d.log.warn(`setup: stored credentials cannot be opened: ${describe(err)}`);
      return;
    }
    this.sn = device.credentials.sn;
    await this.d.apply(device);
    this.current = { state: 'ready', canEdit: false };
    this.d.log.info('setup: credentials decrypted, connecting to the device');
  }

  /** From the setup form: validate, check with the device's cloud or the device, encrypt, store, connect. */
  async save(input: unknown): Promise<void> {
    if (this.d.fromEnv) throw new Error('credentials come from .env; remove them there to use this page');
    const { db, session, file } = this.d;
    if (!db || !session) throw new Error('the dashboard has not answered yet (no Supabase project): try again in a minute');
    const clientId = session.state.clientId;
    if (session.state.state !== 'ok' || !clientId) throw new Error('log in first: the encryption key is kept with your exporter login');
    const { plugin } = this.d;
    let creds: DeviceCredentials;
    try {
      creds = plugin.credentials.parse(input);
    } catch (err) {
      throw new Error(describe(err));
    }
    await plugin.verify(creds, this.d.log);
    const key = await (this.d.fetchKey ?? fetchExporterKey)(db);
    file.write(key, clientId, { device: plugin.id, credentials: { ...creds } });
    this.sn = creds.sn;
    await this.d.apply({ plugin, credentials: creds });
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
