import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** On-disk envelope of an AES-256-GCM encrypted JSON value. */
export interface Sealed {
  v: 1;
  alg: 'A256GCM';
  /** base64: 96-bit random nonce, 128-bit tag, ciphertext */
  iv: string;
  tag: string;
  ct: string;
}

export const KEY_BYTES = 32;

export const newKey = (): Buffer => randomBytes(KEY_BYTES);

function checkKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
}

/**
 * Encrypts `value` as JSON. `aad` binds the ciphertext to its context (format version,
 * which exporter): the same key cannot open it under another context.
 */
export function seal(key: Uint8Array, aad: string, value: unknown): Sealed {
  checkKey(key);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { v: 1, alg: 'A256GCM', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** Decrypts a `seal()` envelope. Throws on a wrong key, another `aad` or any tampering. */
export function open(key: Uint8Array, aad: string, s: Sealed): unknown {
  checkKey(key);
  if (s.v !== 1 || s.alg !== 'A256GCM') throw new Error('unknown encrypted file format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(s.iv, 'base64'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(s.tag, 'base64'));
  try {
    const pt = Buffer.concat([d.update(Buffer.from(s.ct, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8')) as unknown;
  } catch {
    throw new Error('cannot decrypt: wrong key, another exporter login, or the file was changed');
  }
}
