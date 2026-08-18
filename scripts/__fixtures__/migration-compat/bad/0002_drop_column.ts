// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (bad): ALTER TABLE ... DROP COLUMN. The previous image queries
// that column; dropping it breaks the rollback.
export const name = '0002_drop_column';

const DDL = `ALTER TABLE foo DROP COLUMN bar;`;

export function up(): void {
  // no-op fixture
}
