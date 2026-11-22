import { existsSync, readFileSync } from 'node:fs';
import * as sea from 'node:sea';

/**
 * Files the exporter reads at runtime (the .proto, the status page). Normally they sit next to
 * the modules (src/ or dist/); in the single executable (docs/NATIVE.md) they are assets in the
 * binary, under the same relative name (`proto/delta3maxplus.proto`, `ui/app.js`).
 *
 * `onDisk` is a thunk so that `import.meta.url` is never evaluated inside the executable,
 * which is a CommonJS bundle without it.
 */
export function readAsset(name: string, onDisk: () => URL): Buffer | undefined {
  if (inExecutable()) {
    try {
      return Buffer.from(sea.getAsset(name));
    } catch {
      return undefined;
    }
  }
  const file = onDisk();
  return existsSync(file) ? readFileSync(file) : undefined;
}

export function inExecutable(): boolean {
  try {
    return sea.isSea();
  } catch {
    return false;
  }
}
