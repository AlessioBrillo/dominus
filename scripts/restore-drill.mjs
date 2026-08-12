#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// DOMINUS backup restore drill.
//
// Verifies that the SQLite database can be backed up and re-opened
// without corruption, and that every table survives with the same
// row count. Run at least once per release (see docs/deployment/README.md).
//
// Usage:
//   node scripts/restore-drill.mjs [path-to-dominus.db]
//   node scripts/restore-drill.mjs --pg-base <dir>  # static PG base-backup check
//   exit 0 = green, exit 1 = red (restore unusable)

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);

function fail(message) {
  console.error(`restore-drill: FAIL - ${message}`);
  process.exit(1);
}

// ── Mode 2: PostgreSQL base-backup static integrity (ADR-0054) ─────────
// A pg_basebackup output must contain PG_VERSION, global/pg_control and a
// backup label/manifest. This is the CI-testable part of the PITR drill;
// the live replay itself runs on the host via deploy/postgres/restore-base.sh.
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
  console.log(
    `restore-drill: OK - postgres base backup ${baseDir} (PG ${version}, ${size} bytes)`,
  );
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

const pgBaseIndex = args.indexOf('--pg-base');
if (pgBaseIndex !== -1) {
  const baseDir = args[pgBaseIndex + 1];
  if (!baseDir) fail('--pg-base requires a directory argument');
  checkPgBase(baseDir);
  process.exit(0);
}

const dbPath = args[0] ?? './data/dominus.db';

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