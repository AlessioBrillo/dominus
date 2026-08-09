// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, resetConfig } from './config.js';

// Locks the schema defaults so documented and effective configuration
// cannot drift apart again (see the DNS_PARKING_CHECK_ENABLED and
// DNS_BULK_CONCURRENCY mismatches this suite was written for).
describe('config defaults', () => {
  const ENV_KEYS = [
    'DNS_PARKING_CHECK_ENABLED',
    'DNS_BULK_CONCURRENCY',
    'DNS_PERSISTENT_AVAILABLE_STALE_HOURS',
  ] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('DNS_PARKING_CHECK_ENABLED defaults to false (parking detection is opt-in)', () => {
    expect(loadConfig().DNS_PARKING_CHECK_ENABLED).toBe(false);
  });

  it('DNS_BULK_CONCURRENCY defaults to 200 (matching the documented default)', () => {
    expect(loadConfig().DNS_BULK_CONCURRENCY).toBe(200);
  });

  it('DNS_PERSISTENT_AVAILABLE_STALE_HOURS defaults to 24 (availability freshness)', () => {
    expect(loadConfig().DNS_PERSISTENT_AVAILABLE_STALE_HOURS).toBe(24);
  });

  it('DNS_PERSISTENT_AVAILABLE_STALE_HOURS accepts an explicit override', () => {
    process.env.DNS_PERSISTENT_AVAILABLE_STALE_HOURS = '48';
    resetConfig();
    expect(loadConfig().DNS_PERSISTENT_AVAILABLE_STALE_HOURS).toBe(48);
  });

  it('DNS_PERSISTENT_AVAILABLE_STALE_HOURS rejects values below 1 hour', () => {
    process.env.DNS_PERSISTENT_AVAILABLE_STALE_HOURS = '0';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

// Locks the public (anonymous /public) per-IP rate-limit defaults so the
// router timing and the documented .env.example values stay in sync.
describe('public rate limit config defaults', () => {
  const ENV_KEYS = [
    'PUBLIC_RATE_LIMIT_WINDOW_MS',
    'PUBLIC_RATE_LIMIT_MAX',
    'PER_DOMAIN_RATE_LIMIT_WINDOW_MS',
    'PER_DOMAIN_RATE_LIMIT_MAX',
    'POST_RATE_LIMIT_WINDOW_MS',
    'POST_RATE_LIMIT_MAX',
    'POST_BODY_MAX_BYTES',
  ] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('PUBLIC_RATE_LIMIT_WINDOW_MS defaults to 60000 (1 minute)', () => {
    expect(loadConfig().PUBLIC_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it('PUBLIC_RATE_LIMIT_MAX defaults to 30 (requests per minute per IP)', () => {
    expect(loadConfig().PUBLIC_RATE_LIMIT_MAX).toBe(30);
  });

  it('PER_DOMAIN_RATE_LIMIT_WINDOW_MS defaults to 60000 (1 minute)', () => {
    expect(loadConfig().PER_DOMAIN_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it('PER_DOMAIN_RATE_LIMIT_MAX defaults to 5 (per domain per IP)', () => {
    expect(loadConfig().PER_DOMAIN_RATE_LIMIT_MAX).toBe(5);
  });

  it('POST_RATE_LIMIT_WINDOW_MS defaults to 60000 (1 minute)', () => {
    expect(loadConfig().POST_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it('POST_RATE_LIMIT_MAX defaults to 10 (score creations per minute per IP)', () => {
    expect(loadConfig().POST_RATE_LIMIT_MAX).toBe(10);
  });

  it('POST_BODY_MAX_BYTES defaults to 1000', () => {
    expect(loadConfig().POST_BODY_MAX_BYTES).toBe(1000);
  });

  it('PUBLIC_RATE_LIMIT_MAX accepts an explicit override', () => {
    process.env.PUBLIC_RATE_LIMIT_MAX = '7';
    resetConfig();
    expect(loadConfig().PUBLIC_RATE_LIMIT_MAX).toBe(7);
  });
});

// Locks DNS_RESOLVER_GROUPS parsing (ADR-0047): custom DoH lookups must be
// able to express the RFC 8484 wire format for providers without a JSON API
// (Quad9, AdGuard, Mullvad). A group pointing at a wire-only endpoint that
// cannot say so would silently send JSON and never contribute a vote.
describe('DNS resolver groups config (custom groups)', () => {
  const ENV_KEYS = ['DNS_RESOLVER_GROUPS', 'DNS_LOOKUP_STRATEGY'] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('preserves the wire format on a custom DoH lookup (ADR-0047)', () => {
    process.env.DNS_RESOLVER_GROUPS =
      '[{"name":"primary","lookups":[{"type":"doh","endpoint":"https://dns.quad9.net/dns-query","format":"wire"}]}]';
    resetConfig();
    const groups = loadConfig().DNS_RESOLVER_GROUPS;
    expect(groups).toBeDefined();
    const lookup = groups?.[0]?.lookups[0] as unknown as {
      type?: string;
      format?: string;
    };
    expect(lookup?.type).toBe('doh');
    expect(lookup?.format).toBe('wire');
  });

  it('defaults the format to json when unspecified (JSON API compatibility)', () => {
    process.env.DNS_RESOLVER_GROUPS =
      '[{"name":"primary","lookups":[{"type":"doh","endpoint":"https://cloudflare-dns.com/dns-query"}]}]';
    resetConfig();
    const lookup = loadConfig().DNS_RESOLVER_GROUPS?.[0]?.lookups[0] as
      { type: 'doh'; format?: 'json' | 'wire' } | undefined;
    expect(lookup?.type).toBe('doh');
    expect(lookup?.format).toBeUndefined();
  });

  it('rejects an unknown wire format value', () => {
    process.env.DNS_RESOLVER_GROUPS =
      '[{"name":"primary","lookups":[{"type":"doh","endpoint":"https://dns.quad9.net/dns-query","format":"spdy"}]}]';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

// Locks the dedicated 2-of-3 DNS consensus control budget (ADR-0044). The
// consensus secondary must run against its own rate-limit bucket, concurrency
// ceiling, and per-tenant fair share — sharing the primary's would let a
// strict gate starve under the very load it is supposed to verify, and both
// budgets would count against each other.
describe('DNS consensus budget config defaults', () => {
  const ENV_KEYS = [
    'DNS_CONSENSUS_RATE_LIMIT_TOKENS',
    'DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS',
    'DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS',
    'DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS',
    'DNS_CONSENSUS_BULK_CONCURRENCY',
    'DNS_DOH_MAX_CONNECTIONS',
  ] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('DNS_CONSENSUS_RATE_LIMIT_TOKENS defaults to 20 (mirrors the primary)', () => {
    expect(loadConfig().DNS_CONSENSUS_RATE_LIMIT_TOKENS).toBe(20);
  });

  it('DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS defaults to 1000', () => {
    expect(loadConfig().DNS_CONSENSUS_RATE_LIMIT_INTERVAL_MS).toBe(1000);
  });

  it('DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS defaults to 5', () => {
    expect(loadConfig().DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS).toBe(5);
  });

  it('DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS defaults to 1000', () => {
    expect(loadConfig().DNS_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS).toBe(1000);
  });

  it('DNS_CONSENSUS_BULK_CONCURRENCY defaults to 20 (independent of DNS_BULK_CONCURRENCY=200)', () => {
    expect(loadConfig().DNS_CONSENSUS_BULK_CONCURRENCY).toBe(20);
  });

  it('DNS_DOH_MAX_CONNECTIONS defaults to 64 (keep-alive agent per origin)', () => {
    expect(loadConfig().DNS_DOH_MAX_CONNECTIONS).toBe(64);
  });

  it('DNS_CONSENSUS_RATE_LIMIT_TOKENS accepts an explicit override', () => {
    process.env.DNS_CONSENSUS_RATE_LIMIT_TOKENS = '8';
    resetConfig();
    expect(loadConfig().DNS_CONSENSUS_RATE_LIMIT_TOKENS).toBe(8);
  });

  it('DNS_CONSENSUS_BULK_CONCURRENCY rejects values below 1', () => {
    process.env.DNS_CONSENSUS_BULK_CONCURRENCY = '0';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

// Locks the optional third consensus leg (ADR-0045). DNS_TERTIARY_ENABLED is
// opt-in (a third opinion is only worth its extra query when the deployment
// can actually provide an independent resolver), and
// DNS_CONSENSUS_REQUIRED_AVAILABLE controls how many verification legs must
// confirm an Available verdict (1 = secondary confirmation suffices,
// 2 = both secondary and tertiary must confirm). Default 1 preserves the
// strict 2-of-3 semantics: a single confirmation beyond the primary is
// still the gate's minimum bar.
describe('DNS consensus tertiary leg config defaults (ADR-0045)', () => {
  const ENV_KEYS = [
    'DNS_TERTIARY_ENABLED',
    'DNS_TERTIARY_STRATEGY',
    'DNS_TERTIARY_NAMESERVERS',
    'DNS_CONSENSUS_REQUIRED_AVAILABLE',
  ] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('DNS_TERTIARY_ENABLED defaults to false (third opinion is opt-in)', () => {
    expect(loadConfig().DNS_TERTIARY_ENABLED).toBe(false);
  });

  it('DNS_TERTIARY_STRATEGY defaults to native (system recursor)', () => {
    expect(loadConfig().DNS_TERTIARY_STRATEGY).toBe('native');
  });

  it('DNS_CONSENSUS_REQUIRED_AVAILABLE defaults to 1 (a single confirmation beyond the primary)', () => {
    expect(loadConfig().DNS_CONSENSUS_REQUIRED_AVAILABLE).toBe(1);
  });

  it('DNS_CONSENSUS_REQUIRED_AVAILABLE accepts 2 (both verification legs must confirm)', () => {
    process.env.DNS_CONSENSUS_REQUIRED_AVAILABLE = '2';
    resetConfig();
    expect(loadConfig().DNS_CONSENSUS_REQUIRED_AVAILABLE).toBe(2);
  });

  it('DNS_CONSENSUS_REQUIRED_AVAILABLE rejects values outside 1..2', () => {
    process.env.DNS_CONSENSUS_REQUIRED_AVAILABLE = '3';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('DNS_TERTIARY_ENABLED accepts an explicit true', () => {
    process.env.DNS_TERTIARY_ENABLED = 'true';
    resetConfig();
    expect(loadConfig().DNS_TERTIARY_ENABLED).toBe(true);
  });
});

// Locks the RDAP 2-of-2 consensus gate (ADR-0050) and the shared keep-alive
// agent pool (ADR-0049). The gate is opt-in: every Available verdict from the
// primary failover is confirmed by a dedicated second RDAP provider, so a
// second HTTP query per Available doubles RDAP volume when enabled.
describe('RDAP consensus config defaults (ADR-0050)', () => {
  const ENV_KEYS = [
    'RDAP_MAX_CONNECTIONS',
    'RDAP_CONSENSUS_ENABLED',
    'RDAP_CONSENSUS_REQUIRED_AVAILABLE',
    'RDAP_CONSENSUS_DEGRADED_RATIO',
    'RDAP_CONSENSUS_DEGRADED_MIN',
    'RDAP_CONSENSUS_RATE_LIMIT_TOKENS',
    'RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS',
    'RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS',
    'RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS',
    'RDAP_CONSENSUS_BULK_CONCURRENCY',
    'RDAP_CONSENSUS_TIMEOUT_MS',
  ] as const;
  const backup = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      backup.set(key, process.env[key]);
      delete process.env[key];
    }
    resetConfig();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = backup.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetConfig();
  });

  it('RDAP_MAX_CONNECTIONS defaults to 32 (keep-alive agent per origin)', () => {
    expect(loadConfig().RDAP_MAX_CONNECTIONS).toBe(32);
  });

  it('RDAP_CONSENSUS_ENABLED defaults to false (gate is opt-in)', () => {
    expect(loadConfig().RDAP_CONSENSUS_ENABLED).toBe(false);
  });

  it('RDAP_CONSENSUS_REQUIRED_AVAILABLE defaults to 1 (2-of-2 total)', () => {
    expect(loadConfig().RDAP_CONSENSUS_REQUIRED_AVAILABLE).toBe(1);
  });

  it('RDAP_CONSENSUS_DEGRADED_RATIO defaults to 0.5', () => {
    expect(loadConfig().RDAP_CONSENSUS_DEGRADED_RATIO).toBe(0.5);
  });

  it('RDAP_CONSENSUS_DEGRADED_MIN defaults to 10 (protects small runs)', () => {
    expect(loadConfig().RDAP_CONSENSUS_DEGRADED_MIN).toBe(10);
  });

  it('RDAP_CONSENSUS_RATE_LIMIT_TOKENS defaults to 5 (below the primary 10)', () => {
    expect(loadConfig().RDAP_CONSENSUS_RATE_LIMIT_TOKENS).toBe(5);
  });

  it('RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS defaults to 1000', () => {
    expect(loadConfig().RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS).toBe(1000);
  });

  it('RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS defaults to 2', () => {
    expect(loadConfig().RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS).toBe(2);
  });

  it('RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS defaults to 1000', () => {
    expect(loadConfig().RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS).toBe(1000);
  });

  it('RDAP_CONSENSUS_BULK_CONCURRENCY defaults to 10 (independent of RDAP_BATCH_CONCURRENCY)', () => {
    expect(loadConfig().RDAP_CONSENSUS_BULK_CONCURRENCY).toBe(10);
  });

  it('RDAP_CONSENSUS_TIMEOUT_MS defaults to 10000', () => {
    expect(loadConfig().RDAP_CONSENSUS_TIMEOUT_MS).toBe(10000);
  });

  it('RDAP_CONSENSUS_RATE_LIMIT_TOKENS accepts an explicit override', () => {
    process.env.RDAP_CONSENSUS_RATE_LIMIT_TOKENS = '8';
    resetConfig();
    expect(loadConfig().RDAP_CONSENSUS_RATE_LIMIT_TOKENS).toBe(8);
  });

  it('RDAP_CONSENSUS_REQUIRED_AVAILABLE rejects values outside 1..2', () => {
    process.env.RDAP_CONSENSUS_REQUIRED_AVAILABLE = '3';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('RDAP_MAX_CONNECTIONS rejects values above 512', () => {
    process.env.RDAP_MAX_CONNECTIONS = '513';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});
