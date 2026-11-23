# Decoder packs

**English** · [Українська](uk/DECODER_PACKS.md)

A decoder pack tells the exporter how to read one device model, **as data**. New models and
fixes can then reach running exporters without a new image, and without ever sending code to
anyone's machine.

## Why data and not code

If the server could send JavaScript, one compromise of the hosting, the Supabase project or the
deploy pipeline would run attacker code on every user's machine, next to their EcoFlow
credentials and dashboard token. So a pack is a JSON document checked by a strict schema
(`src/packs/schema.ts`) and read by a fixed interpreter (`src/packs/interpreter.ts`) that ships
inside the pinned, reviewed exporter image. A pack can only:

- name the protobuf types per `cmdFunc/cmdId` and carry their descriptor (the JSON form of a
  `.proto`, produced by `protobufjs`; nothing is compiled or evaluated);
- say how messages merge (`shallow`, `nested`, per pack);
- map fields into the common model (`src/model/types.ts`) with a fixed list of operations:
  `first`, `array`, `floats`, `neg_clamp_floats`, `int8s`, `sum`, `product`, `diff`,
  `packs_sum_all`, plus `divide` / `scale` / `offset` / `round`, `reduce` (max, min, sum),
  `index`, `zeroIsNull`, `skipZero`, and `freshAfterGridChange` for values that lag behind;
- detect the grid with two fixed predicates (a flag equal to a value, a voltage above a minimum).

Anything that needs real logic gets a code adapter in a normal release instead.

## Packs in this repo

`decoders/<vendor>/<model>.json`, reviewed in pull requests. The first one,
`decoders/ecoflow/delta3maxplus.json`, describes the Delta 3 Max Plus; `test/packs.test.ts`
replays the live recording through it and through the code adapter (`src/decode/delta3maxplus.ts`)
and requires the same events and readings after **every** message, and the same full state.

```bash
npm run packs -- check                                    # validate every pack
npm run packs -- proto decoders/ecoflow/delta3maxplus.json src/proto/delta3maxplus.proto
```

The second command embeds the `.proto` as the pack's descriptor; the test fails if they drift.
The descriptor comes from the ioBroker project's definitions (MIT, `src/proto/LICENSE-ioBroker`).

Writing a pack for a new model: start from a shared sample and the census of message
types, copy the closest pack, give it a new `id`, list the model's `productCodes` (first 4
characters of the serial number), and add a fixture test like the one above. Bump `version` on
every change, and `minExporterVersion` when the pack needs a newer interpreter.

## Publishing and signing

CI (`.github/workflows/deploy-web.yml`, on `main` and weekly) builds `decoders/index.json` and
signs it with **Ed25519**; both go to the dashboard's own Firebase Hosting site under
`/decoders/`. The index lists every pack with its `sha256`, size, `version`,
`min_exporter_version`, a `sequence` that only grows (seconds since the epoch) and an
`expires_at` (30 days; the weekly run renews it).

Set up once, as the operator:

1. `npm run packs -- keygen` on a trusted machine. It prints a public key and a private key.
2. In the GitHub repo: **Settings, Environments, `decoder-signing`**: limit deployment branches to
   `main`, add the secret `DECODER_SIGNING_KEY` = the private key. Clear the terminal.
3. Put the public key into `TRUSTED_KEYS` in `src/packs/verify.ts` (pull request), so it is
   compiled into the next exporter image.
4. Exporters take `<dashboard>/decoders/index.json` of the dashboard they are connected to (the
   project's by default, `DASHBOARD_URL` otherwise);
   `DECODER_INDEX_URL` overrides it.

Rotating the key: generate a new pair, add the new public key next to the old one in
`TRUSTED_KEYS`, release the exporter, wait until users updated, then swap the secret and remove
the old public key in a later release. If the private key leaks, remove its public key at once
and release; an exporter that already trusts a leaked key can be fed packs until it updates, but
packs are data: the worst case is wrong readings, not code execution.

Forks publish their own index with their own key and pass it as `DECODER_PUBLIC_KEYS` (base64,
comma separated).

## What the exporter does

- `DECODER_UPDATES=auto` (default), `notify` (show what is available, keep decoding with what it
  has) or `off`. Without a trusted key nothing is fetched.
- About 30 s after start and then every 24 h: fetch `index.json` and `index.json.sig` (https only,
  no redirects, size limits), check the signature, refuse an expired index or one with a lower
  `sequence` than the cached one (rollback), choose the pack locally (exact product code first,
  then the vendor's fallback pack), fetch only that pack, check its size and `sha256`, the schema
  and that its proto loads, and only then write both to `DECODER_CACHE_DIR` (atomically). When the
  chosen pack changes, the device connection restarts with it.
- Offline, the last good cached pack keeps working; with no pack, the built-in code adapter is
  used, as before.
- The status page shows the decoder in use and the last check.
- The request carries nothing about the user or the device: the whole index is fetched and the
  choice is made on the user's machine. The hosting still sees the exporter's IP address and the
  time (Privacy Policy).
