import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RELEASES_FORMAT, type Release, type ReleaseManifest } from '../src/update/schema.js';
import { UpdaterClient } from '../src/update/updater-client.js';
import { checkStatement, githubRepo, seedTrustedRoot, verifyProvenance } from '../src/updater/attest.js';
import type { ContainerInspect, ContainerSummary, DockerApi, ImageInspect } from '../src/updater/docker.js';
import { handle } from '../src/updater/http.js';
import { UpdaterService, type UpdaterOptions } from '../src/updater/service.js';
import { createBody, RolledBackError, swapContainer, type Probe } from '../src/updater/swap.js';

const IMAGE = 'ghcr.io/example/exporter';
const D = (c: string) => `sha256:${c.repeat(64)}`;
const PROJECT = 'ecoflow';
const LABELS = { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'exporter', 'com.docker.compose.config-hash': 'abc' };

/** Just enough of the Docker Engine API, in memory. */
class FakeDocker implements DockerApi {
  containers = new Map<string, ContainerInspect>();
  images = new Map<string, ImageInspect>();
  calls: string[] = [];
  /** version each image's exporter reports, by image ref */
  versions = new Map<string, string>();
  pullFails = false;
  exitOnStart = new Set<string>();
  private n = 0;

  addImage(ref: string, version: string, over: Partial<ImageInspect> = {}): void {
    this.images.set(ref, {
      Id: `img-${ref}`,
      RepoDigests: ref.includes('@') ? [ref] : [],
      Config: { Env: ['PATH=/usr/bin', 'NODE_ENV=production'], Cmd: ['node', 'dist/index.js'], Labels: { 'org.opencontainers.image.source': 'x' } },
      ...over,
    });
    this.versions.set(ref, version);
  }

  addContainer(name: string, image: string): ContainerInspect {
    const id = `c${++this.n}`.padEnd(64, '0');
    const c: ContainerInspect = {
      Id: id,
      Name: `/${name}`,
      Image: image,
      Config: {
        Image: image,
        Env: ['PATH=/usr/bin', 'NODE_ENV=production', 'HEALTH_PORT=9101', 'EXPORTER_RELEASES_URL=https://example.test/releases.json'],
        Cmd: ['node', 'dist/index.js'],
        Labels: { ...LABELS, 'org.opencontainers.image.source': 'x' },
        Healthcheck: { Test: ['CMD', 'wget'] },
      },
      HostConfig: { Mounts: [{ Type: 'volume', Source: 'ecoflow_buffer', Target: '/data' }], PortBindings: { '9101/tcp': [{ HostIp: '127.0.0.1', HostPort: '9101' }] } },
      State: { Running: true, Restarting: false, Status: 'running' },
      NetworkSettings: { Networks: { ecoflow_default: { IPAddress: `10.0.0.${this.n}`, Aliases: ['exporter', id.slice(0, 12)] } } },
    };
    this.containers.set(id, c);
    return c;
  }

  async listContainers(labels: string[]): Promise<ContainerSummary[]> {
    return [...this.containers.values()]
      .filter((c) => labels.every((l) => {
        const [k, v] = l.split('=');
        return c.Config.Labels?.[k ?? ''] === v;
      }))
      .map((c) => ({ Id: c.Id, Names: [c.Name], Image: c.Image, State: c.State.Running ? 'running' : 'exited', Labels: c.Config.Labels ?? {} }));
  }
  async inspectContainer(id: string): Promise<ContainerInspect> {
    const c = this.containers.get(id);
    if (!c) throw new Error(`no container ${id}`);
    return structuredClone(c);
  }
  async inspectImage(ref: string): Promise<ImageInspect | undefined> {
    return this.images.get(ref);
  }
  async pull(repo: string, digest: string): Promise<void> {
    this.calls.push(`pull ${repo}@${digest}`);
    if (this.pullFails) throw new Error('pull failed');
  }
  async create(name: string, body: Record<string, unknown>): Promise<string> {
    this.calls.push(`create ${name}`);
    const image = body.Image as string;
    const c = this.addContainer(name, image);
    c.Config = { ...(body as ContainerInspect['Config']) };
    c.State = { Running: false, Restarting: false, Status: 'created' };
    return c.Id;
  }
  async start(id: string): Promise<void> {
    this.calls.push(`start ${this.containers.get(id)?.Name}`);
    const c = this.containers.get(id)!;
    c.State = this.exitOnStart.has(c.Image) ? { Running: true, Restarting: true, Status: 'restarting', ExitCode: 3 } : { Running: true, Restarting: false, Status: 'running' };
  }
  async stop(id: string): Promise<void> {
    this.calls.push(`stop ${this.containers.get(id)?.Name}`);
    this.containers.get(id)!.State = { Running: false, Restarting: false, Status: 'exited' };
  }
  async rename(id: string, name: string): Promise<void> {
    const c = this.containers.get(id)!;
    if ([...this.containers.values()].some((o) => o.Name === `/${name}`)) throw new Error(`name ${name} in use`);
    this.calls.push(`rename ${c.Name} -> ${name}`);
    c.Name = `/${name}`;
  }
  async remove(id: string): Promise<void> {
    this.calls.push(`remove ${this.containers.get(id)?.Name}`);
    this.containers.delete(id);
  }
  probe = async (c: ContainerInspect): Promise<Probe> => {
    const live = this.containers.get(c.Id);
    if (!live?.State.Running) throw new Error('connection refused');
    return { version: this.versions.get(live.Image) ?? 'unknown', ok: true };
  };
  names(): string[] {
    return [...this.containers.values()].map((c) => `${c.Name.slice(1)}:${c.Image}:${c.State.Running ? 'up' : 'down'}`).sort();
  }
}

const fast = { timeoutMs: 50, stableMs: 0, intervalMs: 1, sleep: async () => undefined };

describe('createBody', () => {
  it('keeps what compose set and drops what the old image set', () => {
    const docker = new FakeDocker();
    docker.addImage('old', '0.1.0');
    const old = docker.addContainer('ecoflow-exporter-1', 'old');
    const body = createBody(old, docker.images.get('old'), `${IMAGE}@${D('b')}`);
    expect(body.Image).toBe(`${IMAGE}@${D('b')}`);
    expect(body.Env).toEqual(['HEALTH_PORT=9101', 'EXPORTER_RELEASES_URL=https://example.test/releases.json']);
    expect(body.Cmd).toBeUndefined(); // the new image's own command
    expect(body.Healthcheck).toEqual({ Test: ['CMD', 'wget'] });
    expect(body.Labels).toEqual(LABELS); // compose labels stay, so compose still owns it
    expect(body.HostConfig).toBe(old.HostConfig);
    expect(body.NetworkingConfig).toEqual({ EndpointsConfig: { ecoflow_default: { Aliases: ['exporter'] } } });
  });
});

describe('swapContainer', () => {
  function setup(newVersion = '0.2.0') {
    const docker = new FakeDocker();
    docker.addImage('old', '0.1.0');
    const ref = `${IMAGE}@${D('b')}`;
    docker.addImage(ref, newVersion);
    const old = docker.addContainer('ecoflow-exporter-1', 'old');
    return { docker, old, ref };
  }

  it('replaces the container and removes the old one', async () => {
    const { docker, old, ref } = setup();
    const phases: string[] = [];
    await swapContainer({ docker, old, image: ref, expectVersion: '0.2.0', requireOk: true, probe: docker.probe, onPhase: (p) => phases.push(p), ...fast });
    expect(docker.names()).toEqual([`ecoflow-exporter-1:${ref}:up`]);
    expect(phases).toEqual(['starting', 'checking']);
    expect(docker.calls.indexOf('stop /ecoflow-exporter-1')).toBeLessThan(docker.calls.indexOf('start /ecoflow-exporter-1'));
  });

  it('rolls back when the new one reports another version', async () => {
    const { docker, old, ref } = setup('0.1.9');
    await expect(swapContainer({ docker, old, image: ref, expectVersion: '0.2.0', requireOk: false, probe: docker.probe, ...fast })).rejects.toThrow(/reports version 0.1.9/);
    expect(docker.names()).toEqual(['ecoflow-exporter-1:old:up']);
  });

  it('rolls back when the new one exits', async () => {
    const { docker, old, ref } = setup();
    docker.exitOnStart.add(ref);
    const err = await swapContainer({ docker, old, image: ref, expectVersion: '0.2.0', requireOk: false, probe: docker.probe, ...fast }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RolledBackError);
    expect((err as RolledBackError).restored).toBe(true);
    expect((err as Error).message).toMatch(/keeps restarting, exit code 3/);
    expect(docker.names()).toEqual(['ecoflow-exporter-1:old:up']);
  });

  it('requires data from the station when the old one had it', async () => {
    const { docker, old, ref } = setup();
    const probe = async (c: ContainerInspect) => ({ ...(await docker.probe(c)), ok: c.Image === 'old' });
    await expect(swapContainer({ docker, old, image: ref, expectVersion: '0.2.0', requireOk: true, probe, ...fast })).rejects.toThrow(/no data/);
    expect(docker.names()).toEqual(['ecoflow-exporter-1:old:up']);
  });
});

describe('UpdaterService', () => {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rel = (version: string, digestChar: string, over: Partial<Release> = {}): Release => ({
    version,
    digest: D(digestChar),
    channel: 'stable',
    published_at: '2026-11-22T00:00:00.000Z',
    min_db_migration: '20261122172000',
    notes: '',
    revoked: false,
    ...over,
  });

  function setup(releases: Release[], over: Partial<UpdaterOptions> = {}) {
    const m: ReleaseManifest = {
      format: RELEASES_FORMAT,
      sequence: 5,
      published_at: '2026-11-22T00:00:00.000Z',
      expires_at: new Date(Date.now() + 86400_000).toISOString(),
      image: IMAGE,
      releases,
    };
    const body = Buffer.from(JSON.stringify(m));
    const files: Record<string, Buffer | string> = { 'releases.json': body, 'releases.json.sig': sign(null, body, privateKey).toString('base64') };
    const fetchFn = (async (url: string | URL) => {
      const f = files[String(url).split('/').pop() ?? ''];
      return f === undefined ? new Response('', { status: 404 }) : new Response(f);
    }) as typeof fetch;
    const docker = new FakeDocker();
    docker.addImage('old', '0.1.0');
    for (const r of releases) docker.addImage(`${IMAGE}@${r.digest}`, r.version);
    docker.addContainer('ecoflow-exporter-1', 'old');
    const provenance = vi.fn(async () => undefined);
    const svc = new UpdaterService({
      docker,
      settings: () => ({ releasesUrl: 'https://example.test/releases.json', channel: 'stable', keys: [publicKey] }),
      project: PROJECT,
      service: 'exporter',
      stateFile: join(mkdtempSync(join(tmpdir(), 'updater-')), 'updater.json'),
      probe: docker.probe,
      verifyProvenance: provenance,
      log,
      fetch: fetchFn,
      swapTimings: fast,
      ...over,
    });
    return { svc, docker, provenance };
  }

  it('installs the requested version from the signed list', async () => {
    const { svc, docker, provenance } = setup([rel('0.2.0', 'b'), rel('0.1.0', 'a')]);
    svc.request('0.2.0');
    await svc.wait();
    const s = await svc.status();
    expect(s.job).toMatchObject({ version: '0.2.0', from: '0.1.0', phase: 'done' });
    expect(s.current).toBe('0.2.0');
    expect(provenance).toHaveBeenCalledWith(IMAGE, D('b'), '0.2.0');
    expect(docker.calls).toContain(`pull ${IMAGE}@${D('b')}`);
    expect(docker.names()).toEqual([`ecoflow-exporter-1:${IMAGE}@${D('b')}:up`]);
  });

  it.each([
    ['0.3.0', /not in the signed release list/],
    ['0.0.9', /not newer/],
    ['0.2.1', /revoked/],
    ['0.2.2', /not on the stable channel/],
  ])('refuses %s', async (version, error) => {
    const { svc, docker } = setup([rel('0.2.0', 'b'), rel('0.0.9', 'c'), rel('0.2.1', 'd', { revoked: true }), rel('0.2.2', 'e', { channel: 'beta' })]);
    svc.request(version);
    await svc.wait();
    const s = await svc.status();
    expect(s.job?.phase).toBe('failed');
    expect(s.job?.error).toMatch(error);
    expect(docker.names()).toEqual(['ecoflow-exporter-1:old:up']);
  });

  it('starts nothing when the provenance check fails', async () => {
    const { svc, docker } = setup([rel('0.2.0', 'b')], { verifyProvenance: async () => Promise.reject(new Error('build provenance: built from refs/heads/x')) });
    svc.request('0.2.0');
    await svc.wait();
    expect((await svc.status()).job).toMatchObject({ phase: 'failed', error: expect.stringMatching(/provenance/) });
    expect(docker.calls.filter((c) => c.startsWith('pull') || c.startsWith('create'))).toEqual([]);
  });

  it('refuses a pulled image that is not the digest', async () => {
    const { svc, docker } = setup([rel('0.2.0', 'b')]);
    docker.images.get(`${IMAGE}@${D('b')}`)!.RepoDigests = [`${IMAGE}@${D('f')}`];
    svc.request('0.2.0');
    await svc.wait();
    expect((await svc.status()).job?.error).toMatch(/does not match/);
  });

  it('runs one update at a time', async () => {
    const { svc } = setup([rel('0.2.0', 'b')]);
    svc.request('0.2.0');
    expect(() => svc.request('0.2.0')).toThrow(/already running/);
    await svc.wait();
  });

  it('auto mode installs the newest stable release only', async () => {
    const { svc } = setup([rel('0.3.0', 'c', { channel: 'beta' }), rel('0.2.0', 'b')]);
    await svc.tick();
    expect((await svc.status()).job).toBeUndefined(); // off by default
    svc.setAuto(true);
    await svc.tick();
    await svc.wait();
    expect((await svc.status()).job).toMatchObject({ version: '0.2.0', phase: 'done', auto: true });
  });

  it('puts the installed version back after compose recreated an older one', async () => {
    const { svc, docker } = setup([rel('0.2.0', 'b')]);
    svc.request('0.2.0');
    await svc.wait();
    // `docker compose up` with the old image
    for (const c of docker.containers.values()) docker.containers.delete(c.Id);
    docker.addContainer('ecoflow-exporter-1', 'old');
    await svc.tick();
    await svc.wait();
    expect(docker.names()).toEqual([`ecoflow-exporter-1:${IMAGE}@${D('b')}:up`]);
  });

  it('recovers from an update interrupted mid-swap', async () => {
    const { svc, docker } = setup([rel('0.2.0', 'b')]);
    const old = [...docker.containers.values()][0]!;
    await docker.stop(old.Id);
    await docker.rename(old.Id, 'ecoflow-exporter-1-previous');
    const next = await docker.create('ecoflow-exporter-1-update', { Image: `${IMAGE}@${D('b')}`, Labels: LABELS });
    await docker.rename(next, 'ecoflow-exporter-1');
    await svc.recover();
    expect(docker.names()).toEqual(['ecoflow-exporter-1:old:up']);
  });
});

describe('build provenance', () => {
  const fixture = readFileSync(new URL('./fixtures/attestation/v0.1.1.json', import.meta.url), 'utf8');
  const digest = 'sha256:2a18e83d9c649cd3b83b0aed008848ec1c5473d04511e0038cc7cbf7b505db6a';
  const image = 'ghcr.io/energy-monitor-hub/exporter';
  const api = (async () => new Response(fixture)) as unknown as typeof fetch;
  const trustedRoot = async () => seedTrustedRoot();

  it('maps the image to its repository', () => {
    expect(githubRepo(image)).toBe('energy-monitor-hub/exporter');
    expect(() => githubRepo('docker.io/library/node')).toThrow(/ghcr.io/);
  });

  it('accepts the real v0.1.1 attestation', async () => {
    await expect(verifyProvenance({ image, digest, version: '0.1.1', trustedRoot, fetch: api })).resolves.toBeUndefined();
  });

  it('rejects it for another version, digest or repository', async () => {
    await expect(verifyProvenance({ image, digest, version: '0.1.2', trustedRoot, fetch: api })).rejects.toThrow(/v0.1.2 tag/);
    await expect(verifyProvenance({ image, digest: D('b'), version: '0.1.1', trustedRoot, fetch: api })).rejects.toThrow(/another image digest/);
    await expect(verifyProvenance({ image: 'ghcr.io/someone/exporter', digest, version: '0.1.1', trustedRoot, fetch: api })).rejects.toThrow(/built from https:\/\/github.com\/energy-monitor-hub/);
  });

  it('rejects a statement whose signature does not cover it', async () => {
    const tampered = JSON.parse(fixture) as { attestations: { bundle: { dsseEnvelope: { payload: string } } }[] };
    const env = tampered.attestations[0]!.bundle.dsseEnvelope;
    const st = JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')) as { subject: { digest: { sha256: string } }[] };
    st.subject[0]!.digest.sha256 = 'b'.repeat(64);
    env.payload = Buffer.from(JSON.stringify(st)).toString('base64');
    const fetchFn = (async () => new Response(JSON.stringify(tampered))) as unknown as typeof fetch;
    await expect(verifyProvenance({ image, digest: D('b'), version: '0.1.1', trustedRoot, fetch: fetchFn })).rejects.toThrow(/payload hash mismatch|signature/i);
  });

  it('checks the statement fields', () => {
    const st = {
      predicateType: 'https://slsa.dev/provenance/v1',
      subject: [{ digest: { sha256: 'a'.repeat(64) } }],
      predicate: { buildDefinition: { externalParameters: { workflow: { repository: 'https://github.com/o/r', path: '.github/workflows/other.yml', ref: 'refs/tags/v1.0.0' } } } },
    };
    expect(() => checkStatement(st, 'o/r', D('a'), '1.0.0')).toThrow(/other.yml/);
  });
});

describe('updater HTTP API', () => {
  let server: Server;
  let base: string;
  let allowed: string[] = [];
  const svc = {
    exporterAddresses: async () => allowed,
    status: async () => ({ available: true }),
    request: vi.fn((v: string) => {
      if (v === '9.9.9') throw new Error('busy');
    }),
    setAuto: vi.fn(),
  };

  beforeAll(async () => {
    server = createServer((req, res) => void handle(svc as unknown as UpdaterService, req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => new Promise((r) => server.close(r)));

  it('answers only the exporter container', async () => {
    allowed = ['10.0.0.9'];
    expect((await fetch(`${base}/status`)).status).toBe(403);
    allowed = ['127.0.0.1'];
    expect(await (await fetch(`${base}/status`)).json()).toEqual({ available: true });
  });

  it('takes a version and the auto switch, nothing else', async () => {
    allowed = ['127.0.0.1'];
    const client = new UpdaterClient({ url: base });
    await client.request('0.2.0');
    expect(svc.request).toHaveBeenCalledWith('0.2.0');
    await expect(client.request('9.9.9')).rejects.toThrow('busy');
    await client.setAuto(true);
    expect(svc.setAuto).toHaveBeenCalledWith(true);
    expect((await fetch(`${base}/auto`, { method: 'POST', body: '{"enabled":"yes"}' })).status).toBe(400);
  });

  it('the exporter reports an unreachable updater as unavailable', async () => {
    const client = new UpdaterClient({ url: 'http://127.0.0.1:1' });
    expect(await client.status()).toMatchObject({ available: false });
  });
});
