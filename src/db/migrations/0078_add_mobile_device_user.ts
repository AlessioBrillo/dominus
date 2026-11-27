// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';
import { execPg } from '../pg-ddl.js';

export const name = '0078_add_mobile_device_user';
export const backwardCompatible = true;

/**
 * The user who minted a device token (ADR-0107, ADR-0116).
 *
 * A browser session is re-checked against the live team seat on every
 * request. A device token must be too: a removed or demoted member must not
 * keep a valid `member` credential until the token is manually revoked.
 * API-key-minted devices carry NULL and keep the API key's own contract.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE mobile_device_sessions ADD COLUMN user_id TEXT');
}

export function down(_db: Database.Database): void {
  // SQLite cannot DROP COLUMN on supported versions; additive and ignored.
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, 'ALTER TABLE mobile_device_sessions ADD COLUMN IF NOT EXISTS user_id TEXT');
}
