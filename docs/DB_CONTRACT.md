# Database contract (exporter ↔ Supabase)

**English** · [Українська](uk/DB_CONTRACT.md)

The exporter talks to a Supabase project it does not own: the schema lives with the dashboard (its `supabase/migrations/`). This file is the list of everything the exporter relies on there, so a schema change on either side can be checked against it. If you run your own dashboard, your project must provide exactly this.

**Version of the contract:** `dbContract.minMigration` in [package.json](../package.json) is the newest migration (file name prefix, 14 digits) the exporter needs. Release entries take it as `min_db_migration` ([UPDATES.md](UPDATES.md)). Bump it in the same change that starts using a newer object.

## How it connects

- The Supabase URL + anon key (public by design) and **the user's own access token**, never `service_role`. The URL and key come from the dashboard's `exporter.json` (`{"supabaseUrl": "https://…", "supabaseAnonKey": "…"}`, published by its build next to `index.html`), or from `SUPABASE_URL` + `SUPABASE_ANON_KEY` in `.env`.
- The token comes from Supabase Auth's **OAuth 2.1 server** (`/auth/v1/oauth/*`): dynamic client registration, authorization code + PKCE, loopback redirect (`http://127.0.0.1:<port>/callback`), refresh tokens. The user approves the client on the dashboard's `/oauth/consent` page and revokes it on `/exporters`.
- The token's role is `authenticated`; its `client_id` claim identifies the exporter (used by `exporter_key`).
- Every write is under RLS: a user reaches only rows of devices with `devices.owner_id = auth.uid()`.

## Remote procedures (RPC)

| Function | Arguments | Returns | Used for | Since |
|---|---|---|---|---|
| `ensure_device` | `p_sn text, p_vendor text, p_model text, p_firmware text` | `uuid` (devices.id) | find or create the caller's device by serial number | `20261121230000`, `20261122100000` |
| `exporter_key` | `p_new text` (base64, 32 bytes) | `text` (base64 key) | stores `p_new` on first call, then returns the stored key; only for a token with a `client_id` claim | `20261122171000` |
| `forget_exporter_key` | none | void | deletes this exporter's key ("Forget credentials") | `20261122171000` |
| `submit_census` | `p_vendor, p_product_code, p_firmware text, p_msg_ids text[], p_exporter text` | void | opt-in model census | `20261122172000` |
| `reserve_sample` | `p_vendor, p_product_code, p_firmware text` | `jsonb {status, id?, path?, max_bytes?}`; status `wanted` / `supported` / `enough` / `limit` | asks whether a sample is wanted and reserves an upload path | `20261122172000` |
| `complete_sample` | `p_id uuid, p_size int, p_sha256 text` | void | marks an uploaded sample complete | `20261122172000` |

## Tables

| Table | Access | Columns the exporter sends or reads | Conflict target |
|---|---|---|---|
| `telemetry_raw` | upsert, `ignoreDuplicates` | `device_id, ts, soc_pct, watts_in, watts_out, ac_in_voltage_v, ac_in_freq_hz, ac_out_freq_hz, grid_present, extra (jsonb)` and the other columns in `src/db/types.ts` (`TelemetryRawInsert`) | `(device_id, ts)` |
| `pack_raw` | upsert, `ignoreDuplicates` | `device_id, pack, ts, soc_pct, soh_pct, cycles, cell_voltages_mv int[], cell_temps_c int[], min_mos_temp_c, max_mos_temp_c, balance_state, extra (jsonb)` (`PackRawInsert`); array index = cell number, `pack` 0 = main unit | `(device_id, pack, ts)` |
| `outages` | upsert on start, update on end; select (status page) | `device_id, started_at, ended_at, soc_start_pct, soc_end_pct, energy_out_wh` (`OutageRow`); since `20261123080000` also `start_latest_at, end_earliest_at, inferred` (start / end windows when the exporter was blind) | `(device_id, started_at)` |
| `exporter_gaps` | upsert, `ignoreDuplicates` (since `20261123080000`) | `device_id, started_at, ended_at, reason` (`sleep` / `offline` / `stopped`), `slept_s` (`ExporterGapRow`) | `(device_id, started_at)` |
| `device_state` | upsert | `device_id, updated_at, state (jsonb)` | `(device_id)` |
| `consents` | select, insert | `purpose` (`model_census` / `raw_sample_upload`), `text_version, text_sha256, source` (`exporter`), `device_id`; reads `withdrawn_at` | none |

`src/db/types.ts` holds the exact row shapes; keep it in sync with this table.

## Storage

- Bucket `samples` (private): `upload(path, file, { upsert: false })` to the path `reserve_sample` returned, `application/gzip`, at most `max_bytes`.

## Admin script (operator only)

`npm run samples` (`src/admin/samples.ts`) is the only code here that uses `service_role`, from the operator's own environment, never shipped in the image's runtime path: it reads `model_census`, `model_samples`, `known_models` and the `samples` bucket.

## Changing the contract

- **Dashboard side** (new migration): adding columns with defaults, tables or functions is safe. Renaming or dropping anything above, changing an RPC's arguments or return shape, or tightening RLS for `authenticated` breaks running exporters: add a new function or column instead, keep the old one until every supported release has moved off it.
- **Exporter side**: a new object needs its migration on the dashboard first, then raise `dbContract.minMigration` and add the row here.
