import { SOURCES } from './sources/types.js';

export interface Config {
  port: number;
  /** Address the HTTP server binds to. Loopback by default; the Docker image sets 0.0.0.0 and publishes the port on the host's 127.0.0.1. */
  listenHost: string;
  /**
   * Also require a loopback peer address for the setup endpoints (credentials, sharing).
   * On by default; the Docker image turns it off, because published ports reach the
   * container from the bridge gateway, never from 127.0.0.1.
   */
  uiPeerCheck: boolean;
  /** Address of the status page as the browser sees it; the page's login comes back to `<uiUrl>/callback`. */
  uiUrl: string;
  /** Extra host names the status page answers to (it always does for localhost and IP addresses). */
  uiAllowedHosts: string[];
  /** Which device source runs (src/sources). */
  source: (typeof SOURCES)[number];
  ecoflowApiHost: string | undefined;
  ecoflowUsername: string | undefined;
  ecoflowPassword: string | undefined;
  deviceSn: string | undefined;
  supabaseUrl: string | undefined;
  /** Public anon / publishable key (the `apikey` header); RLS applies, the user comes from the OAuth token. */
  supabaseAnonKey: string | undefined;
  /** Tokens from the exporter login (secret, keep it on the data volume). */
  oauthTokenPath: string;
  /** EcoFlow credentials from the setup page, encrypted with a key held by Supabase. */
  credentialsPath: string;
  /** Loopback port the browser comes back to after the consent page. */
  oauthCallbackPort: number;
  /** Shown on the dashboard's "Exporters" page. */
  oauthClientName: string;
  /** How often a snapshot is written to telemetry_raw / pack_raw. */
  sampleIntervalS: number;
  /** Local SQLite queue for writes that have not reached Supabase yet. */
  bufferPath: string;
  /** Reconnect if MQTT is silent this long (0 = off). */
  mqttSilenceTimeoutS: number;
  /** Ask the device for a full snapshot this often (0 = off). */
  quotaEveryS: number;
  /** Signed decoder packs (src/packs/): off, notify (show only) or auto (use them). */
  decoderUpdates: 'off' | 'notify' | 'auto';
  /** https URL of the published index.json; no updates without it. */
  decoderIndexUrl: string | undefined;
  /** Extra Ed25519 public keys (base64 SPKI) besides the ones compiled in (forks). */
  decoderPublicKeys: string[];
  /** Last good index and packs (data volume). */
  decoderCacheDir: string;
  /** New exporter versions (issue #44): off or notify (the exporter never replaces itself). */
  exporterUpdates: 'off' | 'notify';
  /** https URL of the signed releases.json; no check without it. */
  exporterReleasesUrl: string | undefined;
  exporterChannel: 'stable' | 'beta';
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const v = env[name] || fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`Invalid ${name}: ${v} (${allowed.join(' | ')})`);
  return v as T;
}

function decoderUpdates(raw: string | undefined): Config['decoderUpdates'] {
  const v = raw || 'auto';
  if (v !== 'off' && v !== 'notify' && v !== 'auto') throw new Error(`Invalid DECODER_UPDATES: ${raw} (off | notify | auto)`);
  return v;
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  const v = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`Invalid ${name}: ${raw}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const source = env.SOURCE || 'ecoflow-mqtt';
  if (!(SOURCES as readonly string[]).includes(source)) throw new Error(`Invalid SOURCE: ${source} (known: ${SOURCES.join(', ')})`);
  const port = int(env, 'HEALTH_PORT', 9101, 1, 65535);
  return {
    port,
    listenHost: env.LISTEN_HOST || '127.0.0.1',
    uiPeerCheck: env.UI_PEER_CHECK !== 'off',
    uiUrl: (env.UI_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    uiAllowedHosts: (env.UI_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    source: source as Config['source'],
    ecoflowApiHost: env.ECOFLOW_API_HOST || undefined,
    ecoflowUsername: env.ECOFLOW_USERNAME || undefined,
    ecoflowPassword: env.ECOFLOW_PASSWORD || undefined,
    deviceSn: env.DEVICE_SN || undefined,
    supabaseUrl: env.SUPABASE_URL || undefined,
    supabaseAnonKey: env.SUPABASE_ANON_KEY || undefined,
    oauthTokenPath: env.OAUTH_TOKEN_PATH || 'data/oauth.json',
    credentialsPath: env.CREDENTIALS_PATH || 'data/credentials.json',
    oauthCallbackPort: int(env, 'OAUTH_CALLBACK_PORT', 9102, 1, 65535),
    oauthClientName: env.OAUTH_CLIENT_NAME || `Exporter ${new Date().toISOString().slice(0, 10)}`,
    sampleIntervalS: int(env, 'SAMPLE_INTERVAL_S', 10, 1, 3600),
    bufferPath: env.BUFFER_PATH || 'data/buffer.sqlite',
    mqttSilenceTimeoutS: int(env, 'MQTT_SILENCE_TIMEOUT_S', 180, 0, 86400),
    quotaEveryS: int(env, 'QUOTA_EVERY_S', 300, 0, 86400),
    decoderUpdates: decoderUpdates(env.DECODER_UPDATES),
    decoderIndexUrl: env.DECODER_INDEX_URL || undefined,
    decoderPublicKeys: (env.DECODER_PUBLIC_KEYS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    decoderCacheDir: env.DECODER_CACHE_DIR || 'data/decoders',
    exporterUpdates: oneOf(env, 'EXPORTER_UPDATES', ['off', 'notify'] as const, 'notify'),
    exporterReleasesUrl: env.EXPORTER_RELEASES_URL || undefined,
    exporterChannel: oneOf(env, 'EXPORTER_CHANNEL', ['stable', 'beta'] as const, 'stable'),
  };
}
