import type { DeviceEvent } from '../model/types.js';
import type { Op } from './ops.js';

/** Open outage, persisted so a restart in the middle of an outage keeps it. */
export interface OpenOutage {
  startedAt: string;
  socStartPct: number | null;
  energyOutWh: number;
  /** Last discharge power sample and its time, for integrating energy. */
  lastWatts: number | null;
  lastAt: string | null;
}

export interface OutageStore {
  getState<T>(key: string): T | undefined;
  setState(key: string, value: unknown): void;
}

const KEY = 'open_outage';
/** Discharge between samples further apart than this is not counted (we were blind). */
const MAX_GAP_MS = 5 * 60_000;
/** A silence this long before a grid change means we did not see the moment itself. */
export const BLIND_GAP_MS = 2 * 60_000;

/**
 * Turns grid presence changes into outage rows (issue #15).
 *
 * Without internet (it usually goes down with the grid) the cloud MQTT is silent, so the
 * exporter often sees an outage only when the connection is back. Then:
 * - start = the last moment the grid was seen present (the device reports every few seconds
 *   while on grid, so this is close to the real start);
 * - end = the first moment the grid is seen present again.
 */
export class OutageTracker {
  private open: OpenOutage | undefined;
  private lastPresentAt: Date | undefined;
  private lastSeenAt: Date | undefined;

  constructor(
    private readonly sn: string,
    private readonly store: OutageStore,
  ) {
    this.open = store.getState<OpenOutage>(KEY);
  }

  get current(): OpenOutage | undefined {
    return this.open;
  }

  /** Every decoded message, whatever it says (keeps "last seen" times). */
  seen(at: Date, gridPresent: boolean | undefined): void {
    this.lastSeenAt = at;
    if (gridPresent) this.lastPresentAt = at;
  }

  onEvent(e: DeviceEvent, socPct: number | null): Op[] {
    if (e.type !== 'grid') return [];
    const blind = this.lastSeenAt !== undefined && e.at.getTime() - this.lastSeenAt.getTime() > BLIND_GAP_MS;
    if (!e.present) {
      if (this.open) return [];
      const start = blind && this.lastPresentAt ? this.lastPresentAt : e.at;
      this.open = { startedAt: start.toISOString(), socStartPct: socPct, energyOutWh: 0, lastWatts: null, lastAt: null };
      this.store.setState(KEY, this.open);
      return [{ kind: 'outage_start', sn: this.sn, started_at: this.open.startedAt, soc_start_pct: socPct }];
    }
    if (!this.open) return [];
    const o = this.open;
    this.integrate(e.at, null);
    this.open = undefined;
    this.store.setState(KEY, undefined);
    const ended = e.at.getTime() < Date.parse(o.startedAt) ? new Date(o.startedAt) : e.at;
    return [
      {
        kind: 'outage_end',
        sn: this.sn,
        started_at: o.startedAt,
        ended_at: ended.toISOString(),
        soc_end_pct: socPct,
        energy_out_wh: Math.round(o.energyOutWh * 10) / 10,
      },
    ];
  }

  /** Feed the output power while the grid is away (called on every sample). */
  sample(at: Date, wattsOut: number | null): void {
    if (!this.open) return;
    this.integrate(at, wattsOut);
    this.store.setState(KEY, this.open);
  }

  private integrate(at: Date, wattsOut: number | null): void {
    const o = this.open;
    if (!o) return;
    if (o.lastAt !== null && o.lastWatts !== null) {
      const dt = at.getTime() - Date.parse(o.lastAt);
      if (dt > 0 && dt <= MAX_GAP_MS) o.energyOutWh += (o.lastWatts * dt) / 3_600_000;
    }
    o.lastAt = at.toISOString();
    o.lastWatts = wattsOut;
  }
}
