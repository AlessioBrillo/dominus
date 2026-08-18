// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (bad): ALTER TABLE ... RENAME TO — old code references the old
// table name.
export const name = '0004_rename_table';

const DDL = `ALTER TABLE foo RENAME TO bar;`;

export function up(): void {
  // no-op fixture
}
