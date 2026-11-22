import protobuf from 'protobufjs';
import { decodePayload, type Codec, type DecodedMessage } from '../decode/envelope.js';
import type { DeviceAdapter, DeviceEvent, DeviceState, Extra, ExtraValue, PackSample, Reading, TelemetrySample } from '../model/types.js';
import type { DecoderPack, ValueSpec } from './schema.js';

type Fields = Record<string, unknown>;
type Value = number | number[] | null;

interface Part {
  data: Fields;
  at: Date;
  /** When each top-level field was last reported (for `freshAfterGridChange`). */
  seen: Map<string, Date>;
}

/** A codec over the pack's own proto descriptor. */
export function packCodec(pack: DecoderPack): Codec {
  const root = protobuf.Root.fromJSON(pack.proto as protobuf.INamespace);
  const byId = new Map(Object.entries(pack.messages).map(([k, m]) => [k, m.type]));
  const types = new Map<string, protobuf.Type>();
  for (const name of new Set(byId.values())) types.set(name, root.lookupType(name)); // throws on a missing type: refused at load
  return {
    typeName: (cmdFunc, cmdId) => byId.get(`${cmdFunc}/${cmdId}`),
    lookupType: (name) => {
      const t = types.get(name);
      if (!t) throw new Error(`pack: no type ${name}`);
      return t;
    },
  };
}

/**
 * A device adapter driven by a decoder pack (issue #43): the same job as a code adapter
 * (src/decode/delta3maxplus.ts), with what to read where taken from data.
 */
export class PackAdapter implements DeviceAdapter {
  readonly descriptor: { vendor: string; model: string };
  private readonly codec: Codec;
  private readonly byId: Map<string, DecoderPack['messages'][string]>;
  /** Single messages by alias. */
  private readonly parts = new Map<string, Part>();
  /** Per-pack messages by alias, then pack number. */
  private readonly perPack = new Map<string, Map<number, Part>>();
  private readonly full: DeviceState = {};
  private grid: boolean | undefined;
  private gridChangedAt: Date | undefined;
  private last: Date | undefined;

  constructor(readonly pack: DecoderPack) {
    this.descriptor = { ...pack.descriptor };
    this.codec = packCodec(pack);
    this.byId = new Map(Object.entries(pack.messages));
  }

  get lastMessageAt(): Date | undefined {
    return this.last;
  }

  get gridPresent(): boolean | undefined {
    return this.grid;
  }

  apply(payload: Uint8Array, at: Date): DeviceEvent[] {
    const msgs = decodePayload(payload, this.codec);
    if (!msgs) return [];
    const events: DeviceEvent[] = [];
    for (const m of msgs) {
      const spec = this.byId.get(`${m.cmdFunc}/${m.cmdId}`);
      this.keep(m, at, spec?.perPack === true);
      if (!m.data) continue;
      this.last = at;
      if (spec?.alias) this.merge(spec, m.data, at);
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

  private packKey(data: Fields): number {
    return num(data[this.pack.packs?.keyField ?? 'num']) ?? 0;
  }

  private merge(spec: DecoderPack['messages'][string], data: Fields, at: Date): void {
    const alias = spec.alias as string;
    let prev: Part | undefined;
    let put: (p: Part) => void;
    if (spec.perPack) {
      const byPack = this.perPack.get(alias) ?? new Map<number, Part>();
      this.perPack.set(alias, byPack);
      const n = this.packKey(data);
      prev = byPack.get(n);
      put = (p) => byPack.set(n, p);
    } else {
      prev = this.parts.get(alias);
      put = (p) => this.parts.set(alias, p);
    }
    const merged: Fields = { ...(prev?.data ?? {}) };
    for (const [k, v] of Object.entries(data)) {
      merged[k] = spec.merge === 'nested' && isObj(v) && isObj(merged[k]) ? { ...(merged[k] as Fields), ...v } : v;
    }
    const seen = new Map(prev?.seen ?? []);
    for (const k of Object.keys(data)) seen.set(k, at);
    put({ data: merged, at, seen });
  }

  /** Every decoded field (known or not) into the full state, serials left out. */
  private keep(m: DecodedMessage, at: Date, perPack: boolean): void {
    if (!m.data && !m.unknown) return;
    const data = m.data ?? {};
    const key = `${m.cmdFunc}/${m.cmdId}${m.type ? ` ${m.type}` : ''}${perPack ? ` #${this.packKey(data)}` : ''}`;
    const prev = this.full[key];
    const fields = { ...(prev?.fields ?? {}), ...withoutSerials(data) };
    const unknown = m.unknown || prev?.unknown ? { ...(prev?.unknown ?? {}), ...(m.unknown ?? {}) } : undefined;
    this.full[key] = { at: at.toISOString(), fields, ...(unknown ? { unknown } : {}) };
  }

  state(): DeviceState | null {
    return Object.keys(this.full).length ? structuredClone(this.full) : null;
  }

  private gridFromState(): boolean | undefined {
    const g = this.pack.grid;
    if (g.flag) {
      const flag = this.read(g.flag.from, undefined);
      if (typeof flag === 'number') return flag === g.flag.equals;
    }
    if (g.voltage) {
      const v = this.read(g.voltage.from, undefined);
      if (typeof v === 'number') return v >= g.voltage.min;
    }
    return undefined;
  }

  private packNumbers(): number[] {
    const list = this.pack.packs?.list;
    return list ? [...(this.perPack.get(list)?.keys() ?? [])].sort((a, b) => a - b) : [];
  }

  reading(): Reading | null {
    if (this.parts.size === 0 && this.packNumbers().length === 0) return null;
    return { telemetry: this.telemetry(), packs: this.pack.pack ? this.packNumbers().map((n) => this.packSample(n)) : [] };
  }

  /** The part a source names: a single message, or this pack's one. */
  private part(alias: string, pack: number | undefined): Part | undefined {
    const byPack = this.perPack.get(alias);
    if (byPack) return pack === undefined ? undefined : byPack.get(pack);
    return this.parts.get(alias);
  }

  private read(source: string, pack: number | undefined): unknown {
    const [alias, ...path] = source.split('.');
    let v: unknown = this.part(alias ?? '', pack)?.data;
    for (const k of path) v = isObj(v) ? v[k] : undefined;
    return v;
  }

  private fresh(source: string, pack: number | undefined): boolean {
    const [alias, field] = source.split('.');
    const at = this.part(alias ?? '', pack)?.seen.get(field ?? '');
    return at !== undefined && (!this.gridChangedAt || at >= this.gridChangedAt);
  }

  private eval(spec: ValueSpec, ctx: { pack: number | undefined; outputs: Map<string, Value> }): Value {
    if (spec.any) {
      const last = spec.any.length - 1;
      for (let i = 0; i < last; i++) {
        const v = this.eval(spec.any[i] as ValueSpec, ctx);
        if (v !== null && !(spec.skipZero && v === 0)) return post(v, spec);
      }
      return post(this.eval(spec.any[last] as ValueSpec, ctx), spec);
    }
    const sources = typeof spec.from === 'string' ? [spec.from] : (spec.from ?? []);
    if (spec.freshAfterGridChange && !sources.every((s) => this.fresh(s, ctx.pack))) return null;
    const raw = sources.map((s) => this.read(s, ctx.pack));
    let v: Value;
    switch (spec.op ?? 'first') {
      case 'first':
        v = raw.map(num).find((n) => n !== null) ?? null;
        break;
      case 'array':
        v = arr(raw[0]);
        break;
      case 'floats':
        v = arr(isObj(raw[0]) ? raw[0].value : undefined);
        break;
      case 'neg_clamp_floats':
        v = arr(isObj(raw[0]) ? raw[0].value : undefined)?.map((x) => Math.max(0, -x)) ?? null;
        break;
      case 'int8s':
        v = typeof raw[0] === 'string' && raw[0] !== '' ? [...Buffer.from(raw[0], 'base64')].map((b) => (b > 127 ? b - 256 : b)) : null;
        break;
      case 'sum': {
        const ns = raw.map(num).filter((n): n is number => n !== null);
        v = ns.length ? ns.reduce((a, b) => a + b, 0) : null;
        break;
      }
      case 'product': {
        const ns = raw.map(num);
        v = ns.length && ns.every((n) => n !== null) ? (ns as number[]).reduce((a, b) => a * b) : null;
        break;
      }
      case 'diff': {
        const ns = (spec.ref ?? []).map((r) => ctx.outputs.get(r) ?? null);
        v = ns.length && ns.every((n) => typeof n === 'number') ? (ns as number[]).reduce((a, b) => a - b) : null;
        break;
      }
      case 'packs_sum_all': {
        const ns = this.packNumbers().map((n) => this.eval(spec.pack as ValueSpec, { pack: n, outputs: new Map() }));
        v = ns.length && ns.every((n) => typeof n === 'number') ? (ns as number[]).reduce((a, b) => a + b, 0) : null;
        break;
      }
    }
    return post(v, spec);
  }

  private section(specs: Record<string, ValueSpec | Record<string, ValueSpec> | undefined>, pack: number | undefined) {
    const outputs = new Map<string, Value>();
    const core: Record<string, Value> = {};
    for (const [k, s] of Object.entries(specs)) {
      if (k === 'extra' || !s) continue;
      const v = this.eval(s as ValueSpec, { pack, outputs });
      core[k] = v;
      outputs.set(k, v);
    }
    const extra: Extra = {};
    for (const [k, s] of Object.entries((specs.extra ?? {}) as Record<string, ValueSpec>)) {
      const v = this.eval(s, { pack, outputs });
      outputs.set(`extra.${k}`, v);
      if (v !== null) extra[k] = v as ExtraValue;
    }
    return { core, extra };
  }

  private telemetry(): TelemetrySample {
    const { core, extra } = this.section(this.pack.telemetry as Record<string, ValueSpec>, undefined);
    const n = (k: string) => (typeof core[k] === 'number' ? (core[k] as number) : null);
    return {
      socPct: n('socPct'),
      wattsIn: n('wattsIn'),
      wattsOut: n('wattsOut'),
      acInVoltageV: n('acInVoltageV'),
      acInFreqHz: n('acInFreqHz'),
      acOutFreqHz: n('acOutFreqHz'),
      gridPresent: this.grid ?? null,
      extra,
    };
  }

  private packSample(pack: number): PackSample {
    const { core, extra } = this.section((this.pack.pack ?? {}) as Record<string, ValueSpec>, pack);
    const n = (k: string) => (typeof core[k] === 'number' ? (core[k] as number) : null);
    const a = (k: string) => (Array.isArray(core[k]) ? (core[k] as number[]) : null);
    return {
      pack,
      socPct: n('socPct'),
      sohPct: n('sohPct'),
      cycles: n('cycles'),
      cellVoltagesMv: a('cellVoltagesMv'),
      cellTempsC: a('cellTempsC'),
      minMosTempC: n('minMosTempC'),
      maxMosTempC: n('maxMosTempC'),
      balanceState: n('balanceState'),
      extra,
    };
  }
}

/** divide / scale / offset / round (element-wise on arrays), then reduce, index, zeroIsNull. */
function post(v: Value, spec: ValueSpec): Value {
  if (v === null) return null;
  const one = (x: number) => {
    let y = x;
    if (spec.divide !== undefined) y = y / spec.divide;
    if (spec.scale !== undefined) y = y * spec.scale;
    if (spec.offset !== undefined) y = y + spec.offset;
    if (spec.round !== undefined) {
      const f = 10 ** spec.round;
      y = Math.round(y * f) / f;
    }
    return y;
  };
  let out: Value = Array.isArray(v) ? v.map(one) : one(v);
  if (Array.isArray(out) && spec.reduce) {
    out = out.length === 0 ? null : spec.reduce === 'max' ? Math.max(...out) : spec.reduce === 'min' ? Math.min(...out) : out.reduce((a, b) => a + b, 0);
  }
  if (Array.isArray(out) && spec.index !== undefined) out = out[spec.index] ?? null;
  if (spec.zeroIsNull && out === 0) out = null;
  return out;
}

function isObj(v: unknown): v is Fields {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arr(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.every((x) => typeof x === 'number') ? (v as number[]) : null;
}

/** Drop serial numbers (`bmsSn`, `packSn`, ...) at any depth. */
function withoutSerials(o: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(o)) {
    if (/sn$/i.test(k) && typeof v === 'string') continue;
    out[k] = isObj(v) ? withoutSerials(v) : v;
  }
  return out;
}
