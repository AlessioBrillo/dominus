// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (good): purely additive migration — new column, no destructive
// statement. This is the shape every new migration must follow.
export const name = '0002_additive_column';

const DDL = `ALTER TABLE foo ADD COLUMN bar TEXT;
CREATE INDEX IF NOT EXISTS idx_foo_bar ON foo (bar);`;

export function up(): void {
  // no-op fixture
}
