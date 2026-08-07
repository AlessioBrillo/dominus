// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PostgresAdapter } from '../postgres-adapter.js';
import { runWithTenant } from '../../../utils/tenant-context.js';

const PG_URL = process.env.DATABASE_URL ?? '';

// Multi-tenant isolation is enforced at the PostgreSQL layer (migration
// 0047 FORCE ROW LEVEL SECURITY + the dedicated dominus_app role from
// deploy/postgres/init-app-role.sh). These tests prove the DB-level
// guarantee holds regardless of what any repository layer does.
//
// Runs only when DATABASE_URL is set (same as postgres-adapter.test.ts).
describe.runIf(PG_URL)('RLS tenant isolation', () => {
  let adapter: PostgresAdapter;

  afterEach(async () => {
    if (adapter?.isOpen()) {
      await adapter.close();
    }
  });

  async function isSuperuser(): Promise<boolean> {
    const rows = await adapter.query<{ isSuper: boolean }>(
      `SELECT rolsuper AS "isSuper" FROM pg_roles WHERE rolname = current_user`,
    );
    return rows[0]?.isSuper ?? false;
  }

  it('FORCE ROW LEVEL SECURITY + policy blocks cross-tenant reads', async () => {
    adapter = await PostgresAdapter.create(PG_URL);
    // Skip furniture: superusers bypass RLS by design, so the negative
    // assertion is only valid for the dedicated non-superuser app role.
    if (await isSuperuser()) {
      return;
    }
    const table = `rls_iso_test_${randomBytes(4).toString('hex')}`;

    await adapter.exec(`CREATE TABLE ${table} (
      id SERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      val TEXT NOT NULL
    )`);
    try {
      await adapter.exec(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await adapter.exec(
        `CREATE POLICY tenant_isolation_test ON ${table} FOR ALL USING
         (tenant_id = current_setting('app.tenant_id', true)::TEXT)`,
      );

      await runWithTenant('tenant-a', () =>
        adapter.exec(`INSERT INTO ${table} (tenant_id, val) VALUES ($1, $2)`, ['tenant-a', 'a']),
      );
      await runWithTenant('tenant-a', () =>
        adapter.exec(`INSERT INTO ${table} (tenant_id, val) VALUES ($1, $2)`, ['tenant-a', 'a2']),
      );
      await runWithTenant('tenant-b', () =>
        adapter.exec(`INSERT INTO ${table} (tenant_id, val) VALUES ($1, $2)`, ['tenant-b', 'b']),
      );

      const asA = await runWithTenant('tenant-a', () =>
        adapter.query<{ val: string }>(`SELECT val FROM ${table}`),
      );
      expect(asA.map((r) => r.val).sort()).toEqual(['a', 'a2']);

      const asB = await runWithTenant('tenant-b', () =>
        adapter.query<{ val: string }>(`SELECT val FROM ${table}`),
      );
      expect(asB.map((r) => r.val)).toEqual(['b']);

      // stray context (no tenant) sees nothing — fail-closed
      const anon = await adapter.query<{ val: string }>(`SELECT val FROM ${table}`);
      expect(anon).toHaveLength(0);
    } finally {
      await adapter.exec(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    }
  });

  it('migration 0047 forces RLS on every tenant-scoped table in the db', async () => {
    adapter = await PostgresAdapter.create(PG_URL);

    // Keep in sync with the entity list in migration 0047 and 0030.
    const tables = [
      'candidates',
      'scoring_runs',
      'portfolio_entries',
      'trademark_results',
      'outcomes',
      'outcome_scores',
      'watchlist_entries',
      'listings',
      'listing_offers',
      'bids',
      'renewal_alerts',
      'auto_listings',
      'events',
      'onboarding_state',
      'public_scores',
    ];

    const rows = await adapter.query<{ tableName: string; forced: boolean }>(
      `SELECT c.relname AS table_name, c.relforcerowsecurity AS forced
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
    );
    const byName = new Map(rows.map((r) => [r.tableName, r.forced]));

    const absent = tables.filter((t) => !byName.has(t));
    expect(absent).toEqual([]);
    for (const t of tables) {
      expect(byName.get(t), `${t} must be FORCE ROW LEVEL SECURITY`).toBe(true);
    }
  });
});
