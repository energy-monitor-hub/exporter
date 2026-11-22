import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { Delta3MaxPlus } from '../src/decode/delta3maxplus.js';
import { decodePayload } from '../src/decode/envelope.js';
import { lookupType } from '../src/decode/proto.js';
import type { DeviceEvent } from '../src/model/types.js';
import { loadSession } from './helpers/fixtures.js';
import { encodeHeaderMessage } from './helpers/proto.js';

const session = loadSession();

function encode(type: string, data: Record<string, unknown>): Uint8Array {
  const t = lookupType(type);
  return t.encode(t.fromObject(data)).finish();
}

describe('decodePayload on the live recording', () => {
  it('decodes every message; only 53/249 has no known type', () => {
    const unknown = new Set<string>();
    let decoded = 0;
    for (const m of session) {
      const msgs = decodePayload(m.payload);
      expect(msgs, m.file).not.toBeNull();
      for (const h of msgs ?? []) {
        expect(h.error, m.file).toBeUndefined();
        if (h.type) decoded++;
        else unknown.add(`${h.cmdFunc}/${h.cmdId}`);
      }
    }
    expect(decoded).toBeGreaterThan(1700);
    expect([...unknown]).toEqual(['53/249']);
  });

  it('BMS reports one pack (the main unit) with 16 cells and 4 temperature sensors', () => {
    const packs = new Set<number>();
    for (const m of session) {
      for (const h of decodePayload(m.payload) ?? []) {
        if (h.type !== 'BMSHeartBeatReport' || !h.data?.cellVol) continue;
        const d = h.data as { num?: number; cellVol: number[]; cellTemp: number[]; cellSeriesNum: number };
        packs.add(d.num ?? 0);
        expect(d.cellVol).toHaveLength(16);
        expect(d.cellSeriesNum).toBe(16);
        expect(d.cellTemp).toHaveLength(4);
        for (const v of d.cellVol) {
          expect(v).toBeGreaterThan(3000);
          expect(v).toBeLessThan(3650);
        }
      }
    }
    expect([...packs]).toEqual([0]);
  });

  it('contains no battery serial numbers (scrubbed to placeholders)', () => {
    for (const m of session) {
      for (const h of decodePayload(m.payload) ?? []) {
        for (const key of ['bmsSn', 'packSn']) {
          const v = h.data?.[key];
          if (typeof v === 'string') expect(v).toMatch(/^X+$/);
        }
      }
    }
  });

  it('returns null for JSON and garbage', () => {
    expect(decodePayload(Buffer.from('{"a":1}'))).toBeNull();
    expect(decodePayload(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
    expect(decodePayload(new Uint8Array())).toBeNull();
  });

  it('un-XORs pdata when encType = 1', () => {
    const seq = 0x0102_03a7;
    const plain = encode('DisplayPropertyUpload', { powInSumW: 123, plugInInfoAcInFlag: 1 });
    const payload = encodeHeaderMessage([
      { pdata: plain.map((b) => b ^ (seq & 0xff)), encType: 1, src: 2, seq, cmdFunc: 254, cmdId: 21 },
    ]);
    const [m] = decodePayload(payload) ?? [];
    expect(m?.data).toEqual({ powInSumW: 123, plugInInfoAcInFlag: 1 });
  });

  it('keeps the proto parseable (protobufjs)', () => {
    expect(lookupType('BMSHeartBeatReport')).toBeInstanceOf(protobuf.Type);
  });
});

describe('Delta3MaxPlus adapter', () => {
  function replay(): { adapter: Delta3MaxPlus; events: DeviceEvent[] } {
    const adapter = new Delta3MaxPlus();
    const events: DeviceEvent[] = [];
    for (const m of session) events.push(...adapter.apply(m.payload, m.at));
    return { adapter, events };
  }

  it('sees the grid outage of 2026-11-21 (20:40:50 to 20:51:01 local time)', () => {
    const { events } = replay();
    expect(events.map((e) => [e.present, e.at.toISOString(), e.initial])).toEqual([
      [true, '2026-11-21T17:13:39.582Z', true],
      [false, '2026-11-21T18:40:50.935Z', false],
      [true, '2026-11-21T18:51:01.570Z', false],
    ]);
  });

  it('merges incremental messages into a full reading', () => {
    const { adapter } = replay();
    const r = adapter.reading();
    expect(r).not.toBeNull();
    const t = r!.telemetry;
    expect(t.gridPresent).toBe(true);
    expect(t.socPct).toBeGreaterThanOrEqual(89);
    expect(t.acOutFreqHz).toBe(50);
    expect(t.acInFreqHz).toBeNull();
    expect(t.acInVoltageV).toBeGreaterThan(200);
    expect(t.wattsIn).toBeTypeOf('number');
    expect(t.wattsOut).toBeTypeOf('number');
    expect(r!.packs).toHaveLength(1);
    const p = r!.packs[0]!;
    expect(p.pack).toBe(0);
    expect(p.cellVoltagesMv).toHaveLength(16);
    expect(p.cellTempsC).toHaveLength(4);
    expect(p.sohPct).toBe(100);
    expect(p.cycles).toBe(37);
    expect(p.extra.real_soh_pct).toBeCloseTo(96.9, 1);
  });

  it('decodes the fields added for charts (local proto additions, battery power, passport)', () => {
    const { adapter } = replay();
    const r = adapter.reading()!;
    const t = r.telemetry.extra;
    // pow_get_ac_out is always 0 on this model; the AC load shows up in unknown972[2].
    expect(t.out_ports_w).toHaveLength(5);
    expect(t.ac_out_w).toBe((t.out_ports_w as number[])[2]);
    expect(t.ac_out_w).toBeGreaterThan(30);
    expect(t.temps_aux_c).toHaveLength(5);
    expect(t.chg_line_flag).toBe(1);
    expect(t.batt_w).toBeTypeOf('number');
    expect(t.loss_w).toBeTypeOf('number');
    const p = r.packs[0]!.extra;
    expect(p.power_w).toBeCloseTo(((p.voltage_mv as number) * (p.current_ma as number)) / 1e6, 1);
    expect(p.aux_temps_c).toHaveLength(8);
    expect(p.remain_wh).toBeGreaterThan(1500);
    expect(p.accu_chg_mah).toBeGreaterThan(1_000_000);
    // 50/2 (battery passport) arrived once, on the grid change; it stays in later samples.
    expect(p.launch_ts).toBeGreaterThan(1_700_000_000);
    expect(p.rated_round_trip_eff_pct).toBe(80);
  });

  it('battery power is negative while the grid is off and the station feeds the load', () => {
    const adapter = new Delta3MaxPlus();
    let w: unknown;
    for (const m of session) {
      adapter.apply(m.payload, m.at);
      if (m.at.toISOString().startsWith('2026-11-21T18:45:3')) w = adapter.reading()?.telemetry.extra.batt_w;
    }
    expect(w).toBeLessThan(-50);
  });

  it('hides the stale AC input voltage right after the grid changes', () => {
    const adapter = new Delta3MaxPlus();
    let during: number | null | undefined;
    for (const m of session) {
      adapter.apply(m.payload, m.at);
      if (m.at.toISOString() === '2026-11-21T18:40:50.935Z') during = adapter.reading()?.telemetry.acInVoltageV;
    }
    // The device still reported 242 V at that moment; we must not store it as grid voltage.
    expect(during).toBeNull();
  });

  it('falls back to AC input voltage when the grid flag never arrived', () => {
    const adapter = new Delta3MaxPlus();
    const runtime = (v: number) =>
      encodeHeaderMessage([{ pdata: encode('RuntimePropertyUpload', { plugInInfoAcInVol: v }), src: 2, cmdFunc: 254, cmdId: 22 }]);
    expect(adapter.apply(runtime(230), new Date(1000))).toMatchObject([{ present: true, initial: true }]);
    expect(adapter.apply(runtime(0.8), new Date(2000))).toMatchObject([{ present: false, initial: false }]);
  });
});
