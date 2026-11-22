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
 * Tells the user when a newer exporter is out (issue #44). Notify only: the exporter never
 * replaces itself (that would need the Docker socket, i.e. root on the host). The update is
 * `make exporter-update`, or pinning the image to the digest shown. The request carries no
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
      const body = await this.get(this.o.manifestUrl, MAX_RELEASES_BYTES);
      const sig = Buffer.from(await this.get(`${this.o.manifestUrl}.sig`, 1024)).toString('utf8');
      verifySignature(body, sig, this.o.keys, 'release list');
      const m = releaseManifestSchema.parse(JSON.parse(Buffer.from(body).toString('utf8')));
      if (Date.parse(m.expires_at) <= now) throw new Error('the published release list has expired');
      if (this.manifest && m.sequence < this.manifest.sequence) throw new Error('refused an older release list');
      this.manifest = m;
      this.error = undefined;
      const s = this.status();
      if (s.revoked) this.o.log.warn(`update: exporter ${this.o.currentVersion} was revoked; update now (make exporter-update)`);
      else if (s.latest) this.o.log.info(`update: exporter ${s.latest.version} is available (${s.latest.image})`);
    } catch (err) {
      this.error = (err as Error).message;
      this.o.log.warn(`update: ${this.error}`);
    }
  }

  private async get(url: string, limit: number): Promise<Uint8Array> {
    if (!url.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('release list is fetched over https only');
    const res = await (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(`${new URL(url).pathname}: too large`);
    return buf;
  }
}
