#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Verifies that the npm tarball produced by `npm pack` is a complete,
 * usable artifact.
 *
 * Historically the published package shipped without `frontend/dist/`
 * (the SPA was never built before publish, so every HTML route 404'd) and
 * without the bundled `parking-ips.json` data file (so
 * `DNS_PARKING_CHECK_ENABLED` silently became a no-op). Neither failure was
 * visible in CI, because the CI smoke test builds the Docker image — which
 * copies the frontend from source — instead of the npm artifact.
 *
 * This gate is intentionally distribution-focused: it is the only check that
 * exercises the path a consumer actually receives.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Resolve the npm CLI from the current Node installation instead of spawning
// `npm` through a shell: `shell: true` with an argument array is deprecated
// (DEP0190) because the arguments are concatenated unescaped.
function resolveNpmCli() {
  const bundled = join(
    dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return existsSync(bundled) ? bundled : 'npm-cli.js';
}

const REQUIRED = [
  'dist/web/index.html',
  'dist/web/assets',
  'dist/providers/dns/parking-ips.json',
  'dist/cli.js',
  'dist/index.js',
  'examples/closeout-sample.csv',
  'examples/keywords-sample.json',
  'examples/comps-sample.csv',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'THIRD-PARTY-NOTICES.md',
  'package.json',
];

// No path outside `dist/` and `examples/` may appear: the package must be a
// single self-contained build output, not a mixed source distribution.
const FORBIDDEN_TOP_LEVEL = ['frontend/', 'src/', 'node_modules/', '.git/', 'docs/'];

const FORBIDDEN_PATTERNS = [
  // Compiled test suites must never ship to consumers.
  { re: /^dist\/.*__tests__\/.*\.test\.js$/, label: 'compiled test file' },
  { re: /^dist\/.*__tests__\/.*\.test\.d\.ts$/, label: 'compiled test declaration' },
  // An accidental nested package.json makes npm treat frontend/ as a workspace.
  { re: /^frontend\/package\.json$/, label: 'nested frontend package.json' },
];

/**
 * `npm pack --dry-run --json` writes the JSON document to stdout, but npm
 * may also emit human-readable notices there (for example ".git can't be
 * packed" on a shallow clone). Parsing the whole stream then fails with a
 * SyntaxError, which would make this gate report a broken tarball when the
 * tarball is fine. Extract the outermost JSON array/object instead by
 * bracket-matching from its first opening character.
 */
function extractJson(raw) {
  const start = raw.search(/[[{]/);
  if (start === -1) throw new Error('no JSON document in npm pack output');
  const open = raw[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(raw.slice(start, i + 1));
    }
  }
  throw new Error('unterminated JSON document in npm pack output');
}

try {
  const raw = execFileSync(process.execPath, [resolveNpmCli(), 'pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = extractJson(raw);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = new Set(pack.files.map((f) => f.path));

  const failures = [];

  for (const req of REQUIRED) {
    const ok =
      files.has(req) ||
      // `npm pack` collapses directories to a trailing slash for empty dirs.
      [...files].some((f) => f.startsWith(`${req}/`));
    if (!ok) failures.push(`missing required file: ${req}`);
  }

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    for (const f of files) {
      if (re.test(f)) failures.push(`forbidden ${label} shipped: ${f}`);
    }
  }

  for (const forbidden of FORBIDDEN_TOP_LEVEL) {
    for (const f of files) {
      if (f.startsWith(forbidden)) {
        failures.push(`unexpected top-level path in tarball: ${f} (expected only dist/, examples/ and the licence files)`);
      }
    }
  }

  // `parking-ips.json` must be real data, not a stub.
  const parkingPath = join(root, 'dist', 'providers', 'dns', 'parking-ips.json');
  if (!existsSync(parkingPath)) {
    failures.push('dist/providers/dns/parking-ips.json was not produced by the build');
  }

  if (failures.length > 0) {
    console.error(`check-pack: FAILED (${failures.length} problem(s))`);
    for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
    process.exit(1);
  }

  console.log(`check-pack: OK — tarball ${pack.name}@${pack.version} is complete (${files.size} files)`);
} catch (err) {
  console.error(`check-pack: could not inspect tarball: ${String(err)}`);
  process.exit(1);
}
