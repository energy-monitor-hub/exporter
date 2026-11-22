import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../config.js';
import type { DeviceDescriptor } from '../model/types.js';

/**
 * Supabase client for the exporter, acting as the user who approved it: the anon /
 * publishable key goes in `apikey`, the user's OAuth access token in Authorization, so
 * RLS only lets it write that user's devices. No service_role key on the exporter.
 */
export function createDbClient(config: Config, accessToken: () => Promise<string>): SupabaseClient | undefined {
  if (!config.supabaseUrl || !config.supabaseAnonKey) return undefined;
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    accessToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Returns the caller's devices.id for a serial number (public.ensure_device: create or update). */
export async function ensureDevice(db: SupabaseClient, sn: string, d: DeviceDescriptor): Promise<string> {
  const { data, error } = await db.rpc('ensure_device', {
    p_sn: sn,
    p_vendor: d.vendor,
    p_model: d.model,
    p_firmware: d.firmware ?? null,
  });
  if (error) throw new Error(`ensure_device failed: ${error.message}`);
  if (typeof data !== 'string') throw new Error('ensure_device returned no id');
  return data;
}
