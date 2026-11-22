# Exporter updates

**English** · [Українська](uk/UPDATES.md)

New device models and decoder fixes arrive as signed decoder packs
([DECODER_PACKS.md](DECODER_PACKS.md)), without a new image. This page is about the rest:
new versions of the exporter itself.

## What the exporter does

It **tells** you about a new version; it never replaces itself. Replacing a container from inside
needs the Docker socket, which is root on the host, so the exporter never gets it.

- `EXPORTER_UPDATES=notify` (default) or `off`; `EXPORTER_CHANNEL=stable` (default) or `beta`;
  `EXPORTER_RELEASES_URL=https://<your-site>/releases/releases.json`. Without the URL and a trusted
  key nothing is fetched.
- About a minute after start and then daily it fetches `releases.json` and its signature
  (Ed25519, the same keys as decoder packs), refuses an expired or older list, and compares the
  versions. The request carries no identifiers; the hosting sees the IP address and the time.
- The status page shows the running version and, when there is a newer one, a banner with the
  image **pinned by digest**. If the running version was revoked, the banner says so in red.

To update:

```bash
make exporter-update                                   # the :main tag, as before
# or pin the exact release from the banner (deploy/.env or the shell):
ECOFLOW_EXPORTER_IMAGE=ghcr.io/<owner>/<repo>@sha256:<digest> make exporter-update
```

A digest never changes, so a pinned exporter stays exactly as it is until you change the line.

## Releasing (maintainer)

1. Bump `version` in `package.json` (and the lockfile: `npm version X.Y.Z --no-git-tag-version`),
   merge to `main`. Do this first: a tag on a commit with another version fails the image build.
2. Tag the merge commit `vX.Y.Z` and push the tag (or create the GitHub release with a new tag on
   `main`). To redo a wrong tag, delete the **tag** too, not only the release: a release published
   again on an existing tag reuses it and builds nothing. `exporter-image.yml` checks the tag against
   `package.json`, builds amd64 + arm64 with **SLSA build provenance**, pushes
   `exporter:vX.Y.Z` (release tags are never cleaned up) and prints the digest and a ready
   `releases.json` entry in the run summary.
3. Add the entry to `releases/releases.json` with `"channel": "beta"` (pull request). The web
   deploy signs and publishes it with the dashboard.
4. **Quarantine**: after 7 days without problem reports, change it to `"stable"` (the same 7 days as
   the npm rule in `CLAUDE.md`). Only then do stable exporters see it.
5. Kill switch: `"revoked": true` on a bad release. Exporters running it show a red banner and are
   never offered it.

`min_db_migration` is the newest migration the release needs on the server. Apply migrations
before marking a release stable.

## Checking an image by hand

```bash
docker buildx imagetools inspect ghcr.io/<owner>/<repo>@sha256:<digest> \
  --format '{{ json .Provenance }}'
```

The provenance names the repository, the commit and the workflow that built the image. Compare
the digest with the one in `releases.json` and in the release run's summary.

## Not done (yet)

- **Hands-off updates for Docker**: a separate updater service holding the Docker socket that
  only accepts digests from the verified list, with a health check and automatic rollback. It is a
  real trade-off (root-equivalent access in that one container), so it stays optional and is not
  built yet. The desktop app will use the platform's own signed updater instead.
- Showing the update on the web dashboard as well (today: the status page and the logs).
