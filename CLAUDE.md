# CLAUDE.md

The exporter of the Energy Monitor Hub project (dashboard repository: energy-monitor-hub/dashboard): reads an EcoFlow station over its private MQTT API (protobuf), writes to the user's Supabase as the user (OAuth), serves a local status page. Public on purpose: users must be able to verify that their credentials never leave their machine except to EcoFlow and their own Supabase (README, "Where your credentials go"). Keep it that way: no telemetry, analytics or calls to any host the user did not configure.

The dashboard (web app, `supabase/migrations/`, hosting) is a separate repository that includes this one as a git submodule. The only interface between them is [docs/DB_CONTRACT.md](docs/DB_CONTRACT.md).

- TypeScript, ESM, `strict` (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Node 22. npm only (no Corepack, no pnpm/yarn); keep `package-lock.json` committed.
- Relative imports use the `.js` extension (NodeNext resolution).
- Tests: `npm test` (vitest). Type check: `npm run typecheck`. `make` lists everyday commands.
- Secrets live only in `.env` (gitignored). Never commit credentials, device SN, userId or battery serials (also scrub them from fixtures: `src/record/scrub.ts`; check new fixtures before committing). No `service_role` key in the exporter's runtime path; only `src/admin/` uses it, from the operator's environment.
- Database: never assume an object the contract does not list. A new table, column or RPC needs its migration in the dashboard repository first; then update `src/db/types.ts`, `docs/DB_CONTRACT.md` (+ `docs/uk/`) and raise `dbContract.minMigration` in package.json.

## Public repo (always)

- No personal accounts or setup in the repo: no owner's GitHub login in instructions, no emails, Supabase project refs, Firebase / GCP project ids or site URLs, local paths, machine names. Use placeholders (`<project-ref>`, `<you>`), env vars, values derived at runtime (`${{ github.repository }}`), or `example.*` in tests and fixtures. The only allowed upstream reference is this repository's own location (`github.com/energy-monitor-hub/exporter`, its ghcr image) as an overridable default, e.g. `ECOFLOW_IMAGE_REPO`.
- Docs: English is primary (`README.md`, `docs/*.md`, `SECURITY.md`); Ukrainian is a separate translation next to each (`README.uk.md`, `docs/uk/*.md`, `SECURITY.uk.md`). Change both in the same PR, or say in the PR that the translation lags.
- Code comments, logs, errors and CLI prompts are English. The status page (`src/ui/`) has English and Ukrainian strings.

## Dependencies (supply-chain rule, always)

Everything that gets installed has an exact version. Never `latest`, `^`, `~`, `*`, a major-only tag or an unpinned `curl | sh`. New versions are used only after a **7-day quarantine**.

- npm: `.npmrc` has `save-exact`, `min-release-age=7`, `engine-strict`, `strict-allow-scripts`. Needs npm >= 11.10 (`engines.npm`); images and CI install npm 11 at a pinned version. Install with `npm ci`; add a dep as `npm install <pkg>@<exact version>` published >= 7 days ago.
- Dependency install scripts run only if listed in `allowScripts` (package.json, pinned `pkg@version`). Review the script before `npm install-scripts approve <pkg>`.
- `make deps-check` (`scripts/check-deps.mjs`, also in CI) must pass.
- Docker images: `name:<exact tag>@sha256:<digest>`. GitHub Actions by commit SHA with a `# vX.Y.Z` comment. A pinned npm package outside package.json gets a `# npm-pin: <name>` comment on the line above.
- No Renovate/Dependabot. Updates are manual: `make deps-outdated`. Never bump to something newer than 7 days.

## Images and releases

- `exporter-image.yml`: `ghcr.io/<owner>/<repo>:main` + `:sha-<commit>` on main (3 versions kept), `:vX.Y.Z` on tags (kept), each digest with a build provenance attestation. `exporter-binaries.yml`: single-file binaries, attested and attached to the release on tags.
- `releases/releases.json` and `decoders/` are data; the dashboard's deploy signs and publishes them (docs/UPDATES.md, docs/DECODER_PACKS.md).
