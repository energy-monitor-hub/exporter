/**
 * Record raw EcoFlow MQTT messages into test/fixtures/<session>/ for offline decoder work (M2).
 * Run locally (the cloud sandbox cannot reach the broker):
 *   npm run record                 # until Ctrl+C
 *   npm run record -- --minutes 20 # stop by itself
 *   npm run record -- --no-quotas  # do not ask the device for full snapshots
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { loadEcoflowEnv } from './auth/env.js';
import { EcoflowAuthError } from './auth/errors.js';
import { EcoflowMqtt } from './mqtt/client.js';
import { FixtureWriter } from './record/fixtures.js';
import { Scrubber } from './record/scrub.js';

const { values: args } = parseArgs({
  options: {
    minutes: { type: 'string' },
    out: { type: 'string', default: 'test/fixtures' },
    'no-quotas': { type: 'boolean', default: false },
    'quota-every': { type: 'string', default: '300' },
  },
});

async function main(): Promise<void> {
  const env = loadEcoflowEnv();
  const minutes = args.minutes === undefined ? undefined : Number(args.minutes);
  if (minutes !== undefined && !(minutes > 0)) throw new Error('--minutes must be a positive number');

  const scrubber = new Scrubber([{ value: env.deviceSn, fill: 'X' }]);
  const writer = new FixtureWriter(args.out, scrubber);

  const mqtt = new EcoflowMqtt({
    auth: {
      username: env.username,
      password: env.password,
      ...(env.apiHost ? { apiHost: env.apiHost } : {}),
    },
    deviceSn: env.deviceSn,
    requestQuotasEveryMs: args['no-quotas'] ? 0 : Number(args['quota-every']) * 1000,
  });

  mqtt.on('connected', ({ userId }) => {
    scrubber.add(userId, '0');
    console.log(`record: connected, writing to ${writer.dir}`);
  });
  mqtt.on('message', (msg) => {
    writer.add(msg).catch((err: unknown) => console.error(`record: write failed: ${(err as Error).message}`));
  });

  const status = setInterval(() => {
    const top = Object.entries(writer.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => `${k}:${n}`)
      .join(' ');
    console.log(`record: ${writer.count} messages${mqtt.isConnected ? '' : ' (offline)'} ${top}`);
  }, 30_000);

  let stopping = false;
  const stop = async (why: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(`record: ${why}, finishing...`);
    clearInterval(status);
    await mqtt.stop();
    await writer.close();
    console.log(writer.count > 0 ? `record: saved ${writer.count} messages to ${writer.dir}` : 'record: nothing received, nothing saved');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('Ctrl+C'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  if (minutes !== undefined) setTimeout(() => void stop(`${minutes} min elapsed`), minutes * 60_000);

  console.log('record: logging in to EcoFlow...');
  await mqtt.start();
}

main().catch((err: unknown) => {
  if (err instanceof EcoflowAuthError) {
    console.error(`record: EcoFlow rejected the login (code ${err.code}): ${err.message}. Check ECOFLOW_USERNAME / ECOFLOW_PASSWORD.`);
  } else {
    console.error(`record: ${(err as Error).message}`);
  }
  process.exit(1);
});
