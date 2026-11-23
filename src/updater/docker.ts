import { request } from 'node:http';

/**
 * The few Docker Engine API calls the updater needs, over the Unix socket, with no client
 * library. Only the updater container has the socket; the exporter never does.
 */

export class DockerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The parts of `GET /containers/{id}/json` the updater reads (the rest is passed through). */
export interface ContainerInspect {
  Id: string;
  Name: string;
  Image: string;
  Config: ContainerConfig;
  HostConfig: Record<string, unknown>;
  State: { Running: boolean; Restarting: boolean; Status: string; ExitCode?: number; StartedAt?: string };
  RestartCount?: number;
  NetworkSettings: { Networks?: Record<string, EndpointSettings> };
}

export interface ContainerConfig {
  Image?: string;
  Env?: string[] | null;
  Cmd?: string[] | null;
  Entrypoint?: string[] | null;
  WorkingDir?: string;
  User?: string;
  Labels?: Record<string, string> | null;
  Healthcheck?: unknown;
  StopSignal?: string;
  [key: string]: unknown;
}

export interface EndpointSettings {
  IPAddress?: string;
  GlobalIPv6Address?: string;
  Aliases?: string[] | null;
  DNSNames?: string[] | null;
  IPAMConfig?: unknown;
  [key: string]: unknown;
}

export interface ImageInspect {
  Id: string;
  RepoDigests?: string[] | null;
  Config?: ContainerConfig | null;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Labels: Record<string, string>;
}

export interface DockerApi {
  listContainers(labels: string[]): Promise<ContainerSummary[]>;
  inspectContainer(id: string): Promise<ContainerInspect>;
  /** undefined when the image is not on this machine */
  inspectImage(ref: string): Promise<ImageInspect | undefined>;
  /** Pulls `repo@sha256:...` (the daemon picks this machine's platform from the index). */
  pull(repo: string, digest: string): Promise<void>;
  create(name: string, body: Record<string, unknown>): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutS: number): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
}

const MAX_RESPONSE = 8 * 1024 * 1024;

export class DockerClient implements DockerApi {
  constructor(private readonly socketPath = '/var/run/docker.sock') {}

  private call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: { Host: 'docker', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE) req.destroy(new Error(`docker ${method} ${path}: response too large`));
            else chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path}: timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  private async json<T>(method: string, path: string, body?: unknown, ok: number[] = [200, 201, 204], timeoutMs?: number): Promise<T> {
    const r = await this.call(method, path, body, timeoutMs);
    if (!ok.includes(r.status)) {
      let msg = r.text.trim();
      try {
        msg = (JSON.parse(r.text) as { message?: string }).message ?? msg;
      } catch {
        // plain text error
      }
      throw new DockerError(`docker ${method} ${path.split('?')[0]}: ${r.status} ${msg}`, r.status);
    }
    return (r.text ? JSON.parse(r.text) : undefined) as T;
  }

  listContainers(labels: string[]): Promise<ContainerSummary[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: labels }));
    return this.json('GET', `/containers/json?all=true&filters=${filters}`);
  }

  inspectContainer(id: string): Promise<ContainerInspect> {
    return this.json('GET', `/containers/${encodeURIComponent(id)}/json`);
  }

  async inspectImage(ref: string): Promise<ImageInspect | undefined> {
    try {
      return await this.json<ImageInspect>('GET', `/images/${encodeURIComponent(ref)}/json`);
    } catch (err) {
      if (err instanceof DockerError && err.status === 404) return undefined;
      throw err;
    }
  }

  async pull(repo: string, digest: string): Promise<void> {
    const q = new URLSearchParams({ fromImage: repo, tag: digest });
    const r = await this.call('POST', `/images/create?${q.toString()}`, undefined, 15 * 60_000);
    if (r.status !== 200) throw new DockerError(`docker pull ${repo}@${digest}: ${r.status} ${r.text.trim().slice(0, 300)}`, r.status);
    // The progress stream answers 200 and reports failures as {"error": ...} lines.
    for (const line of r.text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { error?: string };
        if (msg.error) throw new DockerError(`docker pull ${repo}@${digest}: ${msg.error}`, 500);
      } catch (err) {
        if (err instanceof DockerError) throw err;
      }
    }
  }

  async create(name: string, body: Record<string, unknown>): Promise<string> {
    const r = await this.json<{ Id: string }>('POST', `/containers/create?name=${encodeURIComponent(name)}`, body);
    return r.Id;
  }

  async start(id: string): Promise<void> {
    await this.json('POST', `/containers/${encodeURIComponent(id)}/start`, undefined, [204, 304]);
  }

  async stop(id: string, timeoutS: number): Promise<void> {
    await this.json('POST', `/containers/${encodeURIComponent(id)}/stop?t=${timeoutS}`, undefined, [204, 304], (timeoutS + 30) * 1000);
  }

  async rename(id: string, name: string): Promise<void> {
    await this.json('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`, undefined, [204]);
  }

  async remove(id: string): Promise<void> {
    await this.json('DELETE', `/containers/${encodeURIComponent(id)}?force=true`, undefined, [204, 404]);
  }
}
