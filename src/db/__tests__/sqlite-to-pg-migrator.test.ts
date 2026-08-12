// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import {
  exportSqliteToJsonl,
  importJsonlToPg,
  readJsonlExport,
  verifyImport,
} from '../sqlite-to-pg-migrator.js';
import { toPgDdl } from '../pg-ddl.js';

const PG_URL = process.env.DATABASE_URL ?? '';

const TEST_DIR = resolve('./data/tmp/sqlite-to-pg-test');
const TEST_DB = join(TEST_DIR, 'community.db');
const TEST_EXPORT = join(TEST_DIR, 'export.jsonl');

function createCommunityDb(): void {
  const db = new Database(TEST_DB);
  db.exec(`
    CREATE TABLE candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      verdict TEXT,
      score INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT
    );
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    INSERT INTO candidates (domain, verdict, score, payload_json) VALUES
      ('example.com', 'buy', 82, '{"signals": 3}'),
      ('example.net', 'pass', 41, NULL);
    INSERT INTO settings (key, value) VALUES ('theme', 'dark');
  `);
  db.close();
}

describe('exportSqliteToJsonl', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    createCommunityDb();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('exports every user table with full rows, one line per table', async () => {
    const summary = await exportSqliteToJsonl(TEST_DB, TEST_EXPORT);
    expect(summary.tables).toBe(2);
    expect(summary.rows).toBe(3);

    const lines = readFileSync(TEST_EXPORT, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const batches: Array<{ table: string; rows: unknown[] }> = [];
    for await (const batch of readJsonlExport(TEST_EXPORT)) batches.push(batch);
    const candidates = batches.find((b) => b.table === 'candidates')!;
    expect(candidates.rows).toHaveLength(2);
    expect(candidates.rows[0]).toMatchObject({
      domain: 'example.com',
      verdict: 'buy',
      score: 82,
      payload_json: '{"signals": 3}',
    });
    const settings = batches.find((b) => b.table === 'settings')!;
    expect(settings.rows).toEqual([{ key: 'theme', value: 'dark' }]);
  });

  it('skips empty tables in the JSONL but counts them in the summary', async () => {
    const db = new Database(TEST_DB);
    db.exec('CREATE TABLE empty_table (id INTEGER PRIMARY KEY);');
    db.close();
    const summary = await exportSqliteToJsonl(TEST_DB, TEST_EXPORT);
    expect(summary.tables).toBe(3);
    const content = readFileSync(TEST_EXPORT, 'utf8');
    expect(content).not.toContain('empty_table');
  });
});

describe.runIf(PG_URL)('importJsonlToPg', () => {
  const schema = `mig_test_${Date.now()}`;
  const pool = new Pool({ connectionString: PG_URL });

  beforeEach(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });

  afterEach(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function withSearchPath<T>(fn: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      // create the same shape as the DOMINUS schema via toPgDdl
      await client.query(
        toPgDdl(`CREATE TABLE candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        verdict TEXT,
        score INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT
      );`),
      );
      await client.query(
        toPgDdl(`CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );`),
      );
      await client.query(`SET search_path TO "${schema}", public`);
      const result = await fn();
      await client.query(`SET search_path TO public`);
      return result;
    } finally {
      client.release();
    }
  }

  it('imports the export into matching tables and advances sequences', async () => {
    await withSearchPath(async () => {
      const summary = await importJsonlToPg(TEST_EXPORT, pool);
      expect(summary.tables).toBe(2);
      expect(summary.rows).toBe(3);

      const candidates = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM "${schema}".candidates`,
      );
      expect(Number(candidates.rows[0]!.n)).toBe(2);
      const row = await pool.query<{ domain: string; payload_json: string }>(
        `SELECT domain, payload_json FROM "${schema}".candidates WHERE id = 1`,
      );
      expect(row.rows[0]).toMatchObject({ domain: 'example.com', payload_json: '{"signals": 3}' });

      // sequence advanced past the migrated max(id)=2
      const next = await pool.query<{ n: string }>(
        `SELECT nextval(pg_get_serial_sequence('"${schema}".candidates', 'id')) AS n`,
      );
      expect(Number(next.rows[0]!.n)).toBe(3);
    });
  });

  it('verifyImport reports zero mismatches on a correct import', async () => {
    await withSearchPath(async () => {
      await importJsonlToPg(TEST_EXPORT, pool);
      const mismatches = await verifyImport(TEST_EXPORT, pool);
      expect(mismatches).toEqual([]);
    });
  });
});
