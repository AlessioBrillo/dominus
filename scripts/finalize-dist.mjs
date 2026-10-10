#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Post-build finalisation of `dist/`.
 *
 * `tsc` is a TypeScript compiler, not a bundler: it does not know that the
 * unit and integration test suites under the `__tests__` directories in
 * `src/` are never needed at runtime, and it does not copy non-`.ts` data
 * files at all. Left alone, the output therefore
 *
 *   1. contains every compiled test file, which
 *      - inflates the published tarball and every Docker image,
 *      - ships internal test code to consumers,
 *      - bloats the source maps;
 *   2. is missing runtime JSON assets, so `ParkingIpRegistry.load()` falls
 *      back to an empty list and `DNS_PARKING_CHECK_ENABLED=true` becomes a
 *      silent no-op (a fail-open behaviour that violates the
 *      scoring-conservatism principle; see ADR-0059).
 *
 * Both are build concerns, not runtime ones, so they are fixed here: after
 * every `tsc` run the output is pruned and completed, for every distribution
 * channel (tsx from source, node from dist, the npm tarball, Docker).
 *
 * Note: this deliberately does NOT remove `.js.map` files. Keeping source
 * maps in the published output lets production stack traces resolve to the
 * original TypeScript lines, which is the only way an operator can report an
 * actionable bug.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

const failures = [];

if (!existsSync(srcDir)) {
  console.error('finalize-dist: src/ not found — run from the repository root');
  process.exit(1);
}
if (!existsSync(distDir)) {
  console.error('finalize-dist: dist/ not found — run `tsc` first');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 1. Copy runtime JSON assets (tsc drops non-.ts files)
 * ------------------------------------------------------------------ */
function findJson(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJson(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

let copied = 0;
for (const src of findJson(srcDir)) {
  const dest = join(distDir, relative(srcDir, src));
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied += 1;
  } catch (err) {
    failures.push(`copy ${relative(root, src).split(sep).join('/')}: ${String(err)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Stage the built SPA at dist/web (npm packages cannot ship a
 *    nested frontend/ tree — npm force-includes any directory's
 *    package.json, so `frontend/` in `files` always leaks
 *    frontend/package.json into the tarball). Keeping the compiled SPA
 *    under dist/ means one layout for every channel: source checkout,
 *    npm tarball, and all three Docker targets.
 * ------------------------------------------------------------------ */
const frontendDist = join(root, 'frontend', 'dist');
const webOut = join(distDir, 'web');

if (existsSync(frontendDist)) {
  try {
    mkdirSync(webOut, { recursive: true });
    cpSync(frontendDist, webOut, { recursive: true });
    console.log('finalize-dist: staged built SPA at dist/web/');
  } catch (err) {
    failures.push(`stage SPA into dist/web: ${String(err)}`);
  }
} else {
  console.warn(
    'finalize-dist: frontend/dist not found — the API will have no SPA to serve. ' +
      'Run `npm run build:frontend` before `npm run build` for a complete artifact.',
  );
}

/* ------------------------------------------------------------------ *
 * 3. Prune compiled test suites and their orphaned source maps
 * ------------------------------------------------------------------ */
function countFiles(dir) {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
    else n += 1;
  }
  return n;
}

function findTestDirs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.name === '__tests__') out.push(full);
    else out.push(...findTestDirs(full));
  }
  return out;
}

let prunedFiles = 0;
for (const testDir of findTestDirs(distDir)) {
  try {
    prunedFiles += countFiles(testDir);
    rmSync(testDir, { recursive: true, force: true });
  } catch (err) {
    failures.push(`prune ${relative(root, testDir).split(sep).join('/')}: ${String(err)}`);
  }
}

if (failures.length > 0) {
  console.error(`finalize-dist: FAILED (${failures.length} problem(s))`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(
  `finalize-dist: copied ${copied} JSON asset(s), pruned ${prunedFiles} compiled test file(s)`,
);
