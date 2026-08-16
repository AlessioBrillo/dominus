// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildDnsBreakers,
  buildDnsConsensusConfig,
  buildDnsProvider,
} from '../provider-factory.js';
import { NodeDnsProvider } from '../../providers/dns/node-dns-provider.js';
import { DnsBreakerRegistry } from '../../providers/dns/dns-breaker.js';
import { CircuitBreaker } from '../../providers/circuit-breaker.js';
import {
  DistributedCircuitBreaker,
  type RedisClient,
} from '../../providers/redis/index.js';
import { loadConfig, resetConfig } from '../../config.js';

function makeMockRedisClient(): RedisClient {
  return {
    isConnected: true,
    keyPrefix: 'dominus:',
    prefixed: (key: string) => `dominus:${key}`,
    withRedis: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
    client: {} as never,
    ping: vi.fn(),
    shutdown: vi.fn(),
  } as unknown as RedisClient;
}

describe('buildDnsBreakers (ADR-0059)', () => {
  afterEach(() => {
    resetConfig();
  });

  it('returns undefined when DNS_CIRCUIT_BREAKER_ENABLED is false', () => {
    process.env.DNS_CIRCUIT_BREAKER_ENABLED = 'false';
    const config = loadConfig();
    expect(buildDnsBreakers(config, undefined)).toBeUndefined();
  });

  it('returns a registry of in-memory breakers by default', () => {
    const config = loadConfig();
    const registry = buildDnsBreakers(config, undefined);
    expect(registry).toBeInstanceOf(DnsBreakerRegistry);
    expect(registry?.localBreaker('doh:cloudflare-dns.com')).toBeInstanceOf(CircuitBreaker);
  });

  it('uses distributed breakers when a Redis client is connected', () => {
    const config = loadConfig();
    const registry = buildDnsBreakers(config, makeMockRedisClient());
    expect(registry).toBeInstanceOf(DnsBreakerRegistry);
    expect(registry?.localBreaker('doh:cloudflare-dns.com')).toBeInstanceOf(
      DistributedCircuitBreaker,
    );
  });

  it('wires the registry into the primary DNS provider', () => {
    const config = loadConfig();
    const breakers = buildDnsBreakers(config, undefined);
    const provider = buildDnsProvider(config, undefined, undefined, breakers) as NodeDnsProvider;
    expect(provider.breakerSnapshot()).toBeDefined();
    expect(provider.breakerSnapshot()).toEqual({ open: 0, closed: 0, halfOpen: 0, total: 0 });
    provider.dispose();
  });

  it('wires the registry into the consensus secondary and tertiary legs', () => {
    process.env.DNS_CONSENSUS_ENABLED = 'true';
    process.env.DNS_TERTIARY_ENABLED = 'true';
    process.env.DNS_TERTIARY_STRATEGY = 'doh-only';
    const config = loadConfig();
    const breakers = buildDnsBreakers(config, undefined);

    const consensus = buildDnsConsensusConfig(config, undefined, breakers);
    expect(consensus).toBeDefined();
    expect((consensus!.secondaryProvider as NodeDnsProvider).breakerSnapshot()).toBeDefined();
    expect(consensus!.tertiaryProvider).toBeDefined();
    expect((consensus!.tertiaryProvider as NodeDnsProvider).breakerSnapshot()).toBeDefined();
  });
});

describe('dnsBreakerRegistry distributed state sharing (ADR-0059)', () => {
  afterEach(() => {
    resetConfig();
  });

  it('exposes per-endpoint local breakers with the DNS key prefix', () => {
    const config = loadConfig();
    const registry = buildDnsBreakers(config, makeMockRedisClient());
    const breaker = registry?.localBreaker('dot:1.1.1.1|cloudflare-dns.com|853') as
      | DistributedCircuitBreaker
      | undefined;
    expect(breaker).toBeInstanceOf(DistributedCircuitBreaker);
  });

  it('default policy mirrors the RDAP per-server breaker', () => {
    const config = loadConfig();
    const registry = buildDnsBreakers(config, undefined);
    const breaker = registry?.localBreaker('native:system-resolver') as CircuitBreaker | undefined;
    expect(breaker?.cooldownMs).toBe(120_000);
    expect(breaker?.state).toBe('closed');
  });
});
