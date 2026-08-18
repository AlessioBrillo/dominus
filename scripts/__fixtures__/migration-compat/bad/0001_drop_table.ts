// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (bad): DROP TABLE without a matching CREATE TABLE in the same
// migration. A rolled-back image would boot against a missing table.
export const name = '0001_drop_table';

const DDL = `DROP TABLE IF EXISTS foo;`;

export function up(): void {
  // no-op fixture
}
