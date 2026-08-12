#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
//
// DOMINUS community-to-Cloud data migration CLI (ADR-0027 zero lock-in).
//
// Usage:
//   # Phase 1 — export the SQLite database to a portable JSONL file
//   npx tsx scripts/migrate-sqlite-to-pg.ts export ./data/dominus.db ./data/dominus-export.jsonl
//
//   # Phase 2 — import into PostgreSQL (target schema must be migrated:
//   # start the Cloud stack once, or run `dominus maintenance migrate`)
//   DATABASE_URL=postgres://user:pass@host:5432/dominus \
//     npx tsx scripts/migrate-sqlite-to-pg.ts import ./data/dominus-export.jsonl
//
//   # Phase 3 — verify row counts match the export
//   DATABASE_URL=postgres://user:pass@host:5432/dominus \
//     npx tsx scripts/migrate-sqlite-to-pg.ts verify ./data/dominus-export.jsonl
//
// The import runs in a single transaction and must run as the table
// owner (the DATABASE_URL app role). See docs/migration/community-to-cloud.md.

import { Pool } from 'pg';
import {
  exportSqliteToJsonl,
  importJsonlToPg,
  verifyImport,
} from '../src/db/sqlite-to-pg-migrator.js';

const [command, arg1, arg2] = process.argv.slice(2);

function usageAndExit(code: number): never {
  console.error(
    `usage: migrate-sqlite-to-pg.ts export <sqlite.db> <out.jsonl>\n` +
      `       migrate-sqlite-to-pg.ts import <export.jsonl>   (needs DATABASE_URL)\n` +
      `       migrate-sqlite-to-pg.ts verify <export.jsonl>   (needs DATABASE_URL)`,
  );
  process.exit(code);
}

if (!command || !arg1 || (command === 'export' && !arg2)) {
  usageAndExit(1);
}

if (command === 'export') {
  const summary = await exportSqliteToJsonl(arg1, arg2!);
  console.log(
    `exported ${summary.rows} rows across ${summary.tables} tables -> ${summary.outputFile}`,
  );
  console.log('next: DATABASE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts import', arg2);
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required for import/verify');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  if (command === 'import') {
    const summary = await importJsonlToPg(arg1, pool);
    console.log(`imported ${summary.rows} rows across ${summary.tables} tables (single transaction)`);
    console.log('next: npx tsx scripts/migrate-sqlite-to-pg.ts verify', arg1);
  } else if (command === 'verify') {
    const mismatches = await verifyImport(arg1, pool);
    if (mismatches.length > 0) {
      for (const m of mismatches) {
        console.error(`MISMATCH ${m.table}: expected ${m.expected} rows, found ${m.actual}`);
      }
      process.exit(1);
    }
    console.log('verify: OK - all table row counts match the export');
  } else {
    usageAndExit(1);
  }
} finally {
  await pool.end();
}