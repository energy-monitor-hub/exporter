import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Op } from './ops.js';

export interface QueuedOp {
  id: number;
  op: Op;
}

/**
 * Local durable queue (SQLite file, node:sqlite) between the exporter and Supabase. Every
 * write goes here first and is deleted only after Supabase confirmed it, so an internet or
 * Supabase outage loses nothing. Also keeps small state (open outage) across restarts.
 */
export class Outbox {
  private readonly db: DatabaseSync;
  private readonly maxRows: number;

  /** `path` ':memory:' for tests. When more than `maxRows` are pending, the oldest samples are dropped (outage ops never). */
  constructor(path: string, maxRows = 500_000) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.maxRows = maxRows;
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      create table if not exists outbox (
        id integer primary key autoincrement,
        kind text not null,
        body text not null,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      create table if not exists kv (key text primary key, value text not null);
    `);
  }

  push(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    const insert = this.db.prepare('insert into outbox (kind, body) values (?, ?)');
    // Only the newest device state matters: drop a pending older one of the same device.
    const dropState = this.db.prepare(`delete from outbox where kind = 'state' and json_extract(body, '$.sn') = ?`);
    this.db.exec('begin');
    try {
      for (const op of ops) {
        if (op.kind === 'state') dropState.run(op.sn);
        insert.run(op.kind, JSON.stringify(op));
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
    this.trim();
  }

  /** Oldest pending ops first. */
  peek(limit: number): QueuedOp[] {
    const rows = this.db.prepare('select id, body from outbox order by id limit ?').all(limit) as { id: number; body: string }[];
    return rows.map((r) => ({ id: Number(r.id), op: JSON.parse(r.body) as Op }));
  }

  remove(ids: readonly number[]): void {
    if (ids.length === 0) return;
    const del = this.db.prepare('delete from outbox where id = ?');
    this.db.exec('begin');
    for (const id of ids) del.run(id);
    this.db.exec('commit');
  }

  get size(): number {
    const row = this.db.prepare('select count(*) as n from outbox').get() as { n: number };
    return Number(row.n);
  }

  getState<T>(key: string): T | undefined {
    const row = this.db.prepare('select value from kv where key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setState(key: string, value: unknown): void {
    if (value === undefined) this.db.prepare('delete from kv where key = ?').run(key);
    else this.db.prepare('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value));
  }

  close(): void {
    this.db.close();
  }

  private trim(): void {
    const over = this.size - this.maxRows;
    if (over <= 0) return;
    this.db
      .prepare(`delete from outbox where id in (select id from outbox where kind in ('telemetry', 'pack') order by id limit ?)`)
      .run(over);
  }
}
