// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildDnsProvider } from '../provider-factory.js';
import { UnboundResolver, NodeDnsProvider } from '../../providers/dns/index.js';
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
    DNS_UNBOUND_FALLBACK_ENABLED: true,
    DNS_UNBOUND_REVALIDATION_INTERVAL_MS: 600_000,
    DNS_UNBOUND_FALLBACK_REVALIDATION_INTERVAL_MS: 30_000,
    DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_FALLBACK: 1,
    DNS_UNBOUND_UNHEALTHY_COOLDOWN_MS: 30_000,
    DNSSEC_MODE: 'strict',
    DNS_LOOKUP_TIMEOUT_MS: 1500,
    DNS_LOOKUP_STRATEGY: 'native',
    DNS_DOH_ENDPOINT: 'https://cloudflare-dns.com/dns-query',
    DNS_DOH_MAX_CONNECTIONS: 64,
    DNS_DOT_POOL_MAX_QUEUED: 4096,
    DNS_USE_DEDICATED_RESOLVER: true,
    DNS_NATIVE_DNSSEC_ENABLED: false,
    DNS_PRIVACY_MODE: false,
    DNS_NAMESERVERS: undefined,
    DNS_PARKING_IPS_PATH: undefined,
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
      hosts: [
        {
          host: '127.0.0.1',
          dnssecValid: false,
          healthy: true,
          consecutiveFailures: 0,
          lastCheckAt: Date.now(),
        },
      ],
    });

    await expect(
      buildDnsProvider(makeConfig({ DNS_UNBOUND_FALLBACK_ENABLED: false })),
    ).rejects.toThrow(/DNSSEC validation/);
  });

  it('rejects boot when the resolver is unreachable', async () => {
    vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
      healthy: false,
      dnssecValid: false,
      details: 'A record resolution failed',
      hosts: [
        {
          host: '127.0.0.1',
          dnssecValid: false,
          healthy: false,
          consecutiveFailures: 1,
          lastCheckAt: Date.now(),
        },
      ],
    });

    await expect(
      buildDnsProvider(makeConfig({ DNS_UNBOUND_FALLBACK_ENABLED: false })),
    ).rejects.toThrow(/health check failed/);
  });

  it('boots when the resolver is reachable and DNSSEC validation is proven', async () => {
    vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
      healthy: true,
      dnssecValid: true,
      details: 'DNSSEC validation confirmed',
      hosts: [
        {
          host: '127.0.0.1',
          dnssecValid: true,
          healthy: true,
          consecutiveFailures: 0,
          lastCheckAt: Date.now(),
        },
      ],
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

describe('buildDnsProvider — native fallback (DNS_UNBOUND_ENABLED=false)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('boots a NodeDnsProvider instead of throwing', async () => {
    const provider = await buildDnsProvider(makeConfig({ DNS_UNBOUND_ENABLED: false }));
    expect(provider).toBeInstanceOf(NodeDnsProvider);
  });

  it('requires DNS_NAMESERVERS when privacy mode is on', async () => {
    await expect(
      buildDnsProvider(
        makeConfig({
          DNS_UNBOUND_ENABLED: false,
          DNS_PRIVACY_MODE: true,
          DNS_NAMESERVERS: undefined,
        }),
      ),
    ).rejects.toThrow(/DNS_NAMESERVERS/);
  });

  it('boots under privacy mode when DNS_NAMESERVERS is pinned', async () => {
    const provider = await buildDnsProvider(
      makeConfig({
        DNS_UNBOUND_ENABLED: false,
        DNS_PRIVACY_MODE: true,
        DNS_NAMESERVERS: '127.0.0.1',
      }),
    );
    expect(provider).toBeInstanceOf(NodeDnsProvider);
  });
});
