import type { GapReason } from '../db/types.js';
import type { DeviceEvent } from '../model/types.js';
import type { Op } from './ops.js';
import type { SuspendLog } from './suspend.js';

/** Open outage, persisted so a restart in the middle of an outage keeps it. */
export interface OpenOutage {
  /** Earliest possible start (exact unless `startLatestAt` is set). */
  startedAt: string;
  /** Latest possible start, when the exporter was blind at the moment the grid went away. */
  startLatestAt?: string;
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

/** What the exporter last saw, persisted so the time it was not running counts as a gap. */
interface LastSeen {
  at: string;
  presentAt: string | null;
  socPct: number | null;
  grid: boolean | null;
}

/** A stretch without data from the device, kept until the state after it is confirmed. */
interface Gap {
  from: Date;
  to: Date;
  socBefore: number | null;
  gridBefore: boolean | null;
  presentBefore: Date | undefined;
  /** A grid change was seen right after it, so it is accounted for. */
  explained: boolean;
}

const KEY = 'open_outage';
/** Discharge between samples further apart than this is not counted (we were blind). */
const MAX_GAP_MS = 5 * 60_000;
/** A silence this long means we may have missed a grid change; it is recorded as a gap. */
export const BLIND_GAP_MS = 2 * 60_000;
/**
 * After a gap the adapter still holds the grid flag from before it until the device reports
 * it again (on the first messages after a reconnect). A grid change seen this soon after a
 * gap happened inside it.
 */
export const CONFIRM_MS = 30_000;
/** How often "last seen" goes to disk (a restart loses at most this much precision). */
const SEEN_PERSIST_MS = 15_000;
/**
 * A battery drop over a blind stretch, with the grid there before and after, that means an
 * outage nobody saw: at least this many percentage points, plus the standby drain per hour
 * (pass-through costs a few watts even on grid).
 */
export const INFER_MIN_DROP_PCT = 3;
const STANDBY_DRAIN_PCT_PER_H = 0.3;

/**
 * Turns grid presence changes into outage rows (issue #15), and the exporter's own blind
 * stretches into gap rows.
 *
 * Without internet (it usually goes down with the grid), while the host sleeps or while the
 * exporter is stopped, nothing comes from the device, so the exporter may see an outage only
 * after the fact. Then the outage gets a window instead of a moment:
 * - start between the last time the grid was seen present and the first time it was seen gone;
 * - end between the last time it was seen gone and the first time it was seen present again;
 * - an outage that began and ended inside the gap leaves only a battery drop; that is recorded
 *   as an inferred outage spanning the gap.
 * Every gap is recorded with its cause (host asleep, exporter stopped, or no data while running).
 */
export class OutageTracker {
  private open: OpenOutage | undefined;
  private lastPresentAt: Date | undefined;
  private lastSeenAt: Date | undefined;
  private lastSoc: number | null = null;
  private lastGrid: boolean | null = null;
  /** "Last seen" came from disk: the exporter was not running since then. */
  private fromPreviousRun = false;
  private gap: Gap | undefined;
  private persistedAt = 0;

  constructor(
    private readonly sn: string,
    private readonly store: OutageStore,
    private readonly suspends?: SuspendLog,
  ) {
    this.open = store.getState<OpenOutage>(KEY);
    const seen = store.getState<LastSeen>(this.seenKey);
    if (seen) {
      this.lastSeenAt = new Date(seen.at);
      this.lastPresentAt = seen.presentAt ? new Date(seen.presentAt) : undefined;
      this.lastSoc = seen.socPct;
      this.lastGrid = seen.grid;
      this.fromPreviousRun = true;
    }
  }

  /** Per device: after switching devices, the old one's "last seen" means nothing. */
  private get seenKey(): string {
    return `last_seen:${this.sn}`;
  }

  get current(): OpenOutage | undefined {
    return this.open;
  }

  /**
   * One decoded message: the events it caused, then the grid flag and SoC after it (`socPct`
   * is read lazily, only when needed).
   */
  message(at: Date, events: readonly DeviceEvent[], gridPresent: boolean | undefined, socPct: () => number | null): Op[] {
    const ops: Op[] = [];
    if (this.lastSeenAt && at.getTime() - this.lastSeenAt.getTime() > BLIND_GAP_MS) {
      ops.push(this.gapOp(this.lastSeenAt, at));
      this.gap = {
        from: this.lastSeenAt,
        to: at,
        socBefore: this.lastSoc,
        gridBefore: this.lastGrid,
        presentBefore: this.lastPresentAt,
        explained: false,
      };
    }
    this.fromPreviousRun = false;
    const soc = events.length > 0 || this.due(at) ? socPct() : null;
    for (const e of events) ops.push(...this.onEvent(e, soc));
    this.lastSeenAt = at;
    this.lastGrid = gridPresent ?? null;
    if (gridPresent) this.lastPresentAt = at;
    // Right after a gap the SoC may still be the one from before it.
    if (!this.confirming(at) && soc !== null) this.lastSoc = soc;
    if (this.due(at)) this.persistSeen(at);
    return ops;
  }

  onEvent(e: DeviceEvent, socPct: number | null): Op[] {
    if (e.type !== 'grid') return [];
    const gap = this.gap && this.confirming(e.at) ? this.gap : undefined;
    if (gap) gap.explained = true;
    if (!e.present) {
      if (this.open) return [];
      const start = gap ? (gap.presentBefore ?? gap.from) : e.at;
      this.open = { startedAt: start.toISOString(), socStartPct: socPct, energyOutWh: 0, lastWatts: null, lastAt: null };
      if (gap) this.open.startLatestAt = e.at.toISOString();
      this.store.setState(KEY, this.open);
      return [
        {
          kind: 'outage_start',
          sn: this.sn,
          started_at: this.open.startedAt,
          soc_start_pct: socPct,
          ...(this.open.startLatestAt ? { start_latest_at: this.open.startLatestAt } : {}),
        },
      ];
    }
    if (!this.open) return [];
    const o = this.open;
    this.integrate(e.at, null);
    this.open = undefined;
    this.store.setState(KEY, undefined);
    const startMs = Date.parse(o.startedAt);
    const ended = e.at.getTime() < startMs ? new Date(startMs) : e.at;
    const earliest = gap ? new Date(Math.min(ended.getTime(), Math.max(startMs, gap.from.getTime()))) : undefined;
    return [
      {
        kind: 'outage_end',
        sn: this.sn,
        started_at: o.startedAt,
        ended_at: ended.toISOString(),
        soc_end_pct: socPct,
        energy_out_wh: Math.round(o.energyOutWh * 10) / 10,
        start_latest_at: o.startLatestAt ?? null,
        end_earliest_at: earliest && earliest.getTime() < ended.getTime() ? earliest.toISOString() : null,
      },
    ];
  }

  /**
   * Every sample: integrates the output power while the grid is away, and once the state
   * after a gap is confirmed, checks whether the battery dropped across it.
   */
  sample(at: Date, wattsOut: number | null, socPct: number | null = null, gridPresent: boolean | null = null): Op[] {
    if (this.open) {
      this.integrate(at, wattsOut);
      this.store.setState(KEY, this.open);
    }
    const gap = this.gap;
    if (!gap || at.getTime() - gap.to.getTime() < CONFIRM_MS) return [];
    this.gap = undefined;
    if (socPct !== null) this.lastSoc = socPct;
    if (gap.explained || this.open || gap.gridBefore !== true || gridPresent !== true) return [];
    if (gap.socBefore === null || socPct === null) return [];
    const hours = (gap.to.getTime() - gap.from.getTime()) / 3_600_000;
    if (gap.socBefore - socPct < INFER_MIN_DROP_PCT + STANDBY_DRAIN_PCT_PER_H * hours) return [];
    const from = gap.from.toISOString();
    const to = gap.to.toISOString();
    return [
      {
        kind: 'outage_end',
        sn: this.sn,
        started_at: from,
        ended_at: to,
        soc_start_pct: gap.socBefore,
        soc_end_pct: socPct,
        energy_out_wh: null,
        start_latest_at: to,
        end_earliest_at: from,
        inferred: true,
      },
    ];
  }

  /** Right after a gap: the grid flag and SoC may still be the ones from before it. */
  private confirming(at: Date): boolean {
    return this.gap !== undefined && at.getTime() - this.gap.to.getTime() < CONFIRM_MS;
  }

  private due(at: Date): boolean {
    return at.getTime() - this.persistedAt >= SEEN_PERSIST_MS;
  }

  private persistSeen(at: Date): void {
    this.persistedAt = at.getTime();
    const seen: LastSeen = {
      at: at.toISOString(),
      presentAt: this.lastPresentAt?.toISOString() ?? null,
      socPct: this.lastSoc,
      grid: this.lastGrid,
    };
    this.store.setState(this.seenKey, seen);
  }

  private gapOp(from: Date, to: Date): Op {
    let reason: GapReason;
    let slept: number | null = null;
    if (this.fromPreviousRun) {
      reason = 'stopped';
    } else {
      const ms = this.suspends?.sleptWithin(from.getTime(), to.getTime()) ?? 0;
      reason = ms * 2 >= to.getTime() - from.getTime() ? 'sleep' : 'offline';
      if (this.suspends) slept = Math.round(ms / 1000);
    }
    return { kind: 'gap', sn: this.sn, started_at: from.toISOString(), ended_at: to.toISOString(), reason, slept_s: slept };
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
