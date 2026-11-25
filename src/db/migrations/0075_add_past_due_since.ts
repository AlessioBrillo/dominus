// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';
import { execPg } from '../pg-ddl.js';

export const name = '0075_add_past_due_since';
export const backwardCompatible = true;

/**
 * A stable start time for the dunning grace (ADR-0112). `updated_at` is
 * refreshed by every subscription write, including Stripe's retries, so
 * counting the seven-day grace from it never expires. `past_due_since` is
 * set only on the active -> past_due transition and cleared when the
 * subscription recovers.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE tenant_subscriptions ADD COLUMN past_due_since TEXT');
}

export function down(_db: Database.Database): void {
  // SQLite cannot DROP COLUMN on supported versions; the column is additive
  // and ignored by older binaries, so rollback keeps it.
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    'ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ',
  );
}
