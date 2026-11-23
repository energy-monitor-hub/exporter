/** Where the time comes from; injectable for tests. */
export interface Clocks {
  /** Wall clock, ms since the epoch. */
  wall(): number;
  /** Monotonic clock, ms; stops while the host is suspended (macOS and Linux). */
  mono(): number;
}

export interface SuspendSpan {
  from: number;
  to: number;
}

/** Answers how long the host was suspended in a stretch of wall-clock time. */
export interface SuspendLog {
  sleptWithin(fromMs: number, toMs: number): number;
}

const realClocks: Clocks = { wall: () => Date.now(), mono: () => performance.now() };
const KEEP_MS = 7 * 24 * 3600_000;
const MAX_SPANS = 500;

/**
 * Notices when the host was asleep (a laptop lid, system sleep): the process is frozen, so
 * its timers fire late and the wall clock jumps ahead of the monotonic one. `tick()` runs
 * every few seconds; a tick that comes `slackMs` later than it should marks the missing time
 * as suspended. A long synchronous stall would look the same, but this process has none that
 * long.
 */
export class SuspendDetector implements SuspendLog {
  private readonly spans: SuspendSpan[] = [];
  private lastWall: number;
  private lastMono: number;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: { tickMs?: number; slackMs?: number; clocks?: Clocks } = {},
  ) {
    const c = this.clocks;
    this.lastWall = c.wall();
    this.lastMono = c.mono();
  }

  private get clocks(): Clocks {
    return this.opts.clocks ?? realClocks;
  }

  private get tickMs(): number {
    return this.opts.tickMs ?? 5_000;
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    const c = this.clocks;
    const wall = c.wall();
    const mono = c.mono();
    const wallDelta = wall - this.lastWall;
    // While suspended the monotonic clock stands still; where it does not (some VMs), the
    // timer itself fires late. Either way the wall clock ran ahead of what the process lived.
    const lived = Math.min(mono - this.lastMono, this.tickMs);
    const lost = wallDelta - lived;
    this.lastWall = wall;
    this.lastMono = mono;
    if (lost > (this.opts.slackMs ?? 20_000)) this.add({ from: wall - lost, to: wall });
  }

  get recent(): readonly SuspendSpan[] {
    return this.spans;
  }

  sleptWithin(fromMs: number, toMs: number): number {
    let ms = 0;
    for (const s of this.spans) ms += Math.max(0, Math.min(toMs, s.to) - Math.max(fromMs, s.from));
    return ms;
  }

  private add(span: SuspendSpan): void {
    this.spans.push(span);
    const cutoff = span.to - KEEP_MS;
    while (this.spans.length > MAX_SPANS || (this.spans[0] && this.spans[0].to < cutoff)) this.spans.shift();
  }
}
