import { readFileSync } from 'node:fs';
import { inExecutable, readAsset } from './assets.js';
import { lookupType } from './decode/proto.js';

/** package.json's version, or the one baked into the single executable (scripts/build-sea.mjs). */
export function exporterVersion(): string {
  if (process.env.ECOFLOW_BUILD_VERSION) return process.env.ECOFLOW_BUILD_VERSION;
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Prints the version, or checks that the bundled files load (proto, status page). Exit code. */
export function selfCheck(mode: string): number {
  if (mode === '--version') {
    console.log(exporterVersion());
    return 0;
  }
  try {
    lookupType('BMSHeartBeatReport');
    for (const f of ['index.html', 'app.js', 'app.css', 'tokens.css']) {
      if (!readAsset(`ui/${f}`, () => new URL(`./ui/${f}`, import.meta.url))) throw new Error(`ui/${f} is missing`);
    }
    console.log(`ok ${exporterVersion()} ${process.platform}-${process.arch}${inExecutable() ? ' (single executable)' : ''}`);
    return 0;
  } catch (err) {
    console.error(`self-check failed: ${(err as Error).message}`);
    return 1;
  }
}
