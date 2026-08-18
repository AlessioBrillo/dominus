// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (bad): RENAME COLUMN — old code still selects the old name.
export const name = '0003_rename_column';

const DDL = `ALTER TABLE foo RENAME COLUMN old_name TO new_name;`;

export function up(): void {
  // no-op fixture
}
