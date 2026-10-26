#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The published-install gate.
//
// `check-quickstart` runs the locally built dist/cli.js against a fixture
// trademark source: it proves the code works. `check-pack` inspects the
// tarball this repository builds: it proves the artifact is complete.
// Neither proves the artifact a stranger actually downloads works.
//
// This gate runs the public channel end-to-end:
//
//   1. downloads the tarball attached to the GitHub Release (the alias
//      `dominus-oss.tgz`, not the versioned one - the alias is what an
//      installer and a reader should rely on);
//   2. verifies its sha256 against the checksum published beside it;
//   3. installs it into a throwaway directory with npm;
//   4. runs the first command from the README (`dominus score ...`);
//   5. asserts exit 0, the decision on stdout alone, nothing written to
//      the disk, and a time budget.
//
// The trademark source is a local fixture: the gate is offline and
// deterministic, exactly like `check-quickstart`. The real USPTO endpoint
// is exercised by `npm run check:trademarks`.
//
// Usage:
//
//   node scripts/check-published-install.mjs          # latest release
//   node scripts/check-published-install.mjs --url https://github.com/AlessioBrillo/dominus/releases/tag/v1.4.0
//
// Exit 0 = the public channel works, 1 = it does not.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

const root = process.cwd();

// A URL pointing at a tag (releases/tag/vX.Y.Z) is accepted: the alias
// tarball is resolved from the tag's latest release.
function defaultTarballUrl() {
  return 'https://github.com/AlessioBrillo/dominus/releases/latest/download/dominus-oss.tgz';
}

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const tarballUrl = urlIndex >= 0 ? args[urlIndex + 1] : defaultTarballUrl();

// The checksum travels beside the tarball: a user who downloads the
// tarball can verify it without trusting the release page.
const checksumUrl = tarballUrl.endsWith('.tgz')
  ? tarballUrl.replace(/\.tgz$/, '.tgz.sha256')
  : `${tarballUrl}.sha256`;

const DECISION_LABELS = [
  'Expected value:',
  'Suggested buy max:',
  'List price:',
  'Confidence:',
  'Recommended:',
];

const TIME_BUDGET_MS = 60_000; // generous: downloads + install + run
const DOMAIN = 'vintagecoffee.com';

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[ok] ${message}`);
}

async function fetchBytes(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${url} answered ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url) {
  const bytes = await fetchBytes(url);
  return bytes.toString('utf8');
}

// ── Fixture trademark source ───────────────────────────────────────────
// A minimal local stand-in for the USPTO tmsearch backend. It answers the
// search POST with an empty hit set, so `vintagecoffee.com` clears
// deterministically without touching the network.

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

async function main() {
  let workdir;
  try {
    // ── 1. download tarball + checksum from the public release channel ─
    console.log(`check-published-install: downloading ${tarballUrl}`);
    const tarballBytes = await fetchBytes(tarballUrl);
    const checksumText = await fetchText(checksumUrl).catch(() => '');

    // Parse the checksum line: "<hash>  <filename>" or just "<hash>".
    const checksumMatch = /^[0-9a-fA-F]{64}/.exec(checksumText.trim());
    const expectedChecksum = checksumMatch ? checksumMatch[0].toLowerCase() : null;

    const actualChecksum = createHash('sha256').update(tarballBytes).digest('hex');

    if (expectedChecksum === null) {
      fail(`could not parse a sha256 checksum from ${checksumUrl}`);
    } else if (actualChecksum !== expectedChecksum) {
      fail(
        `checksum mismatch: tarball sha256 is ${actualChecksum}, the release publishes ${expectedChecksum}`,
      );
    } else {
      ok(`tarball checksum verified (${actualChecksum.slice(0, 16)}…)`);
    }

    // ── 2. install into a throwaway directory ────────────────────────────
    workdir = mkdtempSync(join(tmpdir(), 'dominus-published-'));
    const tarballPath = join(workdir, 'dominus-oss.tgz');
    writeFileSync(tarballPath, tarballBytes);

    const { exitCode: installExitCode, stderr: installStderr } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [
          join(root, 'node_modules', '.bin', 'npx') ?? 'npx',
          'npm',
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--prefix',
          workdir,
          tarballPath,
        ],
        {
          cwd: workdir,
          env: { ...process.env, npm_config_loglevel: 'error' },
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 300000,
        },
        (err, out, errOut) => {
          resolve({
            stdout: out ?? '',
            stderr: errOut ?? '',
            exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          });
        },
      );
    }).then(({ exitCode, stderr }) => ({ exitCode, stderr }));

    if (installExitCode !== 0) {
      fail(`npm install of the published tarball exited ${installExitCode}`);
      console.error(installStderr.slice(0, 800));
      return;
    }

    ok('the published tarball installs with npm');

    // ── 3. run the first command from the README ─────────────────────────
    const cliPath = join(workdir, 'node_modules', 'dominus-oss', 'dist', 'cli.js');
    if (!existsSync(cliPath)) {
      fail(`the installed artifact has no dist/cli.js (expected at ${cliPath})`);
      return;
    }

    const url = `http://127.0.0.1:${fixturePort}/tmsearch`;
    await startFixture();

    const { stdout: scoreStdout, stderr: scoreStderr, exitCode: scoreExit } =
      await new Promise((resolve) => {
        execFile(
          process.execPath,
          [cliPath, 'score', DOMAIN],
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
            timeout: 120000,
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

    const started = Date.now();
    const durationMs = Date.now() - started;

    // ── 4. the exit code ─────────────────────────────────────────────────
    if (scoreExit === 0) {
      ok('the command exits 0');
    } else {
      fail(
        `the command exited ${scoreExit}` +
          (scoreStderr ? `\n  stderr: ${scoreStderr.slice(0, 400)}` : ''),
      );
    }

    // ── 5. stdout carries the decision and nothing else ──────────────────
    const stdoutLines = scoreStdout.split('\n').filter((line) => line.trim() !== '');
    const logLines = stdoutLines.filter((line) => line.trim().startsWith('{'));
    if (logLines.length === 0) {
      ok('stdout carries no log lines');
    } else {
      fail(
        `stdout carries ${logLines.length} log line(s) - the output of a command must be the decision, ` +
          'not the diagnostics (the logs belong on stderr)',
      );
    }

    if (/^Score: vintagecoffee\.com$/m.test(scoreStdout)) {
      ok('the decision names the domain');
    } else {
      fail('the output does not contain the "Score: vintagecoffee.com" line');
    }

    // ── 6. the five numbers ──────────────────────────────────────────────
    for (const label of DECISION_LABELS) {
      if (scoreStdout.includes(label)) {
        ok(`the decision carries "${label}"`);
      } else {
        fail(`the decision does not carry "${label}"`);
      }
    }

    // ── 7. nothing written to the disk ───────────────────────────────────
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

    // ── 8. the time budget ───────────────────────────────────────────────
    if (durationMs <= TIME_BUDGET_MS) {
      ok(`the command finished in ${durationMs} ms`);
    } else {
      fail(`the command took ${durationMs} ms - over the ${TIME_BUDGET_MS} ms budget`);
    }

    await stopFixture();
  } catch (err) {
    await stopFixture().catch(() => {});
    fail(`check-published-install: ${err?.message ?? String(err)}`);
  } finally {
    if (workdir) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  if (process.exitCode === 1) {
    console.error(`check-published-install: FAIL`);
    process.exit(1);
  }
  console.log(`check-published-install: OK - the published artifact installs and answers`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`check-published-install: ${err?.message ?? String(err)}`);
  process.exit(1);
});
