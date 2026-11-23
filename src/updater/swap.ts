import type { ContainerInspect, DockerApi, ImageInspect } from './docker.js';

/**
 * Replaces the exporter container with one running another image, keeping everything else
 * (volumes, ports, networks, env, restart policy, compose labels), checks that the new one
 * comes up, and puts the old one back if it does not.
 */

export interface Probe {
  /** Version from the exporter's /healthz (src/index.ts). */
  version?: string;
  /** /healthz `ok`: data arrives from the station. */
  ok?: boolean;
}

export type SwapPhase = 'starting' | 'checking' | 'rolling-back';

export interface SwapOptions {
  docker: DockerApi;
  old: ContainerInspect;
  /** `repo@sha256:...`, already pulled and checked. */
  image: string;
  expectVersion: string;
  /** Require /healthz ok=true (the old exporter was getting data, so the new one must too). */
  requireOk: boolean;
  probe: (c: ContainerInspect) => Promise<Probe>;
  onPhase?: (p: SwapPhase) => void;
  /** Give up and roll back after this long (default 4 min). */
  timeoutMs?: number;
  /** The new container must stay up and healthy this long (default 20 s). */
  stableMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class RolledBackError extends Error {
  constructor(
    message: string,
    /** false when even the rollback failed: the exporter may be stopped. */
    readonly restored: boolean,
  ) {
    super(message);
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The create body for the new container. Values the old container only had because its image
 * set them (env, cmd, labels, healthcheck) are left out, so the new image's own defaults apply;
 * everything set by compose (or `docker run`) is kept. Host config is copied as is.
 */
export function createBody(old: ContainerInspect, oldImage: ImageInspect | undefined, image: string): Record<string, unknown> {
  const c = old.Config;
  const ic = oldImage?.Config ?? {};
  const config: Record<string, unknown> = { Image: image };
  for (const k of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck', 'StopSignal'] as const) {
    if (c[k] !== undefined && c[k] !== null && c[k] !== '' && !same(c[k], ic[k])) config[k] = c[k];
  }
  const imageEnv = new Set(ic.Env ?? []);
  config.Env = (c.Env ?? []).filter((e) => !imageEnv.has(e));
  const imageLabels = ic.Labels ?? {};
  config.Labels = Object.fromEntries(Object.entries(c.Labels ?? {}).filter(([k, v]) => imageLabels[k] !== v));
  for (const k of ['ExposedPorts', 'Tty', 'OpenStdin', 'StdinOnce', 'AttachStdin', 'AttachStdout', 'AttachStderr']) {
    if (c[k] !== undefined && c[k] !== null) config[k] = c[k];
  }
  const shortId = old.Id.slice(0, 12);
  const endpoints = Object.fromEntries(
    Object.entries(old.NetworkSettings.Networks ?? {}).map(([net, e]) => [
      net,
      {
        Aliases: (e.Aliases ?? []).filter((a) => a !== shortId && !old.Id.startsWith(a)),
        ...(e.IPAMConfig ? { IPAMConfig: e.IPAMConfig } : {}),
      },
    ]),
  );
  return { ...config, HostConfig: old.HostConfig, NetworkingConfig: { EndpointsConfig: endpoints } };
}

export async function swapContainer(o: SwapOptions): Promise<void> {
  const { docker, old } = o;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const name = old.Name.replace(/^\//, '');
  const oldImage = await docker.inspectImage(old.Image);

  o.onPhase?.('starting');
  const id = await docker.create(`${name}-update`, createBody(old, oldImage, o.image));
  let oldStopped = false;
  let oldRenamed = false;
  try {
    await docker.stop(old.Id, 30);
    oldStopped = true;
    await docker.rename(old.Id, `${name}-previous`);
    oldRenamed = true;
    await docker.rename(id, name);
    await docker.start(id);
    o.onPhase?.('checking');
    await waitHealthy(o, id, sleep, now);
  } catch (err) {
    o.onPhase?.('rolling-back');
    const reason = (err as Error).message;
    try {
      await docker.remove(id);
      if (oldRenamed) await docker.rename(old.Id, name);
      if (oldStopped) await docker.start(old.Id);
    } catch (rbErr) {
      throw new RolledBackError(`${reason}; rollback failed: ${(rbErr as Error).message}`, false);
    }
    throw new RolledBackError(reason, true);
  }
  // The old container is no longer needed; its image stays until Docker prunes it.
  await docker.remove(old.Id).catch(() => undefined);
}

async function waitHealthy(o: SwapOptions, id: string, sleep: (ms: number) => Promise<void>, now: () => number): Promise<void> {
  const deadline = now() + (o.timeoutMs ?? 4 * 60_000);
  const stableMs = o.stableMs ?? 20_000;
  let goodSince: number | undefined;
  let lastProblem = 'the new exporter did not answer';
  for (;;) {
    const c = await o.docker.inspectContainer(id);
    const exit = c.State.ExitCode ? `, exit code ${c.State.ExitCode}` : '';
    // A crash under `restart: unless-stopped` shows as Running + Restarting, or a restart count.
    if (c.State.Restarting || (c.RestartCount ?? 0) > 0) throw new Error(`the new exporter keeps restarting${exit}`);
    if (!c.State.Running) throw new Error(`the new exporter stopped (${c.State.Status}${exit})`);
    let good = false;
    try {
      const p = await o.probe(c);
      if (p.version !== o.expectVersion) lastProblem = `the new exporter reports version ${p.version ?? 'none'}, expected ${o.expectVersion}`;
      else if (o.requireOk && p.ok !== true) lastProblem = 'the new exporter gets no data from the station';
      else good = true;
    } catch (err) {
      lastProblem = `the new exporter did not answer (${(err as Error).message})`;
    }
    const t = now();
    if (!good) goodSince = undefined;
    else goodSince ??= t;
    if (goodSince !== undefined && t - goodSince >= stableMs) return;
    if (t >= deadline) throw new Error(lastProblem);
    await sleep(o.intervalMs ?? 3000);
  }
}
