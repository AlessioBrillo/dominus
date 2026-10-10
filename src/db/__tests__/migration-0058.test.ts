// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { getMigrations } from '../migrations/registry.js';

/**
 * Migration 0058 rebuilds tables (DROP + RENAME). These tests pin that it keeps
 * every row, and that a failure half-way leaves the original tables untouched.
 */
const SCHEMA_BEFORE = '0058_tenant_scoped_domain_uniqueness';

function dbAtPreviousSchema(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(
    'CREATE TABLE schema_migrations (migration_name TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)',
  );
  for (const m of getMigrations()) {
    if (m.name >= SCHEMA_BEFORE) break;
    m.up(db);
  }
  return db;
}

const migration = (): ReturnType<typeof getMigrations>[number] => {
  const m = getMigrations().find((x) => x.name === SCHEMA_BEFORE);
  if (!m) throw new Error('migration 0058 not found');
  return m;
};

function seed(db: Database.Database): void {
  db.exec(`
    INSERT INTO candidates (domain, tld, source, status, tenant_id)
      VALUES ('a.com', '.com', 'closeout_csv', 'scored', 'alice'),
             ('b.com', '.com', 'closeout_csv', 'pending', 'bob');
    INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar, tenant_id)
      VALUES ('a.com', '.com', '2026-01-01', '2027-01-01', 10, 12, 'x', 'alice');
    INSERT INTO outcomes (domain, type, occurred_at, tenant_id)
      VALUES ('a.com', 'sold', '2026-06-01', 'alice');
    INSERT INTO watchlist_entries (domain, tld, tenant_id) VALUES ('w.com', '.com', 'alice');
  `);
}

const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('migration 0058', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = dbAtPreviousSchema();
    seed(db);
  });

  it('keeps every row and lets two tenants hold the same domain afterwards', () => {
    migration().up(db);

    expect(count(db, 'candidates')).toBe(2);
    expect(count(db, 'portfolio_entries')).toBe(1);
    expect(count(db, 'outcomes')).toBe(1);
    expect(count(db, 'watchlist_entries')).toBe(1);

    // The old global UNIQUE(domain) is gone: the same domain in another tenant works,
    // a duplicate inside one tenant is still rejected.
    db.exec(
      `INSERT INTO candidates (domain, tld, source, status, tenant_id) VALUES ('a.com', '.com', 'closeout_csv', 'pending', 'bob')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO candidates (domain, tld, source, status, tenant_id) VALUES ('a.com', '.com', 'closeout_csv', 'pending', 'bob')`,
      ),
    ).toThrow(/UNIQUE/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__rebuild'").all()).toEqual(
      [],
    );
  });

  it('is atomic: an error between DROP and RENAME leaves the original tables intact', () => {
    // Fail the second rebuild (portfolio_entries) after candidates was already rebuilt.
    const realExec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (/^DROP TABLE portfolio_entries\b/.test(sql)) throw new Error('boom');
      return realExec(sql);
    }) as typeof db.exec;

    expect(() => migration().up(db)).toThrow('boom');
    db.exec = realExec;

    // Nothing half-done: all rows present, no orphan __rebuild table, and the
    // original global uniqueness still in force (the rebuild was rolled back).
    expect(count(db, 'candidates')).toBe(2);
    expect(count(db, 'portfolio_entries')).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__rebuild'").all()).toEqual(
      [],
    );
    expect(() =>
      db.exec(
        `INSERT INTO candidates (domain, tld, source, status, tenant_id) VALUES ('a.com', '.com', 'closeout_csv', 'pending', 'bob')`,
      ),
    ).toThrow(/UNIQUE/);
  });
});
