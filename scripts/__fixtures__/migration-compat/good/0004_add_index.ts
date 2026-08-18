// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (good): index-only change — CREATE INDEX must not trip the gate.
export const name = '0004_add_index';

const DDL = `CREATE INDEX IF NOT EXISTS idx_foo_label ON foo (label);`;

export function up(): void {
  // no-op fixture
}
