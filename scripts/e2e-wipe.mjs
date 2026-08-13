// SPDX-License-Identifier: AGPL-3.0-only
// Removes the local E2E runtime directory so the Playwright webServer boots
// against a pristine database. Runs as part of the webServer command chain —
// before `node dist/index.js` — because Playwright starts the webServer
// before globalSetup.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const e2eDir = resolve('.e2e');

rmSync(e2eDir, { recursive: true, force: true });
console.log(`[e2e] wiped ${e2eDir}`);
