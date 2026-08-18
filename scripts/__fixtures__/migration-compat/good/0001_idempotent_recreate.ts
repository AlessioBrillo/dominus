// SPDX-License-Identifier: AGPL-3.0-only
// Fixture (good): idempotent recreate — DROP TABLE paired with a CREATE
// TABLE for the same name. The release gate allows this pattern.
export const name = '0001_idempotent_recreate';

const DDL = `DROP TABLE IF EXISTS foo;
CREATE TABLE foo (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);`;

export function up(): void {
  // no-op fixture
}
