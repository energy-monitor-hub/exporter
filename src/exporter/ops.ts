import type { GapReason } from '../db/types.js';
import type { DeviceState, Extra } from '../model/types.js';

/** Rows as they go to Supabase, minus device_id (resolved from `sn` when sending). */
export interface TelemetryRow {
  ts: string;
  soc_pct: number | null;
  watts_in: number | null;
  watts_out: number | null;
  ac_in_voltage_v: number | null;
  ac_in_freq_hz: number | null;
  ac_out_freq_hz: number | null;
  grid_present: boolean | null;
  extra: Extra | null;
}

export interface PackRow {
  ts: string;
  pack: number;
  soc_pct: number | null;
  soh_pct: number | null;
  cycles: number | null;
  cell_voltages_mv: number[] | null;
  cell_temps_c: number[] | null;
  min_mos_temp_c: number | null;
  max_mos_temp_c: number | null;
  balance_state: number | null;
  extra: Extra | null;
}

/**
 * One pending write. Every op is idempotent on the server (upsert / update by key), so an op
 * that was sent but not confirmed can simply be sent again.
 */
export type Op =
  | { kind: 'telemetry'; sn: string; row: TelemetryRow }
  | { kind: 'pack'; sn: string; row: PackRow }
  /** Every decoded field, upserted into public.device_state (one row per device). */
  | { kind: 'state'; sn: string; updated_at: string; state: DeviceState }
  /** `start_latest_at`: set when the exporter was blind at the moment (start is a window). */
  | { kind: 'outage_start'; sn: string; started_at: string; soc_start_pct: number | null; start_latest_at?: string }
  /**
   * Closes (or writes whole) an outage. The optional fields are missing in ops queued by
   * older versions; then they are left as they are in the row.
   */
  | {
      kind: 'outage_end';
      sn: string;
      started_at: string;
      ended_at: string;
      soc_end_pct: number | null;
      energy_out_wh: number | null;
      soc_start_pct?: number | null;
      start_latest_at?: string | null;
      end_earliest_at?: string | null;
      /** Not seen: inferred from a battery drop across a gap. */
      inferred?: boolean;
    }
  /** A stretch without data from the device, written once data is back. */
  | { kind: 'gap'; sn: string; started_at: string; ended_at: string; reason: GapReason; slept_s: number | null };
