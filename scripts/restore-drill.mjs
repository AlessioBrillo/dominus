#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// DOMINUS backup restore drill.
//
// WHY THIS FILE EXISTS
//
// A backup that has never been restored is a hypothesis, not a backup.
// This script is the part of the stack that turns the hypothesis into
// evidence. It implements the two automatable levels of the recovery
// runbook (docs/operations/rto-rpo.md §3): the third level — promoting
// the restored instance into production — stays a manual, operator-
// judged step and is deliberately not scripted here.
//
//   MODE 1 — SQLite (default) — the live database goes through the
//      online backup API, the copy is re-opened, `integrity_check` must
//      pass and every table must come back with the same row count.
//      That is the community-edition path: it needs nothing but Node
//      and runs on a developer machine.
//
//   MODE 2 — `--pg-base <dir>` — a STATIC inspection of a `pg_basebackup`
//      output. The layout must contain PG_VERSION / global / pg_wal and
//      a backup_label or backup_manifest, and the manifest is parsed for
//      the PostgreSQL version, the system identifier and the WAL start
//      location. It proves the FILES are what they claim to be; it
//      proves nothing whatsoever about the DATA. It runs anywhere, CI
//      included.
//
//   MODE 3 — `--pg-restore` — the real point-in-time-recovery
//      rehearsal. The base is staged into a throwaway data directory,
//      the WAL archive is replayed on top of it, the drill WAITS for the
//      recovery to finish (a restore that is still replaying is not a
//      restore), the row counts are compared against what the operator
//      expects, and the cluster is stopped again so the drill leaves
//      nothing behind.
//
// WHY MODE 3 IS OPT-IN
//
// Mode 2 is what CI can run anywhere. Mode 3 needs a host with the
// PostgreSQL client tools, a base backup and a WAL archive; it copies
// the whole data directory to disk and it takes minutes. It must never
// run by accident: the default invocation touches no PostgreSQL at all.
//
// THE DEFECT THIS FILE FIXES
//
// `--pg-base` used to be called "the PITR drill" while only listing a
// directory. An operator who saw it pass had learned that a folder
// existed — not that the backup could be restored, not that the WAL
// could be replayed, and not that the restored rows were the rows that
// were backed up. A drill that cannot fail is not a drill. Mode 3 is
// the mode that can fail, and it is the only evidence that the RTO in
// docs/operations/rto-rpo.md is real.
//
// Usage:
//   node scripts/restore-drill.mjs [path-to-dominus.db]
//   node scripts/restore-drill.mjs --pg-base <base-dir>
//   node scripts/restore-drill.mjs --pg-restore --base <base-dir> --wal <wal-dir> \
//       [--target-time "<UTC timestamp>"] [--port <port>] [--expect-rows <table>:<count>] ...
//   node scripts/restore-drill.mjs --help
//
// exit 0 = green, exit 1 = red (restore unusable).

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RESTORE_SCRIPT = join(ROOT, 'deploy', 'postgres', 'restore-base.sh');
const ARGV = process.argv.slice(2);

const USAGE = [
  'Usage:',
  '  node scripts/restore-drill.mjs [path-to-dominus.db]',
  '  node scripts/restore-drill.mjs --pg-base <base-dir>',
  '  node scripts/restore-drill.mjs --pg-restore --base <base-dir> --wal <wal-dir> \\',
  '      [--target-time "<UTC timestamp>"] [--port <port>] [--expect-rows <table>:<count>] ...',
  '',
  'Options of --pg-restore:',
  '  --base <dir>            pg_basebackup output to restore (required)',
  '  --wal <dir>             local WAL archive directory to replay (required)',
  '  --target-time "<ts>"    UTC recovery target, e.g. "2026-08-12 09:30:00 UTC"',
  '  --port <port>           port of the restored cluster (default 55432)',
  '  --expect-rows <t>:<n>   expected row count of table <t>; repeatable',
  '  --timeout <seconds>     recovery timeout (default 300)',
  '  --dbname <name>         database to query on the restored instance (default dominus)',
  '  --user <name>           role to connect with (default postgres)',
  '  --socket-dir <dir>      fallback unix socket dir (default /var/run/postgresql)',
  '  --keep-data             keep the restored data directory for inspection',
].join('\n');

/** An expected failure of the rehearsal: reported, never swallowed. */
class DrillError extends Error {}

function fail(message) {
  console.error(`restore-drill: FAIL - ${message}`);
  process.exit(1);
}

function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    total += statSync(abs).isDirectory() ? dirSize(abs) : statSync(abs).size;
  }
  return total;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mode 2: PostgreSQL base-backup static integrity (ADR-0054) ─────────
// A pg_basebackup output must contain PG_VERSION, global/pg_control and a
// backup label/manifest. This is the CI-testable part of the PITR drill;
// it proves the LAYOUT, not the data — the rehearsal (--pg-restore) is
// what proves the data.
function checkPgBase(baseDir) {
  const required = ['PG_VERSION', 'global', 'pg_wal'];
  for (const entry of required) {
    if (!existsSync(join(baseDir, entry))) {
      fail(`postgres base backup ${baseDir} is missing ${entry}`);
    }
  }
  if (!existsSync(join(baseDir, 'backup_label')) && !existsSync(join(baseDir, 'backup_manifest'))) {
    fail(`postgres base backup ${baseDir} has no backup_label/backup_manifest`);
  }
  const version = String(readFileSyncSafe(join(baseDir, 'PG_VERSION')) ?? '?').trim();
  const size = dirSize(baseDir);
  console.log(`restore-drill: OK - postgres base backup ${baseDir} (PG ${version}, ${size} bytes)`);

  // The manifest is plain-text JSON: the metadata keys sit at the top of
  // the file, before the (potentially huge) file list, so only the head
  // is read. Every field is optional — a manifest without a system
  // identifier is still a valid manifest, and a missing optional field
  // must never fail the drill.
  const manifestPath = join(baseDir, 'backup_manifest');
  if (existsSync(manifestPath)) {
    const fields = parseManifestFields(readManifestHead(manifestPath));
    const parts = [];
    if (fields.systemIdentifier) parts.push(`system ${fields.systemIdentifier}`);
    if (fields.startLocation) parts.push(`WAL start ${fields.startLocation}`);
    if (fields.startTime) parts.push(`start time ${fields.startTime}`);
    if (parts.length > 0) {
      console.log(`restore-drill: manifest - ${parts.join(', ')}`);
    }
  }
}

const MANIFEST_HEAD_BYTES = 256 * 1024;

/** Read the first slice of a file without loading the whole thing. */
function readManifestHead(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(MANIFEST_HEAD_BYTES);
    const read = readSync(fd, buffer, 0, MANIFEST_HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Pull the interesting fields out of a `pg_basebackup` manifest.
 *
 * The manifest is JSON, but it also lists every file of the backup, so
 * it is parsed with targeted patterns instead of JSON.parse: a partial
 * or unexpected manifest must degrade to "field unknown", never to a
 * failed drill.
 */
function parseManifestFields(text) {
  const take = (key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
    return match ? match[1] : null;
  };
  return {
    systemIdentifier: take('PostgreSQL-Backup-System-Identifier'),
    startLocation: take('PostgreSQL-Backup-Start-Location'),
    startTime: take('PostgreSQL-Backup-Start-Time'),
  };
}

// ── Mode 3: the real point-in-time-recovery rehearsal ─────────────────
const PG_DEFAULT_PORT = 55432;
const PG_DEFAULT_TIMEOUT_S = 300;
const PG_DEFAULT_DBNAME = 'dominus';
const PG_DEFAULT_USER = 'postgres';
const PG_DEFAULT_SOCKET_DIR = '/var/run/postgresql';
const PG_POLL_INTERVAL_MS = 2000;
const PG_RESTORE_SCRIPT_TIMEOUT_MS = 3600 * 1000;
const PG_QUERY_TIMEOUT_MS = 60 * 1000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** The exact command the operator ran, echoed back in every error message. */
function drillCommand() {
  return `node scripts/restore-drill.mjs ${ARGV.join(' ')}`;
}

/**
 * Parse the `--pg-restore` options.
 *
 * Every flag is explicit: the drill must never guess which base, which
 * archive or which database to touch, and it must never fall back to a
 * default instance.
 */
function parsePgRestoreOptions(argv) {
  const spec = {
    '--base': { key: 'base', type: 'value' },
    '--wal': { key: 'wal', type: 'value' },
    '--target-time': { key: 'targetTime', type: 'value' },
    '--port': { key: 'port', type: 'value' },
    '--expect-rows': { key: 'expectations', type: 'list' },
    '--timeout': { key: 'timeout', type: 'value' },
    '--dbname': { key: 'dbname', type: 'value' },
    '--user': { key: 'user', type: 'value' },
    '--socket-dir': { key: 'socketDir', type: 'value' },
    '--keep-data': { key: 'keepData', type: 'boolean' },
  };

  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      fail(`unexpected argument '${arg}'\n${USAGE}`);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const def = spec[name];
    if (!def) {
      fail(`unknown option '${name}'\n${USAGE}`);
    }
    if (def.type === 'boolean') {
      parsed[def.key] = inline === null ? true : inline !== 'false';
      continue;
    }
    const value = inline !== null ? inline : argv[(i += 1)];
    if (value === undefined) {
      fail(`option '${name}' requires a value\n${USAGE}`);
    }
    if (def.type === 'list') {
      parsed[def.key] = [...(parsed[def.key] ?? []), value];
      continue;
    }
    parsed[def.key] = value;
  }

  if (!parsed.base) fail(`--pg-restore requires --base <base-dir>\n${USAGE}`);
  if (!parsed.wal) fail(`--pg-restore requires --wal <wal-dir>\n${USAGE}`);

  const port = Number(parsed.port ?? PG_DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`--port must be a TCP port number, got '${parsed.port}'`);
  }
  const timeout = Number(parsed.timeout ?? PG_DEFAULT_TIMEOUT_S);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    fail(`--timeout must be a number of seconds, got '${parsed.timeout}'`);
  }

  return {
    base: parsed.base,
    wal: parsed.wal,
    targetTime: parsed.targetTime ?? null,
    port,
    timeoutMs: timeout * 1000,
    expectations: (parsed.expectations ?? []).map(parseExpectation),
    dbname: parsed.dbname ?? PG_DEFAULT_DBNAME,
    user: parsed.user ?? PG_DEFAULT_USER,
    socketDir: parsed.socketDir ?? PG_DEFAULT_SOCKET_DIR,
    keepData: parsed.keepData === true,
  };
}

/**
 * Parse a `<table>:<count>` expectation.
 *
 * The table name is validated and quoted: the drill passes SQL to psql
 * as an argument, and an unvalidated identifier is an injection hole
 * even without a shell.
 */
function parseExpectation(raw) {
  const sep = raw.lastIndexOf(':');
  if (sep <= 0) {
    fail(`--expect-rows must be <table>:<count>, got '${raw}'`);
  }
  const table = raw.slice(0, sep);
  const count = Number(raw.slice(sep + 1));
  if (!Number.isInteger(count) || count < 0) {
    fail(`--expect-rows count must be a non-negative integer, got '${raw.slice(sep + 1)}'`);
  }
  const parts = table.split('.');
  for (const part of parts) {
    if (!IDENTIFIER.test(part)) {
      fail(`--expect-rows table '${table}' is not a plain SQL identifier`);
    }
  }
  return { table, count, quoted: parts.map((p) => `"${p}"`).join('.') };
}

/** Fail closed when a tool the rehearsal needs is not installed. */
function requireCommand(command, hint) {
  const probe = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 30000 });
  if (probe.error) {
    throw new DrillError(
      `${command} is not available on this host (${hint}).\n` +
        `  Install it and re-run:\n  ${drillCommand()}`,
    );
  }
}

/**
 * The rehearsal only makes sense on a real `pg_basebackup` output and a
 * real WAL archive: a directory that does not look like a base backup
 * would "restore" into a cluster that never recovers, and the drill
 * would report a meaningless failure (or, worse, a meaningless pass).
 */
function assertRestorePrerequisites(opts) {
  requireCommand('bash', 'the restore script is a bash script');
  requireCommand('psql', 'the rehearsal queries the restored instance');
  requireCommand('pg_ctl', 'the rehearsal starts and stops the restored cluster');

  if (!existsSync(RESTORE_SCRIPT)) {
    throw new DrillError(
      `${RESTORE_SCRIPT} is missing — run the drill from a checkout that contains deploy/postgres/.\n` +
        `  Then re-run:\n  ${drillCommand()}`,
    );
  }

  for (const entry of ['PG_VERSION', join('global', 'pg_control')]) {
    if (!existsSync(join(opts.base, entry))) {
      throw new DrillError(
        `${opts.base} does not look like a pg_basebackup output (missing ${entry}).\n` +
          `  Point --base at a real base backup and re-run:\n  ${drillCommand()}`,
      );
    }
  }
  if (
    !existsSync(join(opts.base, 'backup_label')) &&
    !existsSync(join(opts.base, 'backup_manifest'))
  ) {
    throw new DrillError(
      `${opts.base} has no backup_label/backup_manifest — it is not a base backup.\n` +
        `  Point --base at a real base backup and re-run:\n  ${drillCommand()}`,
    );
  }

  if (!existsSync(opts.wal) || !statSync(opts.wal).isDirectory()) {
    throw new DrillError(
      `the WAL archive directory ${opts.wal} does not exist.\n` +
        `  The restore script replays from a LOCAL directory: pull the segments down ` +
        `(rclone copy b2:<bucket>/wal/ ${opts.wal}) and re-run:\n  ${drillCommand()}`,
    );
  }
}

/**
 * Run deploy/postgres/restore-base.sh.
 *
 * The script stages the base, writes the restore_command, starts the
 * cluster on the drill port and LEAVES IT RUNNING — it does not wait for
 * the WAL replay to finish and it does not verify a single row. The
 * output is captured to a file (not a pipe) so a postmaster that
 * inherits the file descriptors can never block the drill.
 */
function runRestoreScript(opts, dataDir, logPath) {
  const fd = openSync(logPath, 'w');
  try {
    const args = [RESTORE_SCRIPT, opts.base, opts.wal];
    if (opts.targetTime) args.push(opts.targetTime);
    const result = spawnSync('bash', args, {
      env: {
        ...process.env,
        PG_RESTORE_PORT: String(opts.port),
        PG_RESTORE_DATA_DIR: dataDir,
      },
      stdio: ['ignore', fd, fd],
      timeout: PG_RESTORE_SCRIPT_TIMEOUT_MS,
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      output: readFileSyncSafe(logPath) ?? '',
    };
  } finally {
    closeSync(fd);
  }
}

function printRestoreOutput(output) {
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    console.log(`restore-drill: | ${line}`);
  }
}

/** The ways the drill is allowed to reach the restored instance. */
function connectionCandidates(opts) {
  const candidates = [{ label: 'tcp 127.0.0.1', hostArgs: ['-h', '127.0.0.1'] }];
  if (opts.socketDir) {
    candidates.push({ label: `unix socket ${opts.socketDir}`, hostArgs: ['-h', opts.socketDir] });
  }
  return candidates.map((candidate) => ({
    ...candidate,
    port: opts.port,
    user: opts.user,
    dbname: opts.dbname,
  }));
}

/** Run one query on the restored instance. Never throws. */
function psqlQuery(candidate, sql) {
  const args = [
    '-X',
    '-q',
    '-t',
    '-A',
    '-v',
    'ON_ERROR_STOP=1',
    ...candidate.hostArgs,
    '-p',
    String(candidate.port),
    '-U',
    candidate.user,
    '-d',
    candidate.dbname,
    '-c',
    sql,
  ];
  const result = spawnSync('psql', args, {
    encoding: 'utf8',
    timeout: PG_QUERY_TIMEOUT_MS,
    // stdin is closed: psql must never sit waiting for a password
    // prompt on the operator's terminal, and the drill must never
    // swallow the input of the shell that started it.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'dominus-restore-drill',
    },
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || '').trim() || `psql exited with ${result.status}`,
    };
  }
  return { ok: true, value: (result.stdout || '').trim() };
}

/**
 * The lines the restored cluster wrote while it replayed the WAL.
 *
 * restore-base.sh points the server's stderr at ${DATA_DIR}/recovery.log,
 * but a cluster with logging_collector=on writes to ${DATA_DIR}/log/*.log
 * instead — both are read so the drill can report what the replay did
 * whatever the server's logging configuration is.
 */
function readRecoveryLogLines(dataDir) {
  const paths = [];
  const main = join(dataDir, 'recovery.log');
  if (existsSync(main)) paths.push(main);
  const logDir = join(dataDir, 'log');
  if (existsSync(logDir) && statSync(logDir).isDirectory()) {
    for (const entry of readdirSync(logDir)) {
      if (entry.endsWith('.log')) paths.push(join(logDir, entry));
    }
  }
  const lines = [];
  for (const path of paths) {
    const text = readFileSyncSafe(path);
    if (text) lines.push(...text.split('\n'));
  }
  return lines;
}

/**
 * What the replay actually did.
 *
 * `fatal` is the case the drill must not paper over: PostgreSQL aborts
 * the recovery when the archive runs out before the requested target
 * time, which means the operator's requested point in time does not
 * exist in the archive — the drill would otherwise report a "restored"
 * database that is silently short of the target.
 */
function scanRecoveryLog(dataDir) {
  const scan = { fatal: null, stopLocation: null, stopTime: null, complete: false };
  for (const line of readRecoveryLogLines(dataDir)) {
    if (/recovery ended before configured recovery target was reached/.test(line)) {
      scan.fatal =
        'the WAL archive ended before the requested recovery target was reached — ' +
        'the requested point in time is not in the archive';
    }
    const stopAfter = /recovery stopping after WAL location \(LSN\) "([^"]+)"/.exec(line);
    if (stopAfter) scan.stopLocation = stopAfter[1];
    const stopBefore = /recovery stopping before commit of transaction \d+, time ([^\r\n]+)/.exec(
      line,
    );
    if (stopBefore) scan.stopTime = stopBefore[1].trim();
    if (/archive recovery complete/.test(line)) scan.complete = true;
  }
  return scan;
}

/**
 * Wait for the recovery to FINISH.
 *
 * This is the step the restore script does not do: `pg_ctl start -w`
 * only waits for the server to accept connections, which it does while
 * the WAL is still being replayed. The drill polls `pg_is_in_recovery()`
 * until the server says it is a normal primary again, with a bounded
 * timeout so the drill can never hang forever.
 */
async function waitForRecovery(opts, dataDir) {
  const deadline = Date.now() + opts.timeoutMs;
  const candidates = connectionCandidates(opts);
  let last = 'the restored instance did not accept any connection';
  while (Date.now() < deadline) {
    const scan = scanRecoveryLog(dataDir);
    if (scan.fatal) throw new DrillError(scan.fatal);
    for (const candidate of candidates) {
      const state = psqlQuery(candidate, 'SELECT pg_is_in_recovery()');
      if (!state.ok) {
        last = `${candidate.label}: ${state.error}`;
        continue;
      }
      const inRecovery = state.value.trim().toLowerCase();
      if (inRecovery === 'f' || inRecovery === 'false') {
        return { candidate, scan };
      }
      last = `the restored instance is still replaying WAL (via ${candidate.label})`;
      break;
    }
    await sleep(PG_POLL_INTERVAL_MS);
  }
  throw new DrillError(
    `the restored instance was still in recovery after ${Math.round(opts.timeoutMs / 1000)}s — ${last}\n` +
      `  Raise --timeout if the archive is large, and check the recovery log in the restored data directory.\n` +
      `  Re-run:\n  ${drillCommand()}`,
  );
}

/**
 * Prove the instance we are talking to IS the restored backup.
 *
 * The system identifier is written in the base backup's manifest and
 * read back from the restored control file: if they differ, the drill
 * is talking to some other server that happens to sit on the drill port
 * — the exact mistake this rehearsal must never make.
 */
function assertRestoredInstance(candidate, baseDir) {
  const fields = parseManifestFields(readManifestHead(join(baseDir, 'backup_manifest')));
  if (!fields.systemIdentifier) {
    console.log(
      'restore-drill: WARN - the base backup has no manifest system identifier, ' +
        'the restored instance could not be identified',
    );
    return;
  }
  const result = psqlQuery(candidate, 'SELECT system_identifier::text FROM pg_control_system()');
  if (!result.ok) {
    console.log(
      `restore-drill: WARN - could not read the system identifier of the restored instance ` +
        `(${result.error}) — the instance was not identified`,
    );
    return;
  }
  if (result.value !== fields.systemIdentifier) {
    throw new DrillError(
      `the instance on port ${candidate.port} is not the restored backup: ` +
        `system identifier ${result.value} != ${fields.systemIdentifier}`,
    );
  }
  console.log(
    `restore-drill: identity - restored instance matches the base backup (${result.value})`,
  );
}

/** Compare the row counts the operator expects with the restored ones. */
function verifyRowCounts(candidate, expectations) {
  if (expectations.length === 0) {
    const smoke = psqlQuery(candidate, 'SELECT count(*) FROM schema_migrations');
    if (!smoke.ok) {
      throw new DrillError(
        `the smoke query failed on the restored instance: ${smoke.error} — ` +
          'the restored database does not look like a DOMINUS schema',
      );
    }
    console.log(`restore-drill: smoke - schema_migrations holds ${smoke.value} rows`);
    return 'schema_migrations=' + smoke.value + ' rows';
  }
  const verified = [];
  for (const expectation of expectations) {
    const result = psqlQuery(candidate, `SELECT count(*) FROM ${expectation.quoted}`);
    if (!result.ok) {
      throw new DrillError(
        `the row count of "${expectation.table}" could not be read: ${result.error}`,
      );
    }
    const actual = Number(result.value);
    if (!Number.isFinite(actual)) {
      throw new DrillError(
        `the row count of "${expectation.table}" is '${result.value}', which is not a number`,
      );
    }
    if (actual !== expectation.count) {
      throw new DrillError(
        `row count mismatch for "${expectation.table}": expected ${expectation.count}, ` +
          `the restored instance has ${actual}`,
      );
    }
    verified.push(`${expectation.table}=${actual}`);
  }
  console.log(`restore-drill: rows - verified ${verified.join(', ')}`);
  return `verified ${verified.join(', ')}`;
}

/** Stop the restored cluster. The drill must leave nothing running. */
function stopRestoredCluster(dataDir) {
  if (!existsSync(join(dataDir, 'postmaster.pid'))) return true;
  for (const mode of ['fast', 'immediate']) {
    const result = spawnSync('pg_ctl', ['-D', dataDir, 'stop', '-m', mode, '-w'], {
      encoding: 'utf8',
      timeout: PG_QUERY_TIMEOUT_MS,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0 || /not running|no server running|not found/i.test(output)) {
      return true;
    }
  }
  return false;
}

/** The last words of the restored cluster, for a failed drill. */
function printRecoveryLogTail(dataDir) {
  const lines = readRecoveryLogLines(dataDir);
  if (lines.length === 0) return;
  console.error('restore-drill: --- last lines of the restored cluster log ---');
  for (const line of lines.slice(-30)) {
    if (line.trim() === '') continue;
    console.error(`restore-drill: | ${line}`);
  }
}

/**
 * The rehearsal.
 *
 * Restore, replay, wait, verify, stop — in that order, and the stop
 * happens whatever the outcome is.
 */
async function runPgRestore(opts) {
  const startedAt = Date.now();
  const workDir = mkdtempSync(join(tmpdir(), 'dominus-pg-restore-'));
  const dataDir = join(workDir, 'pgdata');
  mkdirSync(dataDir, { recursive: true });
  const restoreLogPath = join(workDir, 'restore-base.log');

  let error = null;
  let summary = '';

  try {
    assertRestorePrerequisites(opts);

    const target = opts.targetTime ? ` to ${opts.targetTime}` : ' (replay the whole archive)';
    console.log(
      `restore-drill: restoring ${opts.base}${target} with the WAL archive ${opts.wal} ` +
        `into ${dataDir} on port ${opts.port}`,
    );

    const restore = runRestoreScript(opts, dataDir, restoreLogPath);
    printRestoreOutput(restore.output);
    if (restore.error) {
      throw new DrillError(
        `deploy/postgres/restore-base.sh could not be run: ${restore.error.message}`,
      );
    }
    if (restore.status !== 0) {
      throw new DrillError(
        `deploy/postgres/restore-base.sh exited with code ${restore.status}` +
          `${restore.signal ? ` (signal ${restore.signal})` : ''} — see its output above`,
      );
    }

    const { candidate, scan } = await waitForRecovery(opts, dataDir);
    const recoverySeconds = (Date.now() - startedAt) / 1000;

    const stop = scan.stopLocation
      ? `replay stopped at ${scan.stopLocation}${scan.stopTime ? ` (${scan.stopTime})` : ''}`
      : scan.complete
        ? 'replay reached the end of the archive'
        : 'replay stop not reported by the server log';
    console.log(`restore-drill: replay - ${stop}`);
    if (opts.targetTime && !scan.stopLocation) {
      console.log(
        'restore-drill: WARN - the server log does not confirm the requested target time; ' +
          'check the recovery log in the restored data directory',
      );
    }

    assertRestoredInstance(candidate, opts.base);
    const rows = verifyRowCounts(candidate, opts.expectations);

    summary = `recovery ${recoverySeconds.toFixed(1)}s, ${stop}, ${rows}`;
  } catch (err) {
    error = err instanceof Error ? err : new Error(String(err));
    printRecoveryLogTail(dataDir);
  } finally {
    const stopped = stopRestoredCluster(dataDir);
    if (!stopped) {
      console.error(
        `restore-drill: WARN - the restored cluster could not be stopped — stop it with:\n` +
          `  pg_ctl -D ${dataDir} stop -m immediate`,
      );
    }
    if (opts.keepData) {
      console.log(`restore-drill: the restored data directory is kept at ${workDir}`);
    } else {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  if (error) {
    console.error(
      `restore-drill: FAIL - postgres PITR rehearsal: ${error.message} (${totalSeconds.toFixed(1)}s)`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `restore-drill: OK - postgres PITR rehearsal: ${summary} (${totalSeconds.toFixed(1)}s)`,
  );
}

// ── Dispatch ───────────────────────────────────────────────────────────
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

if (ARGV.includes('--pg-restore')) {
  const options = parsePgRestoreOptions(ARGV.filter((arg) => arg !== '--pg-restore'));
  await runPgRestore(options);
  process.exit(process.exitCode ?? 0);
}

const pgBaseIndex = ARGV.indexOf('--pg-base');
if (pgBaseIndex !== -1) {
  const baseDir = ARGV[pgBaseIndex + 1];
  if (!baseDir) fail('--pg-base requires a directory argument');
  checkPgBase(baseDir);
  process.exit(0);
}

if (ARGV[0] && ARGV[0].startsWith('--')) {
  fail(`unknown option '${ARGV[0]}'\n${USAGE}`);
}

const dbPath = ARGV[0] ?? './data/dominus.db';

let source = null;
let restored = null;
let backupFile = null;

try {
  source = new Database(dbPath, { readonly: true });

  const tableNames = source
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all()
    .map((r) => r.name);

  const sourceCounts = Object.fromEntries(
    tableNames.map((t) => [t, source.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]),
  );

  console.log(`restore-drill: backing up ${dbPath} (${tableNames.length} tables)`);

  // Use the online backup API (WAL-safe), not a file copy.
  backupFile = join(mkdtempSync(join(tmpdir(), 'dominus-restore-drill-')), 'drill.db');
  await source.backup(backupFile);

  restored = new Database(backupFile, { readonly: true });
  const integrity = restored.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') {
    fail(`integrity_check returned '${integrity}' on the restored copy`);
  }

  const diverged = [];
  for (const table of tableNames) {
    const n = restored.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
    if (n !== sourceCounts[table]) {
      diverged.push(`${table}: ${sourceCounts[table]} -> ${n}`);
    }
  }

  if (diverged.length > 0) {
    fail(`row counts diverged after restore: ${diverged.join(', ')}`);
  }

  const totalRows = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
  console.log(
    `restore-drill: OK - ${tableNames.length} tables, ${totalRows} rows, integrity verified`,
  );
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  if (source) source.close();
  if (restored) restored.close();
  if (backupFile) rmSync(backupFile, { force: true });
}
