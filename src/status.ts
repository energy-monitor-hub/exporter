import type { SupabaseClient } from '@supabase/supabase-js';
import type { Exporter } from './exporter/exporter.js';
import type { FlusherStatus } from './exporter/flusher.js';
import type { PackSample, Reading } from './model/types.js';
import type { OAuthSession } from './oauth/session.js';
import type { SetupStatus } from './setup.js';
import type { Source } from './sources/types.js';

/** One past outage as the status page shows it (public.outages). */
export interface OutageRow {
  started_at: string;
  ended_at: string | null;
  soc_start_pct: number | null;
  soc_end_pct: number | null;
  energy_out_wh: number | null;
  start_latest_at: string | null;
  end_earliest_at: string | null;
  inferred: boolean;
}

export interface RecentOutages {
  rows: OutageRow[];
  fetchedAt?: string;
  error?: string;
}

/**
 * Last few outages of this device from Supabase, as the exporter's user (RLS). Cached, so the
 * status page polling every few seconds costs one query a minute at most.
 */
export class OutageHistory {
  private cache: RecentOutages = { rows: [] };
  private fetchedAtMs: number | undefined;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly db: SupabaseClient,
    /** Serial number of the device now running; nothing is fetched without one. */
    private readonly sn: () => string | undefined,
    private readonly opts: { ttlMs?: number; limit?: number; now?: () => number } = {},
  ) {}

  /** Force the next `get()` to query again (after a login). */
  invalidate(): void {
    this.fetchedAtMs = undefined;
  }

  async get(): Promise<RecentOutages> {
    const now = (this.opts.now ?? Date.now)();
    if (this.fetchedAtMs === undefined || now - this.fetchedAtMs >= (this.opts.ttlMs ?? 60_000)) {
      this.inflight ??= this.fetch(now).finally(() => (this.inflight = undefined));
      await this.inflight;
    }
    return this.cache;
  }

  private async fetch(now: number): Promise<void> {
    this.fetchedAtMs = now;
    const sn = this.sn();
    if (!sn) {
      this.cache = { rows: [] };
      return;
    }
    try {
      const { data, error } = await this.db
        .from('outages')
        .select('started_at, ended_at, soc_start_pct, soc_end_pct, energy_out_wh, start_latest_at, end_earliest_at, inferred, devices!inner(sn)')
        .eq('devices.sn', sn)
        .order('started_at', { ascending: false })
        .limit(this.opts.limit ?? 5);
      if (error) throw new Error(error.message);
      const rows = (data ?? []).map((r) => ({
        started_at: r.started_at as string,
        ended_at: (r.ended_at as string | null) ?? null,
        soc_start_pct: (r.soc_start_pct as number | null) ?? null,
        soc_end_pct: (r.soc_end_pct as number | null) ?? null,
        energy_out_wh: (r.energy_out_wh as number | null) ?? null,
        start_latest_at: (r.start_latest_at as string | null) ?? null,
        end_earliest_at: (r.end_earliest_at as string | null) ?? null,
        inferred: (r.inferred as boolean | null) ?? false,
      }));
      this.cache = { rows, fetchedAt: new Date(now).toISOString() };
    } catch (err) {
      // Keep the rows we had; the page shows the error next to them.
      this.cache = { ...this.cache, error: (err as Error).message };
    }
  }
}

/** Keeps the serial number out of screenshots: only its last 4 characters. */
export const maskSn = (sn: string) => (sn.length > 4 ? `…${sn.slice(-4)}` : sn);

const min = (xs: readonly number[]) => (xs.length ? Math.min(...xs) : null);
const max = (xs: readonly number[]) => (xs.length ? Math.max(...xs) : null);

export function packSummary(p: PackSample) {
  const v = p.cellVoltagesMv ?? [];
  const t = p.cellTempsC ?? [];
  const vMin = min(v);
  const vMax = max(v);
  return {
    pack: p.pack,
    socPct: p.socPct,
    sohPct: p.sohPct,
    cycles: p.cycles,
    cells: v.length,
    cellMinMv: vMin,
    cellMaxMv: vMax,
    cellSpreadMv: vMin !== null && vMax !== null ? vMax - vMin : null,
    tempMinC: min(t),
    tempMaxC: max(t),
  };
}

export function readingSummary(r: Reading | null) {
  if (!r) return null;
  const t = r.telemetry;
  return {
    socPct: t.socPct,
    wattsIn: t.wattsIn,
    wattsOut: t.wattsOut,
    acInVoltageV: t.acInVoltageV,
    acInFreqHz: t.acInFreqHz,
    gridPresent: t.gridPresent,
    packs: r.packs.map(packSummary),
  };
}

export interface StatusDeps {
  /** Undefined until credentials are set up (setup page) or after "Forget". */
  source: Source | undefined;
  exporter: Exporter | undefined;
  setup: SetupStatus;
  /** Decoder packs (src/packs/): update state and the adapter in use. */
  decoders?: unknown;
  /** New exporter versions (src/update/). */
  updates?: unknown;
  queue: () => FlusherStatus | { pending: number };
  session: OAuthSession | undefined;
  dbConfigured: boolean;
  outages: OutageHistory | undefined;
  sampleIntervalS: number;
  startedAt: Date;
  /** Exporter login from the page is possible (Supabase configured). */
  canLogin: boolean;
  /** A login was started from the page and is waiting for the browser to come back. */
  loginPending: boolean;
  now?: () => Date;
}

/** Everything the status page shows, in one JSON document (GET /api/status). */
export async function buildStatus(d: StatusDeps) {
  const now = (d.now ?? (() => new Date()))();
  const a = d.source?.adapter;
  const auth = d.session?.state;
  return {
    now: now.toISOString(),
    startedAt: d.startedAt.toISOString(),
    setup: d.setup,
    ...(d.decoders !== undefined ? { decoders: d.decoders } : {}),
    ...(d.updates !== undefined ? { updates: d.updates } : {}),
    device: d.source && a ? { sn: maskSn(d.source.sn), ...a.descriptor } : null,
    source: { connected: d.source?.isConnected ?? false, lastMessageAt: a?.lastMessageAt?.toISOString() ?? null },
    sampling: { intervalS: d.sampleIntervalS, lastSampleAt: d.exporter?.lastSample?.toISOString() ?? null },
    db: { configured: d.dbConfigured, canLogin: d.canLogin, loginPending: d.loginPending },
    auth: auth ?? null,
    queue: d.queue(),
    grid: {
      present: a?.gridPresent ?? null,
      openOutageSince: d.exporter?.outages.current?.startedAt ?? null,
      // set when the exporter was blind at the moment: the start is somewhere in between
      openOutageSinceLatest: d.exporter?.outages.current?.startLatestAt ?? null,
    },
    reading: readingSummary(a?.reading() ?? null),
    // Only ask Supabase while the login works; otherwise every poll would fail the same way.
    outages: d.outages && auth?.state !== 'logged-out' && auth?.state !== 'revoked' ? await d.outages.get() : null,
  };
}

export type Status = Awaited<ReturnType<typeof buildStatus>>;
