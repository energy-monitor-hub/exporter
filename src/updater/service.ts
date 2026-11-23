import type { KeyObject } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchReleaseManifest } from '../update/checker.js';
import { compareVersions, newestRelease, type Release, type ReleaseManifest } from '../update/schema.js';
import type { ContainerInspect, ContainerSummary, DockerApi } from './docker.js';
import { RolledBackError, swapContainer, type Probe, type SwapPhase } from './swap.js';

export type JobPhase = 'verifying' | 'pulling' | SwapPhase | 'done' | 'failed' | 'rolled-back';

export interface Job {
  version: string;
  from?: string;
  phase: JobPhase;
  /** started by auto mode or to put back a version compose replaced, not by the user */
  auto: boolean;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface UpdaterState {
  /** Install `stable` releases without asking. */
  auto: boolean;
  /** Last version this updater installed, kept when compose recreates the exporter from an older image. */
  pinned?: { version: string; digest: string };
  job?: Job;
  /** Highest release list sequence seen (an older list is refused). */
  sequence?: number;
}

export interface UpdaterStatus {
  available: true;
  configured: boolean;
  auto: boolean;
  channel: 'stable' | 'beta';
  attestation: boolean;
  current?: string;
  job?: Job;
  error?: string;
}

/** Where to look for releases: the exporter's own settings (its .env), read from its container. */
export interface UpdateSettings {
  releasesUrl: string | undefined;
  channel: 'stable' | 'beta';
  keys: readonly KeyObject[];
}

export interface UpdaterOptions {
  docker: DockerApi;
  /** From the exporter container's environment (set by the user, not changeable by the exporter process). */
  settings: (exporter: ContainerInspect | undefined) => UpdateSettings;
  /** compose project of the updater; the exporter is found by its labels */
  project: string;
  service: string;
  stateFile: string;
  probe: (c: ContainerInspect) => Promise<Probe>;
  /** Checks the image's build provenance; undefined turns the check off (UPDATER_ATTESTATION=off). */
  verifyProvenance: ((image: string, digest: string, version: string) => Promise<void>) | undefined;
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  fetch?: typeof fetch;
  now?: () => number;
  swapTimings?: { timeoutMs?: number; stableMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
}

const RUNNING: readonly JobPhase[] = ['verifying', 'pulling', 'starting', 'checking', 'rolling-back'];
/** Auto mode does not retry a version that failed for this long. */
const AUTO_RETRY_MS = 24 * 3600_000;
const SUFFIXES = ['-update', '-previous'];

export class UpdaterService {
  private state: UpdaterState;
  private running: Promise<void> | undefined;
  private lastError: string | undefined;
  private manifest: ReleaseManifest | undefined;
  private settings: UpdateSettings;

  constructor(private readonly o: UpdaterOptions) {
    this.state = this.load();
    this.settings = o.settings(undefined);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private load(): UpdaterState {
    try {
      const s = JSON.parse(readFileSync(this.o.stateFile, 'utf8')) as Partial<UpdaterState>;
      return {
        auto: s.auto === true,
        ...(s.pinned && typeof s.pinned.version === 'string' && typeof s.pinned.digest === 'string' ? { pinned: s.pinned } : {}),
        ...(s.job ? { job: s.job } : {}),
        ...(typeof s.sequence === 'number' ? { sequence: s.sequence } : {}),
      };
    } catch {
      return { auto: false };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.o.stateFile), { recursive: true });
    const tmp = `${this.o.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.o.stateFile);
  }

  get configured(): boolean {
    return this.settings.releasesUrl !== undefined && this.settings.keys.length > 0;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  async status(): Promise<UpdaterStatus> {
    let current: string | undefined;
    try {
      const c = await this.exporterContainer();
      if (c) current = await this.versionOf(c);
    } catch {
      // shown as unknown
    }
    return {
      available: true,
      configured: this.configured,
      auto: this.state.auto,
      channel: this.settings.channel,
      attestation: this.o.verifyProvenance !== undefined,
      ...(current ? { current } : {}),
      ...(this.state.job ? { job: this.state.job } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  setAuto(enabled: boolean): void {
    this.state.auto = enabled;
    this.save();
    this.o.log.info(`updater: automatic stable updates ${enabled ? 'on' : 'off'}`);
  }

  /** IP addresses of the exporter container: the only peer allowed to call the updater. */
  async exporterAddresses(): Promise<string[]> {
    const c = await this.exporterContainer();
    if (!c) return [];
    return Object.values(c.NetworkSettings.Networks ?? {}).flatMap((n) => [n.IPAddress, n.GlobalIPv6Address].filter((a): a is string => Boolean(a)));
  }

  /** The compose service's container (not a one-off `run`, not our own leftovers). */
  async exporterContainer(): Promise<ContainerInspect | undefined> {
    const list = await this.o.docker.listContainers([`com.docker.compose.project=${this.o.project}`, `com.docker.compose.service=${this.o.service}`]);
    const main = list.filter((c: ContainerSummary) => c.Labels['com.docker.compose.oneoff'] !== 'True' && !c.Names.some((n) => SUFFIXES.some((s) => n.endsWith(s))));
    const pick = main.find((c) => c.State === 'running') ?? main[0];
    const c = pick ? await this.o.docker.inspectContainer(pick.Id) : undefined;
    if (c) this.settings = this.o.settings(c);
    return c;
  }

  /** From /healthz, or for older exporters without it there, by the image digest in the release list. */
  async versionOf(c: ContainerInspect): Promise<string | undefined> {
    try {
      const p = await this.o.probe(c);
      if (p.version) return p.version;
    } catch {
      // not answering: try the image
    }
    const m = this.manifest;
    if (!m) return undefined;
    const img = await this.o.docker.inspectImage(c.Image);
    const digests = (img?.RepoDigests ?? []).filter((d) => d.startsWith(`${m.image}@`)).map((d) => d.slice(m.image.length + 1));
    return m.releases.find((r) => digests.includes(r.digest))?.version;
  }

  private async refresh(): Promise<ReleaseManifest> {
    await this.exporterContainer(); // its current settings
    if (!this.settings.releasesUrl) throw new Error('EXPORTER_RELEASES_URL is not set');
    const m = await fetchReleaseManifest({
      url: this.settings.releasesUrl,
      keys: this.settings.keys,
      now: this.now(),
      ...(this.state.sequence !== undefined ? { minSequence: this.state.sequence } : {}),
      ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
    });
    this.manifest = m;
    if (m.sequence !== this.state.sequence) {
      this.state.sequence = m.sequence;
      this.save();
    }
    return m;
  }

  /**
   * Starts installing `version` (the user's button). Only a version from the signed list, newer
   * than the running one, on the configured channel, not revoked. Resolves once started.
   */
  request(version: string): void {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('bad version');
    this.start(version, false);
  }

  private start(version: string, auto: boolean): void {
    if (this.running) throw new Error(`an update to ${this.state.job?.version ?? 'another version'} is already running`);
    if (!this.configured) throw new Error('updates are not set up (EXPORTER_RELEASES_URL)');
    this.state.job = { version, phase: 'verifying', auto, startedAt: new Date(this.now()).toISOString() };
    this.save();
    this.running = this.install(version, auto).finally(() => (this.running = undefined));
  }

  /** For tests and shutdown: the running job, if any. */
  wait(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private phase(p: JobPhase, error?: string): void {
    const job = this.state.job;
    if (!job) return;
    job.phase = p;
    if (!RUNNING.includes(p)) job.finishedAt = new Date(this.now()).toISOString();
    if (error) job.error = error;
    this.save();
  }

  private async install(version: string, auto: boolean): Promise<void> {
    const job = this.state.job;
    try {
      const m = await this.refresh();
      const old = await this.exporterContainer();
      if (!old) throw new Error(`no "${this.o.service}" container in compose project ${this.o.project}`);
      const current = await this.versionOf(old);
      if (job && current) job.from = current;
      const rel = this.pick(m, version, current, auto);

      if (this.o.verifyProvenance) await this.o.verifyProvenance(m.image, rel.digest, rel.version);
      this.phase('pulling');
      await this.o.docker.pull(m.image, rel.digest);
      const ref = `${m.image}@${rel.digest}`;
      const img = await this.o.docker.inspectImage(ref);
      if (!img?.RepoDigests?.includes(ref)) throw new Error(`pulled image does not match ${rel.digest}`);

      let requireOk = false;
      try {
        requireOk = (await this.o.probe(old)).ok === true;
      } catch {
        // the old one is not answering: only require that the new one starts
      }
      this.o.log.info(`updater: installing exporter ${rel.version} (${ref}) in place of ${current ?? 'an unknown version'}`);
      await swapContainer({
        docker: this.o.docker,
        old,
        image: ref,
        expectVersion: rel.version,
        requireOk,
        probe: this.o.probe,
        onPhase: (p) => this.phase(p),
        ...this.o.swapTimings,
      });
      this.state.pinned = { version: rel.version, digest: rel.digest };
      this.phase('done');
      this.o.log.info(`updater: exporter ${rel.version} is running`);
    } catch (err) {
      const msg = (err as Error).message;
      if (err instanceof RolledBackError) {
        this.phase(err.restored ? 'rolled-back' : 'failed', msg);
        this.o.log.error(`updater: ${version} did not come up, ${err.restored ? 'the previous exporter is back' : 'and the rollback failed'}: ${msg}`);
      } else {
        this.phase('failed', msg);
        this.o.log.error(`updater: update to ${version} failed: ${msg}`);
      }
    }
  }

  private pick(m: ReleaseManifest, version: string, current: string | undefined, auto: boolean): Release {
    const rel = m.releases.find((r) => r.version === version);
    if (!rel) throw new Error(`${version} is not in the signed release list`);
    if (rel.revoked) throw new Error(`${version} was revoked`);
    const channelOk = auto ? rel.channel === 'stable' || this.state.pinned?.version === version : this.settings.channel === 'beta' || rel.channel === 'stable';
    if (!channelOk) throw new Error(`${version} is not on the ${auto ? 'stable' : this.settings.channel} channel`);
    if (current && compareVersions(version, current) <= 0) throw new Error(`${version} is not newer than the running ${current}`);
    return rel;
  }

  /**
   * Periodic run: refresh the list; put the installed version back if compose recreated the
   * exporter from an older image; in auto mode install the newest stable release.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    try {
      await this.exporterContainer();
      if (!this.configured) return;
      const m = await this.refresh();
      this.lastError = undefined;
      const c = await this.exporterContainer();
      if (!c) return;
      const current = await this.versionOf(c);
      if (!current) return; // a local build or :main without /healthz version: leave it alone
      const pinned = this.state.pinned;
      const pinnedRel = pinned && m.releases.find((r) => r.version === pinned.version && r.digest === pinned.digest && !r.revoked);
      if (pinnedRel && compareVersions(current, pinnedRel.version) < 0) {
        this.o.log.info(`updater: the exporter runs ${current}, older than the installed ${pinnedRel.version}; putting it back`);
        this.start(pinnedRel.version, true);
        return;
      }
      if (!this.state.auto) return;
      const next = newestRelease(m, current, 'stable');
      if (!next) return;
      const last = this.state.job;
      if (last && last.version === next.version && (last.phase === 'failed' || last.phase === 'rolled-back') && last.finishedAt && this.now() - Date.parse(last.finishedAt) < AUTO_RETRY_MS) return;
      this.start(next.version, true);
    } catch (err) {
      this.lastError = (err as Error).message;
      this.o.log.warn(`updater: ${this.lastError}`);
    }
  }

  /**
   * After a restart in the middle of an update (host reboot, updater recreated): make sure an
   * exporter runs, drop our leftover containers, and close the job.
   */
  async recover(): Promise<void> {
    const job = this.state.job;
    const list = await this.o.docker.listContainers([`com.docker.compose.project=${this.o.project}`, `com.docker.compose.service=${this.o.service}`]);
    const name = (c: ContainerSummary) => (c.Names[0] ?? '').replace(/^\//, '');
    const previous = list.find((c) => name(c).endsWith('-previous'));
    const next = list.find((c) => name(c).endsWith('-update'));
    const main = list.find((c) => c.Labels['com.docker.compose.oneoff'] !== 'True' && c !== previous && c !== next);
    // No record of the job (state lost): treat it as interrupted, the old exporter is the known one.
    const interrupted = job === undefined || RUNNING.includes(job.phase);
    let rolledBack = false;
    if (previous && !interrupted && main) {
      // A finished update whose old container could not be removed.
      await this.o.docker.remove(previous.Id).catch(() => undefined);
    } else if (previous) {
      // The swap was under way: the new exporter was never confirmed, so the old one comes back.
      const base = name(previous).slice(0, -'-previous'.length);
      if (main) await this.o.docker.remove(main.Id);
      await this.o.docker.rename(previous.Id, base);
      await this.o.docker.start(previous.Id);
      rolledBack = true;
      this.o.log.warn('updater: an update was interrupted; the previous exporter is running again');
    }
    if (next) await this.o.docker.remove(next.Id).catch(() => undefined);
    if (job && interrupted) {
      job.phase = rolledBack ? 'rolled-back' : 'failed';
      job.error = 'interrupted (the updater restarted)';
      job.finishedAt = new Date(this.now()).toISOString();
      this.save();
    }
  }
}
