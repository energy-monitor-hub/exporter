import type { DeviceAdapter, Reading } from '../model/types.js';
import type { Op, PackRow, TelemetryRow } from './ops.js';
import type { Outbox } from './outbox.js';
import { OutageTracker } from './outage.js';

export interface ExporterOptions {
  sn: string;
  /** Data older than this is not written as a sample (device or connection silent). */
  staleAfterMs?: number;
  /** How often the full device state (public.device_state) is written. Default 60 s. */
  stateIntervalMs?: number;
}

/**
 * Glue between a device adapter and the outbox: applies MQTT payloads, records outages
 * as they happen, and on every `sample()` writes the merged state as one telemetry row
 * plus one row per battery pack.
 */
export class Exporter {
  readonly outages: OutageTracker;
  private readonly staleAfterMs: number;
  private lastSampleAt: Date | undefined;
  private lastStateAt: Date | undefined;

  constructor(
    private readonly adapter: DeviceAdapter & { readonly gridPresent?: boolean | undefined },
    private readonly outbox: Outbox,
    private readonly opts: ExporterOptions,
  ) {
    this.outages = new OutageTracker(opts.sn, outbox);
    this.staleAfterMs = opts.staleAfterMs ?? 3 * 60_000;
  }

  get lastSample(): Date | undefined {
    return this.lastSampleAt;
  }

  onMessage(payload: Uint8Array, at: Date): void {
    const before = this.adapter.lastMessageAt;
    const events = this.adapter.apply(payload, at);
    const ops: Op[] = [];
    for (const e of events) ops.push(...this.outages.onEvent(e, this.adapter.reading()?.telemetry.socPct ?? null));
    if (this.adapter.lastMessageAt !== before) this.outages.seen(at, this.adapter.gridPresent);
    this.outbox.push(ops);
  }

  /** Write one snapshot at `now`. Returns false if there is nothing fresh to write. */
  sample(now: Date): boolean {
    const last = this.adapter.lastMessageAt;
    if (!last || now.getTime() - last.getTime() > this.staleAfterMs) return false;
    const reading = this.adapter.reading();
    if (!reading) return false;
    // ts is the primary key: two samples in the same millisecond would collide.
    if (this.lastSampleAt && now.getTime() <= this.lastSampleAt.getTime()) return false;
    this.lastSampleAt = now;
    this.outages.sample(now, reading.telemetry.wattsOut);
    const ops = toOps(this.opts.sn, now.toISOString(), reading);
    const every = this.opts.stateIntervalMs ?? 60_000;
    if (this.adapter.state && (!this.lastStateAt || now.getTime() - this.lastStateAt.getTime() >= every)) {
      const state = this.adapter.state();
      if (state) {
        ops.push({ kind: 'state', sn: this.opts.sn, updated_at: now.toISOString(), state });
        this.lastStateAt = now;
      }
    }
    this.outbox.push(ops);
    return true;
  }
}

export function toOps(sn: string, ts: string, r: Reading): Op[] {
  const t = r.telemetry;
  const telemetry: TelemetryRow = {
    ts,
    soc_pct: t.socPct,
    watts_in: t.wattsIn,
    watts_out: t.wattsOut,
    ac_in_voltage_v: t.acInVoltageV,
    ac_in_freq_hz: t.acInFreqHz,
    ac_out_freq_hz: t.acOutFreqHz,
    grid_present: t.gridPresent,
    extra: Object.keys(t.extra).length ? t.extra : null,
  };
  const ops: Op[] = [{ kind: 'telemetry', sn, row: telemetry }];
  for (const p of r.packs) {
    const row: PackRow = {
      ts,
      pack: p.pack,
      soc_pct: p.socPct,
      soh_pct: p.sohPct,
      cycles: p.cycles,
      cell_voltages_mv: p.cellVoltagesMv,
      cell_temps_c: p.cellTempsC,
      min_mos_temp_c: p.minMosTempC,
      max_mos_temp_c: p.maxMosTempC,
      balance_state: p.balanceState,
      extra: Object.keys(p.extra).length ? p.extra : null,
    };
    ops.push({ kind: 'pack', sn, row });
  }
  return ops;
}
