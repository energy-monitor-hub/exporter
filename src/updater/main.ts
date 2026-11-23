import { hostname } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { loadConfig } from '../config.js';
import { DEFAULT_DASHBOARD_URL } from '../destinations.js';
import { publicKeys } from '../packs/verify.js';
import { exporterVersion } from '../selfcheck.js';
import { sigstoreTrustedRoot, verifyProvenance } from './attest.js';
import { DockerClient, type ContainerInspect } from './docker.js';
import { handle, send } from './http.js';
import { UpdaterService, type UpdateSettings } from './service.js';
import type { Probe } from './swap.js';

/**
 * The updater (issue #44): a separate container next to the exporter, the only one with the
 * Docker socket. It installs an exporter release when the status page asks for it (or by itself
 * in auto mode, stable only): a digest from the signed release list, its build provenance
 * checked, then it recreates the exporter container and rolls back if the new one does not come
 * up. It has no published port; it answers only the exporter container (docs/UPDATES.md).
 */

const log = console;
const env = process.env;

/**
 * Release URL, channel and extra keys come from the exporter container's environment (the
 * user's .env, applied by compose), so the updater needs no copy of .env and its secrets.
 * The exporter process cannot change its own container's environment.
 */
function settingsFrom(c: ContainerInspect | undefined): UpdateSettings {
  const vars: NodeJS.ProcessEnv = {};
  for (const e of c?.Config.Env ?? []) {
    const i = e.indexOf('=');
    if (i > 0) vars[e.slice(0, i)] = e.slice(i + 1);
  }
  try {
    const config = loadConfig(vars);
    return { releasesUrl: config.exporterReleasesUrl, channel: config.exporterChannel, keys: publicKeys(config.decoderPublicKeys) };
  } catch (err) {
    if (c) log.warn(`updater: the exporter's settings are invalid (${(err as Error).message}); using the defaults`);
    return { releasesUrl: vars.EXPORTER_RELEASES_URL || `${DEFAULT_DASHBOARD_URL}/releases/releases.json`, channel: 'stable', keys: publicKeys() };
  }
}
const stateDir = env.UPDATER_STATE_DIR || '/state';
const port = Number(env.UPDATER_PORT || 9103);
const exporterPort = Number(env.UPDATER_EXPORTER_PORT || 9101);
const attestation = (env.UPDATER_ATTESTATION || 'require') as 'require' | 'off';
if (attestation !== 'require' && attestation !== 'off') throw new Error(`Invalid UPDATER_ATTESTATION: ${String(attestation)} (require | off)`);

const docker = new DockerClient(env.DOCKER_SOCKET || '/var/run/docker.sock');

/** GET http://<container ip>:<port>/healthz on the compose network (503 still carries the body). */
function probe(c: ContainerInspect): Promise<Probe> {
  const ip = Object.values(c.NetworkSettings.Networks ?? {}).find((n) => n.IPAddress)?.IPAddress;
  if (!ip) return Promise.reject(new Error('no IP address yet'));
  return new Promise((resolve, reject) => {
    const req = request({ host: ip, port: exporterPort, path: '/healthz', timeout: 5000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => {
        body += d;
        if (body.length > 64 * 1024) req.destroy(new Error('response too large'));
      });
      res.on('end', () => {
        try {
          const j = JSON.parse(body) as { version?: unknown; ok?: unknown };
          resolve({ ...(typeof j.version === 'string' ? { version: j.version } : {}), ...(typeof j.ok === 'boolean' ? { ok: j.ok } : {}) });
        } catch {
          reject(new Error(`HTTP ${res.statusCode ?? 0}`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  // Our own container tells which compose project to look in.
  const self = await docker.inspectContainer(env.UPDATER_CONTAINER || hostname());
  const project = self.Config.Labels?.['com.docker.compose.project'];
  if (!project) throw new Error('the updater must run as a docker compose service (no com.docker.compose.project label)');

  const trustedRoot = sigstoreTrustedRoot(join(stateDir, 'sigstore'), log);
  const updater = new UpdaterService({
    docker,
    settings: (c) => settingsFrom(c),
    project,
    service: env.UPDATER_SERVICE || 'exporter',
    stateFile: join(stateDir, 'updater.json'),
    probe,
    verifyProvenance:
      attestation === 'off' ? undefined : (image, digest, version) => verifyProvenance({ image, digest, version, trustedRoot }),
    log,
  });
  await updater.recover();
  await updater.exporterContainer().catch(() => undefined); // reads its settings for the log below

  const server = createServer((req, res) => {
    handle(updater, req, res).catch((err: unknown) => send(res, 500, { error: (err as Error).message }));
  });
  server.listen(port, '0.0.0.0', () => log.info(`updater ${exporterVersion()}: project ${project}, waiting for requests from the exporter on :${port}`));
  if (!updater.configured) log.warn('updater: no release list or trusted key; nothing to install');
  if (attestation === 'off') log.warn('updater: build provenance check is off (UPDATER_ATTESTATION=off)');

  setTimeout(() => void updater.tick(), 2 * 60_000).unref();
  setInterval(() => void updater.tick(), 6 * 3600_000).unref();
  const stop = () => {
    server.close();
    void updater.wait().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err: unknown) => {
  log.error(`updater: ${(err as Error).message}`);
  process.exit(1);
});
