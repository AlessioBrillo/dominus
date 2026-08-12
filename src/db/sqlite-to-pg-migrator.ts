// SPDX-License-Identifier: AGPL-3.0-only
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import type { Pool, PoolClient } from 'pg';

/**
 * Community-to-Cloud data migration (ADR-0027 "zero lock-in", ADR-0054
 * roadmap: migration guide). The schema is shared between SQLite and
 * PostgreSQL (validate-migration-sync.ts + toPgDdl), so the data path is
 * a plain pass-through: export every user table to JSONL, import it into
 * the same table names on the PostgreSQL side, then advance the SERIAL
 * sequences. No type coercion: SQLite TEXT/INTEGER/REAL/BLOB values map
 * 1:1 onto the PG columns (toPgDdl maps BLOB→BYTEA, and node-postgres
 * serialises Buffers as bytea).
 *
 * The import must run as the table owner (the DATABASE_URL app role):
 * RLS policies do not apply to the owner unless FORCE ROW LEVEL SECURITY
 * is set (see ADR-0027 / 0047).
 */

export interface JsonlTableBatch {
  table: string;
  rows: Record<string, unknown>[];
}

export interface MigrationSummary {
  tables: number;
  rows: number;
  outputFile: string | null;
}

const INSERT_BATCH_SIZE = 500;

/** Enumerate user tables (mirrors scripts/restore-drill.mjs). */
function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Phase 1 — read a SQLite database into a portable JSONL file. One line
 * per table: {"table":"<name>","rows":[...]}. Read-only on the source.
 */
export async function exportSqliteToJsonl(
  sqlitePath: string,
  outFile: string,
): Promise<MigrationSummary> {
  const db = new Database(sqlitePath, { readonly: true });
  const out = createWriteStream(outFile);
  const tables = listTables(db);
  let rows = 0;
  try {
    for (const table of tables) {
      const all = db.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
      rows += all.length;
      if (all.length > 0) {
        const batch: JsonlTableBatch = { table, rows: all };
        out.write(`${JSON.stringify(batch)}\n`);
      }
    }
    out.end();
    await once(out, 'finish');
  } finally {
    db.close();
  }
  return { tables: tables.length, rows, outputFile: outFile };
}

/** Read the JSONL export back, one {table, rows} batch at a time. */
export async function* readJsonlExport(jsonlPath: string): AsyncGenerator<JsonlTableBatch> {
  const rl = createInterface({ input: createReadStream(jsonlPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    const batch = JSON.parse(line) as JsonlTableBatch;
    if (typeof batch?.table !== 'string' || !Array.isArray(batch.rows)) {
      throw new Error(`malformed migration line for table ${String(batch?.table)}`);
    }
    yield batch;
  }
}

/**
 * Phase 2 — import a JSONL export into PostgreSQL. Runs in a single
 * transaction (all-or-nothing; re-runnable after fixing the blocker) and
 * advances SERIAL sequences afterwards so future app inserts do not
 * collide with migrated rows.
 */
export async function importJsonlToPg(jsonlPath: string, pool: Pool): Promise<MigrationSummary> {
  const client = await pool.connect();
  let tables = 0;
  let rows = 0;
  try {
    await client.query('BEGIN');
    for await (const { table, rows: tableRows } of readJsonlExport(jsonlPath)) {
      if (tableRows.length === 0) continue;
      const columns = Object.keys(tableRows[0] as Record<string, unknown>);
      await insertBatch(client, table, columns, tableRows);
      await advanceSerialSequence(client, table);
      tables++;
      rows += tableRows.length;
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback failure leaves the transaction aborted; the error below
      // is the actionable one
    }
    throw err;
  } finally {
    client.release();
  }
  return { tables, rows, outputFile: null };
}

async function insertBatch(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  const colList = columns.map((c) => `"${c}"`).join(', ');
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const chunk = rows.slice(i, i + INSERT_BATCH_SIZE);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const row of chunk) {
      const rowPlaceholders: string[] = [];
      for (const column of columns) {
        const value = row[column];
        // BYTEA via Buffer; JSONL round-trip of undefined → null
        values.push(value === undefined ? null : value);
        rowPlaceholders.push(`$${p++}`);
      }
      placeholders.push(`(${rowPlaceholders.join(', ')})`);
    }
    await client.query(
      `INSERT INTO "${table}" (${colList}) VALUES ${placeholders.join(', ')}`,
      values,
    );
  }
}

/** Advance a SERIAL/BIGSERIAL sequence to max(id) after migrating rows. */
async function advanceSerialSequence(client: PoolClient, table: string): Promise<void> {
  const seq = await client.query<{ seq: string | null }>(
    `SELECT pg_get_serial_sequence('${table}', 'id') AS seq`,
  );
  if (!seq.rows[0]?.seq) return;
  await client.query(
    `SELECT setval('${seq.rows[0].seq}', GREATEST((SELECT COALESCE(MAX(id), 1) FROM "${table}"), 1))`,
  );
}

/**
 * Phase 3 — verify an import: compares per-table row counts in the JSONL
 * export against the live PostgreSQL table. Returns mismatches.
 */
export async function verifyImport(
  jsonlPath: string,
  pool: Pool,
): Promise<Array<{ table: string; expected: number; actual: number }>> {
  const mismatches: Array<{ table: string; expected: number; actual: number }> = [];
  for await (const { table, rows } of readJsonlExport(jsonlPath)) {
    const result = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM "${table}"`);
    const actual = Number(result.rows[0]?.n ?? 0);
    if (actual !== rows.length) {
      mismatches.push({ table, expected: rows.length, actual });
    }
  }
  return mismatches;
}
