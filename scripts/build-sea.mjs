#!/usr/bin/env node
// Builds the exporter as one executable for this OS/arch with Node's Single Executable
// Applications (docs/NATIVE.md, issue #45): esbuild bundle (CommonJS) + assets (the .proto and
// the status page) + a copy of this Node binary, injected with postject. Same code as the image.
//
//   node scripts/build-sea.mjs        -> build/sea/ecoflow-exporter[.exe]
//
// Uses the Node that runs it: build with the pinned Node 22 (CI: actions/setup-node).
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const out = join(root, 'build', 'sea');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const exe = join(out, process.platform === 'win32' ? 'ecoflow-exporter.exe' : 'ecoflow-exporter');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(out, 'exporter.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // import.meta.url is only read behind readAsset()'s thunk, never inside the executable.
  logOverride: { 'empty-import-meta': 'silent' },
  define: { 'process.env.ECOFLOW_BUILD_VERSION': JSON.stringify(version) },
  legalComments: 'external',
});

const asset = (p) => join(root, p);
writeFileSync(
  join(out, 'sea-config.json'),
  JSON.stringify(
    {
      main: join(out, 'exporter.cjs'),
      output: join(out, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
      useCodeCache: false,
      useSnapshot: false,
      assets: {
        'proto/delta3maxplus.proto': asset('src/proto/delta3maxplus.proto'),
        'ui/index.html': asset('src/ui/index.html'),
        'ui/app.js': asset('src/ui/app.js'),
        'ui/app.css': asset('src/ui/app.css'),
      },
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ['--experimental-sea-config', join(out, 'sea-config.json')], { stdio: 'inherit' });

copyFileSync(process.execPath, exe);
chmodSync(exe, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe], { stdio: 'inherit' });
const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(
  process.execPath,
  [
    postject,
    exe,
    'NODE_SEA_BLOB',
    join(out, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
// Ad-hoc signature so macOS runs it; a Developer ID signature is a separate step (docs/NATIVE.md).
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe], { stdio: 'inherit' });
console.log(`built ${exe} (v${version}, ${process.platform}-${process.arch})`);
