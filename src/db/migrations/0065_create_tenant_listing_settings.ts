// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0065_create_tenant_listing_settings';
export const backwardCompatible = true;

/**
 * Per-tenant listing policy (ADR-0083, M4 — the marketplace automation
 * part that does not depend on unverified vendor APIs).
 *
 * One row per tenant, absent until the tenant sets a policy. Defaults are
 * conservative: the listing price keeps coming from the scoring engine
 * and offers are never auto-answered. The vendor ListingProvider
 * adapters themselves stay out until their APIs are verified (ADR-0082).
 *
 * Control-plane table like tenant_automation_settings (0063): not covered
 * by FORCE ROW LEVEL SECURITY, isolated by the repository through
 * resolveTenantId().
 */
const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS tenant_listing_settings (
  tenant_id TEXT PRIMARY KEY,
  price_policy TEXT NOT NULL DEFAULT 'scoring'
    CHECK(price_policy IN ('scoring','fixed')),
  base_price_eur REAL,
  offer_auto_decline_below_eur REAL,
  offer_counter_eur REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const DDL_PG = `
CREATE TABLE IF NOT EXISTS tenant_listing_settings (
  tenant_id TEXT PRIMARY KEY,
  price_policy TEXT NOT NULL DEFAULT 'scoring'
    CHECK(price_policy IN ('scoring','fixed')),
  base_price_eur DOUBLE PRECISION,
  offer_auto_decline_below_eur DOUBLE PRECISION,
  offer_counter_eur DOUBLE PRECISION,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

export function up(db: Database.Database): void {
  db.exec(DDL_SQLITE);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(DDL_PG);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_listing_settings');
}
