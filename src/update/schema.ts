import { z } from 'zod';

/**
 * Exporter releases (issue #44). The maintained list is releases/releases.json in the repo;
 * CI publishes it signed (Ed25519, the same keys as decoder packs) as releases.json on the
 * dashboard's hosting. An exporter only ever points to an image by digest from this list.
 */

export const RELEASES_FORMAT = 'ecoflow-dashboard/releases/1';
export const MAX_RELEASES_BYTES = 64 * 1024;

const semver = z.string().regex(/^\d+\.\d+\.\d+$/);

export const releaseSchema = z
  .object({
    version: semver,
    /** Multi-arch image index digest of exporter:v<version>. */
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** `beta` at once; `stable` only after a quarantine without problem reports (docs/UPDATES.md). */
    channel: z.enum(['stable', 'beta']),
    published_at: z.string().datetime(),
    /** Newest migration (file name prefix) the release needs on the server. */
    min_db_migration: z.string().regex(/^\d{14}$/),
    notes: z.string().max(500),
    /** Kill switch: exporters on a revoked version are told to move off it. */
    revoked: z.boolean().default(false),
  })
  .strict();

/** releases/releases.json in the repo. */
export const releaseListSchema = z.object({ releases: z.array(releaseSchema).max(200) }).strict();

/** The signed file the exporter fetches. */
export const releaseManifestSchema = z
  .object({
    format: z.literal(RELEASES_FORMAT),
    sequence: z.number().int().min(1),
    published_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    /** `ghcr.io/<owner>/<repo>` (this repository's image) */
    image: z.string().regex(/^[a-z0-9.-]+(:\d+)?(\/[a-z0-9._-]+)+$/),
    releases: z.array(releaseSchema).max(200),
  })
  .strict();

export type Release = z.infer<typeof releaseSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** -1, 0, 1 for x.y.z versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Newest release newer than `current` on the channel (beta also sees stable), not revoked. */
export function newestRelease(m: ReleaseManifest, current: string, channel: 'stable' | 'beta'): Release | undefined {
  return m.releases
    .filter((r) => !r.revoked && (channel === 'beta' || r.channel === 'stable') && compareVersions(r.version, current) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
}
