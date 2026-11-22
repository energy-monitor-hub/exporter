import type { KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../mqtt/client.js';
import { MAX_INDEX_BYTES, MAX_PACK_BYTES, type DecoderPack, type PackIndex } from './schema.js';
import { choose, verifyIndex, verifyPack } from './verify.js';

export type DecoderUpdates = 'off' | 'notify' | 'auto';

export interface PackUpdaterOptions {
  /** https URL of index.json; packs are fetched from next to it. */
  indexUrl: string | undefined;
  mode: DecoderUpdates;
  /** On the data volume: last good index, its signature and the packs in use. */
  cacheDir: string;
  keys: readonly KeyObject[];
  exporterVersion: string;
  log: Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface PackUpdaterStatus {
  mode: DecoderUpdates;
  configured: boolean;
  sequence?: number;
  channel?: string;
  publishedAt?: string;
  checkedAt?: string;
  error?: string;
  /** Packs this device could use from the last good index (also in notify mode). */
  available: { id: string; version: number }[];
}

const TIMEOUT_MS = 15_000;

/**
 * Decoder packs from the project's hosting (issue #43): fetch the signed index, check it,
 * fetch only the pack this device needs, check its hash, keep both on the data volume.
 * The request carries nothing about the user or the device (the whole index is fetched and
 * the choice is made here). Packs are data for src/packs/interpreter.ts, never code.
 */
export class PackUpdater {
  private index: PackIndex | undefined;
  private readonly packs = new Map<string, DecoderPack>();
  private checkedAt: string | undefined;
  private error: string | undefined;
  private available: { id: string; version: number }[] = [];

  constructor(private readonly o: PackUpdaterOptions) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get enabled(): boolean {
    return this.o.mode !== 'off' && this.o.indexUrl !== undefined && this.o.keys.length > 0;
  }

  status(): PackUpdaterStatus {
    return {
      mode: this.o.mode,
      configured: this.enabled,
      ...(this.index ? { sequence: this.index.sequence, channel: this.index.channel, publishedAt: this.index.published_at } : {}),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {}),
      ...(this.error ? { error: this.error } : {}),
      available: this.available,
    };
  }

  /** Last good index and packs from the volume (works offline; checked again on load). */
  loadCached(): void {
    if (!this.enabled) return;
    const file = join(this.o.cacheDir, 'index.json');
    if (!existsSync(file)) return;
    try {
      const index = verifyIndex(readFileSync(file), readFileSync(`${file}.sig`, 'utf8'), this.o.keys);
      this.index = index;
      for (const entry of index.packs) {
        const p = join(this.o.cacheDir, entry.file);
        if (existsSync(p)) this.packs.set(entry.file, verifyPack(readFileSync(p), entry));
      }
    } catch (err) {
      this.error = `cached decoder packs ignored: ${(err as Error).message}`;
      this.o.log.warn(`packs: ${this.error}`);
    }
  }

  /** The pack to use for this device, if updates are on (`auto`) and one is cached. */
  pick(vendor: string, productCode: string): DecoderPack | undefined {
    if (!this.enabled || this.o.mode !== 'auto' || !this.index) return undefined;
    const entry = choose(this.index, vendor, productCode, this.o.exporterVersion);
    return entry ? this.packs.get(entry.file) : undefined;
  }

  /** Fetch and check; keeps the last good state on any failure. */
  async check(vendor: string, productCode: string): Promise<void> {
    if (!this.enabled || !this.o.indexUrl) return;
    this.checkedAt = new Date(this.now).toISOString();
    try {
      const base = new URL('.', this.o.indexUrl);
      const body = await this.get(this.o.indexUrl, MAX_INDEX_BYTES);
      const sig = Buffer.from(await this.get(`${this.o.indexUrl}.sig`, 1024)).toString('utf8');
      const index = verifyIndex(body, sig, this.o.keys);
      if (Date.parse(index.expires_at) <= this.now) throw new Error('the published decoder index has expired');
      if (this.index && index.sequence < this.index.sequence) {
        throw new Error(`refused an older decoder index (${index.sequence} < ${this.index.sequence})`);
      }
      const entry = choose(index, vendor, productCode, this.o.exporterVersion);
      let pack: DecoderPack | undefined;
      let packBytes: Uint8Array | undefined;
      if (entry) {
        pack = this.packs.get(entry.file);
        if (!pack) {
          packBytes = await this.get(new URL(entry.file, base).toString(), MAX_PACK_BYTES);
          pack = verifyPack(packBytes, entry);
        }
      }
      // Everything checked: write the pack first, the index last, each atomically.
      mkdirSync(this.o.cacheDir, { recursive: true });
      if (entry && packBytes) atomicWrite(join(this.o.cacheDir, entry.file), packBytes);
      atomicWrite(join(this.o.cacheDir, 'index.json.sig'), Buffer.from(sig));
      atomicWrite(join(this.o.cacheDir, 'index.json'), body);
      this.index = index;
      if (entry && pack) this.packs.set(entry.file, pack);
      this.available = entry ? [{ id: entry.id, version: entry.version }] : [];
      this.error = undefined;
    } catch (err) {
      this.error = (err as Error).message;
      this.o.log.warn(`packs: ${this.error}`);
    }
  }

  private async get(url: string, limit: number): Promise<Uint8Array> {
    if (!url.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) throw new Error('decoder packs are fetched over https only');
    const res = await (this.o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${new URL(url).pathname}: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(`${new URL(url).pathname}: too large`);
    return buf;
  }
}

function atomicWrite(path: string, bytes: Uint8Array): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, bytes, { mode: 0o644 });
  renameSync(tmp, path);
}
