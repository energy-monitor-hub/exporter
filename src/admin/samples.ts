/**
 * Operator tool for shared model samples (issue #42). Not part of the exporter: it needs the
 * project's service_role key, which only the operator has and which never goes into an
 * exporter, the web app or the repo.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npm run samples -- <command>
 *
 *   list                              census and samples per model
 *   pull <sample id> [dir]            download one sample (gzip JSON) to dir (default: .)
 *   status <sample id> <analysing|used|rejected>
 *   known <vendor> <code> <supported|enough|remove>
 *   purge                             remove files of expired / deleted samples and orphans
 *
 * Pulled samples are personal data until the analysis is done: keep them off shared drives,
 * delete them locally when the model is supported. Never commit them (they are not fixtures;
 * publishing an excerpt needs the separate `sample_as_public_fixture` consent).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'samples';

function client(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (operator only)');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function check<T>(r: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  if (r.data === null || r.data === undefined) throw new Error(`${what}: nothing returned`);
  return r.data;
}

async function list(db: SupabaseClient): Promise<void> {
  const census = check(await db.from('model_census').select('vendor, product_code, firmware, seen_at'), 'model_census');
  const samples = check(await db.from('model_samples').select('id, vendor, product_code, status, size_bytes, uploaded_at').order('created_at'), 'model_samples');
  const known = check(await db.from('known_models').select('vendor, product_code, status'), 'known_models');
  const models = new Map<string, { users: number; samples: string[]; known?: string }>();
  const at = (v: string, c: string) => {
    const k = `${v} ${c}`;
    const m = models.get(k) ?? { users: 0, samples: [] };
    models.set(k, m);
    return m;
  };
  for (const r of census) at(r.vendor as string, r.product_code as string).users++;
  for (const r of samples) at(r.vendor as string, r.product_code as string).samples.push(`${r.id as string} ${r.status as string} ${(r.size_bytes as number | null) ?? '-'}B`);
  for (const r of known) at(r.vendor as string, r.product_code as string).known = r.status as string;
  for (const [k, m] of [...models].sort()) {
    console.log(`${k}: ${m.users} in census${m.known ? `, ${m.known}` : ''}`);
    for (const s of m.samples) console.log(`  ${s}`);
  }
}

async function pull(db: SupabaseClient, id: string, dir = '.'): Promise<void> {
  const row = check(await db.from('model_samples').select('path, status').eq('id', id).single(), 'sample');
  if (!['uploaded', 'analysing'].includes(row.status as string)) throw new Error(`sample is ${row.status as string}`);
  const blob = check(await db.storage.from(BUCKET).download(row.path as string), 'download');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${id}.json.gz`);
  writeFileSync(out, Buffer.from(await blob.arrayBuffer()), { mode: 0o600 });
  console.log(out);
}

async function setStatus(db: SupabaseClient, id: string, status: string): Promise<void> {
  if (!['analysing', 'used', 'rejected'].includes(status)) throw new Error('status: analysing | used | rejected');
  check(await db.from('model_samples').update({ status }).eq('id', id).select('id').single(), 'update');
}

async function known(db: SupabaseClient, vendor: string, code: string, status: string): Promise<void> {
  if (status === 'remove') {
    check(await db.from('known_models').delete().eq('vendor', vendor).eq('product_code', code.toUpperCase()).select('vendor'), 'delete');
    return;
  }
  if (!['supported', 'enough'].includes(status)) throw new Error('status: supported | enough | remove');
  check(await db.from('known_models').upsert({ vendor, product_code: code.toUpperCase(), status, updated_at: new Date().toISOString() }).select('vendor'), 'upsert');
}

/** SQL cannot delete Storage files: rows go to expired / deleted there, the files go here. */
async function purge(db: SupabaseClient): Promise<void> {
  const rows = check(await db.from('model_samples').select('id, path, status'), 'model_samples');
  const keep = new Set(rows.filter((r) => !['expired', 'deleted'].includes(r.status as string)).map((r) => r.path as string));
  const gone = rows.filter((r) => ['expired', 'deleted'].includes(r.status as string));
  // every file in the bucket: <user id>/<sample id>.json.gz
  const files: string[] = [];
  const folders = check(await db.storage.from(BUCKET).list('', { limit: 1000 }), 'list');
  for (const f of folders) {
    const inner = check(await db.storage.from(BUCKET).list(f.name, { limit: 1000 }), 'list');
    for (const o of inner) files.push(`${f.name}/${o.name}`);
  }
  const remove = files.filter((p) => !keep.has(p));
  for (let i = 0; i < remove.length; i += 100) check(await db.storage.from(BUCKET).remove(remove.slice(i, i + 100)), 'remove');
  if (gone.length) check(await db.from('model_samples').delete().in('id', gone.map((r) => r.id as string)).select('id'), 'delete rows');
  console.log(`removed ${remove.length} file(s), ${gone.length} row(s)`);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const db = client();
  switch (cmd) {
    case 'list':
      return list(db);
    case 'pull':
      if (!args[0]) break;
      return pull(db, args[0], args[1]);
    case 'status':
      if (!args[0] || !args[1]) break;
      return setStatus(db, args[0], args[1]);
    case 'known':
      if (!args[0] || !args[1] || !args[2]) break;
      return known(db, args[0], args[1], args[2]);
    case 'purge':
      return purge(db);
  }
  console.error('usage: npm run samples -- list | pull <id> [dir] | status <id> <analysing|used|rejected> | known <vendor> <code> <supported|enough|remove> | purge');
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
