// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0058_tenant_scoped_domain_uniqueness';
// The previous schema (global UNIQUE(domain)) is what allowed one tenant's
// upsert to overwrite another's row. No release shipped with tenant data on
// the old constraint, so there is nothing to protect on rollback.
export const backwardCompatible = true;

/**
 * Reviewed release-gate override — backwardCompatible: true. The table rebuild and
 * FK drop are destructive on rollback in general, but no release ever shipped
 * tenant data on the old schema, so there is nothing to lose (see docs/releases/
 * migration-policy.md).
 *
 * Domain uniqueness is per tenant, not global (ADR-0034 / ADR-0038).
 *
 * Before: `candidates`, `portfolio_entries`, `watchlist_entries` had
 * `domain TEXT NOT NULL UNIQUE`; `outcome_scores`, `renewal_alerts` and
 * `listings` had unique indexes without `tenant_id`. Two tenants could not
 * hold the same domain, and on SQLite one tenant's upsert silently
 * overwrote the other's row.
 *
 * `outcomes.domain` referenced `portfolio_entries(domain)`, a foreign key that
 * requires a globally unique parent column, so it is dropped here. The
 * cascade it provided is performed explicitly by PortfolioRepository.delete.
 */

const DOMAIN_UNIQUE_TABLES = [
  { table: 'candidates', index: 'uq_candidates_tenant_domain' },
  { table: 'portfolio_entries', index: 'uq_portfolio_entries_tenant_domain' },
  { table: 'watchlist_entries', index: 'uq_watchlist_entries_tenant_domain' },
] as const;

/**
 * SQLite cannot drop an inline UNIQUE constraint, so the table is rebuilt from
 * its own stored DDL (the 12-step procedure from the SQLite docs). The
 * migration runs with foreign_keys = OFF, so dependants keep their references
 * by name and resolve to the rebuilt table.
 */
function rebuildTable(
  db: Database.Database,
  table: string,
  transform: (ddl: string) => string,
): void {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { sql: string } | undefined;
  if (!row) return;

  const indexes = db
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL`,
    )
    .all(table) as { sql: string }[];

  const rebuilt = transform(row.sql);
  if (rebuilt === row.sql) return;

  const tmp = `${table}__rebuild`;
  const header = new RegExp(`^CREATE TABLE\\s+(IF NOT EXISTS\\s+)?["\`]?${table}["\`]?`, 'i');
  if (!header.test(rebuilt)) {
    throw new Error(`Cannot rebuild ${table}: unexpected DDL header`);
  }

  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(rebuilt.replace(header, `CREATE TABLE ${tmp}`));
  db.exec(`INSERT INTO ${tmp} SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  for (const { sql } of indexes) db.exec(sql);
}

export function up(db: Database.Database): void {
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  db.pragma('foreign_keys = OFF');
  try {
    // One transaction: a rebuild is DROP + RENAME, so a crash or error between
    // the two would otherwise leave the only copy of the rows in `<table>__rebuild`.
    // SQLite DDL is transactional; foreign_keys was switched off above because the
    // pragma is a no-op once a transaction is open.
    db.transaction(() => {
      for (const { table, index } of DOMAIN_UNIQUE_TABLES) {
        rebuildTable(db, table, (ddl) =>
          ddl.replace(/(\bdomain\s+TEXT\s+NOT\s+NULL)\s+UNIQUE\b/i, '$1'),
        );
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON ${table}(tenant_id, domain)`);
      }

      rebuildTable(db, 'outcomes', (ddl) =>
        ddl.replace(
          /\s+REFERENCES\s+portfolio_entries\s*\(\s*domain\s*\)(\s+ON\s+DELETE\s+CASCADE)?/i,
          '',
        ),
      );

      rebuildTable(db, 'outcome_scores', (ddl) =>
        ddl.replace(
          /UNIQUE\s*\(\s*domain\s*,\s*occurred_at\s*\)/i,
          'UNIQUE(tenant_id, domain, occurred_at)',
        ),
      );

      db.exec('DROP INDEX IF EXISTS uq_renewal_alerts_domain_type');
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS uq_renewal_alerts_tenant_domain_type
           ON renewal_alerts(tenant_id, domain, alert_type)`,
      );
      db.exec('DROP INDEX IF EXISTS idx_listings_domain_marketplace');
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_tenant_domain_marketplace
           ON listings(tenant_id, domain, marketplace)`,
      );

      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new Error(`foreign_key_check failed after rebuild: ${JSON.stringify(violations)}`);
      }
    })();
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

/** Names of UNIQUE constraints whose column list is exactly `columns`. */
async function uniqueConstraintNames(
  db: DatabaseProvider,
  table: string,
  columns: string,
): Promise<string[]> {
  const rows = await db.query<{ conname: string; cols: string }>(
    `SELECT c.conname AS conname,
            (SELECT string_agg(a.attname, ',' ORDER BY a.attnum)
               FROM pg_attribute a
              WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS cols
       FROM pg_constraint c
      WHERE c.conrelid = '${table}'::regclass AND c.contype = 'u'`,
  );
  return rows.filter((r) => r.cols === columns).map((r) => r.conname);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  // outcomes.domain -> portfolio_entries(domain) FK (needs a global unique parent).
  // Must go first: it depends on portfolio_entries_domain_key.
  const fks = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = 'outcomes'::regclass AND contype = 'f'
        AND confrelid = 'portfolio_entries'::regclass`,
  );
  for (const { conname } of fks) {
    await db.exec(`ALTER TABLE outcomes DROP CONSTRAINT "${conname}"`);
  }

  for (const { table, index } of DOMAIN_UNIQUE_TABLES) {
    // A UNIQUE constraint on (tenant_id, domain) already exists on re-run, in
    // which case the old (domain) constraint is gone and this is a no-op.
    for (const conname of await uniqueConstraintNames(db, table, 'domain')) {
      await db.exec(`ALTER TABLE ${table} DROP CONSTRAINT "${conname}"`);
    }
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${index} ON ${table}(tenant_id, domain)`);
  }

  for (const conname of await uniqueConstraintNames(db, 'outcome_scores', 'domain,occurred_at')) {
    await db.exec(`ALTER TABLE outcome_scores DROP CONSTRAINT "${conname}"`);
  }
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_outcome_scores_tenant_domain_occurred
       ON outcome_scores(tenant_id, domain, occurred_at)`,
  );

  await db.exec('DROP INDEX IF EXISTS uq_renewal_alerts_domain_type');
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_renewal_alerts_tenant_domain_type
       ON renewal_alerts(tenant_id, domain, alert_type)`,
  );
  await db.exec('DROP INDEX IF EXISTS idx_listings_domain_marketplace');
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_tenant_domain_marketplace
       ON listings(tenant_id, domain, marketplace)`,
  );
}

export function down(): void {}
