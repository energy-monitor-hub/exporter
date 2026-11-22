import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { packCodec } from './interpreter.js';
import { decoderPackSchema, MAX_PACK_BYTES, packIndexSchema, type DecoderPack, type PackIndex, type PackIndexEntry } from './schema.js';

/**
 * Public keys that may sign decoder indexes and the exporter release list, as base64 SPKI (DER). The project's key goes
 * here once it is generated (`npm run packs -- keygen`, see docs/DECODER_PACKS.md); forks
 * add their own through DECODER_PUBLIC_KEYS. Several keys allow a rotation without a gap.
 */
export const TRUSTED_KEYS: readonly string[] = [
  // Project key, 2026-11-22 (private half: DECODER_SIGNING_KEY in the `decoder-signing` environment).
  'MCowBQYDK2VwAyEA4cBKZr6u7cAQug0PRN8BH7vycD2K2M1CyqzSrqbwDqk=',
];

export function publicKeys(extraBase64: readonly string[] = []): KeyObject[] {
  return [...TRUSTED_KEYS, ...extraBase64].map((k) => {
    const key = createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('decoder keys must be Ed25519');
    return key;
  });
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Checks a detached Ed25519 signature (base64) of the exact bytes against the trusted keys. */
export function verifySignature(bytes: Uint8Array, signatureBase64: string, keys: readonly KeyObject[], what: string): void {
  if (keys.length === 0) throw new Error('no trusted signing key is configured');
  const sig = Buffer.from(signatureBase64.trim(), 'base64');
  if (sig.length !== 64) throw new Error(`${what}: bad signature`);
  if (!keys.some((k) => verify(null, bytes, k, sig))) throw new Error(`${what}: signature does not match any trusted key`);
}

/** Signature of the exact index bytes, then the schema. */
export function verifyIndex(bytes: Uint8Array, signatureBase64: string, keys: readonly KeyObject[]): PackIndex {
  verifySignature(bytes, signatureBase64, keys, 'decoder index');
  return packIndexSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
}

/** A pack's bytes against its index entry: size, hash, schema, and that its proto loads. */
export function verifyPack(bytes: Uint8Array, entry: PackIndexEntry): DecoderPack {
  if (bytes.length > MAX_PACK_BYTES || bytes.length !== entry.bytes) throw new Error(`pack ${entry.id}: unexpected size`);
  if (sha256(bytes) !== entry.sha256) throw new Error(`pack ${entry.id}: hash mismatch`);
  const pack = parsePack(bytes);
  if (pack.id !== entry.id || pack.version !== entry.version) throw new Error(`pack ${entry.id}: id or version differs from the index`);
  return pack;
}

/** Schema + proto check, for packs from the repo as well as downloaded ones. */
export function parsePack(bytes: Uint8Array): DecoderPack {
  const pack = decoderPackSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  packCodec(pack); // every message type must exist in the descriptor
  return pack;
}

/** `a >= b` for x.y.z versions. */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The entry for this device: an exact product code first, else a fallback pack of the vendor. */
export function choose(index: PackIndex, vendor: string, productCode: string, exporterVersion: string): PackIndexEntry | undefined {
  const usable = index.packs.filter((p) => p.vendor === vendor && versionAtLeast(exporterVersion, p.min_exporter_version));
  const best = (list: PackIndexEntry[]) => list.sort((a, b) => b.version - a.version)[0];
  return best(usable.filter((p) => p.productCodes.includes(productCode))) ?? best(usable.filter((p) => p.fallback));
}
