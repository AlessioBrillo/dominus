#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Smoke test the built ESM artifact before it ships.
 *
 * This proves that what `tsc` + `finalize-dist` produce actually runs:
 * - the CLI boots and reports its own version (not 0.0.0),
 * - `dominus score` answers a decision on a single domain,
 * - `dominus doctor --json --skip-trademark` reports structured checks
 *   without crashing on a fresh installation.
 *
 * It runs against `dist/` directly (no install step), so it is fast enough
 * for every local gate run. The release workflow also runs it after
 * `check:pack` has built the tarball, so the same check covers the
 * artifact a consumer receives.
 *
 * Usage:
 *   node scripts/test-artifact.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distCli = join(root, 'dist', 'cli.js');

const failures = [];

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function fail(message) {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
}

function runCli(args, { cwd = root, env = process.env } = {}) {
  return execFileSync(process.execPath, [distCli, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...env, LOG_LEVEL: 'silent' },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120000,
  });
}

function extractJsonObject(raw) {
  for (let start = raw.indexOf('{'); start !== -1; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(raw.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

// ── 1: the artifact must exist ────────────────────────────────────────
if (!existsSync(distCli)) {
  fail('dist/cli.js does not exist — run `npm run build` first');
  process.exit(1);
}

// ── 2: --version must report the real version ─────────────────────────
let versionOutput;
try {
  versionOutput = runCli(['--version']);
} catch (err) {
  fail(`dominus --version crashed: ${err?.message ?? String(err)}`);
  process.exit(1);
}
const reportedVersion = versionOutput.trim();
const rootVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version;
if (reportedVersion === '0.0.0') {
  fail('the CLI reports version 0.0.0 — package.json is resolved from the wrong directory');
} else if (!reportedVersion.includes(rootVersion)) {
  fail(`the CLI reports "${reportedVersion}", expected ${rootVersion}`);
} else {
  pass(`the CLI reports version ${reportedVersion}`);
}

// ── 3: score answers a decision on a single domain ────────────────────
const tmpDir = mkdtempSync(join(tmpdir(), 'dominus-artifact-'));
const dbPath = join(tmpDir, 'dominus.db');
try {
  const scoreOutput = runCli(['score', 'vintagecoffee.com'], {
    cwd: tmpDir,
    env: {
      DATABASE_PATH: dbPath,
      KEYWORD_DATA_PATH: join(root, 'examples', 'keywords-sample.json'),
      COMPS_DATA_PATH: join(root, 'examples', 'comps-sample.csv'),
    },
  });
  if (!scoreOutput.includes('Score: vintagecoffee.com')) {
    fail('`dominus score` did not print a decision header');
  } else if (!scoreOutput.includes('Trademark gate')) {
    fail('`dominus score` did not run the trademark gate');
  } else {
    pass('`dominus score vintagecoffee.com` returns a decision with trademark gate');
  }
} catch (err) {
  const stderr = err?.stderr ? String(err.stderr) : '';
  fail(
    `\`dominus score vintagecoffee.com\` crashed: ${(stderr || err?.message || String(err)).trim()}`,
  );
}

// ── 4: doctor --json --skip-trademark on a fresh install ──────────────
// On a fresh installation the database does not exist yet, so doctor exits
// 1 with a structured "database not initialized" check. That is the
// intended behaviour — we still need the JSON report on stdout.
let doctorOutput;
try {
  doctorOutput = runCli(['doctor', '--json', '--skip-trademark'], {
    cwd: root,
    env: { DATABASE_PATH: dbPath },
  });
} catch (err) {
  const stderr = err?.stderr ? String(err.stderr) : '';
  const stdout = err?.stdout ? String(err.stdout) : '';
  if (stdout.trim()) {
    doctorOutput = stdout;
  } else {
    fail(
      `\`dominus doctor --json --skip-trademark\` crashed: ${(stderr || err?.message || String(err)).trim()}`,
    );
    rmSync(tmpDir, { recursive: true, force: true });
    if (failures.length > 0) process.exit(1);
    process.exit(0);
  }
}

const doctor = extractJsonObject(doctorOutput);
if (doctor === null) {
  fail('`dominus doctor --json` produced no JSON report');
} else {
  if (doctor.version === '0.0.0') {
    fail('`dominus doctor` reports version 0.0.0');
  } else {
    pass(`doctor reports version ${doctor.version}`);
  }

  const dbCheck = doctor.checks?.find((c) => c.name === 'database integrity');
  if (!dbCheck) {
    fail('`dominus doctor` has no "database integrity" check');
  } else if (dbCheck.status === 'fail' && !dbCheck.detail.includes('not initialized')) {
    fail(`\`dominus doctor\` database check failed with an unexpected detail: ${dbCheck.detail}`);
  } else {
    pass(`database integrity: ${dbCheck.status} — ${dbCheck.detail}`);
  }

  const diskCheck = doctor.checks?.find((c) => c.name === 'disk space');
  if (!diskCheck) {
    fail('`dominus doctor` has no "disk space" check');
  } else if (diskCheck.status === 'fail') {
    fail(`\`dominus doctor\` disk space check failed: ${diskCheck.detail}`);
  } else {
    pass(`disk space: ${diskCheck.status} — ${diskCheck.detail}`);
  }

  const canaryCheck = doctor.checks?.find((c) => c.name === 'trademark canary');
  if (!canaryCheck) {
    fail('`dominus doctor` has no "trademark canary" check');
  } else if (canaryCheck.status !== 'ok') {
    fail(`trademark canary: ${canaryCheck.status} — ${canaryCheck.detail}`);
  } else {
    pass(`trademark canary: ${canaryCheck.status} — ${canaryCheck.detail}`);
  }
}

rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(
    `\ntest-artifact: FAILED (${failures.length} problem(s)) — the artifact is not releasable.`,
  );
  process.exit(1);
}

console.log('\ntest-artifact: OK — the built artifact boots, scores and diagnoses.');
