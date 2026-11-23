import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { bundleFromJSON } from '@sigstore/bundle';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { getTrustedRoot } from '@sigstore/tuf';
import { toSignedEntity, toTrustMaterial, Verifier } from '@sigstore/verify';

/**
 * GitHub build provenance (exporter-image.yml, actions/attest-build-provenance): a Sigstore
 * bundle saying that this image digest was built by this repository's image workflow from the
 * release tag. Checked before an image from the signed release list is started, so a leaked
 * list-signing key alone cannot ship an image that CI did not build.
 */

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
export const IMAGE_WORKFLOW = '.github/workflows/exporter-image.yml';
const MAX_ATTESTATION_BYTES = 4 * 1024 * 1024;

export interface ProvenanceCheck {
  /** `ghcr.io/<owner>/<repo>` from the signed release list */
  image: string;
  digest: string;
  version: string;
  trustedRoot: () => Promise<TrustedRoot>;
  fetch?: typeof fetch;
  apiUrl?: string;
}

/** `ghcr.io/<owner>/<repo>` → `<owner>/<repo>`; provenance is only looked up for GitHub's registry. */
export function githubRepo(image: string): string {
  const m = /^ghcr\.io\/([a-z0-9][a-z0-9-]*)\/([a-z0-9._-]+)$/.exec(image);
  if (!m) throw new Error(`build provenance is checked for ghcr.io images only, not ${image}`);
  return `${m[1]}/${m[2]}`;
}

interface Statement {
  _type?: string;
  predicateType?: string;
  subject?: { name?: string; digest?: Record<string, string> }[];
  predicate?: { buildDefinition?: { externalParameters?: { workflow?: { ref?: string; repository?: string; path?: string } } } };
}

/** The in-toto statement says what we expect: this digest, from this repo's image workflow at the release tag. */
export function checkStatement(st: Statement, repo: string, digest: string, version: string): void {
  if (st.predicateType !== SLSA_PROVENANCE_V1) throw new Error(`not SLSA provenance (${st.predicateType ?? 'none'})`);
  const hex = digest.replace(/^sha256:/, '');
  if (!(st.subject ?? []).some((s) => s.digest?.sha256 === hex)) throw new Error('the attestation is for another image digest');
  const wf = st.predicate?.buildDefinition?.externalParameters?.workflow;
  if (wf?.repository !== `https://github.com/${repo}`) throw new Error(`built from ${wf?.repository ?? 'an unknown repository'}`);
  if (wf.path !== IMAGE_WORKFLOW) throw new Error(`built by ${wf.path ?? 'an unknown workflow'}`);
  if (wf.ref !== `refs/tags/v${version}`) throw new Error(`built from ${wf.ref ?? 'an unknown ref'}, not the v${version} tag`);
}

/** Throws unless one attestation for the digest passes Sigstore verification and the checks above. */
export async function verifyProvenance(o: ProvenanceCheck): Promise<void> {
  const repo = githubRepo(o.image);
  const url = `${o.apiUrl ?? 'https://api.github.com'}/repos/${repo}/attestations/${o.digest}`;
  const res = await (o.fetch ?? fetch)(url, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (res.status === 404) throw new Error(`no build provenance for ${o.digest}`);
  if (!res.ok) throw new Error(`build provenance lookup: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_ATTESTATION_BYTES) throw new Error('build provenance lookup: response too large');
  const list = (JSON.parse(text) as { attestations?: { bundle?: unknown }[] }).attestations ?? [];
  if (list.length === 0) throw new Error(`no build provenance for ${o.digest}`);

  const verifier = new Verifier(toTrustMaterial(await o.trustedRoot()), { tlogThreshold: 1, ctlogThreshold: 1 });
  const policy = {
    subjectAlternativeName: `https://github.com/${repo}/${IMAGE_WORKFLOW}@refs/tags/v${o.version}`,
    extensions: { issuer: GITHUB_ISSUER },
  };
  let lastError = 'no usable attestation';
  for (const a of list) {
    try {
      const bundle = bundleFromJSON(a.bundle);
      if (bundle.content.$case !== 'dsseEnvelope') throw new Error('not a DSSE attestation');
      const env = bundle.content.dsseEnvelope;
      if (env.payloadType !== 'application/vnd.in-toto+json') throw new Error(`unexpected payload ${env.payloadType}`);
      checkStatement(JSON.parse(Buffer.from(env.payload).toString('utf8')) as Statement, repo, o.digest, o.version);
      // Certificate chain to Fulcio, transparency log entry, DSSE signature, signer identity.
      verifier.verify(toSignedEntity(bundle), policy);
      return;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  throw new Error(`build provenance: ${lastError}`);
}

/** The Sigstore root shipped inside @sigstore/tuf (its TUF seed), for when the TUF mirror is unreachable. */
export function seedTrustedRoot(): TrustedRoot {
  const require = createRequire(import.meta.url);
  const seeds = JSON.parse(readFileSync(require.resolve('@sigstore/tuf/seeds.json'), 'utf8')) as Record<string, { targets?: Record<string, string> }>;
  const target = Object.values(seeds)[0]?.targets?.['trusted_root.json'];
  if (!target) throw new Error('no Sigstore trusted root in the TUF seed');
  return TrustedRoot.fromJSON(JSON.parse(Buffer.from(target, 'base64').toString('utf8')));
}

/**
 * Sigstore's current trust root through TUF (tuf-repo-cdn.sigstore.dev), cached in `cachePath`.
 * Falls back to the cached copy, then to the seed shipped with the package.
 */
export function sigstoreTrustedRoot(cachePath: string, log: { warn(msg: string): void }): () => Promise<TrustedRoot> {
  return async () => {
    try {
      return await getTrustedRoot({ cachePath });
    } catch (err) {
      log.warn(`updater: Sigstore TUF refresh failed (${(err as Error).message}); using the cached or built-in trust root`);
    }
    try {
      return await getTrustedRoot({ cachePath, forceCache: true });
    } catch {
      return seedTrustedRoot();
    }
  };
}
