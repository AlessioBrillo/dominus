// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (good): destructive DDL carrying an explicit reviewed override.
// The gate still refuses the pattern unless the exported object marks
// backwardCompatible: true — the documented escape hatch.
export const name = '0003_documented_override';

const DDL = `ALTER TABLE foo DROP COLUMN never_shipped;`;

export function up(): void {
  // no-op fixture
}

export const migration = {
  // Reviewed override: the column never shipped to production (reverted
  // during development), so dropping it cannot break a rolled-back image.
  backwardCompatible: true,
};
