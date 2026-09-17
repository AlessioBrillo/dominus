// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDnsProvider } from '../provider-factory.js';
import { UnboundResolver } from '../../providers/dns/index.js';
import type { Config } from '../../config.js';

/** Minimal Config slice buildDnsProvider's Unbound branch reads. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DNS_UNBOUND_ENABLED: true,
    DNS_UNBOUND_HOSTS: '127.0.0.1',
    DNS_UNBOUND_TIMEOUT_MS: 1500,
    DNS_CACHE_TTL_SECONDS: 300,
    DNS_CACHE_MAX_SIZE: 10000,
    DNS_BULK_CONCURRENCY: 200,
    DNS_PARKING_CHECK_ENABLED: false,
    DNS_PERSISTENT_CACHE_ENABLED: false,
    DNS_PERSISTENT_CACHE_TTL_HOURS: 168,
    DNS_PERSISTENT_AVAILABLE_STALE_HOURS: 24,
    DNS_DNSSEC_VALIDATION_ENABLED: true,
    DNS_UNBOUND_HEALTH_CHECK_ENABLED: true,
    ...overrides,
  } as unknown as Config;
}

describe('buildDnsProvider — boot health check gating', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects boot when DNSSEC validation is not proven, even if the resolver is reachable', async () => {
    vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
      healthy: true,
      dnssecValid: false,
      details: 'resolver accepted a bad signature',
    });

    await expect(buildDnsProvider(makeConfig())).rejects.toThrow(/DNSSEC validation/);
  });

  it('rejects boot when the resolver is unreachable', async () => {
    vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
      healthy: false,
      dnssecValid: false,
      details: 'A record resolution failed',
    });

    await expect(buildDnsProvider(makeConfig())).rejects.toThrow(/health check failed/);
  });

  it('boots when the resolver is reachable and DNSSEC validation is proven', async () => {
    vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
      healthy: true,
      dnssecValid: true,
      details: 'DNSSEC validation confirmed',
    });

    const provider = await buildDnsProvider(makeConfig());
    expect(provider).toBeInstanceOf(UnboundResolver);
  });

  it('skips the health check entirely when disabled', async () => {
    const healthCheck = vi.spyOn(UnboundResolver.prototype, 'healthCheck');

    const provider = await buildDnsProvider(
      makeConfig({ DNS_UNBOUND_HEALTH_CHECK_ENABLED: false }),
    );

    expect(provider).toBeInstanceOf(UnboundResolver);
    expect(healthCheck).not.toHaveBeenCalled();
  });
});
