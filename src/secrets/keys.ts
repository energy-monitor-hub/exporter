import type { SupabaseClient } from '@supabase/supabase-js';
import { KEY_BYTES, newKey } from './crypto.js';

/**
 * This exporter's data key from Supabase (public.exporter_key). The first call stores a
 * fresh random key; later calls return the stored one. Only a token issued to this
 * exporter's OAuth client can read it, never the web app's session.
 */
export async function fetchExporterKey(db: SupabaseClient): Promise<Buffer> {
  const { data, error } = await db.rpc('exporter_key', { p_new: newKey().toString('base64') });
  if (error) throw new Error(`exporter key: ${error.message}`);
  if (typeof data !== 'string') throw new Error('exporter key: empty answer');
  const key = Buffer.from(data, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('exporter key: wrong length');
  return key;
}

/** Deletes this exporter's key on the server: any copy of the encrypted file becomes useless. */
export async function forgetExporterKey(db: SupabaseClient): Promise<void> {
  const { error } = await db.rpc('forget_exporter_key', {});
  if (error) throw new Error(`forget exporter key: ${error.message}`);
}
