import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { Delta3MaxPlus } from '../src/decode/delta3maxplus.js';
import { Exporter } from '../src/exporter/exporter.js';
import { Flusher } from '../src/exporter/flusher.js';
import type { Op } from '../src/exporter/ops.js';
import { OutageTracker } from '../src/exporter/outage.js';
import { Outbox } from '../src/exporter/outbox.js';
import { SupabaseSink, type Sink } from '../src/exporter/sink.js';
import { SuspendDetector } from '../src/exporter/suspend.js';
import type { DeviceEvent } from '../src/model/types.js';
import { loadSession } from './helpers/fixtures.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const session = loadSession();

/** Replays the recording; samples every `stepS` seconds of recorded time, like the real interval. */
function replay(outbox: Outbox, filter: (at: Date) => boolean = () => true, stepS = 10) {
  const exporter = new Exporter(new Delta3MaxPlus(), outbox, { sn: 'SN' });
  let next = 0;
  for (const m of session) {
    if (!filter(m.at)) continue;
    exporter.onMessage(m.payload, m.at);
    if (m.at.getTime() >= next) {
      exporter.sample(m.at);
      next = m.at.getTime() + stepS * 1000;
    }
  }
  return exporter;
}

const ops = (outbox: Outbox) => outbox.peek(1_000_000).map((q) => q.op);

describe('Exporter on the live recording', () => {
  it('writes samples and exactly one outage with its discharge energy', () => {
    const outbox = new Outbox(':memory:');
    replay(outbox);
    const all = ops(outbox);
    const outages = all.filter((o) => o.kind.startsWith('outage'));
    expect(outages).toEqual([
      { kind: 'outage_start', sn: 'SN', started_at: '2026-11-21T18:40:50.935Z', soc_start_pct: 89 },
      expect.objectContaining({ kind: 'outage_end', started_at: '2026-11-21T18:40:50.935Z', ended_at: '2026-11-21T18:51:01.570Z' }),
    ]);
    const end = outages[1] as Extract<Op, { kind: 'outage_end' }>;
    // ~75 W for ~10 minutes
    expect(end.energy_out_wh).toBeGreaterThan(10);
    expect(end.energy_out_wh).toBeLessThan(16);

    const tel = all.filter((o): o is Extract<Op, { kind: 'telemetry' }> => o.kind === 'telemetry');
    const packs = all.filter((o): o is Extract<Op, { kind: 'pack' }> => o.kind === 'pack');
    expect(tel.length).toBeGreaterThan(200);
    expect(new Set(tel.map((t) => t.row.ts)).size).toBe(tel.length);
    expect(packs.every((p) => p.row.pack === 0 && p.row.cell_voltages_mv?.length === 16)).toBe(true);
    const during = tel.filter((t) => t.row.ts > '2026-11-21T18:41' && t.row.ts < '2026-11-21T18:51');
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((t) => t.row.grid_present === false && t.row.watts_in === 0)).toBe(true);
  });

  it('writes the full device state about once a minute, keeping only the newest one queued', () => {
    const outbox = new Outbox(':memory:');
    replay(outbox);
    const states = ops(outbox).filter((o): o is Extract<Op, { kind: 'state' }> => o.kind === 'state');
    // Older pending states of the same device are replaced, so one is left.
    expect(states).toHaveLength(1);
    const st = states[0]!.state;
    expect(Object.keys(st)).toEqual(
      expect.arrayContaining(['254/21 DisplayPropertyUpload', '254/22 RuntimePropertyUpload', '32/50 BMSHeartBeatReport #0', '32/2 CMSHeartBeatReport', '53/249']),
    );
    // Settings that reading() leaves out are there, and wire fields the .proto lacks too.
    expect(st['254/21 DisplayPropertyUpload']!.fields.acStandbyTime).toBe(1440);
    expect(st['254/22 RuntimePropertyUpload']!.unknown?.['220']).toBe(0);
    expect(st['53/249']!.unknown).toEqual({ '1': 2, '3': 1 });
    // No serial numbers, also not as unknown text.
    const json = JSON.stringify(st);
    expect(json).not.toMatch(/"(bmsSn|packSn|plugInInfoDcpSn)"/);
    expect(st['254/21 DisplayPropertyUpload']!.unknown?.['88']).toBe('text(16)');
  });

  it('dates a blind outage (no internet) from the last time the grid was seen', () => {
    const outbox = new Outbox(':memory:');
    // Pretend MQTT was silent from 18:40:40 to 18:44:30, as when the router loses power.
    replay(outbox, (at) => at.toISOString() < '2026-11-21T18:40:40' || at.toISOString() > '2026-11-21T18:44:30');
    const start = ops(outbox).find((o) => o.kind === 'outage_start') as Extract<Op, { kind: 'outage_start' }>;
    expect(start.started_at < '2026-11-21T18:40:40').toBe(true);
    expect(start.started_at > '2026-11-21T18:40:30').toBe(true);
    // ...and only knows it happened before it was seen gone
    expect(start.start_latest_at).toBe('2026-11-21T18:44:34.149Z');
    const gap = ops(outbox).find((o) => o.kind === 'gap' && o.ended_at === '2026-11-21T18:44:34.149Z');
    expect(gap).toMatchObject({ reason: 'offline', slept_s: null });
  });

  it('records the gaps of the recording without inventing outages', () => {
    const outbox = new Outbox(':memory:');
    replay(outbox);
    const gaps = ops(outbox).filter((o) => o.kind === 'gap');
    expect(gaps.map((g) => g.started_at)).toEqual([
      '2026-11-21T17:14:01.013Z',
      '2026-11-21T17:49:52.749Z',
      '2026-11-21T18:12:55.562Z',
      '2026-11-21T18:42:29.410Z',
    ]);
    expect(ops(outbox).filter((o) => o.kind.startsWith('outage'))).toHaveLength(2);
  });

  it('does not write samples from stale data', () => {
    const outbox = new Outbox(':memory:');
    const exporter = replay(outbox);
    const n = outbox.size;
    expect(exporter.sample(new Date('2026-11-21T19:30:00Z'))).toBe(false);
    expect(outbox.size).toBe(n);
  });
});

describe('OutageTracker', () => {
  it('survives a restart in the middle of an outage', () => {
    const outbox = new Outbox(':memory:');
    const a = new OutageTracker('SN', outbox);
    a.onEvent({ type: 'grid', present: false, at: new Date('2026-01-01T10:00:00Z'), initial: false }, 80);
    a.sample(new Date('2026-01-01T10:00:00Z'), 100);
    a.sample(new Date('2026-01-01T10:03:00Z'), 100);
    const b = new OutageTracker('SN', outbox); // restart
    expect(b.current?.startedAt).toBe('2026-01-01T10:00:00.000Z');
    const [end] = b.onEvent({ type: 'grid', present: true, at: new Date('2026-01-01T10:06:00Z'), initial: true }, 70);
    expect(end).toEqual({
      kind: 'outage_end',
      sn: 'SN',
      started_at: '2026-01-01T10:00:00.000Z',
      ended_at: '2026-01-01T10:06:00.000Z',
      soc_end_pct: 70,
      energy_out_wh: 10, // 100 W × 6 min
      start_latest_at: null,
      end_earliest_at: null,
    });
    expect(new OutageTracker('SN', outbox).current).toBeUndefined();
  });

  it('starts an outage when the exporter comes up with the grid already gone', () => {
    const t = new OutageTracker('SN', new Outbox(':memory:'));
    expect(t.onEvent({ type: 'grid', present: false, at: new Date(0), initial: true }, 50)).toHaveLength(1);
    expect(t.onEvent({ type: 'grid', present: true, at: new Date(1000), initial: true }, 50)).toHaveLength(1);
    expect(t.onEvent({ type: 'grid', present: true, at: new Date(2000), initial: false }, 50)).toHaveLength(0);
  });
});

describe('OutageTracker gaps', () => {
  const T = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, 0) + min * 60_000);
  const grid = (present: boolean, at: Date): DeviceEvent => ({ type: 'grid', present, at, initial: false });
  const sleptAll = { sleptWithin: (a: number, b: number) => b - a };
  const sleptNone = { sleptWithin: () => 0 };

  it('marks a gap while the host slept, and gives a missed start a window', () => {
    const t = new OutageTracker('SN', new Outbox(':memory:'), sleptAll);
    t.message(T(0), [grid(true, T(0))], true, () => 80);
    t.message(T(1), [], true, () => 80);
    const ops = t.message(T(61), [grid(false, T(61))], false, () => 60);
    expect(ops).toEqual([
      { kind: 'gap', sn: 'SN', started_at: T(1).toISOString(), ended_at: T(61).toISOString(), reason: 'sleep', slept_s: 3600 },
      { kind: 'outage_start', sn: 'SN', started_at: T(1).toISOString(), soc_start_pct: 60, start_latest_at: T(61).toISOString() },
    ]);
    expect(t.current?.startLatestAt).toBe(T(61).toISOString());
  });

  it('gives an end seen only after a gap a window', () => {
    const t = new OutageTracker('SN', new Outbox(':memory:'), sleptNone);
    t.message(T(0), [grid(false, T(0))], false, () => 80);
    t.message(T(5), [], false, () => 75);
    const ops = t.message(T(65), [grid(true, T(65))], true, () => 50);
    expect(ops[0]).toMatchObject({ kind: 'gap', reason: 'offline', slept_s: 0 });
    expect(ops[1]).toMatchObject({
      kind: 'outage_end',
      started_at: T(0).toISOString(),
      start_latest_at: null,
      end_earliest_at: T(5).toISOString(),
      ended_at: T(65).toISOString(),
    });
  });

  it('a grid change well after a gap is exact', () => {
    const t = new OutageTracker('SN', new Outbox(':memory:'), sleptNone);
    t.message(T(0), [], true, () => 80);
    t.message(T(10), [], true, () => 80);
    t.message(T(11), [], true, () => 80);
    const ops = t.message(T(12), [grid(false, T(12))], false, () => 80);
    expect(ops).toEqual([{ kind: 'outage_start', sn: 'SN', started_at: T(12).toISOString(), soc_start_pct: 80 }]);
  });

  it('infers an outage nobody saw from a battery drop across a gap', () => {
    const t = new OutageTracker('SN', new Outbox(':memory:'), sleptAll);
    t.message(T(0), [grid(true, T(0))], true, () => 90);
    expect(t.message(T(180), [], true, () => 90)).toMatchObject([{ kind: 'gap', reason: 'sleep' }]);
    expect(t.sample(T(180), 50, 90, true)).toEqual([]); // SoC not confirmed yet
    expect(t.sample(T(181), 50, 70, true)).toEqual([
      {
        kind: 'outage_end',
        sn: 'SN',
        started_at: T(0).toISOString(),
        ended_at: T(180).toISOString(),
        soc_start_pct: 90,
        soc_end_pct: 70,
        energy_out_wh: null,
        start_latest_at: T(180).toISOString(),
        end_earliest_at: T(0).toISOString(),
        inferred: true,
      },
    ]);
    expect(t.sample(T(182), 50, 70, true)).toEqual([]); // once
  });

  it('does not infer an outage from standby drain or a seen grid change', () => {
    const a = new OutageTracker('SN', new Outbox(':memory:'), sleptAll);
    a.message(T(0), [], true, () => 90);
    a.message(T(600), [], true, () => 88); // 10 h, -2 %
    expect(a.sample(T(601), 5, 87.5, true)).toEqual([]);

    const b = new OutageTracker('SN', new Outbox(':memory:'), sleptAll);
    b.message(T(0), [grid(true, T(0))], true, () => 90);
    b.message(T(60), [grid(false, T(60))], false, () => 60);
    expect(b.sample(T(61), 50, 60, false)).toEqual([]);
  });

  it('counts the time the exporter was not running as a stopped gap', () => {
    const outbox = new Outbox(':memory:');
    const a = new OutageTracker('SN', outbox, sleptNone);
    a.message(T(0), [grid(false, T(0))], false, () => 80);
    const b = new OutageTracker('SN', outbox, sleptNone); // restart 2 h later
    const ops = b.message(T(120), [{ type: 'grid', present: true, at: T(120), initial: true }], true, () => 40);
    expect(ops[0]).toMatchObject({ kind: 'gap', reason: 'stopped', slept_s: null, started_at: T(0).toISOString() });
    expect(ops[1]).toMatchObject({ kind: 'outage_end', end_earliest_at: T(0).toISOString(), ended_at: T(120).toISOString() });
    // "last seen" is per device
    expect(new OutageTracker('OTHER', outbox).message(T(240), [], true, () => 40)).toEqual([]);
  });
});

describe('SuspendDetector', () => {
  it('notices a tick that came late and the wall clock running ahead of the monotonic one', () => {
    let wall = 0;
    let mono = 0;
    const d = new SuspendDetector({ tickMs: 5_000, slackMs: 20_000, clocks: { wall: () => wall, mono: () => mono } });
    const step = (w: number, m: number) => {
      wall += w;
      mono += m;
      d.tick();
    };
    step(5_000, 5_000);
    step(5_500, 5_500); // a bit late: nothing
    expect(d.recent).toEqual([]);
    step(3_605_000, 5_000); // monotonic clock stood still for an hour (macOS, Linux)
    expect(d.recent).toEqual([{ from: 15_500, to: 3_615_500 }]);
    step(605_000, 605_000); // VM whose monotonic clock kept going: the timer fired late
    expect(d.recent[1]).toEqual({ from: 3_620_500, to: 4_220_500 }); // one tick of it was lived
    expect(d.sleptWithin(0, 3_615_500)).toBe(3_600_000);
    expect(d.sleptWithin(3_000_000, 3_700_000)).toBe(615_500 + 79_500);
  });
});

describe('Outbox', () => {
  it('keeps ops in order until removed, and drops the oldest samples past the cap', () => {
    const o = new Outbox(':memory:', 3);
    const tel = (ts: string): Op => ({ kind: 'telemetry', sn: 'SN', row: { ts } as never });
    o.push([{ kind: 'outage_start', sn: 'SN', started_at: 'x', soc_start_pct: null }, tel('1'), tel('2'), tel('3')]);
    expect(o.size).toBe(3);
    expect(o.peek(10).map((q) => q.op.kind)).toEqual(['outage_start', 'telemetry', 'telemetry']);
    o.remove(o.peek(1).map((q) => q.id));
    expect(o.peek(10).map((q) => (q.op as { row: { ts: string } }).row.ts)).toEqual(['2', '3']);
  });
});

describe('Flusher', () => {
  it('retries the same batch after a failure and empties the outbox', async () => {
    const outbox = new Outbox(':memory:');
    outbox.push([{ kind: 'outage_start', sn: 'SN', started_at: 'a', soc_start_pct: 1 }]);
    const sent: Op[][] = [];
    let fail = true;
    const sink: Sink = {
      send: async (ops) => {
        if (fail) throw new Error('offline');
        sent.push([...ops]);
      },
    };
    const f = new Flusher(outbox, sink, quiet, { intervalMs: 1000 });
    await expect(f.flush()).rejects.toThrow('offline');
    expect(outbox.size).toBe(1);
    fail = false;
    expect(await f.flush()).toBe(true);
    expect(outbox.size).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe('SupabaseSink', () => {
  it('batches samples per table and upserts outages by (device_id, started_at)', async () => {
    const calls: { table: string; rows: unknown; opts: unknown }[] = [];
    const db = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ table: fn, rows: args, opts: undefined });
        return { data: 'dev-1', error: null };
      },
      from: (table: string) => ({
        upsert: (rows: unknown, opts: unknown) => {
          calls.push({ table, rows, opts });
          const result = { data: { id: 'dev-1' }, error: null };
          return Object.assign(Promise.resolve(result), { select: () => ({ single: async () => result }) });
        },
      }),
    } as unknown as SupabaseClient;
    const sink = new SupabaseSink(db, () => ({ vendor: 'ecoflow', model: 'DELTA 3 Max Plus' }));
    const tel = (ts: string): Op => ({ kind: 'telemetry', sn: 'SN', row: { ts } as never });
    await sink.send([
      tel('1'),
      tel('2'),
      { kind: 'outage_end', sn: 'SN', started_at: 's', ended_at: 'e', soc_end_pct: 5, energy_out_wh: 1 },
    ]);
    expect(calls.map((c) => c.table)).toEqual(['ensure_device', 'telemetry_raw', 'outages']);
    expect(calls[0]!.rows).toEqual({ p_sn: 'SN', p_vendor: 'ecoflow', p_model: 'DELTA 3 Max Plus', p_firmware: null });
    expect(calls[1]!.rows).toEqual([
      { device_id: 'dev-1', ts: '1' },
      { device_id: 'dev-1', ts: '2' },
    ]);
    expect(calls[1]!.opts).toEqual({ onConflict: 'device_id,ts', ignoreDuplicates: true });
    expect(calls[2]!.opts).toEqual({ onConflict: 'device_id,started_at' });
    // an op queued by an older version leaves the new columns alone
    expect(calls[2]!.rows).toEqual({ device_id: 'dev-1', started_at: 's', ended_at: 'e', soc_end_pct: 5, energy_out_wh: 1 });
  });

  it('writes gaps and outage windows', async () => {
    const calls: { table: string; rows: unknown; opts: unknown }[] = [];
    const db = {
      rpc: async () => ({ data: 'dev-1', error: null }),
      from: (table: string) => ({
        upsert: async (rows: unknown, opts: unknown) => {
          calls.push({ table, rows, opts });
          return { error: null };
        },
      }),
    } as unknown as SupabaseClient;
    const sink = new SupabaseSink(db, () => ({ vendor: 'v', model: 'm' }));
    await sink.send([
      { kind: 'gap', sn: 'SN', started_at: 'a', ended_at: 'b', reason: 'sleep', slept_s: 60 },
      { kind: 'outage_start', sn: 'SN', started_at: 'a', soc_start_pct: 9, start_latest_at: 'b' },
      { kind: 'outage_end', sn: 'SN', started_at: 'a', ended_at: 'd', soc_end_pct: 5, energy_out_wh: null, soc_start_pct: 9, start_latest_at: 'b', end_earliest_at: 'c', inferred: true },
    ]);
    expect(calls).toEqual([
      { table: 'exporter_gaps', rows: { device_id: 'dev-1', started_at: 'a', ended_at: 'b', reason: 'sleep', slept_s: 60 }, opts: { onConflict: 'device_id,started_at', ignoreDuplicates: true } },
      { table: 'outages', rows: { device_id: 'dev-1', started_at: 'a', soc_start_pct: 9, start_latest_at: 'b' }, opts: { onConflict: 'device_id,started_at', ignoreDuplicates: true } },
      {
        table: 'outages',
        rows: { device_id: 'dev-1', started_at: 'a', ended_at: 'd', soc_end_pct: 5, energy_out_wh: null, soc_start_pct: 9, start_latest_at: 'b', end_earliest_at: 'c', inferred: true },
        opts: { onConflict: 'device_id,started_at' },
      },
    ]);
  });

  it('upserts the device state by device_id', async () => {
    const calls: { table: string; rows: unknown; opts: unknown }[] = [];
    const db = {
      rpc: async () => ({ data: 'dev-1', error: null }),
      from: (table: string) => ({
        upsert: async (rows: unknown, opts: unknown) => {
          calls.push({ table, rows, opts });
          return { error: null };
        },
      }),
    } as unknown as SupabaseClient;
    const sink = new SupabaseSink(db, () => ({ vendor: 'ecoflow', model: 'DELTA 3 Max Plus' }));
    await sink.send([{ kind: 'state', sn: 'SN', updated_at: 't', state: { a: { at: 't', fields: { x: 1 } } } }]);
    expect(calls).toEqual([
      { table: 'device_state', rows: { device_id: 'dev-1', updated_at: 't', state: { a: { at: 't', fields: { x: 1 } } } }, opts: { onConflict: 'device_id' } },
    ]);
  });

  it('throws on a Supabase error so the batch stays queued', async () => {
    const db = {
      rpc: async () => ({ data: 'd', error: null }),
      from: () => ({ upsert: async () => ({ error: { message: 'boom' } }) }),
    } as unknown as SupabaseClient;
    await expect(new SupabaseSink(db, () => ({ vendor: 'v', model: 'm' })).send([{ kind: 'telemetry', sn: 'SN', row: { ts: '1' } as never }])).rejects.toThrow('boom');
  });
});
