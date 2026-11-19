// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The scheduler process must ARM the cron timers.
 *
 * The SchedulerService builds the job catalogue when it is created, but the
 * timers are armed by `start()`. The scheduler entrypoint created the
 * service, started the health server and waited — without ever calling
 * `start()`. The container reported itself healthy and the platform
 * automation (the renewal check, the portfolio rescore, the watchlist poll,
 * the prune) ran for NO tenant, ever.
 *
 * The assertion is on the source because the entrypoint is a script: there
 * is no seam to inject a fake scheduler into, and the failure mode is a
 * missing line, not a wrong one.
 */
const here = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(join(here, '..', '..', 'scheduler-entrypoint.ts'), 'utf8');

describe('the scheduler entrypoint', () => {
  it('arms the cron timers of the scheduler', () => {
    expect(entrypoint).toMatch(/scheduler\.start\(\)/);
  });

  it('exits the process after a graceful shutdown', () => {
    // The Redis client reconnects on its own: without an explicit exit the
    // event loop never drains and the container is killed by the grace
    // period instead of stopping cleanly.
    expect(entrypoint).toMatch(/process\.exit\(0\)/);
  });
});
