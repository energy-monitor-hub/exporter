# Device plugins

**English** · [Українська](uk/DEVICE_PLUGINS.md)

Each kind of device the exporter can read is one **device plugin**: a brand and the way to
reach it (cloud MQTT, local Modbus TCP, Bluetooth, an HTTP API). Everything vendor-specific
sits behind the plugin. The rest of the exporter (setup page, encrypted credentials, decoder
packs, model census, the queue and the Supabase writer) only goes through it and through the
common model, so it never names a vendor.

Today there is one plugin, `ecoflow-mqtt` (EcoFlow stations through the EcoFlow app account).
Other devices are added only with real hardware to test on (issue #12).

## How a device is read

```
DevicePlugin (src/sources/<plugin>.ts)
  ├─ setup: form fields, texts, .env variables      → status page builds the form
  ├─ credentials (zod schema), verify()              → setup page checks, then stores encrypted
  ├─ productCode()                                   → picks a decoder pack (vendor + code)
  └─ open() → Source                                 → connects, emits raw payloads
                 ├─ adapter: DeviceAdapter            → common model (src/model/types.ts)
                 └─ discovery: DiscoveryCodec         → model census, opt-in samples
```

- **`DevicePlugin`** (`src/sources/types.ts`) describes a kind of device. `id` is what
  `SOURCE` in `.env` names and what the encrypted credentials file stores next to the
  credentials. `vendor` goes to `devices.vendor` and selects decoder packs.
- **`Source`** is one open connection to one device: `start`, `stop`, `reconnect`,
  `onPayload`, and the identifiers that must be masked in shared samples. Pull protocols
  (Modbus, HTTP) poll inside the source and emit what they read as payloads.
- **`DeviceAdapter`** (`src/model/types.ts`) turns payloads into `TelemetrySample`,
  `PackSample` and `DeviceState`. A plugin ships a built-in adapter; a signed decoder pack
  ([DECODER_PACKS.md](DECODER_PACKS.md)) can replace it without a release.
- **`DiscoveryCodec`** (optional) tells the model census which message types a payload holds
  and how to mask identifiers inside it. Without it, census and samples are off for that
  plugin.

## The plugin interface

```ts
interface DevicePlugin<C extends { sn: string }> {
  id: string;            // 'ecoflow-mqtt'; SOURCE, stored with the credentials
  vendor: string;        // 'ecoflow'; devices.vendor, decoder packs, census
  setup: { title; hint; privacy; fields: FormField[]; envVars: string[] }; // en + uk texts
  credentials: ZodType<C>;
  fromEnv(env): C | undefined;            // all variables set, or undefined
  verify(c: C, log): Promise<void>;       // throws if the device or its cloud refuses them
  productCode(c: C): string;              // model family code before connecting
  open(c: C, ctx: { config, logger, adapter? }): Source;
  describeFatal?(err): string | undefined; // readable line for a rejected login
}
```

Credentials always carry the device's serial number (`sn`): it identifies the device in
`public.devices` (via `ensure_device`) and is masked everywhere it could leave the machine.

## Adding a plugin

1. Write `src/sources/<id>.ts` with the plugin (`definePlugin({...})`), its `Source` and a
   built-in `DeviceAdapter` (in `src/decode/`). Keep the transport in its own module, as
   `src/mqtt/` is for EcoFlow.
2. Add it to `PLUGINS` in `src/sources/index.ts`. Nothing else in the exporter needs to change.
3. Tests run on recorded fixtures with identifiers masked (`src/record/scrub.ts`), never on a
   live device in CI.
4. Document what the plugin connects to in the README's "Where your credentials go": the
   exporter must not call any host the user did not choose.
5. If the device needs new database objects, they come first as a migration in the dashboard
   repository and in [DB_CONTRACT.md](DB_CONTRACT.md).

Decoder packs today describe protobuf messages (`cmdFunc/cmdId`). A plugin for a register-
based protocol (Modbus) needs its own message kind in the pack format before its models can
be fixed through packs; until then its built-in adapter does the decoding.

## Stored credentials

The setup page stores `{ device: <plugin id>, ...credentials }`, encrypted
(`src/secrets/credentials.ts`). Files written before plugins existed have no `device` field
and are read as `ecoflow-mqtt`. The body stays flat, so an older exporter can still read an
EcoFlow file after a rollback.
