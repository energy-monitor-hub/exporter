import 'dotenv/config';
import { EcoflowAuthError } from './auth/errors.js';
import { loadConfig } from './config.js';
import { createDbClient } from './db/client.js';
import { Exporter } from './exporter/exporter.js';
import { Flusher } from './exporter/flusher.js';
import { Outbox } from './exporter/outbox.js';
import { SupabaseSink } from './exporter/sink.js';
import { beginLogin, type PendingLogin } from './oauth/flow.js';
import { OAuthSession } from './oauth/session.js';
import { createHttpServer } from './server.js';
import { buildStatus, OutageHistory } from './status.js';
import { createSource, credentialsFromEnv, type Source } from './sources/index.js';
import { login as ecoflowLogin } from './auth/client.js';
import type { DeviceDescriptor } from './model/types.js';
import { CredentialFile, type EcoflowCredentials } from './secrets/credentials.js';
import { CredentialSetup } from './setup.js';
import { DiscoveryService } from './discovery/service.js';
import type { KeyObject } from 'node:crypto';
import { productCode } from './discovery/census.js';
import { PackAdapter } from './packs/interpreter.js';
import { PackUpdater } from './packs/updater.js';
import { publicKeys } from './packs/verify.js';
import { UpdateChecker } from './update/checker.js';
import { exporterVersion as readVersion, selfCheck } from './selfcheck.js';

// `--version` and `--self-check` (installers and CI check the single executable with these).
if (process.argv[2] === '--version' || process.argv[2] === '--self-check') process.exit(selfCheck(process.argv[2]));

const config = loadConfig();
const log = console;

// Writes go to Supabase as the user who approved this exporter (OAuth, `npm run login`).
const session = config.supabaseUrl ? new OAuthSession(config.oauthTokenPath, config.supabaseUrl) : undefined;
const db = session ? createDbClient(config, () => session.getAccessToken()) : undefined;
if (!db) log.warn('exporter: SUPABASE_URL / SUPABASE_ANON_KEY not set; samples are only queued locally');

const outbox = new Outbox(config.bufferPath);

// Signed decoder packs (issue #43): data only, verified against the keys compiled in.
let packKeys: KeyObject[] = [];
try {
  packKeys = publicKeys(config.decoderPublicKeys);
} catch (err) {
  log.warn(`packs: DECODER_PUBLIC_KEYS ignored: ${(err as Error).message}`);
}

const exporterVersion = readVersion();

const packs = new PackUpdater({
  indexUrl: config.decoderIndexUrl,
  mode: config.decoderUpdates,
  cacheDir: config.decoderCacheDir,
  keys: packKeys,
  exporterVersion,
  log,
});
packs.loadCached();

/** Daily (and soon after start): a newer pack for this device restarts the source with it. */
async function checkPacks(): Promise<void> {
  const s = source;
  if (!s) return;
  await packs.check('ecoflow', productCode(s.sn));
  const pack = packs.pick('ecoflow', productCode(s.sn));
  const next = pack ? `${pack.id} v${pack.version}` : undefined;
  if (next !== activePack && source === s && currentCreds) {
    log.info(`packs: switching the decoder to ${next ?? 'the built-in one'}`);
    await startSource(currentCreds);
  }
}
// The first check waits for the device to be known (credentials from the setup page can take
// a while); without this it would be skipped until the next daily run.
function firstPackCheck(): void {
  if (!source) {
    setTimeout(firstPackCheck, 30_000).unref();
    return;
  }
  void checkPacks();
}
setTimeout(firstPackCheck, 30_000).unref();
setInterval(() => void checkPacks(), 24 * 3600_000).unref();

// New exporter versions (issue #44): shown on the status page, never installed by itself.
const updates = new UpdateChecker({
  manifestUrl: config.exporterReleasesUrl,
  mode: config.exporterUpdates,
  channel: config.exporterChannel,
  keys: packKeys,
  currentVersion: exporterVersion,
  log,
});
setTimeout(() => void updates.check(), 60_000).unref();
setInterval(() => void updates.check(), 24 * 3600_000).unref();

/**
 * The device side runs only once credentials are known: from .env at once, or from the
 * setup page (stored encrypted, opened after the Supabase login). It can be replaced while
 * the exporter runs (new credentials) or stopped ("Forget").
 */
let source: Source | undefined;
/** Credentials the source runs with, to restart it when a new decoder pack arrives. */
let currentCreds: EcoflowCredentials | undefined;
/** `<pack id> v<version>`, or undefined for the built-in code adapter. */
let activePack: string | undefined;
let exporter: Exporter | undefined;
/** Descriptor per serial number seen, so queued rows of an earlier device can still be written. */
const descriptors = new Map<string, DeviceDescriptor>();

async function startSource(creds: EcoflowCredentials): Promise<void> {
  await stopSource();
  currentCreds = creds;
  const pack = packs.pick('ecoflow', productCode(creds.sn));
  activePack = pack ? `${pack.id} v${pack.version}` : undefined;
  if (pack) log.info(`exporter: decoding with pack ${activePack}`);
  const s = createSource(config, creds, log, pack ? new PackAdapter(pack) : undefined);
  const e = new Exporter(s.adapter, outbox, { sn: s.sn });
  descriptors.set(s.sn, s.adapter.descriptor);
  s.onPayload((payload, at, topic) => {
    discovery.observe(payload); // has its own error handling
    try {
      e.onMessage(payload, at);
      descriptors.set(s.sn, s.adapter.descriptor);
    } catch (err) {
      log.error(`exporter: failed to handle ${topic}: ${(err as Error).message}`);
    }
  });
  source = s;
  exporter = e;
  outages?.invalidate();
  s.start().catch((err: unknown) => {
    if (err instanceof EcoflowAuthError) {
      log.error(`exporter: EcoFlow rejected the login (code ${err.code}): ${err.message}`);
    } else {
      log.error(`exporter: ${(err as Error).message}`);
    }
    // Credentials from .env cannot change while running: exit, as before. From the setup
    // page the user can fix them, so keep serving the page.
    if (envCreds) process.exit(1);
  });
}

async function stopSource(): Promise<void> {
  const s = source;
  source = undefined;
  exporter = undefined;
  await s?.stop().catch((err: unknown) => log.warn(`exporter: stopping the source failed: ${(err as Error).message}`));
}

const flusher = db
  ? new Flusher(
      outbox,
      new SupabaseSink(db, (sn) => descriptors.get(sn) ?? { vendor: 'ecoflow', model: 'unknown' }),
      log,
      { intervalMs: config.sampleIntervalS * 1000 },
    )
  : undefined;
const outages = db ? new OutageHistory(db, () => source?.sn) : undefined;

// Unknown models: census and opt-in samples, only on the user's say-so (issue #42).
const discovery = new DiscoveryService({
  db,
  signedIn: () => session?.state.state === 'ok',
  source: () => source,
  exporterVersion,
  log,
});

const envCreds = credentialsFromEnv(config);
const setup = new CredentialSetup({
  file: new CredentialFile(config.credentialsPath),
  db,
  session,
  fromEnv: envCreds !== undefined,
  verify: async (c) => {
    await ecoflowLogin({ username: c.username, password: c.password, ...(c.apiHost ? { apiHost: c.apiHost } : {}) });
  },
  apply: startSource,
  stop: stopSource,
  log,
});

const sampler = setInterval(() => {
  try {
    exporter?.sample(new Date());
  } catch (err) {
    log.error(`exporter: sample failed: ${(err as Error).message}`);
  }
}, config.sampleIntervalS * 1000);

/** Unhealthy when nothing came from the device for 10 minutes. */
const STALE_MS = 10 * 60_000;
const startedAt = new Date();
const queue = () => flusher?.status ?? { pending: outbox.size };

// Exporter login from the status page: the browser comes back to <UI_URL>/callback.
const LOGIN_TTL_MS = 15 * 60_000;
let pending: { login: PendingLogin; expires: number } | undefined;
const supabaseUrl = config.supabaseUrl;

const server = createHttpServer({
  allowedHosts: config.uiAllowedHosts,
  peerCheck: config.uiPeerCheck,
  health: () => {
    const last = source?.adapter.lastMessageAt;
    return {
      ok: last !== undefined && Date.now() - last.getTime() < STALE_MS,
      dbConfigured: db !== undefined,
      auth: session?.state,
      setup: setup.status().state,
      sourceConnected: source?.isConnected ?? false,
      lastMessageAt: last?.toISOString(),
      lastSampleAt: exporter?.lastSample?.toISOString(),
      gridPresent: source?.adapter.gridPresent,
      openOutageSince: exporter?.outages.current?.startedAt,
      queue: queue(),
    };
  },
  ui: {
    status: () =>
      buildStatus({
        source,
        exporter,
        setup: setup.status(),
        decoders: { ...packs.status(), active: activePack ?? null },
        updates: updates.status(),
        queue,
        session,
        dbConfigured: db !== undefined,
        outages,
        sampleIntervalS: config.sampleIntervalS,
        startedAt,
        canLogin: supabaseUrl !== undefined && session !== undefined,
        loginPending: pending !== undefined && pending.expires > Date.now(),
      }),
    ...(supabaseUrl && session
      ? {
          startLogin: async () => {
            const login = await beginLogin({
              supabaseUrl,
              tokenPath: config.oauthTokenPath,
              clientName: config.oauthClientName,
              redirectUri: `${config.uiUrl}/callback`,
            });
            if (login.registered) log.info(`login: registered exporter "${config.oauthClientName}"`);
            pending = { login, expires: Date.now() + LOGIN_TTL_MS };
            return { url: login.url };
          },
          finishLogin: async (callbackUrl: string) => {
            if (!pending || pending.expires < Date.now()) throw new Error('No login in progress (or it expired): start it again');
            await pending.login.finishFromUrl(callbackUrl);
            pending = undefined;
            session.reload();
            outages?.invalidate();
            log.info('login: new token saved, writing to Supabase again');
            // Check the new token now, so the page shows the result without waiting for the next flush.
            await session.getAccessToken().catch(() => undefined);
            void flusher?.flush().catch(() => undefined);
            // Stored credentials can be opened now (the key comes with the login).
            void setup.unlock();
          },
        }
      : {}),
    reconnect: () => source?.reconnect('reconnect requested from the status page'),
    saveCredentials: (body) => setup.save(body),
    forgetCredentials: () => setup.forget(),
    discovery: {
      status: () => discovery.status(),
      act: (action, body) => discovery.act(action, body),
    },
  },
});
server.listen(config.port, config.listenHost, () => log.info(`exporter: status page ${config.uiUrl}/ (health: /healthz)`));

flusher?.start();
if (envCreds) {
  void startSource(envCreds);
} else {
  // Stored credentials: log in to Supabase, fetch the key, decrypt, connect. Retried while
  // locked (no login yet, network down), so a restart after a power cut recovers by itself.
  void setup.unlock();
  setInterval(() => void setup.unlock(), 60_000).unref();
  if (setup.status().state === 'needs-setup') log.info(`exporter: no EcoFlow credentials yet; set them up on ${config.uiUrl}/`);
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  clearInterval(sampler);
  await stopSource();
  await flusher?.stop();
  outbox.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
