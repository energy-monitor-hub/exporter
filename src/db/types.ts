// Row shapes for the tables in supabase/migrations. Keep in sync with the SQL.
// (Can later be replaced by `supabase gen types typescript`.)

export interface DeviceRow {
  id: string;
  /** auth.users.id; null only for legacy rows, which an admin assigns (20261122100000_ensure_device_no_claim.sql). */
  owner_id: string | null;
  sn: string;
  name: string | null;
  vendor: string;
  model: string;
  firmware: string | null;
  created_at: string;
}

/** Arguments of public.ensure_device(); returns devices.id (uuid). */
export interface EnsureDeviceArgs {
  p_sn: string;
  p_vendor: string;
  p_model: string;
  p_firmware: string | null;
}

/** Insert shape for public.telemetry_raw (one exporter snapshot). */
export interface TelemetryRawInsert {
  device_id: string;
  ts: string; // ISO timestamp
  soc_pct?: number | null;
  watts_in?: number | null;
  watts_out?: number | null;
  ac_in_voltage_v?: number | null;
  ac_in_freq_hz?: number | null;
  ac_out_freq_hz?: number | null;
  grid_present?: boolean | null;
  extra?: Record<string, unknown> | null;
}

/** Insert shape for public.pack_raw (one BMS pack snapshot; array index = cell number). */
export interface PackRawInsert {
  device_id: string;
  ts: string;
  pack: number;
  soc_pct?: number | null;
  soh_pct?: number | null;
  cycles?: number | null;
  cell_voltages_mv?: number[] | null;
  cell_temps_c?: number[] | null;
  min_mos_temp_c?: number | null;
  max_mos_temp_c?: number | null;
  balance_state?: number | null;
  extra?: Record<string, unknown> | null;
}

export interface TelemetryHourlyRow {
  device_id: string;
  hour: string;
  samples: number;
  soc_avg_pct: number | null;
  soc_min_pct: number | null;
  soc_max_pct: number | null;
  watts_in_avg: number | null;
  watts_out_avg: number | null;
  energy_in_wh: number | null;
  energy_out_wh: number | null;
  ac_in_voltage_avg_v: number | null;
  ac_in_voltage_min_v: number | null;
  ac_in_voltage_max_v: number | null;
  ac_in_freq_avg_hz: number | null;
  ac_in_freq_min_hz: number | null;
  ac_in_freq_max_hz: number | null;
  grid_present_ratio: number | null;
  /** Per key avg / min / max of the numeric telemetry_raw.extra values (refresh_hourly_extra). */
  extra_avg: Record<string, number> | null;
  extra_min: Record<string, number> | null;
  extra_max: Record<string, number> | null;
}

export interface PackHourlyRow {
  device_id: string;
  hour: string;
  pack: number;
  samples: number;
  soc_avg_pct: number | null;
  soh_avg_pct: number | null;
  cycles_max: number | null;
  cell_voltages_avg_mv: number[] | null;
  cell_voltages_min_mv: number[] | null;
  cell_voltages_max_mv: number[] | null;
  cell_temps_avg_c: number[] | null;
  cell_spread_max_mv: number | null;
  cell_temp_max_c: number | null;
  mos_temp_max_c: number | null;
  /** Per key avg / min / max of the numeric pack_raw.extra values (refresh_hourly_extra). */
  extra_avg: Record<string, number> | null;
  extra_min: Record<string, number> | null;
  extra_max: Record<string, number> | null;
}

export interface OutageRow {
  id: number;
  device_id: string;
  started_at: string;
  ended_at: string | null;
  soc_start_pct: number | null;
  soc_end_pct: number | null;
  energy_out_wh: number | null;
}

/** Row of public.telemetry_series(device, from, to, bucket_s): bucketed averages for the dashboard. */
export interface TelemetrySeriesRow {
  ts: string;
  soc_pct: number | null;
  watts_in: number | null;
  watts_out: number | null;
  ac_in_voltage_v: number | null;
  ac_in_freq_hz: number | null;
  ac_out_freq_hz: number | null;
  /** false if any sample in the bucket had no grid. */
  grid_present: boolean | null;
}

/** Row of public.pack_series(device, from, to, bucket_s): element-wise averaged cell arrays. */
export interface PackSeriesRow {
  ts: string;
  pack: number;
  soc_pct: number | null;
  cell_voltages_mv: number[] | null;
  cell_temps_c: number[] | null;
  max_mos_temp_c: number | null;
  cell_spread_mv: number | null;
}

/**
 * Row of public.metric_series(device, from, to, bucket_s, keys): bucketed averages of
 * `extra` keys. `pack` is null for telemetry_raw.extra, the pack number for pack_raw.extra.
 */
export interface MetricSeriesRow {
  ts: string;
  pack: number | null;
  values: Record<string, number>;
}

/** Row of public.device_state: latest value of every decoded field (see DeviceState). */
export interface DeviceStateRow {
  device_id: string;
  updated_at: string;
  state: Record<string, { at: string; fields: Record<string, unknown>; unknown?: Record<string, number | string> }>;
}

/** Row of public.dashboards: the web app's layout per user and device (JSON shape: web/src/panels/types.ts). */
export interface DashboardRow {
  owner_id: string;
  device_id: string;
  config: Record<string, unknown>;
  updated_at: string;
}

/** Row of public.saved_dashboards: a user's named dashboard; vendor / model null = universal. */
export interface SavedDashboardRow {
  id: string;
  owner_id: string;
  name: string;
  vendor: string | null;
  model: string | null;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** public.consent_purpose (20261122170000_consents_account.sql). */
export type ConsentPurpose = 'model_census' | 'raw_sample_upload' | 'sample_as_public_fixture' | 'auto_update';

/** public.consents: one opt-in per user, purpose and (optional) device. Never deleted, only withdrawn. */
export interface ConsentRow {
  id: string;
  user_id: string;
  purpose: ConsentPurpose;
  text_version: string;
  /** Hex SHA-256 of the exact consent text shown. */
  text_sha256: string;
  source: 'web' | 'exporter';
  device_id: string | null;
  granted_at: string;
  withdrawn_at: string | null;
}

/** Columns a user may insert into public.consents (the rest come from defaults). */
export interface ConsentInsert {
  purpose: ConsentPurpose;
  text_version: string;
  text_sha256: string;
  source: 'web' | 'exporter';
  device_id?: string | null;
}

/** public.has_consent(p_purpose, p_device_id) -> boolean; public.withdraw_consent(p_id) -> boolean. */
export interface HasConsentArgs {
  p_purpose: ConsentPurpose;
  p_device_id?: string | null;
}

/**
 * public.exporter_key(p_new text) -> text: this exporter's data key (base64, 32 bytes),
 * storing p_new if it has none. public.forget_exporter_key(p_client_id text) -> boolean.
 * Table public.exporter_keys is not readable directly (20261122171000_exporter_keys.sql).
 */
export interface ExporterKeyArgs {
  p_new?: string | null;
}

/** public.model_census (20261122172000_model_samples.sql): written only through submit_census(). */
export interface ModelCensusRow {
  user_id: string;
  vendor: string;
  product_code: string;
  firmware: string | null;
  /** [{ id: 'cmdFunc/cmdId', n, bytes, decoded }] */
  msg_ids: unknown[];
  exporter: string | null;
  seen_at: string;
}

/** public.submit_census(...) -> void (needs consent model_census). */
export interface SubmitCensusArgs {
  p_vendor: string;
  p_product_code: string;
  p_firmware: string | null;
  p_msg_ids: unknown[];
  p_exporter?: string | null;
}

export type SampleStatus = 'reserved' | 'uploaded' | 'analysing' | 'used' | 'rejected' | 'expired' | 'deleted';

/** public.model_samples; the file is Storage `samples/<path>`. */
export interface ModelSampleRow {
  id: string;
  user_id: string;
  vendor: string;
  product_code: string;
  firmware: string | null;
  status: SampleStatus;
  path: string;
  size_bytes: number | null;
  sha256: string | null;
  consent_id: string | null;
  created_at: string;
  uploaded_at: string | null;
  expires_at: string;
}

/** public.reserve_sample(p_vendor, p_product_code, p_firmware) -> jsonb. */
export type ReserveSampleResult =
  | { status: 'supported' | 'enough' | 'limit' }
  | { status: 'wanted'; id: string; path: string; max_bytes: number };

/** public.known_models: maintained by the operator (`npm run samples -- known`). */
export interface KnownModelRow {
  vendor: string;
  product_code: string;
  status: 'supported' | 'enough';
  note: string | null;
  updated_at: string;
}
