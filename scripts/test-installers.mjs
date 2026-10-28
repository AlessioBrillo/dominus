#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The installer gate.
//
// `install.sh` and `install.ps1` are the first code a stranger executes, and
// until now they were the only shipped code with no test at all. The v1.3.4
// audit found two defects that a single run would have caught:
//
//   - the installers ran `npm install --prefix` without `-g`, so the binary
//     landed in `<prefix>/node_modules/.bin` while the script looked for
//     `<prefix>/bin/dominus` (and `<prefix>\bin\dominus.cmd` on Windows);
//     the installer printed "installed, but not on PATH" and exited 0 -
//     a silent success with no usable command;
//   - `DOMINUS_RELEASE_BASE` did not exist, so the download path could not
//     be pointed at a fixture and the script could not be tested at all.
//
// This gate runs the real installer against a local HTTP server that serves
// the real tarball and its checksum:
//
//   1. pack the working tree (or take `--tarball <path>`);
//   2. serve `dominus-oss.tgz` + `.sha256` on 127.0.0.1;
//   3. run the platform installer into a throwaway prefix;
//   4. assert the command exists where the installer says it does, and that
//      it answers `score` against a local trademark fixture;
//   5. serve a corrupted checksum and assert the installer refuses to
//      install anything.
//
// Usage:
//   node scripts/test-installers.mjs                  # pack, then test this platform
//   node scripts/test-installers.mjs --tarball x.tgz  # test a given artifact
//   node scripts/test-installers.mjs --shell          # force install.sh
//   node scripts/test-installers.mjs --powershell     # force install.ps1
//
// Exit 0 = the installer installs a working command, 1 = it does not.

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isWindows = process.platform === 'win32';

const args = process.argv.slice(2);

function argValue(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`test-installers: ${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

const tarballArg = argValue('--tarball');
const forcedShell = args.includes('--shell');
const forcedPowerShell = args.includes('--powershell');

if (forcedShell && forcedPowerShell) {
  console.error('test-installers: --shell and --powershell are mutually exclusive');
  process.exit(2);
}

const usePowerShell = forcedPowerShell || (!forcedShell && isWindows);

const DOMAIN = 'vintagecoffee.com';
const TIME_BUDGET_MS = 300_000;

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`[ok] ${message}`);
}

function run(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: TIME_BUDGET_MS,
        ...options,
      },
      (err, stdout, stderr) => {
        resolve({
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

/** Resolve the npm CLI without a shell (the same cascade as check-pack). */
function resolveNpm() {
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && existsSync(execPath)) {
    return { file: process.execPath, args: [execPath] };
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(bundled)) {
    return { file: process.execPath, args: [bundled] };
  }
  // Last resort: a shell, because Windows cannot execFile a .cmd directly.
  return { file: 'npm', args: [], shell: true };
}

/** Pack the working tree and return the tarball path. */
function packArtifact() {
  const destination = mkdtempSync(join(tmpdir(), 'dominus-installer-pack-'));
  const npm = resolveNpm();
  const raw = execFileSync(
    npm.file,
    [
      ...npm.args,
      'pack',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      destination,
    ],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, shell: npm.shell === true },
  );
  const start = raw.search(/[[{]/);
  const parsed = JSON.parse(raw.slice(start));
  const pack = Array.isArray(parsed) ? parsed[0] : parsed;
  const tarball = join(destination, pack.filename);
  if (!existsSync(tarball)) {
    throw new Error(`npm pack reported ${pack.filename} but the file is missing`);
  }
  return tarball;
}

function findCli(prefix) {
  const candidates = [
    join(prefix, 'node_modules', 'dominus-oss', 'dist', 'cli.js'),
    join(prefix, 'lib', 'node_modules', 'dominus-oss', 'dist', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Last resort: a bounded walk, so a change in npm's global layout does not
  // turn a working install into a false negative.
  const walk = (dir, depth) => {
    if (depth > 6) return null;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && full.endsWith(join('dominus-oss', 'dist', 'cli.js'))) {
        return full;
      }
      if (entry.isDirectory()) {
        const found = walk(full, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(prefix, 0);
}

function startServer(tarballBytes) {
  const state = { checksum: null };
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];

    // The trademark fixture: an empty hit set, so `vintagecoffee.com` is
    // deterministically clear without touching the network.
    if (url === '/tmsearch') {
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
      return;
    }

    if (url === '/dominus-oss.tgz') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': tarballBytes.length,
      });
      res.end(tarballBytes);
      return;
    }

    if (url === '/dominus-oss.tgz.sha256') {
      const payload = state.checksum;
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
      });
      res.end(payload);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ server, port, state });
    });
    server.on('error', reject);
  });
}

async function installOnce({ installer, baseUrl, prefix }) {
  const env = {
    ...process.env,
    DOMINUS_RELEASE_BASE: baseUrl,
    DOMINUS_INSTALL_PREFIX: prefix,
  };

  // PowerShell 7 exports its own PSModulePath. Windows PowerShell 5.1 then
  // cannot find its own modules (`Get-FileHash` among them), which is an
  // artifact of the CI shell, not of the installer. Let 5.1 build its own.
  if (usePowerShell) {
    delete env.PSModulePath;
  }

  return usePowerShell
    ? await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installer],
        { env },
      )
    : await run('bash', [installer], { env });
}

function describeFailure(label, result) {
  return (
    `${label}: the installer exited ${result.exitCode}` +
    (result.stderr ? `\n  stderr: ${result.stderr.slice(0, 800)}` : '')
  );
}

async function main() {
  let workdir;
  let server;
  try {
    const tarball = tarballArg ? tarballArg : packArtifact();
    if (!existsSync(tarball)) {
      fail(`the tarball does not exist: ${tarball}`);
      return;
    }
    ok(`artifact: ${tarball}`);

    const tarballBytes = readFileSync(tarball);
    const digest = createHash('sha256').update(tarballBytes).digest('hex');

    workdir = mkdtempSync(join(tmpdir(), 'dominus-installer-'));
    const { server: httpServer, port, state } = await startServer(tarballBytes);
    server = httpServer;
    const baseUrl = `http://127.0.0.1:${port}`;

    const installer = join(root, 'scripts', usePowerShell ? 'install.ps1' : 'install.sh');
    const label = usePowerShell ? 'install.ps1' : 'install.sh';

    // ── positive path: checksum matches, the command is installed ────────
    state.checksum = `${digest}  dominus-oss.tgz\n`;
    const prefix = join(workdir, 'prefix');
    mkdirSync(prefix, { recursive: true });

    const installed = await installOnce({ installer, baseUrl, prefix });
    if (installed.exitCode === 0) {
      ok(`${label}: the installer exits 0`);
    } else {
      fail(describeFailure(label, installed));
    }

    const bin = usePowerShell ? join(prefix, 'dominus.cmd') : join(prefix, 'bin', 'dominus');
    if (existsSync(bin)) {
      ok(`${label}: the command is installed where the script says it is (${bin})`);
    } else {
      fail(
        `${label}: the command is not at ${bin} - the installer printed success but installed ` +
          'somewhere else',
      );
    }

    const cli = findCli(prefix);
    if (cli === null) {
      fail(`${label}: the installed package has no dist/cli.js`);
    } else {
      ok(`${label}: the installed package carries dist/cli.js`);
      const score = await run(process.execPath, [cli, 'score', DOMAIN], {
        env: {
          ...process.env,
          KEYWORD_DATA_PATH: join(root, 'examples', 'keywords-sample.json'),
          COMPS_DATA_PATH: join(root, 'examples', 'comps-sample.csv'),
          LOG_PRETTY: 'false',
          USPTO_SEARCH_URL: `${baseUrl}/tmsearch`,
        },
        timeout: 120_000,
      });
      if (score.exitCode === 0) {
        ok(`${label}: the installed command answers (exit 0)`);
      } else {
        fail(
          `${label}: the installed command exited ${score.exitCode}` +
            (score.stderr ? `\n  stderr: ${score.stderr.slice(0, 800)}` : ''),
        );
      }
      if (/Verdict:\s+clear/.test(score.stdout)) {
        ok(`${label}: the installed command used the trademark fixture (clear)`);
      } else {
        fail(`${label}: the installed command did not report a clear trademark verdict`);
      }
      if (/Recommended:/.test(score.stdout)) {
        ok(`${label}: the installed command prints a recommendation`);
      } else {
        fail(`${label}: the installed command does not print a recommendation`);
      }
    }

    // ── negative path: a corrupted checksum installs nothing ─────────────
    state.checksum = `${'0'.repeat(64)}  dominus-oss.tgz\n`;
    const badPrefix = join(workdir, 'prefix-corrupt');
    mkdirSync(badPrefix, { recursive: true });
    const corrupted = await installOnce({
      installer,
      baseUrl,
      prefix: badPrefix,
    });

    if (corrupted.exitCode !== 0) {
      ok(`${label}: a corrupted checksum is refused`);
    } else {
      fail(`${label}: a corrupted checksum was accepted`);
    }

    const badBin = usePowerShell
      ? join(badPrefix, 'dominus.cmd')
      : join(badPrefix, 'bin', 'dominus');
    if (!existsSync(badBin)) {
      ok(`${label}: a corrupted checksum leaves no command behind`);
    } else {
      fail(`${label}: a corrupted checksum still installed a command`);
    }
  } catch (err) {
    fail(`test-installers: ${err?.message ?? String(err)}`);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (workdir) {
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }

  if (process.exitCode === 1) {
    console.error('test-installers: FAIL');
    process.exit(1);
  }
  console.log('test-installers: OK - the installer installs a command that answers');
  process.exit(0);
}

main().catch((err) => {
  console.error(`test-installers: ${err?.message ?? String(err)}`);
  process.exit(1);
});
