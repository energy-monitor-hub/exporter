import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureIndex } from '../../src/record/fixtures.js';

export const SESSION_DIR = join(import.meta.dirname, '..', 'fixtures', '20261121T171338444Z');

export interface FixtureMessage {
  file: string;
  at: Date;
  kind: string;
  payload: Buffer;
}

/** All messages of the first live recording (2026-11-21, with a grid outage), in order. */
export function loadSession(dir = SESSION_DIR): FixtureMessage[] {
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FixtureIndex;
  return index.messages.map((m) => ({
    file: m.file,
    at: new Date(m.receivedAt),
    kind: m.kind,
    payload: readFileSync(join(dir, m.file)),
  }));
}
