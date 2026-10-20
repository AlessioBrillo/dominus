// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// Fails early, and with a usable message, when the acceptance stack was
// not started: the specs would otherwise fail one by one with a timeout
// that says nothing about the cause.
import { loadCloudFixtures } from './fixtures';

export default async function globalSetup(): Promise<void> {
  const fixtures = loadCloudFixtures();
  const res = await fetch(`${process.env.ACCEPTANCE_BASE_URL ?? 'http://127.0.0.1:3210'}/api/v1/health`);
  if (!res.ok) {
    throw new Error(
      'The acceptance stack is not answering on /api/v1/health. Start it with:\n' +
        '  npm run acceptance:cloud',
    );
  }
  console.log(
    `[e2e/cloud] fixtures loaded (${fixtures.tenantA.domain} / ${fixtures.tenantB.domain})`,
  );
}
