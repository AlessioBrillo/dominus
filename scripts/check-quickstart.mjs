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
// runs the advertised command, in a throwaway directory, against a local
// fixture trademark source (so the verdict is deterministic and offline),
// and asserts the contract a user is entitled to:
//
//   1. it exits 0;
//   2. stdout carries the decision and nothing else (no log lines);
//   3. the decision names the domain and the five numbers;
//   4. it writes nothing to the disk (no database file);
//   5. it finishes inside a time budget;
//   6. the output documented in the README is the output the command
//      actually produces (full comparison, not just labels).
//
// Usage: node scripts/check-quickstart.mjs
// Exit 0 = the front door works, 1 = it does not.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

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

// ── Fixture trademark source ──────────────────────────────────────────
//
// A minimal local stand-in for the USPTO tmsearch backend. It answers the
// search POST with an empty hit set, so `vintagecoffee.com` clears
// deterministically without touching the network. The real endpoint is
// exercised by `npm run check:trademarks`; this gate is offline by design.

let fixtureServer;
let fixturePort = 0;

function startFixture() {
  return new Promise((resolve, reject) => {
    fixtureServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        // Respond with zero hits for any term: the sample domain is clear.
        const payload = JSON.stringify({
          took: 2,
          timedOut: false,
          shardsTotal: 1,
          shardsSuccessful: 1,
          shardsSkipped: 0,
          shardsFailed: 0,
          hits: { totalValue: 0, totalRelation: 'eq', maxScore: null, hits: [] },
        });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(payload),
        });
        res.end(payload);
      });
    });
    fixtureServer.listen(0, '127.0.0.1', () => {
      const addr = fixtureServer.address();
      fixturePort = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve();
    });
    fixtureServer.on('error', reject);
  });
}

function stopFixture() {
  return new Promise((resolve) => {
    if (!fixtureServer) {
      resolve();
      return;
    }
    fixtureServer.close(() => resolve());
  });
}

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`[FAIL] ${message}`);
}

function ok(message) {
  console.log(`[ok] ${message}`);
}

if (!existsSync(cli)) {
  console.error(
    '[FAIL] dist/cli.js is missing — run `npm run build` before this check.',
  );
  process.exit(1);
}

// A throwaway working directory: the command runs there, so a database
// file it creates is visible and disposable instead of landing in the
// repository.
const workdir = mkdtempSync(join(tmpdir(), 'dominus-quickstart-'));
let durationMs = 0;

try {
  await startFixture();

  const url = `http://127.0.0.1:${fixturePort}/tmsearch`;

  const started = Date.now();
  // execFile (async), not execFileSync: execFileSync blocks the event loop
  // and a local fixture HTTP server cannot respond while it is blocked.
  const { stdout, stderr, exitCode } = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [cli, 'score', 'vintagecoffee.com'],
      {
        cwd: workdir,
        env: {
          ...process.env,
          KEYWORD_DATA_PATH: join(root, 'examples', 'keywords-sample.json'),
          COMPS_DATA_PATH: join(root, 'examples', 'comps-sample.csv'),
          LOG_PRETTY: 'false',
          USPTO_SEARCH_URL: url,
        },
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
      (err, out, errOut) => {
        resolve({
          stdout: out ?? '',
          stderr: errOut ?? '',
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        });
      },
    );
  });
  durationMs = Date.now() - started;

  // ── 1. the exit code ─────────────────────────────────────────────────
  if (exitCode === 0) {
    ok('the command exits 0');
  } else {
    fail(
      `the command exited ${exitCode} (a decision command that cannot decide fails the reader)` +
        (stderr ? `\n  stderr: ${stderr.slice(0, 400)}` : ''),
    );
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

  if (/^Score: vintagecoffee\.com$/m.test(stdout)) {
    ok('the decision names the domain');
  } else {
    fail('the output does not contain the "Score: vintagecoffee.com" line');
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
  const databaseFiles = leftovers.filter(
    (entry) => entry.endsWith('.db') || entry === 'data',
  );
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

    // Extract the documented output block from the README's Quick Start
    // section: the fenced code block that follows the sample-data command.
    const outputBlock = extractOutputBlock(readme);
    if (outputBlock === null) {
      fail(
        'README does not document the quickstart output block - the documented output must be the real one',
      );
    } else {
      const actual = normaliseOutput(stdout);
      const documented = normaliseOutput(outputBlock);
      if (actual === documented) {
        ok('the README documents the output the command produces');
      } else {
        fail(
          `the README documents output that does not match the command's output.\n` +
            `  documented:\n${documented.split('\n').map((l) => `    ${l}`).join('\n')}\n` +
            `  produced:\n${actual.split('\n').map((l) => `    ${l}`).join('\n')}`,
        );
      }
    }
  } else {
    fail('README.md is missing');
  }
} finally {
  await stopFixture();
  rmSync(workdir, { recursive: true, force: true });
}

/**
 * Extracts the fenced code block from the README that documents the
 * quickstart output: the block whose content contains `Score:
 * vintagecoffee.com` (the produced decision, not the command that
 * produces it).
 */
function extractOutputBlock(readme) {
  const lines = readme.split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const fence = /^```/.exec(lines[i]);
    if (!fence) {
      i += 1;
      continue;
    }
    const start = i + 1;
    let end = start;
    while (end < lines.length && !/^```/.test(lines[end])) end += 1;
    blocks.push(lines.slice(start, end).join('\n'));
    i = end + 1;
  }
  return blocks.find((block) => /Score: vintagecoffee\.com/.test(block)) ?? null;
}

/**
 * Normalises output for comparison: trim trailing whitespace per line and
 * collapse the trailing newline, so insignificant formatting differences
 * don't fail the gate while content mismatches still do.
 */
function normaliseOutput(output) {
  return output
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n*|\n*$/g, '');
}

if (failures.length > 0) {
  console.error(`check-quickstart: FAIL - ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`check-quickstart: OK - the front door works (${durationMs} ms, exit 0)`);
