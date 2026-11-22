import type { DeviceAdapter, DeviceEvent, DeviceState, Extra, ExtraValue, PackSample, Reading, TelemetrySample } from '../model/types.js';
import { decodePayload, type DecodedMessage } from './envelope.js';

type Fields = Record<string, unknown>;

/** Below this AC input voltage the grid counts as absent (only used when the device flag is missing). */
export const GRID_MIN_VOLTAGE_V = 100;

interface Part {
  data: Fields;
  at: Date;
}

/**
 * EcoFlow Delta 3 Max Plus adapter. The device sends full messages on request (get_reply)
 * and incremental ones on its own (only changed fields), so every message type is merged
 * into the last known state.
 *
 * - 254/21 DisplayPropertyUpload: SoC, power in/out, grid flag (`plugInInfoAcInFlag`), AC out freq.
 * - 254/22 RuntimePropertyUpload: AC in/out voltage and current, temperatures. Updated only
 *   every ~5 min, so AC voltage lags the grid flag by minutes.
 * - 32/50 BMSHeartBeatReport: per pack (`num`) cell voltages and temperatures, SOH, cycles.
 * - 32/2 CMSHeartBeatReport: battery management summary.
 * - 50/2 AppRuquestBpEuLawDataAck: per pack battery passport (launch date, resistance, ...),
 *   only now and then (on grid changes); kept and repeated in every pack sample.
 *
 * Every field and what it is good for: docs/DATA_CATALOG.md.
 */
export class Delta3MaxPlus implements DeviceAdapter {
  readonly descriptor = { vendor: 'ecoflow', model: 'DELTA 3 Max Plus' } as const;
  private display: Part | undefined;
  private runtime: Part | undefined;
  private cms: Part | undefined;
  private readonly bms = new Map<number, Part>();
  private readonly passport = new Map<number, Fields>();
  private readonly full: DeviceState = {};
  /** When AC input voltage was last reported, to tell a stale value after a grid change. */
  private acInVoltageAt: Date | undefined;
  private grid: boolean | undefined;
  private gridChangedAt: Date | undefined;
  private last: Date | undefined;

  get lastMessageAt(): Date | undefined {
    return this.last;
  }

  get gridPresent(): boolean | undefined {
    return this.grid;
  }

  apply(payload: Uint8Array, at: Date): DeviceEvent[] {
    const msgs = decodePayload(payload);
    if (!msgs) return [];
    const events: DeviceEvent[] = [];
    for (const m of msgs) {
      this.keep(m, at);
      if (!m.data) continue;
      this.last = at;
      this.applyOne(m, at);
      const present = this.gridFromState();
      if (present !== undefined && present !== this.grid) {
        const initial = this.grid === undefined;
        this.grid = present;
        this.gridChangedAt = at;
        events.push({ type: 'grid', present, at, initial });
      }
    }
    return events;
  }

  private applyOne(m: DecodedMessage, at: Date): void {
    const data = m.data as Fields;
    switch (m.type) {
      case 'DisplayPropertyUpload':
        this.display = merge(this.display, data, at);
        break;
      case 'RuntimePropertyUpload':
        this.runtime = merge(this.runtime, data, at);
        if ('plugInInfoAcInVol' in data) this.acInVoltageAt = at;
        break;
      case 'CMSHeartBeatReport': {
        const prev = this.cms?.data ?? {};
        this.cms = {
          data: { v1p0: { ...obj(prev.v1p0), ...obj(data.v1p0) }, v1p3: { ...obj(prev.v1p3), ...obj(data.v1p3) } },
          at,
        };
        break;
      }
      case 'BMSHeartBeatReport': {
        const num = numOr(data.num, 0);
        this.bms.set(num, merge(this.bms.get(num), data, at));
        break;
      }
      case 'AppRuquestBpEuLawDataAck': {
        const num = numOr(data.num, 0);
        this.passport.set(num, { ...(this.passport.get(num) ?? {}), ...data });
        break;
      }
      default:
        break;
    }
  }

  /** Merge every field of `m` (known or not) into the full state. */
  private keep(m: DecodedMessage, at: Date): void {
    if (!m.data && !m.unknown) return;
    const data = m.data ?? {};
    const perPack = m.type === 'BMSHeartBeatReport' || m.type === 'AppRuquestBpEuLawDataAck';
    const key = `${m.cmdFunc}/${m.cmdId}${m.type ? ` ${m.type}` : ''}${perPack ? ` #${numOr(data.num, 0)}` : ''}`;
    const prev = this.full[key];
    const fields = { ...(prev?.fields ?? {}), ...withoutSerials(data) };
    const unknown = m.unknown || prev?.unknown ? { ...(prev?.unknown ?? {}), ...(m.unknown ?? {}) } : undefined;
    this.full[key] = { at: at.toISOString(), fields, ...(unknown ? { unknown } : {}) };
  }

  state(): DeviceState | null {
    return Object.keys(this.full).length ? structuredClone(this.full) : null;
  }

  /** Grid state from the device flag, or from AC input voltage if the flag never arrived. */
  private gridFromState(): boolean | undefined {
    const flag = this.display?.data.plugInInfoAcInFlag;
    if (typeof flag === 'number') return flag === 1;
    const v = this.runtime?.data.plugInInfoAcInVol;
    if (typeof v === 'number') return v >= GRID_MIN_VOLTAGE_V;
    return undefined;
  }

  reading(): Reading | null {
    if (!this.display && !this.runtime && this.bms.size === 0) return null;
    return { telemetry: this.telemetry(), packs: [...this.bms.keys()].sort((a, b) => a - b).map((n) => this.pack(n)) };
  }

  private telemetry(): TelemetrySample {
    const d = this.display?.data ?? {};
    const r = this.runtime?.data ?? {};
    const cms = obj(this.cms?.data.v1p0);
    // AC input voltage is refreshed every few minutes; right after the grid goes away or comes
    // back the last value is wrong (e.g. 242 V during an outage), so report it as unknown.
    const voltFresh = this.acInVoltageAt !== undefined && (!this.gridChangedAt || this.acInVoltageAt >= this.gridChangedAt);
    const freqIn = num(d.plugInInfoAcInFeq);
    const cms3 = obj(this.cms?.data.v1p3);
    // unknown972: per-output powers, negative = going out (see the .proto). Shown positive.
    const ports = floats(d.unknown972)?.map((v) => round(Math.max(0, -v), 1) ?? 0) ?? null;
    const acOut = num(d.powGetAcOut) || (ports?.[2] ?? null);
    const packW = [...this.bms.values()].map((b) => power(b.data.vol, b.data.amp));
    const battW = packW.length && packW.every((w) => w !== null) ? round(sum(...packW), 1) : null;
    const wattsIn = num(d.powInSumW);
    const wattsOut = num(d.powOutSumW);
    const auxTemps = floats(r.unknown95)?.map((v) => round(v, 1) ?? 0) ?? null;
    return {
      socPct: round(num(d.cmsBattSoc) ?? num(cms.f32LcdShowSoc) ?? num(d.bmsBattSoc), 2),
      wattsIn,
      wattsOut,
      acInVoltageV: voltFresh ? round(num(r.plugInInfoAcInVol), 1) : null,
      // The Delta 3 Max Plus always reports 0 here; treat 0 as "not reported".
      acInFreqHz: freqIn ? freqIn : null,
      acOutFreqHz: num(d.acOutFreq) ?? num(r.plugInInfoAcOutFreq),
      gridPresent: this.grid ?? null,
      extra: pick({
        ac_in_amp_a: round(num(r.plugInInfoAcInAmp), 2),
        ac_out_voltage_v: round(num(r.plugInInfoAcOutVol), 1),
        ac_out_amp_a: round(num(r.plugInInfoAcOutAmp), 2),
        ac_in_w: num(d.powGetAcIn),
        ac_out_w: acOut,
        out_ports_w: ports,
        pv_w: num(d.powGetPv),
        pv2_w: num(d.powGetPv2),
        dc12v_w: num(d.powGet_12v),
        usb_w: sum(d.powGetQcusb1, d.powGetQcusb2, d.powGetTypec1, d.powGetTypec2),
        batt_voltage_v: milli(r.cmsBattVol),
        batt_current_a: milli(r.cmsBattAmp),
        temp_pcs_ac_c: round(num(r.tempPcsAc), 1),
        temp_pcs_dc_c: round(num(r.tempPcsDc), 1),
        temp_pv_c: round(num(r.tempPv), 1),
        temp_pv2_c: round(num(r.tempPv2), 1),
        temps_aux_c: auxTemps,
        temp_aux_max_c: auxTemps ? Math.max(...auxTemps) : null,
        pv_v: round(num(r.plugInInfoPvVol), 2),
        pv_a: round(num(r.plugInInfoPvAmp), 2),
        pv2_v: round(num(r.plugInInfoPv2Vol), 2),
        pv2_a: round(num(r.plugInInfoPv2Amp), 2),
        batt_w: battW,
        // What goes in but neither out nor into the battery: conversion losses + own use.
        loss_w: wattsIn !== null && wattsOut !== null && battW !== null ? round(wattsIn - wattsOut - battW, 1) : null,
        chg_dsg_state: num(d.cmsChgDsgState) ?? num(cms3.sysChgDsgState),
        chg_line_flag: num(cms3.chgLinePlugInFlag),
        chg_req_v: milli(cms.chgVol),
        chg_req_a: milli(cms.chgAmp),
        fan_level: num(d.pcsFanLevel) ?? num(cms.fanLevel),
        chg_remain_min: num(d.cmsChgRemTime) ?? num(cms.chgRemainTime),
        dsg_remain_min: num(d.cmsDsgRemTime) ?? num(cms.dsgRemainTime),
        max_chg_soc_pct: num(d.cmsMaxChgSoc),
        min_dsg_soc_pct: num(d.cmsMinDsgSoc),
        ac_in_chg_max_w: num(d.plugInInfoAcInChgPowMax),
        err_code: num(d.errcode),
      }),
    };
  }

  private pack(n: number): PackSample {
    const b = this.bms.get(n)?.data ?? {};
    const pp = this.passport.get(n) ?? {};
    const aux = int8s(b.unknown87);
    return {
      pack: n,
      socPct: round(num(b.f32ShowSoc) ?? num(b.soc), 2),
      sohPct: num(b.soh),
      cycles: num(b.cycles),
      cellVoltagesMv: arr(b.cellVol),
      cellTempsC: arr(b.cellTemp),
      minMosTempC: num(b.minMosTemp),
      maxMosTempC: num(b.maxMosTemp),
      balanceState: num(b.balanceState),
      extra: pick({
        voltage_mv: num(b.vol),
        current_ma: num(b.amp),
        power_w: round(power(b.vol, b.amp), 1),
        temp_c: num(b.temp),
        cell_min_mv: num(b.minCellVol),
        cell_max_mv: num(b.maxCellVol),
        remain_cap_mah: num(b.remainCap),
        remain_wh: round(energy(b.remainCap, b.vol), 1),
        full_cap_mah: num(b.fullCap),
        design_cap_mah: num(b.designCap),
        real_soh_pct: round(num(b.realSoh), 2),
        calendar_soh_pct: round(num(b.calendarSoh), 2),
        cycle_soh_pct: round(num(b.cycleSoh), 2),
        mos_temps_c: arr(b.mosTemp),
        cur_sensor_temps_c: arr(b.curSensorTemp),
        cur_sensor_temp_c: num(b.maxCurSensorTemp),
        aux_temps_c: aux,
        aux_temp_max_c: aux ? Math.max(...aux) : null,
        mos_state: num(b.mosState),
        input_w: num(b.inputWatts),
        output_w: num(b.outputWatts),
        remain_min: num(b.remainTime),
        max_vol_diff_mv: num(b.maxVolDiff),
        chg_dsg_state: num(b.chgDsgState),
        accu_chg_wh: num(b.accuChgEnergy),
        accu_dsg_wh: num(b.accuDsgEnergy),
        accu_chg_mah: num(b.accuChgCap),
        accu_dsg_mah: num(b.accuDsgCap),
        target_soc_pct: round(num(b.targetSoc), 2),
        // Battery passport (50/2), see the class comment.
        launch_ts: num(pp.bpLaunchDate),
        ohm_res: num(pp.bpOhmRes),
        power_capability: round(num(pp.bpPowerCapability), 2),
        rated_round_trip_eff_pct: num(pp.bpRoundTripEff),
        self_dsg_rate_pct: num(pp.bpSelfDsgRate),
        deep_dsg_count: num(pp.deepDsgCnt),
        high_temp_chg_time: num(pp.highTempChgTime),
        high_temp_use_time: num(pp.highTempUseTime),
        low_temp_chg_time: num(pp.lowTempChgTime),
        low_temp_use_time: num(pp.lowTempUseTime),
        err_code: num(b.errCode),
        bms_fault: num(b.bmsFault),
      }),
    };
  }
}

/** Drop serial numbers (`bmsSn`, `packSn`, `plugInInfoDcpSn`, ...) at any depth. */
function withoutSerials(o: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(o)) {
    if (/sn$/i.test(k) && typeof v === 'string') continue;
    out[k] = v !== null && typeof v === 'object' && !Array.isArray(v) ? withoutSerials(v as Fields) : v;
  }
  return out;
}

function merge(prev: Part | undefined, data: Fields, at: Date): Part {
  return { data: { ...(prev?.data ?? {}), ...data }, at };
}

function obj(v: unknown): Fields {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Fields) : {};
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function numOr(v: unknown, fallback: number): number {
  return num(v) ?? fallback;
}

function arr(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.every((x) => typeof x === 'number') ? (v as number[]) : null;
}

/** `FloatList` (local proto addition) -> its values. */
function floats(v: unknown): number[] | null {
  return arr(obj(v).value);
}

/** `bytes` (base64 after toObject) of signed bytes -> numbers. */
function int8s(v: unknown): number[] | null {
  if (typeof v !== 'string' || v === '') return null;
  return [...Buffer.from(v, 'base64')].map((b) => (b > 127 ? b - 256 : b));
}

/** mV x mA -> W (positive = charging). */
function power(mv: unknown, ma: unknown): number | null {
  const v = num(mv);
  const a = num(ma);
  return v === null || a === null ? null : (v * a) / 1e6;
}

/** mAh at the present mV -> Wh. */
function energy(mah: unknown, mv: unknown): number | null {
  const c = num(mah);
  const v = num(mv);
  return c === null || v === null ? null : (c * v) / 1e6;
}

function round(v: number | null, digits: number): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function milli(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : round(n / 1000, 3);
}

function sum(...vs: unknown[]): number | null {
  const ns = vs.map(num).filter((n): n is number => n !== null);
  return ns.length ? ns.reduce((a, b) => a + b, 0) : null;
}

/** Drop nulls so `extra` only holds what the device actually reported. */
function pick(o: Record<string, ExtraValue | null>): Extra {
  const out: Extra = {};
  for (const [k, v] of Object.entries(o)) if (v !== null) out[k] = v;
  return out;
}
