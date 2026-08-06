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
//   exit 0 = green, exit 1 = red (restore unusable)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dbPath = process.argv[2] ?? './data/dominus.db';

function fail(message) {
  console.error(`restore-drill: FAIL - ${message}`);
  process.exit(1);
}

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