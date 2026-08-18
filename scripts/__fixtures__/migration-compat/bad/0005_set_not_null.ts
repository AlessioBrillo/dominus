// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (bad): SET NOT NULL on an existing column — inserts from the
// previous image (which writes NULLs) start failing on rollback.
export const name = '0005_set_not_null';

const DDL = `ALTER TABLE foo ALTER COLUMN bar SET NOT NULL;`;

export function up(): void {
  // no-op fixture
}
