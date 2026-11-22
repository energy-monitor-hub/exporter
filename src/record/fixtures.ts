import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodePayload } from '../decode/envelope.js';
import { peekHeaders, type HeaderInfo } from '../mqtt/header.js';
import type { EcoflowMessage } from '../mqtt/client.js';
import type { TopicKind } from '../mqtt/topics.js';
import { Scrubber, xorKeysOf } from './scrub.js';

export interface FixtureEntry {
  file: string;
  receivedAt: string;
  /** Topic with SN and userId replaced by placeholders. */
  topic: string;
  kind: TopicKind;
  bytes: number;
  /** `protobuf` if the payload parsed as a HeaderMessage, else `raw` (JSON or unknown). */
  format: 'protobuf' | 'raw';
  headers: Omit<HeaderInfo, 'deviceSn' | 'moduleSn'>[];
}

export interface FixtureIndex {
  version: 1;
  session: string;
  startedAt: string;
  endedAt?: string;
  /** Placeholders that replaced SN / userId / module serials in files and topics. */
  placeholders: string[];
  counts: Record<string, number>;
  messages: FixtureEntry[];
}

/** `2026-11-21T14:03:05.123Z` -> `20261121T140305123Z`, safe in file names. */
export function compactTime(d: Date): string {
  return d.toISOString().replace(/[-:.]/g, '');
}

export function fixtureFileName(n: number, at: Date, headers: HeaderInfo[] | null): string {
  const first = headers?.[0];
  const tag = !headers ? 'raw' : headers.length > 1 ? `${first?.cmdFunc}-${first?.cmdId}-x${headers.length}` : `${first?.cmdFunc}-${first?.cmdId}`;
  return `${String(n).padStart(5, '0')}-${compactTime(at)}-${tag}.bin`;
}

/**
 * Writes each message as a scrubbed `.bin` plus a running `index.json` (rewritten atomically,
 * so Ctrl+C never leaves a broken index).
 */
export class FixtureWriter {
  readonly dir: string;
  private readonly index: FixtureIndex;
  private readonly scrubber: Scrubber;
  private queue: Promise<void> = Promise.resolve();
  private initialised = false;

  constructor(rootDir: string, scrubber: Scrubber, startedAt = new Date()) {
    const session = compactTime(startedAt);
    this.dir = join(rootDir, session);
    this.scrubber = scrubber;
    this.index = {
      version: 1,
      session,
      startedAt: startedAt.toISOString(),
      placeholders: [],
      counts: {},
      messages: [],
    };
  }

  get count(): number {
    return this.index.messages.length;
  }

  get counts(): Readonly<Record<string, number>> {
    return this.index.counts;
  }

  /** Creates the session folder. Called lazily on the first message, so a failed login leaves nothing behind. */
  async init(): Promise<void> {
    if (this.initialised) return;
    await mkdir(this.dir, { recursive: true });
    this.initialised = true;
    await this.writeIndex();
  }

  /** Serialised so files and index stay in order even if messages arrive in bursts. */
  add(msg: EcoflowMessage): Promise<FixtureEntry> {
    const run = this.queue.then(() => this.write(msg));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Finish the session: re-scrub every file with all serials learned along the way
   * (a module serial seen late may already be in earlier files), then write the final index.
   */
  async close(endedAt = new Date()): Promise<void> {
    await this.queue;
    if (!this.initialised) return;
    for (const m of this.index.messages) {
      const path = join(this.dir, m.file);
      const raw = await readFile(path);
      const { bytes, replaced } = this.scrubber.scrubBytes(raw, xorKeysOf(peekHeaders(raw)));
      if (replaced > 0) await writeFile(path, bytes);
    }
    this.index.endedAt = endedAt.toISOString();
    await this.writeIndex();
  }

  private async write(msg: EcoflowMessage): Promise<FixtureEntry> {
    await this.init();
    const headers = peekHeaders(msg.payload);
    if (headers) {
      this.scrubber.learnFromHeaders(headers);
      this.scrubber.learnFromDecoded(decodePayload(msg.payload));
    }
    const { bytes } = this.scrubber.scrubBytes(msg.payload, xorKeysOf(headers));
    const file = fixtureFileName(this.index.messages.length + 1, msg.receivedAt, headers);
    await writeFile(join(this.dir, file), bytes);

    const entry: FixtureEntry = {
      file,
      receivedAt: msg.receivedAt.toISOString(),
      topic: this.scrubber.scrubText(msg.topic),
      kind: msg.kind,
      bytes: bytes.length,
      format: headers ? 'protobuf' : 'raw',
      headers: (headers ?? []).map(({ deviceSn: _d, moduleSn: _m, ...rest }) => rest),
    };
    this.index.messages.push(entry);
    for (const h of headers ?? [{ cmdFunc: 'raw', cmdId: '' }]) {
      const key = h.cmdId === '' ? 'raw' : `${h.cmdFunc}/${h.cmdId}`;
      this.index.counts[key] = (this.index.counts[key] ?? 0) + 1;
    }
    await this.writeIndex();
    return entry;
  }

  private async writeIndex(): Promise<void> {
    this.index.placeholders = this.scrubber.placeholders();
    const path = join(this.dir, 'index.json');
    await writeFile(`${path}.tmp`, `${JSON.stringify(this.index, null, 2)}\n`);
    await rename(`${path}.tmp`, path);
  }
}
