#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The quickstart gate.
//
// The README's first command is the front door of the project: it is what
// a stranger runs first, and it is the only thing every user sees. It was
// broken in a way no other check could see:
//
//   - it built the WHOLE application (database, migrations, job worker,
//     resolver probe), so it took 12.4 seconds;
//   - it created a SQLite database next to the user;
//   - it printed 14.8 KB of JSON log on stdout, where the decision
//     belongs - so the output could not be piped or parsed;
//   - the README showed an output the command did not produce.
//
// Every other gate in this repository checks the CODE against the
// DOCUMENTATION. This one checks the DOCUMENTATION against the CODE: it
// runs the advertised command, in a throwaway directory, and asserts the
// contract a user is entitled to:
//
//   1. it exits 0;
//   2. stdout carries the decision and nothing else (no log lines);
//   3. the decision names the domain and the five numbers;
//   4. it writes nothing to the disk (no database file);
//   5. it finishes inside a time budget;
//   6. the labels the README documents are the labels the command prints.
//
// Usage: node scripts/check-quickstart.mjs
// Exit 0 = the front door works, 1 = it does not.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.cwd();
const cli = join(root, 'dist', 'cli.js');

/** The labels the human output must carry, in order. */
const DECISION_LABELS = [
  'Expected value:',
  'Suggested buy max:',
  'List price:',
  'Confidence:',
  'Recommended:',
];

/** A generous budget: the point is to catch "it builds the whole app". */
const TIME_BUDGET_MS = 30_000;

const failures = [];

function fail(message) {
  failures.push(message);
}

function ok(message) {
  console.log(`[ok] ${message}`);
}

if (!existsSync(cli)) {
  console.error('[FAIL] dist/cli.js is missing — run `npm run build` before this check.');
  process.exit(1);
}

// A throwaway working directory: the command runs there, so a database
// file it creates is visible and disposable instead of landing in the
// repository.
const workdir = mkdtempSync(join(tmpdir(), 'dominus-quickstart-'));

let stdout = '';
let stderr = '';
let exitCode = 0;
let durationMs = 0;

try {
  const started = Date.now();
  try {
    stdout = execFileSync(process.execPath, [cli, 'score', 'example.com'], {
      cwd: workdir,
      env: {
        ...process.env,
        // The machine format, so the assertions are about the command's
        // output and not about the terminal.
        LOG_PRETTY: 'false',
      },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    exitCode = typeof err.status === 'number' ? err.status : 1;
    stdout = err.stdout ? err.stdout.toString() : '';
    stderr = err.stderr ? err.stderr.toString() : '';
  }
  durationMs = Date.now() - started;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

// ── 1. the exit code ─────────────────────────────────────────────────
if (exitCode === 0) {
  ok('the command exits 0');
} else {
  fail(`the command exited ${exitCode} (a decision command that cannot decide fails the reader)`);
}

// ── 2. stdout carries the decision and nothing else ──────────────────
const stdoutLines = stdout.split('\n').filter((line) => line.trim() !== '');
const logLines = stdoutLines.filter((line) => line.trim().startsWith('{'));
if (logLines.length === 0) {
  ok('stdout carries no log lines');
} else {
  fail(
    `stdout carries ${logLines.length} log line(s) - the output of a command must be the decision, ` +
      'not the diagnostics (the logs belong on stderr)',
  );
}

if (/^Score: example\.com$/m.test(stdout)) {
  ok('the decision names the domain');
} else {
  fail('the output does not contain the "Score: example.com" line');
}

// ── 3. the five numbers ──────────────────────────────────────────────
for (const label of DECISION_LABELS) {
  if (stdout.includes(label)) {
    ok(`the decision carries "${label}"`);
  } else {
    fail(`the decision does not carry "${label}"`);
  }
}

// ── 4. nothing written to the disk ───────────────────────────────────
const leftovers = existsSync(workdir) ? readdirSync(workdir) : [];
const databaseFiles = leftovers.filter((entry) => entry.endsWith('.db') || entry === 'data');
if (databaseFiles.length === 0) {
  ok('the command writes nothing to the disk');
} else {
  fail(
    `the command created ${databaseFiles.join(', ')} - a command that answers a question does not ` +
      'create a database',
  );
}

// ── 5. the time budget ───────────────────────────────────────────────
if (durationMs <= TIME_BUDGET_MS) {
  ok(`the command finished in ${durationMs} ms`);
} else {
  fail(`the command took ${durationMs} ms - over the ${TIME_BUDGET_MS} ms budget`);
}

// ── 6. the README documents the output that is produced ──────────────
const readmePath = join(root, 'README.md');
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, 'utf8');
  const documented = readme
    .split('\n')
    .filter((line) => DECISION_LABELS.some((label) => line.trim().startsWith(label)))
    .map((line) => line.trim().split(':')[0].trim());
  const missing = documented.filter((label) => !DECISION_LABELS.includes(`${label}:`));
  if (missing.length === 0 && documented.length === DECISION_LABELS.length) {
    ok(`the README documents the ${documented.length} labels the command prints`);
  } else {
    fail(
      `the README documents ${documented.length} of the ${DECISION_LABELS.length} labels the command ` +
        `prints (found: ${documented.join(', ') || 'none'}) - the documented output must be the real one`,
    );
  }
} else {
  fail('README.md is missing');
}

// ── Report ───────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`check-quickstart: FAIL - ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`check-quickstart: OK - the front door works (${durationMs} ms, exit 0)`);
