// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (bad): DELETE FROM — irreversible data deletion.
export const name = '0006_delete_rows';

const DDL = `DELETE FROM foo WHERE stale = true;`;

export function up(): void {
  // no-op fixture
}
