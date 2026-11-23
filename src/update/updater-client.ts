/**
 * The exporter's side of the updater (src/updater/): it asks, the updater decides. Only a
 * version number goes over (never an image or digest); the updater installs it only if the
 * signed release list has it. UPDATER_URL is set by compose (`http://updater:9103`).
 */
export interface UpdaterClientOptions {
  url: string;
  fetch?: typeof fetch;
}

export class UpdaterClient {
  constructor(private readonly o: UpdaterClientOptions) {
    if (!/^https?:\/\//.test(o.url)) throw new Error(`Invalid UPDATER_URL: ${o.url}`);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const res = await (this.o.fetch ?? fetch)(`${this.o.url.replace(/\/+$/, '')}${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `updater: HTTP ${res.status}`);
    return data;
  }

  /** The updater's state for the status page; `{ available: false, error }` when it does not answer. */
  async status(): Promise<unknown> {
    try {
      return await this.call('GET', '/status');
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  }

  async request(version: string): Promise<void> {
    await this.call('POST', '/update', { version });
  }

  async setAuto(enabled: boolean): Promise<void> {
    await this.call('POST', '/auto', { enabled });
  }
}
