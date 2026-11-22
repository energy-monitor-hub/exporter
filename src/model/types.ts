/**
 * Device-independent readings. A device adapter (today only EcoFlow Delta 3 Max Plus,
 * src/decode/) turns its own messages into these; the writer (src/db/) only knows these.
 * Keeping this boundary is what lets other stations plug in later (issue #12).
 */

export type ExtraValue = number | string | boolean | number[];
export type Extra = Record<string, ExtraValue>;

/** Whole-device sample. Maps to public.telemetry_raw. */
export interface TelemetrySample {
  socPct: number | null;
  wattsIn: number | null;
  wattsOut: number | null;
  acInVoltageV: number | null;
  acInFreqHz: number | null;
  acOutFreqHz: number | null;
  gridPresent: boolean | null;
  extra: Extra;
}

/** One battery pack (0 = main unit). Maps to public.pack_raw; arrays are indexed by cell / sensor. */
export interface PackSample {
  pack: number;
  socPct: number | null;
  sohPct: number | null;
  cycles: number | null;
  cellVoltagesMv: number[] | null;
  cellTempsC: number[] | null;
  minMosTempC: number | null;
  maxMosTempC: number | null;
  balanceState: number | null;
  extra: Extra;
}

export interface Reading {
  telemetry: TelemetrySample;
  packs: PackSample[];
}

/** Something the adapter noticed while applying a message. */
/** `initial` marks the first time the state became known (no transition happened). */
export type DeviceEvent = { type: 'grid'; present: boolean; at: Date; initial: boolean };

/** What a device is, for public.devices (via ensure_device). */
export interface DeviceDescriptor {
  /** Adapter / brand id, e.g. `ecoflow`. */
  vendor: string;
  model: string;
  firmware?: string;
}

/**
 * Everything decoded from the device, latest value per field, for public.device_state.
 * Keyed by message (e.g. `254/21 DisplayPropertyUpload`, `32/50 BMSHeartBeatReport #0`).
 * Serial numbers are left out.
 */
export type DeviceState = Record<
  string,
  { at: string; fields: Record<string, unknown>; unknown?: Record<string, number | string> }
>;

export interface DeviceAdapter {
  readonly descriptor: DeviceDescriptor;
  /** Apply one raw MQTT payload received at `at`. Returns events it caused. */
  apply(payload: Uint8Array, at: Date): DeviceEvent[];
  /** Current merged state, or null if nothing useful has arrived yet. */
  reading(): Reading | null;
  /** When the last decodable message arrived. */
  readonly lastMessageAt: Date | undefined;
  /** Every decoded field (also those `reading()` leaves out), or null if nothing arrived. */
  state?(): DeviceState | null;
}
