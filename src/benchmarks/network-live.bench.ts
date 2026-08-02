// SPDX-License-Identifier: AGPL-3.0-only
import { bench, describe } from 'vitest';
import { NodeDnsProvider } from '../providers/dns/node-dns-provider.js';
import { FailoverRdapProvider } from '../providers/rdap/failover-rdap-provider.js';
import { IanaRdapBootstrap } from '../providers/rdap/rdap-bootstrap.js';
import { RateLimiter } from '../providers/rate-limiter.js';

/**
 * Live-network benchmarks against real resolvers and registries.
 *
 * Skipped unless DNS_LIVE=1 — they make real network calls and must never
 * run in CI or default local runs:
 *
 *   DNS_LIVE=1 npm run bench
 *
 * Baseline tracking (from the v0.10.0 roadmap): these numbers exist to be
 * compared across runs, so keep the fixture list stable.
 */

const LIVE = process.env.DNS_LIVE === '1';

// Stable fixture: registered domains (definitive answers) plus likely-free
// names, exercising both verdict paths across A→NS/SOA phases.
const FIXTURE: string[] = [
  'example.com',
  'example.net',
  'example.org',
  'google.com',
  'github.com',
  'cloudflare.com',
  'microsoft.com',
  'amazon.com',
  'wikipedia.org',
  'stackoverflow.com',
  'verisign.com',
  'iana.org',
  `qzkb${Math.floor(Math.random() * 1000)}.com`,
  `qzkb${Math.floor(Math.random() * 1000)}.net`,
  `qzkb${Math.floor(Math.random() * 1000)}.org`,
  `qzkb${Math.floor(Math.random() * 1000)}.io`,
  `qzkb${Math.floor(Math.random() * 1000)}.xyz`,
  `qzkb${Math.floor(Math.random() * 1000)}.dev`,
];

describe.runIf(LIVE)('DNS live (real resolvers)', () => {
  for (const strategy of ['dot-only', 'doh-primary', 'native'] as const) {
    const provider = new NodeDnsProvider({
      lookupStrategy: strategy,
      bulkConcurrency: 50,
      cacheTtlMs: 0,
    });
    bench(`bulk ${FIXTURE.length} domains (${strategy})`, async () => {
      provider.clearCache();
      const results = await provider.checkBulk(FIXTURE);
      if (results.length !== FIXTURE.length) throw new Error('unexpected count');
    });
  }
});

describe.runIf(LIVE)('RDAP live (IANA bootstrap + rdap.org)', () => {
  const provider = FailoverRdapProvider.withDefaults(
    new RateLimiter({ maxTokens: 5, tokensPerInterval: 5, intervalMs: 1000 }),
    undefined,
    new IanaRdapBootstrap(),
  );
  bench(`confirm ${FIXTURE.length} domains`, async () => {
    provider.clearCache();
    for (const domain of FIXTURE) {
      await provider.confirm(domain);
    }
  });
});
