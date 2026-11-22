/**
 * Decoder packs, maintainer side (issue #43). Not used by a running exporter.
 *
 *   npm run packs -- check                         validate every decoders/**\/*.json
 *   npm run packs -- proto <pack.json> <file.proto>  embed the .proto as the pack's JSON descriptor
 *   npm run packs -- index <out dir> [stable|beta]   copy packs, write index.json, sign it (CI)
 *   npm run packs -- releases <out dir> <image>      sign releases/releases.json for exporters (CI, #44)
 *   npm run packs -- keygen                        new Ed25519 key pair (once, by the operator)
 *
 * Signing reads the private key from DECODER_SIGNING_KEY (PKCS#8 PEM, or its base64 DER).
 * In CI it is a secret of a GitHub environment that only `main` may use.
 */
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { protoDescriptor } from './descriptor.js';
import { RELEASES_FORMAT, releaseListSchema, releaseManifestSchema } from '../update/schema.js';
import { INDEX_FORMAT, type PackIndex } from './schema.js';
import { parsePack, sha256 } from './verify.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const DECODERS = join(ROOT, 'decoders');
/** How long a published index stays valid; CI publishes on every deploy, and weekly. */
const INDEX_TTL_DAYS = 30;

function packFiles(dir = DECODERS): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...packFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out.sort();
}

function check(): void {
  const ids = new Set<string>();
  for (const f of packFiles()) {
    const pack = parsePack(readFileSync(f));
    if (ids.has(pack.id)) throw new Error(`${f}: duplicate id ${pack.id}`);
    ids.add(pack.id);
    console.log(`ok ${relative(ROOT, f)} (${pack.id} v${pack.version})`);
  }
}

function embedProto(packFile: string, protoFile: string): void {
  const pack = JSON.parse(readFileSync(packFile, 'utf8')) as Record<string, unknown>;
  pack.proto = protoDescriptor(protoFile);
  writeFileSync(packFile, `${JSON.stringify(pack, null, 2)}\n`);
  parsePack(readFileSync(packFile));
  console.log(`embedded ${relative(ROOT, protoFile)} into ${relative(ROOT, packFile)}`);
}

function signingKey() {
  const raw = process.env.DECODER_SIGNING_KEY;
  if (!raw) throw new Error('DECODER_SIGNING_KEY is not set');
  const key = raw.includes('BEGIN') ? createPrivateKey(raw) : createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('DECODER_SIGNING_KEY must be an Ed25519 key');
  return key;
}

function buildIndex(outDir: string, channel: 'stable' | 'beta'): void {
  const key = signingKey();
  mkdirSync(outDir, { recursive: true });
  const now = new Date();
  const index: PackIndex = {
    format: INDEX_FORMAT,
    // Seconds since the epoch: grows with every publish without keeping a counter anywhere.
    sequence: Math.floor(now.getTime() / 1000),
    channel,
    published_at: now.toISOString(),
    expires_at: new Date(now.getTime() + INDEX_TTL_DAYS * 86400_000).toISOString(),
    packs: [],
  };
  for (const f of packFiles()) {
    const bytes = readFileSync(f);
    const pack = parsePack(bytes);
    const file = `${pack.id}-${pack.version}.json`;
    writeFileSync(join(outDir, file), bytes);
    index.packs.push({
      id: pack.id,
      version: pack.version,
      vendor: pack.match.vendor,
      productCodes: pack.match.productCodes,
      fallback: pack.match.fallback,
      file,
      sha256: sha256(bytes),
      bytes: bytes.length,
      min_exporter_version: pack.minExporterVersion,
    });
  }
  const body = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  writeFileSync(join(outDir, 'index.json'), body);
  writeFileSync(join(outDir, 'index.json.sig'), `${sign(null, body, key).toString('base64')}\n`);
  console.log(`index.json: ${index.packs.length} pack(s), sequence ${index.sequence}, channel ${channel}`);
}

/** releases/releases.json -> signed releases.json (+ .sig) for the exporters' update check. */
function buildReleases(outDir: string, image: string): void {
  const key = signingKey();
  const list = releaseListSchema.parse(JSON.parse(readFileSync(join(ROOT, 'releases', 'releases.json'), 'utf8')));
  const now = new Date();
  const manifest = releaseManifestSchema.parse({
    format: RELEASES_FORMAT,
    sequence: Math.floor(now.getTime() / 1000),
    published_at: now.toISOString(),
    expires_at: new Date(now.getTime() + INDEX_TTL_DAYS * 86400_000).toISOString(),
    image: image.toLowerCase(),
    releases: list.releases,
  });
  mkdirSync(outDir, { recursive: true });
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outDir, 'releases.json'), body);
  writeFileSync(join(outDir, 'releases.json.sig'), `${sign(null, body, key).toString('base64')}\n`);
  console.log(`releases.json: ${manifest.releases.length} release(s), sequence ${manifest.sequence}`);
}

function keygen(): void {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  console.log('Public key (add to TRUSTED_KEYS in src/packs/verify.ts, or DECODER_PUBLIC_KEYS):');
  console.log(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  console.log('\nPrivate key (store ONLY as the DECODER_SIGNING_KEY secret of the GitHub environment, then clear this terminal):');
  console.log(privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
}

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'check') check();
  else if (cmd === 'proto' && args[0] && args[1]) embedProto(args[0], args[1]);
  else if (cmd === 'index' && args[0]) buildIndex(args[0], args[1] === 'beta' ? 'beta' : 'stable');
  else if (cmd === 'releases' && args[0] && args[1]) buildReleases(args[0], args[1]);
  else if (cmd === 'release-check') console.log(`ok releases/releases.json (${releaseListSchema.parse(JSON.parse(readFileSync(join(ROOT, 'releases', 'releases.json'), 'utf8'))).releases.length} release(s))`);
  else if (cmd === 'keygen') keygen();
  else {
    console.error('usage: npm run packs -- check | proto <pack.json> <file.proto> | index <out dir> [stable|beta] | releases <out dir> <image> | release-check | keygen');
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
