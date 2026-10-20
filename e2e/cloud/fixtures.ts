// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The Cloud fixtures, read from the file the acceptance runner wrote.
//
// The API keys exist only in the acceptance database (they are minted on
// the stack by `dominus keys create`), so they cannot be constants in the
// spec: the runner writes them after creating the two tenants, and the
// specs read them from here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CloudFixtures {
  tenantA: { key: string; domain: string };
  tenantB: { key: string; domain: string };
  tenantC: { key: string; domain: string };
  metricsToken: string;
}

const FIXTURES_PATH = join(process.cwd(), '.acceptance', 'fixtures.json');

export function loadCloudFixtures(): CloudFixtures {
  if (!existsSync(FIXTURES_PATH)) {
    throw new Error(
      `The Cloud fixtures are missing (${FIXTURES_PATH}). Run the acceptance suite first:\n` +
        '  npm run acceptance:cloud',
    );
  }
  const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf8')) as CloudFixtures;
  if (!fixtures.tenantA?.key || !fixtures.tenantB?.key) {
    throw new Error(`The Cloud fixtures are incomplete (${FIXTURES_PATH}).`);
  }
  return fixtures;
}
