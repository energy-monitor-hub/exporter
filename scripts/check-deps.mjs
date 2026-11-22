#!/usr/bin/env node
// Supply-chain guard for npm. No dependencies, runs on plain Node 22.
//
//   node scripts/check-deps.mjs            # check root and web/
//   node scripts/check-deps.mjs --offline  # skip the registry (release age) check
//   node scripts/check-deps.mjs --outdated # list newer versions that are past the quarantine
//
// Fails when
//   1. a package.json dependency is not an exact version (no ^, ~, *, latest, ranges, tags, URLs);
//   2. package-lock.json is missing or does not match package.json;
//   3. any package in the lockfile (direct or transitive) was published less than
//      MIN_RELEASE_AGE_DAYS ago (quarantine), or comes from outside the npm registry.
//
// npm >= 11.10 enforces the same quarantine at resolve time through `min-release-age`
// in .npmrc; this script also covers `npm ci` (which installs the lockfile as is) and
// lockfiles produced by an older npm that silently ignores that setting.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_RELEASE_AGE_DAYS = 7;
const REGISTRY = 'https://registry.npmjs.org';
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const projects = ['.', 'web'].filter((p) => existsSync(join(root, p, 'package.json')));
const offline = process.argv.includes('--offline');
const errors = [];

async function registryTimes(name) {
  const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`registry: ${name} -> HTTP ${res.status}`);
  return (await res.json()).time ?? {};
}

function cmpSemver(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** Newest stable version published at least MIN_RELEASE_AGE_DAYS ago. */
async function newestPastQuarantine(name) {
  const cutoff = Date.now() - MIN_RELEASE_AGE_DAYS * 86_400_000;
  const time = await registryTimes(name);
  return Object.entries(time)
    .filter(([v, t]) => /^\d+\.\d+\.\d+$/.test(v) && Date.parse(t) <= cutoff)
    .map(([v]) => v)
    .sort(cmpSemver)
    .at(-1);
}

if (process.argv.includes('--outdated')) {
  // package.json deps of root and web/, plus `# npm-pin: <name>` lines in Dockerfiles,
  // the Makefile and CI (the next line holds the version).
  const pins = [];
  for (const project of projects) {
    const pkg = await readJson(join(root, project, 'package.json'));
    for (const field of ['dependencies', 'devDependencies']) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) pins.push({ where: `${project}/package.json`, name, current: spec });
    }
  }
  const files = ['Dockerfile', 'web/Dockerfile', '.devcontainer/Dockerfile', 'Makefile', '.github/workflows/ci.yml', '.github/workflows/deploy-web.yml'];
  for (const file of files.filter((f) => existsSync(join(root, f)))) {
    const text = await readFile(join(root, file), 'utf8');
    for (const m of text.matchAll(/#\s*npm-pin:\s*(\S+)\s*\n[^\n]*?(\d+\.\d+\.\d+)/g)) {
      pins.push({ where: file, name: m[1], current: m[2] });
    }
  }
  const latest = new Map();
  for (const name of new Set(pins.map((p) => p.name))) latest.set(name, await newestPastQuarantine(name));
  const rows = pins.filter((p) => latest.get(p.name) && cmpSemver(latest.get(p.name), p.current) > 0);
  if (!rows.length) {
    console.log(`✓ everything is on the newest version that is older than ${MIN_RELEASE_AGE_DAYS} days`);
  } else {
    console.log(`Newer versions past the ${MIN_RELEASE_AGE_DAYS}-day quarantine:`);
    for (const r of rows) console.log(`  ${r.name.padEnd(28)} ${r.current.padEnd(10)} -> ${latest.get(r.name).padEnd(10)} ${r.where}`);
    console.log('\nnpm deps: npm install <pkg>@<version> (in that folder); pins: edit the file. Check changelogs for majors.');
  }
  process.exit(0);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/** name -> Set(version) for every registry package in all lockfiles */
const locked = new Map();

for (const project of projects) {
  const dir = join(root, project);
  const pkg = await readJson(join(dir, 'package.json'));
  const lockPath = join(dir, 'package-lock.json');
  if (!existsSync(lockPath)) {
    errors.push(`${project}/package-lock.json is missing (commit it, install with npm ci)`);
    continue;
  }
  const lock = await readJson(lockPath);
  const lockRoot = lock.packages?.[''] ?? {};

  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (field !== 'peerDependencies' && !EXACT.test(spec)) {
        errors.push(`${project}/package.json ${field}.${name} = "${spec}" is not an exact version`);
      }
      if (field !== 'peerDependencies' && lockRoot[field]?.[name] !== spec) {
        errors.push(`${project}/package-lock.json is out of date for ${name} (run npm install)`);
      }
      const installed = lock.packages?.[`node_modules/${name}`]?.version;
      if (field !== 'peerDependencies' && installed && installed !== spec) {
        errors.push(`${project}: ${name} is ${spec} in package.json but ${installed} in the lockfile`);
      }
    }
  }

  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    // inBundle: shipped inside its parent's tarball, which is checked (registry, integrity, age) itself.
    if (path === '' || entry.link || entry.inBundle) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!entry.resolved?.startsWith(`${REGISTRY}/`)) {
      errors.push(`${project}: ${name}@${entry.version} is not from ${REGISTRY} (${entry.resolved ?? 'no resolved URL'})`);
      continue;
    }
    if (!entry.integrity) errors.push(`${project}: ${name}@${entry.version} has no integrity hash`);
    if (!locked.has(name)) locked.set(name, new Set());
    locked.get(name).add(entry.version);
  }
}

if (!offline) {
  const cutoff = Date.now() - MIN_RELEASE_AGE_DAYS * 86_400_000;
  const names = [...locked.keys()];
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next++];
      const res = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        errors.push(`registry: ${name} -> HTTP ${res.status}`);
        continue;
      }
      const { time = {} } = await res.json();
      for (const version of locked.get(name)) {
        const published = Date.parse(time[version] ?? '');
        if (Number.isNaN(published)) {
          errors.push(`registry: no publish time for ${name}@${version}`);
        } else if (published > cutoff) {
          const days = ((Date.now() - published) / 86_400_000).toFixed(1);
          errors.push(
            `quarantine: ${name}@${version} was published ${days} days ago (< ${MIN_RELEASE_AGE_DAYS}), pin an older version`,
          );
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker));
}

if (errors.length) {
  console.error(errors.map((e) => `✗ ${e}`).join('\n'));
  process.exit(1);
}
const count = [...locked.values()].reduce((n, s) => n + s.size, 0);
console.log(
  `✓ ${projects.join(', ')}: exact versions, lockfiles in sync, ${count} locked packages` +
    (offline ? '' : ` all older than ${MIN_RELEASE_AGE_DAYS} days`),
);
