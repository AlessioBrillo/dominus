// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0071_create_contract_acceptances';
export const backwardCompatible = true;

/**
 * The evidence that a contract was accepted.
 *
 * A checkbox in a React component is not proof: it leaves no trace of WHICH
 * version of the terms was accepted, by whom, or when. The consumer rules
 * (arts. 49 and 52-59 of the Italian Consumer Code), the art. 1341 c.c.
 * specific approval of the clauses that limit a business customer's rights,
 * and the art. 28 GDPR DPA all need that proof.
 *
 * The table is control-plane on purpose: a signup records an acceptance
 * BEFORE a tenant exists, exactly like signup_verifications (0067). The
 * `email` column is the identifier of the accepting subject: the registered
 * email at signup, the session subject at checkout.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS contract_acceptances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('signup','checkout','dpa','art1341')),
  document_slug TEXT NOT NULL,
  document_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  checkout_session_id TEXT,
  -- Italian electronic-invoicing destination code (or PEC) for a business
  -- customer. Collected with the checkout acceptance, before the first invoice.
  billing_code TEXT,
  accepted_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS contract_acceptances (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('signup','checkout','dpa','art1341')),
  document_slug TEXT NOT NULL,
  document_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  checkout_session_id TEXT,
  billing_code TEXT,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_contract_acceptances_tenant ON contract_acceptances(tenant_id, purpose, accepted_at)',
  'CREATE INDEX IF NOT EXISTS idx_contract_acceptances_email ON contract_acceptances(email, purpose)',
];

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
  for (const ddl of INDEXES) db.exec(ddl);
}

export function down(db: Database.Database): void {
  for (const ddl of INDEXES) {
    db.exec(
      ddl.replace('CREATE INDEX IF NOT EXISTS', 'DROP INDEX IF EXISTS').split(' ON ')[0] ?? '',
    );
  }
  db.exec('DROP TABLE IF EXISTS contract_acceptances');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
  for (const ddl of INDEXES) await db.exec(ddl);
}
