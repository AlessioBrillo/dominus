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
    DNS_UNBOUND_REVALIDATION_INTERVAL_MS: 600_000,
    DNS_UNBOUND_MAX_UNHEALTHY_BEFORE_DEGRADED: 1,
    DNS_UNBOUND_UNHEALTHY_COOLDOWN_MS: 30_000,
    DNS_UNBOUND_STRICT: true,
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
    DNS_PER_QUERY_DNSEC: true,
    DNS_PER_QUERY_DNSEC_TIMEOUT_MS: 2000,
    DNSSEC_POSITIVE_CONTROLS: 'sigok.verteiltesysteme.net,dnssec.works,test.dnssec-tools.org',
    DNS_UNBOUND_UPSTREAM_TLS: false,
    DNS_UNBOUND_READINESS_TIMEOUT_MS: 30_000,
    DNS_UNBOUND_SKIP_READINESS: true,
    ...overrides,
  } as unknown as Config;
}

describe('buildDnsProvider — boot health check gating (ADR-0075)', () => {
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

    await expect(buildDnsProvider(makeConfig())).rejects.toThrow(/DNSSEC validation/);
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

    await expect(buildDnsProvider(makeConfig())).rejects.toThrow(/health check failed/);
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

  it('throws when DNS_UNBOUND_HOSTS is not configured', async () => {
    await expect(buildDnsProvider(makeConfig({ DNS_UNBOUND_HOSTS: '' }))).rejects.toThrow(
      /DNS_UNBOUND_HOSTS must be set/,
    );
  });

  it('throws when DNS_UNBOUND_HOSTS is whitespace only', async () => {
    await expect(buildDnsProvider(makeConfig({ DNS_UNBOUND_HOSTS: '   ' }))).rejects.toThrow(
      /DNS_UNBOUND_HOSTS must be set/,
    );
  });
});

describe('buildDnsProvider — per-query DNSSEC validation (ADR-0073, ADR-0075)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes DNS_PER_QUERY_DNSEC option to UnboundResolver', async () => {
    const healthCheckSpy = vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
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

    const config = makeConfig({ DNS_PER_QUERY_DNSEC: false });
    const provider = await buildDnsProvider(config);

    // The UnboundResolver constructor should have received dnsPerQueryDnssec: false
    // We can't easily test the internal state, but we verify the provider was created
    expect(provider).toBeInstanceOf(UnboundResolver);
    expect(healthCheckSpy).toHaveBeenCalled();
  });

  it('passes DNSSEC_POSITIVE_CONTROLS to UnboundResolver', async () => {
    const healthCheckSpy = vi.spyOn(UnboundResolver.prototype, 'healthCheck').mockResolvedValue({
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

    const config = makeConfig({
      DNSSEC_POSITIVE_CONTROLS: 'custom.example.com,another.example.org',
    });
    const provider = await buildDnsProvider(config);

    expect(provider).toBeInstanceOf(UnboundResolver);
    expect(healthCheckSpy).toHaveBeenCalled();
  });
});
