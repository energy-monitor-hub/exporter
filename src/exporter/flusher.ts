import { backoffDelay } from '../mqtt/backoff.js';
import type { Logger } from '../mqtt/client.js';
import type { Outbox } from './outbox.js';
import type { Sink } from './sink.js';

export interface FlusherStatus {
  pending: number;
  lastOkAt: string | undefined;
  lastError: string | undefined;
}

/** Drains the outbox into the sink in order; on failure waits with backoff and retries. */
export class Flusher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;
  private failures = 0;
  private lastOkAt: Date | undefined;
  private lastError: string | undefined;

  constructor(
    private readonly outbox: Outbox,
    private readonly sink: Sink,
    private readonly log: Logger,
    private readonly opts: { intervalMs: number; batch?: number } = { intervalMs: 10_000 },
  ) {}

  start(): void {
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // One last attempt so a clean shutdown does not leave the latest samples behind.
    await this.flush().catch(() => undefined);
  }

  get status(): FlusherStatus {
    return { pending: this.outbox.size, lastOkAt: this.lastOkAt?.toISOString(), lastError: this.lastError };
  }

  /** Send everything pending. Resolves to true if the outbox is empty afterwards. */
  async flush(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      for (;;) {
        const batch = this.outbox.peek(this.opts.batch ?? 500);
        if (batch.length === 0) return true;
        await this.sink.send(batch.map((b) => b.op));
        this.outbox.remove(batch.map((b) => b.id));
        this.lastOkAt = new Date();
        if (this.failures > 0) this.log.info(`db: back online, ${this.outbox.size} rows still queued`);
        this.failures = 0;
        this.lastError = undefined;
      }
    } finally {
      this.running = false;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      await this.flush();
      this.schedule(this.opts.intervalMs);
    } catch (err) {
      this.lastError = (err as Error).message;
      const delay = Math.max(this.opts.intervalMs, backoffDelay(this.failures++, 5_000, 5 * 60_000));
      this.log.warn(`db: write failed (${this.lastError}); ${this.outbox.size} rows queued, retry in ${Math.round(delay / 1000)}s`);
      this.schedule(delay);
    }
  }
}
