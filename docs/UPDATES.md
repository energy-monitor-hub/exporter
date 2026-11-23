# Exporter updates

**English** · [Українська](uk/UPDATES.md)

New device models and decoder fixes arrive as signed decoder packs
([DECODER_PACKS.md](DECODER_PACKS.md)), without a new image. This page is about the rest:
new versions of the exporter itself.

## How an update works

With Docker Compose (`deploy/compose.yaml` without a clone, or `deploy/docker-compose.yml` in a
clone) the status page has an **Update to vX.Y.Z** button. Nothing to edit, nothing to run.

- The exporter checks the release list: `EXPORTER_UPDATES=notify` (default) or `off`;
  `EXPORTER_CHANNEL=stable` (default) or `beta`;
  `EXPORTER_RELEASES_URL=https://<your-site>/releases/releases.json`. Without the URL and a trusted
  key nothing is fetched. About a minute after start and then daily it fetches `releases.json` and
  its signature (Ed25519, the same keys as decoder packs), refuses an expired or older list, and
  compares the versions. The request carries no identifiers; the hosting sees the IP address and
  the time.
- When there is a newer version on your channel, the status page says so and shows the button.
  If the running version was revoked, the banner is red.
- The button asks the **updater**, a second small container from the same image. The exporter
  sends it only a version number. The updater then, by itself:
  1. fetches and verifies the signed release list again, and takes the version's **digest** from
     it (only a non-revoked version on your channel, newer than the running one);
  2. checks the image's **GitHub build provenance** for that digest (a Sigstore bundle from the
     GitHub attestations API): built by this repository's `exporter-image.yml` from the `vX.Y.Z`
     tag;
  3. pulls `ghcr.io/<owner>/<repo>@sha256:<digest>` and checks the pulled image is that digest;
  4. recreates the exporter container with it, keeping its volume, port, settings and compose
     labels;
  5. waits until the new exporter answers with the new version (and gets data from the station, if
     the old one did) and stays up for 20 s; otherwise it removes it and starts the old one again
     (**rollback**), within 4 minutes.
- **Automatic mode** (a switch on the status page, off by default): the updater installs `stable`
  releases by itself (never `beta`), checking 2 minutes after start and every 6 hours. A version
  that failed is not retried for a day.
- The installed version is remembered in the updater's own volume. A later `docker compose up`
  keeps the updated container; if something recreates the exporter from an older image, the
  updater puts the installed version back.
- The exporter restarts during an update: about a minute without samples (the queue on disk is
  kept).

### Why a separate container

Replacing a container needs the Docker socket, which is root on the host. The exporter (network,
your credentials, a web page) never gets it. The updater has it and is kept minimal:

- no published port: it answers only on the compose network, and only to the exporter container's
  address; its API is `GET /status`, `POST /update {version}`, `POST /auto {enabled}`;
- it starts only digests from a list signed with a trusted key, with matching build provenance;
  the exporter cannot name an image;
- it does not get `.env`: the release URL, channel and extra keys are read from the exporter
  container's settings (which the exporter process cannot change);
- read-only file system, no Linux capabilities, `no-new-privileges`;
- it contacts the release list URL, `api.github.com` (attestations) and the Sigstore TUF mirror
  (`tuf-repo-cdn.sigstore.dev`, the trust root; the copy shipped in the image is used when it is
  unreachable). The Docker daemon pulls from ghcr.io.

Settings (shell or a `.env` next to the compose file): `ECOFLOW_UPDATER=0` leaves the updater out
(the page then explains how to update by hand); `UPDATER_ATTESTATION=off` skips the provenance
check (forks without attestations, local registries); `DOCKER_SOCKET=/run/user/<uid>/docker.sock`
for rootless Docker or Podman.

The updater updates the exporter, not itself: it changes rarely, and `docker compose pull &&
docker compose up -d` refreshes it with the exporter.

### By hand (no updater, `docker run`, a single binary)

```bash
make exporter-update                                   # the :main tag (in a clone)
# or pin the exact release from the banner (deploy/.env or the shell):
ECOFLOW_EXPORTER_IMAGE=ghcr.io/<owner>/<repo>@sha256:<digest> make exporter-update
```

A digest never changes, so a pinned exporter stays exactly as it is until you change the line.
With `docker run`, switch to `deploy/compose.yaml` once (README) to get the button. The single
executable is updated by installing the new file from the release ([NATIVE.md](NATIVE.md)).

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

- The updater does not update itself (see above). The desktop app will use the platform's own
  signed updater instead.
- Showing the update on the web dashboard as well (today: the status page and the logs).
