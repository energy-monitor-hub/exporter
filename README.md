# Energy Monitor Hub: exporter

**English** · [Українська](README.uk.md)

A small local program that reads telemetry from an **EcoFlow** power station (Delta 3 Max Plus today) through EcoFlow's private MQTT API, the one the mobile app uses, decodes the protobuf messages (cell voltages, grid voltage and frequency, temperatures, SOH, balancing, power outages) and writes them to **your own Supabase project**, where a dashboard reads them.

This repository is public so you can check what runs on your machine: the exporter is the only part that ever sees your EcoFlow password. The dashboard (web app, database schema, hosting) lives in a separate repository; the two meet only through the [database contract](docs/DB_CONTRACT.md).

## Where your credentials go

Read the code paths yourself; these are the only places your secrets travel:

| Secret | Where it is used | Where it is stored |
|---|---|---|
| EcoFlow e-mail and password | sent only to EcoFlow's own login API (`ECOFLOW_API_HOST`, default `api.ecoflow.com`) to get MQTT credentials: `src/auth/` | `.env` (if you put them there) or `/data/credentials.json`, encrypted with AES-256-GCM: `src/secrets/` |
| Key for `credentials.json` | random 256-bit key, kept in your Supabase project per exporter (`exporter_key`), handed out only to this exporter's token, deleted when you revoke it | never on the volume |
| Station serial number | MQTT topics at EcoFlow, `devices.sn` in your Supabase | `.env` or `credentials.json` |
| Dashboard login | OAuth 2.1 + PKCE against your Supabase Auth; the exporter never sees your dashboard password | `/data/oauth.json` (`0600`) |

Nothing is sent to the authors of this project. The exporter talks to exactly three kinds of hosts: EcoFlow (login API and MQTT broker), your Supabase project, and, only if you set the URLs, your dashboard site for signed decoder packs and the release list (plain GET requests with no identifiers). Model census and sample uploads (below) are off until you consent on the status page, and go to your own Supabase.

## Verify what you run

- The image and binaries are built by GitHub Actions in this repository ([exporter-image.yml](.github/workflows/exporter-image.yml), [exporter-binaries.yml](.github/workflows/exporter-binaries.yml)) with a signed **build provenance attestation** that ties each image digest and binary to the commit and workflow that built it:
  ```bash
  gh attestation verify oci://ghcr.io/<owner>/<repo>@sha256:<digest> --repo <owner>/<repo>
  gh attestation verify ecoflow-exporter-linux-x64 --repo <owner>/<repo>
  ```
- Or build it yourself from this source: `docker compose -f deploy/docker-compose.yml up -d --build`, or `npm ci && npm run build && npm start`.
- Every dependency is pinned to an exact version and checked against a 7-day quarantine (below).

## Recording fixtures

The script signs in to EcoFlow like the mobile app, connects to MQTT and saves every message as is. Run it locally (plain Node 22, or a devcontainer): a cloud CI or sandbox usually can't reach the broker.

```bash
cp .env.example .env              # ECOFLOW_USERNAME, ECOFLOW_PASSWORD, DEVICE_SN
npm ci
make record                       # records until you press Ctrl+C
make record ARGS="--minutes 20"   # or stops by itself
```

- Files land in `test/fixtures/<start time>/`: `00001-<time>-<cmdFunc>-<cmdId>.bin` and `index.json` (topic, type, cmdFunc/cmdId of every header, sizes).
- The SN, userId and battery module serials are replaced with `XXXX…` / `0000…` of the same length, both in the files and in `index.json`. Check before committing anyway: `grep -rl "<your SN>" test/fixtures` must find nothing.
- At the start and then every 5 minutes the script asks the device for all values (as the app and ioBroker do). Turn it off with `--no-quotas`, change the period with `--quota-every 120` (seconds).
- If login fails on `api.ecoflow.com`, try `ECOFLOW_API_HOST=api-e.ecoflow.com` in `.env`.
- What to record: 10–15 minutes of normal operation, charging from the grid, discharging and, most valuable of all, the grid going down and coming back.
- Connection drops: mqtt.js reconnects every 5 s; if the broker rejects the credentials, the script signs in again with a growing pause (up to 5 min). Messages during an outage are not recorded.

## Without Docker

You need npm ≥ 11.10 (Node 22 ships npm 10, which ignores the quarantine): `npm install -g npm@11.21.2`.

```bash
npm ci
npm run dev        # tsx watch src/index.ts
npm test
npm run build && npm start
```

## Running the exporter in production

### Connecting a new exporter (no clone, no build)

The dashboard's **Exporters** page (`/exporters`) has the steps with this instance's values filled in, so a new user only copies and pastes. Without the dashboard, the same by hand:

1. In an empty folder, create `.env`:

   ```bash
   SUPABASE_URL=https://<project-ref>.supabase.co
   SUPABASE_ANON_KEY=<anon key>          # public, the same one the dashboard uses
   DECODER_INDEX_URL=https://<your-site>/decoders/index.json
   EXPORTER_RELEASES_URL=https://<your-site>/releases/releases.json
   ```

2. Start the prebuilt image (amd64 and arm64) from that folder:

   ```bash
   docker run -d --name ecoflow-exporter --restart unless-stopped \
     --env-file .env -p 127.0.0.1:9101:9101 -v ecoflow-exporter:/data \
     ghcr.io/<owner>/<repo>:main
   ```

   Without Docker, install the single-file binary from the GitHub release instead and put the same `.env` into its data folder ([docs/NATIVE.md](docs/NATIVE.md)).
3. Open the status page **http://127.0.0.1:9101/** on that machine, press **Log in**, sign in to the dashboard and approve the request.
4. On the same page, fill in the **EcoFlow account** card (app e-mail and password, station serial number). Data starts flowing.

Everything the exporter keeps lives in the one `/data` volume: the write queue, the login token, the encrypted EcoFlow credentials (the key stays in Supabase) and cached decoder packs. To update: `docker pull` the image, `docker rm -f ecoflow-exporter`, and run step 2 again; the status page tells you when a new version is out. If the ghcr package is private, `docker login ghcr.io` first (see "Exporter image in ghcr.io").

### With docker compose (from a clone)

```bash
make exporter-update     # pulls the prebuilt image from ghcr.io (amd64 or arm64) and starts it
# the same without make:
docker compose -f deploy/docker-compose.yml pull
docker compose -f deploy/docker-compose.yml up -d
```

To update to the latest `main`: `make exporter-update` again. To use your fork's image, `export ECOFLOW_IMAGE_REPO=ghcr.io/<you>/<repo>` (or put it in `deploy/.env`). `up -d --build` builds the image locally from the current code instead.

In `.env` set `SUPABASE_URL=https://<project-ref>.supabase.co` and `SUPABASE_ANON_KEY` of your cloud project (public, the same one the dashboard uses; its Exporters page shows it). The exporter doesn't need the `service_role` key.

### Exporter login

The exporter writes to Supabase on behalf of the user who approved it (Supabase's OAuth 2.1 server, PKCE), and RLS lets it write only that user's devices. Once, on the machine that runs the exporter:

```bash
docker compose -f deploy/docker-compose.yml run --rm --service-ports login
# dev stack (from source):
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml run --rm --service-ports login
# without Docker: npm run login
```

1. The exporter registers itself as a separate OAuth client (named after `OAUTH_CLIENT_NAME`, for example "Home server") and prints a link.
2. Open it, sign in to the dashboard and approve the request on the `/oauth/consent` page.
3. The browser comes back to `http://127.0.0.1:9102/callback` and the login finishes by itself. If the exporter runs on another machine and that page didn't open, copy its address from the address bar and paste it into the exporter's terminal.

The tokens are stored in `/data/oauth.json` (the same volume as the buffer; the file is secret, `0600`). A running exporter picks up a new login by itself, no restart needed. The access token lives for an hour and the exporter refreshes it. The list of connected exporters and a "Revoke" button are on the dashboard's "Exporters" page (`/exporters`). After a revoke the exporter can't refresh its token (within an hour at most), rows wait in the buffer, and `/healthz` shows `auth.state = revoked`: log in again.

A device appears in `devices` on its first write (RPC `ensure_device`, up to 10 devices per user). A device written earlier by an old `service_role` exporter goes to whoever's exporter first sends the same serial number (or straight to the project's only user, if there is just one).

### Setting up the EcoFlow account

Instead of putting `ECOFLOW_USERNAME`, `ECOFLOW_PASSWORD` and `DEVICE_SN` in `.env`, you can enter them on the status page (below). Leave them out of `.env`, start the exporter, open **http://127.0.0.1:9101/**:

1. **Log in** (the Supabase login above). The form needs it: the encryption key is kept with this exporter's login.
2. Fill in the **EcoFlow account** card: the app account's e-mail and password, the station's serial number, the server (EU accounts can pick `api-e`). "Check and save" signs in to EcoFlow first and stores nothing if that fails.
3. The exporter connects to the station right away. After a restart it logs in to Supabase, fetches the key, decrypts the file and connects, with nothing to type.

How it is protected:

- The credentials are encrypted with AES-256-GCM in `/data/credentials.json` (`CREDENTIALS_PATH`, `0600`). The random 256-bit key is **not** on the volume: Supabase keeps it, one per exporter (`public.exporter_keys`), and hands it out only to a token issued to that exporter (`client_id` claim), never to the web app's session. The server never sees the password.
- **Revoking the exporter** on the dashboard's Exporters page deletes its key, so any copy of the volume or a backup becomes useless. "Forget credentials" on the status page deletes the file and the key.
- The setup form answers only through a loopback host name (`127.0.0.1` / `localhost`) and, natively, only to connections from this computer, even when `UI_ALLOWED_HOSTS` and `LISTEN_HOST` open the page to your LAN.
- Honest limits: while the exporter is **not** revoked, whoever copies the whole volume also has `oauth.json` and can fetch the key (refresh token rotation will then log your exporter out, which is your signal to revoke it). Malware running on the same machine can read the process memory. A restart needs internet to fetch the key; EcoFlow's MQTT is a cloud service, so without internet there is no data anyway.
- Logging in again from another port registers a new exporter with a new key: enter the credentials again then.

Credentials in `.env` still work and win over the page (it then shows them as "From .env" and cannot change them).

### Exporter status page

The exporter serves a simple status page itself: **http://127.0.0.1:9101/** (the same port as `/healthz`; in Docker it is published on `127.0.0.1` only). It shows:

- the connection to the station (MQTT), the last message and sample, a "Reconnect" button;
- the Supabase login state (`ok` / not done / revoked / error) and a "Log in" button: the same OAuth authorization as `login` above, without a terminal. The browser comes back to `http://127.0.0.1:9101/callback`; if it didn't (the page is open from another machine), paste the address it stopped at into the field on the page;
- the write queue (how many rows are waiting, the last error), the grid and an open outage;
- the latest values (charge, input/output, AC, packs and cells) and a few recent outages from Supabase.

The page is plain HTML + JS in `src/ui/` (no build, no dependencies), with data from `GET /api/status`. The UI is in English; the "UK" button switches it to Ukrainian. Logging in from the page registers a separate OAuth client (a different redirect address than `login` on `:9102`), so the dashboard's "Exporters" page may show one more row; you can revoke the old one.

The page only answers on `localhost` / IP addresses (DNS rebinding protection); add any other host name to `UI_ALLOWED_HOSTS`. If the port is published somewhere other than `127.0.0.1:9101`, set `UI_URL`. Natively the exporter listens on `127.0.0.1` only; `LISTEN_HOST=0.0.0.0` opens the page to your LAN (the Docker image already listens on `0.0.0.0` inside the container, and compose publishes the port on `127.0.0.1`).

### Helping support a new model

If the exporter does not understand your station well (the status page shows the share of messages it decodes), the card **"Help support your model"** on the status page lets you share, each with its own consent shown right there:

- a **model census**: vendor, the first 4 characters of the serial number (the model family), firmware and the list of message types with counts. No values, no full serial;
- a **sample**: a recording of 5 to 15 minutes of the station's messages. Serial numbers, the account id and the e-mail are masked before anything leaves the computer, also inside XOR-ed payloads, and serial-like strings are masked too; if any identifier is still found, the sample is blocked. You see a summary (messages, size, how many identifiers were masked) and nothing is sent until you press **Send**.

The server decides whether it needs the sample (models already supported, or with 3 samples, are turned away; 1 upload an hour, 10 MB). You can download, delete and withdraw everything on the dashboard's **My data** page. These buttons only work from the computer the exporter runs on (`127.0.0.1`).

### What the exporter does

- Keeps the MQTT connection, decodes the messages (`src/decode/`, see [docs/DECODER.md](docs/DECODER.md)) and every `SAMPLE_INTERVAL_S` (10 s) writes a row to `telemetry_raw` and one row per pack to `pack_raw`. If nothing came from the station for more than 3 min, no rows are written (so stale data isn't drawn).
- **Local buffer**: everything goes to an SQLite file first (`BUFFER_PATH`, in Docker the `buffer` volume → `/data`) and is deleted from there only after Supabase confirms it. Without internet, rows wait and arrive later (all writes are idempotent). The limit is 500,000 rows; beyond that the oldest samples are dropped (outages never are).
- **Outages** (`outages`): from the station's grid flag. A row is inserted when the grid goes down and closed when it comes back, with SoC and the energy delivered in Wh. If the internet went down together with the power and MQTT was silent, start = the last moment the grid was still seen, end = the first moment it is seen again. An open outage survives a restart.
- **Watchdog**: if the connection is "alive" but no messages arrive for `MQTT_SILENCE_TIMEOUT_S` (180 s), the exporter signs in again with fresh credentials.
- `/healthz` (for the container health check) shows the MQTT state, the last message, the grid, an open outage and the queue; it answers 503 if nothing came from the station for 10 minutes.
- **Decoder packs**: new models and decoder fixes as signed data, never code, fetched from the dashboard's hosting when `DECODER_INDEX_URL` is set. See [docs/DECODER_PACKS.md](docs/DECODER_PACKS.md).
- **Updates**: the status page shows when a newer exporter is out (signed release list, image pinned by digest); it never updates itself. See [docs/UPDATES.md](docs/UPDATES.md).
- **Without Docker**: one executable per OS (Linux, macOS, Windows) with a service installer. See [docs/NATIVE.md](docs/NATIVE.md).

## Exporter image in ghcr.io

GitHub Actions (`.github/workflows/exporter-image.yml`) builds the exporter image for `linux/amd64` and `linux/arm64` (Apple Silicon Macs) on every push to `main` that touches `src/`, `package*.json`, `Dockerfile`, …, and pushes it to the GitHub Container Registry of the repository it runs in: `ghcr.io/<owner>/<repo>`, `<owner>/<repo>` being this repository or your fork. Every pushed digest gets a build provenance attestation (see [Verify what you run](#verify-what-you-run)).

- `deploy/docker-compose.yml` defaults to this repository's image. `ECOFLOW_IMAGE_REPO` (for example `ghcr.io/<you>/<repo>`, in the shell or in `deploy/.env`) switches it to a fork's.
- Tags: `:main` (latest) and `:sha-<commit>`. At most 3 versions are kept (`:main` and the 2 before it); older ones are deleted after every push. Each build's size is shown in the run summary (≈ 67 MB per architecture).
- A PR only builds both architectures (as a check) and pushes nothing.
- Layer cache: GitHub Actions cache (`type=gha`), not counted as ghcr storage.
- The image is used by the `:main` tag, not by digest: it is built from this repository, and everything inside it (base image, npm) is pinned exactly.
- New ghcr packages are private by default. To let anyone pull it without logging in, make the package public (package page → Package settings → Change visibility). Otherwise, log in on the machine that runs the exporter with your own account: `docker login ghcr.io -u <your-github-username>`, password a [classic token](https://github.com/settings/tokens/new?scopes=read:packages&description=ghcr%20pull) with only `read:packages` (ghcr doesn't accept fine-grained tokens).

## Development

```bash
cp .env.example .env     # ECOFLOW_USERNAME, ECOFLOW_PASSWORD, DEVICE_SN, SUPABASE_URL, SUPABASE_ANON_KEY
npm ci
make test                # vitest
make typecheck
make dev                 # docker compose watch: src/ synced, tsx watch restarts; status page http://127.0.0.1:9101
```

`make` lists every command. Decoding work happens on recorded fixtures (below), so tests need no station and no network. Database changes: [docs/DB_CONTRACT.md](docs/DB_CONTRACT.md).

## Dependencies: exact versions and a 7-day quarantine

Everything that gets installed has an exact version; there is no `latest` or `^`/`~` anywhere. New versions are taken only 7 days after they are published: broken releases (supply-chain attacks) are usually found and pulled sooner.

- **npm** (`.npmrc`): `save-exact=true`, `min-release-age=7` (npm ≥ 11.10 doesn't see versions younger than 7 days, transitive dependencies included), `engine-strict=true` (npm 10 simply refuses to install), `strict-allow-scripts=true` (dependency install scripts run only if allowed in `allowScripts` in `package.json`). Install only with `npm ci`; a new dependency: `npm install <pkg>@<version>`.
- **Check**: `make deps-check` (`scripts/check-deps.mjs`) fails if there is a range anywhere, a lockfile is out of sync with `package.json`, or any package in a lockfile is younger than 7 days. CI does the same (`.github/workflows/ci.yml`).
- **Docker**: base images with an exact tag and an `@sha256` digest; npm inside images is pinned.
- **Updates** are manual, from time to time: `make deps-outdated` shows new versions of npm dependencies and of pinned npm CLIs (`# npm-pin:` comment) that are already past the 7-day quarantine. Images (tag + digest) and GitHub Actions (commit SHA) are updated by hand, also only to versions older than 7 days.
- A new dependency with an install script (`npm install` mentions `install-scripts`): review what it does, then `npm install-scripts approve <pkg>`.

## Layout

```
src/            index.ts (start), server.ts + status.ts + ui/ (status page, /healthz), decode/ (protobuf → state), model/ (common model), exporter/ (samples, outages, buffer, writes), mqtt/, auth/ (EcoFlow login), oauth/ (Supabase login), secrets/, sources/, packs/ (signed decoder packs), update/, discovery/ (census, samples), proto/, db/
decoders/       decoder packs (data, signed and published by the dashboard's deploy)
releases/       releases.json: the release list the status page checks (signed the same way)
test/           vitest, fixtures/ (recorded MQTT, serials masked)
deploy/         docker-compose.yml (prod), docker-compose.dev.yml (watch)
packaging/      service installers for the single-file binaries
docs/           DB_CONTRACT.md, DECODER.md, DECODER_PACKS.md, DATA_CATALOG.md, UPDATES.md, NATIVE.md; uk/ — Ukrainian
.github/        CI, image (ghcr.io) and binaries, with build provenance
scripts/        build-sea.mjs (binaries), check-deps.mjs (exact versions + quarantine)
```

## Translations

English is the primary language of the docs. Ukrainian translations live next to them: [README.uk.md](README.uk.md), [docs/uk/](docs/uk/). When the English text changes, update the translation in the same PR (or note in it that the translation lags).
