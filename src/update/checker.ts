import type { KeyObject } from 'node:crypto';
import type { Logger } from '../mqtt/client.js';
import { verifySignature } from '../packs/verify.js';
import { MAX_RELEASES_BYTES, newestRelease, releaseManifestSchema, type ReleaseManifest } from './schema.js';

export type ExporterUpdates = 'off' | 'notify';

export interface UpdateCheckerOptions {
  manifestUrl: string | undefined;
  mode: ExporterUpdates;
  channel: 'stable' | 'beta';
  keys: readonly KeyObject[];
  currentVersion: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface UpdateStatus {
  mode: ExporterUpdates;
  configured: boolean;
  channel: 'stable' | 'beta';
  current: string;
  /** This version was revoked: update as soon as possible. */
  revoked?: boolean;
  latest?: { version: string; image: string; notes: string; publishedAt: string; minDbMigration: string };
  checkedAt?: string;
  error?: string;
}

/**
 * Tells the user when a newer exporter is out (issue #44). The exporter never replaces itself
 * (that needs the Docker socket, i.e. root on the host): the separate updater container does,
 * when the user asks for it on the status page (src/updater/). The request carries no
 * identifiers.
 */
export class UpdateChecker {
  private manifest: ReleaseManifest | undefined;
  private checkedAt: string | undefined;
  private error: string | undefined;

  constructor(private readonly o: UpdateCheckerOptions) {}

  private get enabled(): boolean {
    return this.o.mode !== 'off' && this.o.manifestUrl !== undefined && this.o.keys.length > 0;
  }

  status(): UpdateStatus {
    const m = this.manifest;
    const latest = m ? newestRelease(m, this.o.currentVersion, this.o.channel) : undefined;
    const mine = m?.releases.find((r) => r.version === this.o.currentVersion);
    return {
      mode: this.o.mode,
      configured: this.enabled,
      channel: this.o.channel,
      current: this.o.currentVersion,
      ...(mine?.revoked ? { revoked: true } : {}),
      ...(m && latest
        ? {
            latest: {
              version: latest.version,
              image: `${m.image}@${latest.digest}`,
              notes: latest.notes,
              publishedAt: latest.published_at,
              minDbMigration: latest.min_db_migration,
            },
          }
        : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async check(): Promise<void> {
    if (!this.enabled || !this.o.manifestUrl) return;
    const now = (this.o.now ?? Date.now)();
    this.checkedAt = new Date(now).toISOString();
    try {
      this.manifest = await fetchReleaseManifest({
        url: this.o.manifestUrl,
        keys: this.o.keys,
        now,
        ...(this.manifest ? { minSequence: this.manifest.sequence } : {}),
        ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
      });
      this.error = undefined;
      const s = this.status();
      if (s.revoked) this.o.log.warn(`update: exporter ${this.o.currentVersion} was revoked; update now`);
      else if (s.latest) this.o.log.info(`update: exporter ${s.latest.version} is available (${s.latest.image})`);
    } catch (err) {
      this.error = (err as Error).message;
      this.o.log.warn(`update: ${this.error}`);
    }
  }
}

export interface FetchManifestOptions {
  url: string;
  keys: readonly KeyObject[];
  now: number;
  /** Refuse a list older than one already seen (replay of an old, validly signed list). */
  minSequence?: number;
  fetch?: typeof fetch;
}

/**
 * releases.json and its detached signature: the signature over the exact bytes against the
 * trusted keys, then the schema, the expiry and the sequence. Used by the exporter (notify)
 * and by the updater (src/updater/), which installs only digests from a list that passed this.
 */
export async function fetchReleaseManifest(o: FetchManifestOptions): Promise<ReleaseManifest> {
  const body = await get(o, o.url, MAX_RELEASES_BYTES);
  const sig = Buffer.from(await get(o, `${o.url}.sig`, 1024)).toString('utf8');
  verifySignature(body, sig, o.keys, 'release list');
  const m = releaseManifestSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')));
  if (Date.parse(m.expires_at) <= o.now) throw new Error('the published release list has expired');
  if (o.minSequence !== undefined && m.sequence < o.minSequence) throw new Error('refused an older release list');
  return m;
}

async function get(o: FetchManifestOptions, url: string, limit: number): Promise<Uint8Array> {
  if (!url.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('release list is fetched over https only');
  const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > limit) throw new Error(`${new URL(url).pathname}: too large`);
  return buf;
}
