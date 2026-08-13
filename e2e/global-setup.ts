// SPDX-License-Identifier: AGPL-3.0-only
// Seeds the E2E SQLite database with deterministic fixture data. The
// webServer boots before globalSetup and creates the schema; this script
// waits for the schema to exist (defensive if the startup ordering ever
// changes) and then inserts the fixtures.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = resolve('.e2e/dominus-e2e.db');
const SCHEMA_WAIT_MS = 60_000;

export default async function globalSetup(): Promise<void> {
  await waitForSchema();

  const db = new Database(DB_PATH);
  seed(db);
  db.close();

  console.log('[e2e] database seeded');
}

async function waitForSchema(): Promise<void> {
  const deadline = Date.now() + SCHEMA_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const db = new Database(DB_PATH, { readonly: true });
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'candidates'",
        )
        .get();
      db.close();
      if (row) return;
    } catch {
      // Database not created yet — keep polling.
    }
    await sleep(500);
  }
  throw new Error(`E2E database was not ready within ${SCHEMA_WAIT_MS}ms: ${DB_PATH}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seed(db: any): void {
  const insertRun = db.prepare(
    `INSERT INTO pipeline_runs
      (run_id, started_at, finished_at, total_duration_ms, stage_summary,
       inputs, results_summary, host_version, retained_until, error)
     VALUES (?, ?, ?, ?, '{}', '{}', '{}', 'e2e', ?, NULL)`,
  );
  insertRun.run(
    'e2e-run-0001',
    '2026-08-01T09:00:00.000Z',
    '2026-08-01T09:01:30.000Z',
    90_000,
    '2099-12-31T00:00:00.000Z',
  );

  const insertCandidate = db.prepare(
    `INSERT INTO candidates
      (domain, tld, source, status, pipeline_run_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const candidates = [
    ['candidate-one.com', 'com', 'closeout', 'recommended', 'e2e-run-0001'],
    ['candidate-two.io', 'io', 'keyword', 'scored', 'e2e-run-0001'],
    ['candidate-three.net', 'net', 'keyword', 'scored', 'e2e-run-0001'],
  ] as const;
  for (const [domain, tld, source, status, runId] of candidates) {
    insertCandidate.run(domain, tld, source, status, runId);
  }

  const insertPortfolio = db.prepare(
    `INSERT INTO portfolio_entries
      (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost,
       registrar, current_score, suggested_list_price, verdict)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const portfolio = [
    ['keep-domain.com', 'com', '2025-01-15', '2027-01-15', 12.0, 11.99, 'namecheap', 0.71, 1200, 'keep'],
    ['drop-domain.net', 'net', '2025-02-01', '2027-02-01', 8.0, 9.99, 'cloudflare', 0.31, 90, 'drop'],
  ] as const;
  for (const row of portfolio) {
    insertPortfolio.run(...row);
  }
}
