import { z } from 'zod';

/**
 * A decoder pack (issue #43): how to read one device model, as data. It is interpreted by
 * the fixed code in src/packs/interpreter.ts and never contains code: no expressions beyond
 * a fixed list of operations, no `eval`, no regular expressions, no URLs. If a model needs
 * real logic, it gets a code adapter in a normal release instead.
 */

export const PACK_FORMAT = 'ecoflow-dashboard/decoder-pack/1';
export const INDEX_FORMAT = 'ecoflow-dashboard/decoder-index/1';

/** Packs are small; anything bigger is refused before parsing. */
export const MAX_PACK_BYTES = 512 * 1024;
export const MAX_INDEX_BYTES = 64 * 1024;

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const alias = z.string().regex(/^[a-z][A-Za-z0-9_]{0,31}$/);
/** `<alias>.<field>[.<field>...]`: a field of the last merged message with that alias. */
const source = z.string().regex(/^[a-z][A-Za-z0-9_]{0,31}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){1,4}$/);
/** An output computed earlier in the same section: `wattsIn`, `extra.batt_w`. */
const ref = z.string().regex(/^(extra\.)?[A-Za-z_][A-Za-z0-9_]{0,63}$/);

/**
 * Operations on the source values. Every one is a few lines in the interpreter.
 * - `first`: the first source that is a number;
 * - `array`: a non-empty array of numbers;
 * - `floats`: `{ value: number[] }` (FloatList) -> the numbers;
 * - `neg_clamp_floats`: like floats, each `max(0, -v)` (outputs reported as negative);
 * - `int8s`: base64 bytes -> signed bytes;
 * - `sum`: sum of the sources that are numbers (null if none);
 * - `product`: product of all sources (null if one is missing);
 * - `diff`: refs[0] - refs[1] - ... (null if one is missing);
 * - `packs_sum_all`: sum of `pack` over every pack, null if any pack lacks it.
 */
export const OPS = ['first', 'array', 'floats', 'neg_clamp_floats', 'int8s', 'sum', 'product', 'diff', 'packs_sum_all'] as const;

export interface ValueSpec {
  from?: string | string[] | undefined;
  ref?: string[] | undefined;
  op?: (typeof OPS)[number] | undefined;
  /** Another spec evaluated per pack (`packs_sum_all`). */
  pack?: ValueSpec | undefined;
  /** Candidates: the first non-null (with `skipZero`, also non-zero; the last is taken as is). */
  any?: ValueSpec[] | undefined;
  skipZero?: boolean | undefined;
  divide?: number | undefined;
  scale?: number | undefined;
  offset?: number | undefined;
  round?: number | undefined;
  reduce?: 'max' | 'min' | 'sum' | undefined;
  index?: number | undefined;
  zeroIsNull?: boolean | undefined;
  /** Null unless `from` was reported after the last grid change (values that lag behind). */
  freshAfterGridChange?: boolean | undefined;
}

const finite = z.number().finite();

export const valueSpecSchema: z.ZodType<ValueSpec> = z.lazy(() =>
  z
    .object({
      from: z.union([source, z.array(source).min(1).max(8)]).optional(),
      ref: z.array(ref).min(1).max(8).optional(),
      op: z.enum(OPS).optional(),
      pack: valueSpecSchema.optional(),
      any: z.array(valueSpecSchema).min(2).max(4).optional(),
      skipZero: z.boolean().optional(),
      divide: finite.refine((n) => n !== 0, 'divide by zero').optional(),
      scale: finite.optional(),
      offset: finite.optional(),
      round: z.number().int().min(0).max(6).optional(),
      reduce: z.enum(['max', 'min', 'sum']).optional(),
      index: z.number().int().min(0).max(255).optional(),
      zeroIsNull: z.boolean().optional(),
      freshAfterGridChange: z.boolean().optional(),
    })
    .strict()
    .refine((v) => [v.from, v.ref, v.pack, v.any].filter((x) => x !== undefined).length === 1, 'exactly one of from / ref / pack / any'),
);

const messageSchema = z
  .object({
    /** Proto type in `proto` that pdata decodes to. */
    type: ident,
    /** Name the mappings use; messages without one are decoded for the full state only. */
    alias: alias.optional(),
    /** `shallow`: changed fields replace old ones; `nested`: also one level into sub-messages. */
    merge: z.enum(['shallow', 'nested']).default('shallow'),
    /** One state per pack, keyed by `packs.keyField`. */
    perPack: z.boolean().default(false),
  })
  .strict();

const telemetrySchema = z
  .object({
    socPct: valueSpecSchema.optional(),
    wattsIn: valueSpecSchema.optional(),
    wattsOut: valueSpecSchema.optional(),
    acInVoltageV: valueSpecSchema.optional(),
    acInFreqHz: valueSpecSchema.optional(),
    acOutFreqHz: valueSpecSchema.optional(),
    extra: z.record(ident, valueSpecSchema).default({}),
  })
  .strict();

const packSchema = z
  .object({
    socPct: valueSpecSchema.optional(),
    sohPct: valueSpecSchema.optional(),
    cycles: valueSpecSchema.optional(),
    cellVoltagesMv: valueSpecSchema.optional(),
    cellTempsC: valueSpecSchema.optional(),
    minMosTempC: valueSpecSchema.optional(),
    maxMosTempC: valueSpecSchema.optional(),
    balanceState: valueSpecSchema.optional(),
    extra: z.record(ident, valueSpecSchema).default({}),
  })
  .strict();

/** protobufjs JSON descriptor (`Root.toJSON()`): nested namespaces, types, enums. Checked by protobufjs on load. */
const protoSchema = z.object({ nested: z.record(z.string(), z.unknown()) }).passthrough();

export const decoderPackSchema = z
  .object({
    format: z.literal(PACK_FORMAT),
    /** Stable id, also the file name: `<vendor>-<model>`. */
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
    /** Bumped on every change of the pack. */
    version: z.number().int().min(1),
    /** Oldest exporter whose interpreter understands this pack. */
    minExporterVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.1.0'),
    descriptor: z.object({ vendor: z.string().min(1).max(40), model: z.string().min(1).max(80) }).strict(),
    match: z
      .object({
        vendor: z.string().min(1).max(40),
        /** Serial number prefixes (model family, see src/discovery/census.ts). */
        productCodes: z.array(z.string().regex(/^[A-Z0-9]{2,8}$/)).max(32),
        /** Used when no pack matches the product code (today: every EcoFlow device). */
        fallback: z.boolean().default(false),
      })
      .strict(),
    proto: protoSchema,
    /** `cmdFunc/cmdId` -> message. */
    messages: z.record(z.string().regex(/^\d{1,3}\/\d{1,3}$/), messageSchema),
    packs: z.object({ keyField: ident, list: alias }).strict().optional(),
    grid: z
      .object({
        flag: z.object({ from: source, equals: finite }).strict().optional(),
        voltage: z.object({ from: source, min: finite }).strict().optional(),
      })
      .strict()
      .default({}),
    telemetry: telemetrySchema,
    pack: packSchema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const aliases = new Set(Object.values(p.messages).flatMap((m) => (m.alias ? [m.alias] : [])));
    if (aliases.size !== Object.values(p.messages).filter((m) => m.alias).length) ctx.addIssue({ code: 'custom', message: 'duplicate message alias' });
    if (p.packs && !aliases.has(p.packs.list)) ctx.addIssue({ code: 'custom', message: `packs.list: no message ${p.packs.list}` });
    if (p.pack && !p.packs) ctx.addIssue({ code: 'custom', message: 'pack mappings need packs' });
    const check = (spec: ValueSpec, path: string) => {
      for (const s of typeof spec.from === 'string' ? [spec.from] : (spec.from ?? [])) {
        const a = s.split('.')[0] ?? '';
        if (!aliases.has(a)) ctx.addIssue({ code: 'custom', message: `${path}: no message alias ${a}` });
      }
      if (spec.pack) check(spec.pack, path);
      for (const x of spec.any ?? []) check(x, path);
    };
    for (const [k, v] of Object.entries(p.telemetry)) {
      if (k === 'extra') for (const [e, s] of Object.entries(v as Record<string, ValueSpec>)) check(s, `telemetry.extra.${e}`);
      else check(v as ValueSpec, `telemetry.${k}`);
    }
    for (const [k, v] of Object.entries(p.pack ?? {})) {
      if (k === 'extra') for (const [e, s] of Object.entries(v as Record<string, ValueSpec>)) check(s, `pack.extra.${e}`);
      else check(v as ValueSpec, `pack.${k}`);
    }
  });

export type DecoderPack = z.infer<typeof decoderPackSchema>;

/** The signed list of packs (decoders/index.json on the hosting). */
export const packIndexSchema = z
  .object({
    format: z.literal(INDEX_FORMAT),
    /** Grows with every published index: an older one is refused (rollback). */
    sequence: z.number().int().min(1),
    channel: z.enum(['stable', 'beta']),
    published_at: z.string().datetime(),
    /** Refused after this: a stale index cannot be replayed forever. */
    expires_at: z.string().datetime(),
    packs: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
            version: z.number().int().min(1),
            vendor: z.string().min(1).max(40),
            productCodes: z.array(z.string().regex(/^[A-Z0-9]{2,8}$/)).max(32),
            fallback: z.boolean(),
            /** Path next to index.json. */
            file: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,100}\.json$/),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            bytes: z.number().int().min(1).max(MAX_PACK_BYTES),
            min_exporter_version: z.string().regex(/^\d+\.\d+\.\d+$/),
          })
          .strict(),
      )
      .max(200),
  })
  .strict();

export type PackIndex = z.infer<typeof packIndexSchema>;
export type PackIndexEntry = PackIndex['packs'][number];
