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

// Locks the anonymous trademark budget defaults (ADR-0056) so the schema and
// the documented .env.example values cannot drift apart again.
describe('anonymous trademark budget config defaults (ADR-0056)', () => {
  const ENV_KEYS = [
    'ANON_TRADEMARK_BUDGET_ENABLED',
    'ANON_TRADEMARK_RATE_LIMIT_TOKENS',
    'ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS',
    'ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS',
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

  it('ANON_TRADEMARK_BUDGET_ENABLED defaults to false (community behaviour unchanged)', () => {
    expect(loadConfig().ANON_TRADEMARK_BUDGET_ENABLED).toBe(false);
  });

  it('ANON_TRADEMARK_RATE_LIMIT_TOKENS defaults to 2', () => {
    expect(loadConfig().ANON_TRADEMARK_RATE_LIMIT_TOKENS).toBe(2);
  });

  it('ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS defaults to 1000', () => {
    expect(loadConfig().ANON_TRADEMARK_RATE_LIMIT_INTERVAL_MS).toBe(1000);
  });

  it('ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS defaults to 1000', () => {
    expect(loadConfig().ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS).toBe(1000);
  });

  it('accepts explicit overrides', () => {
    process.env.ANON_TRADEMARK_BUDGET_ENABLED = 'true';
    process.env.ANON_TRADEMARK_RATE_LIMIT_TOKENS = '4';
    process.env.ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS = '250';
    resetConfig();
    expect(loadConfig().ANON_TRADEMARK_BUDGET_ENABLED).toBe(true);
    expect(loadConfig().ANON_TRADEMARK_RATE_LIMIT_TOKENS).toBe(4);
    expect(loadConfig().ANON_TRADEMARK_ACQUIRE_TIMEOUT_MS).toBe(250);
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

  it('DNS_TERTIARY_STRATEGY defaults to doh-tertiary (dual-operator DoH group)', () => {
    expect(loadConfig().DNS_TERTIARY_STRATEGY).toBe('doh-tertiary');
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

// Locks the DNS per-endpoint circuit breaker (ADR-0059). DNS is the last
// provider layer without circuit protection: RDAP and WHOIS trip on repeated
// failures (global + per-server), while a dead DNS resolver burned the full
// lookup timeout on every query, every run. The breaker is on by default,
// mirrors the RDAP per-server policy (5 failures / 60 s window / 120 s
// cooldown), and can be disabled with an explicit flag.
describe('DNS circuit breaker config defaults (ADR-0059)', () => {
  const ENV_KEYS = [
    'DNS_CIRCUIT_BREAKER_ENABLED',
    'DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
    'DNS_CIRCUIT_BREAKER_WINDOW_MS',
    'DNS_CIRCUIT_BREAKER_COOLDOWN_MS',
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

  it('DNS_CIRCUIT_BREAKER_ENABLED defaults to true (resilience parity with RDAP/WHOIS)', () => {
    expect(loadConfig().DNS_CIRCUIT_BREAKER_ENABLED).toBe(true);
  });

  it('DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD defaults to 5', () => {
    expect(loadConfig().DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD).toBe(5);
  });

  it('DNS_CIRCUIT_BREAKER_WINDOW_MS defaults to 60000', () => {
    expect(loadConfig().DNS_CIRCUIT_BREAKER_WINDOW_MS).toBe(60_000);
  });

  it('DNS_CIRCUIT_BREAKER_COOLDOWN_MS defaults to 120000', () => {
    expect(loadConfig().DNS_CIRCUIT_BREAKER_COOLDOWN_MS).toBe(120_000);
  });

  it('accepts explicit values', () => {
    process.env.DNS_CIRCUIT_BREAKER_ENABLED = 'false';
    process.env.DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '3';
    process.env.DNS_CIRCUIT_BREAKER_WINDOW_MS = '30000';
    process.env.DNS_CIRCUIT_BREAKER_COOLDOWN_MS = '90000';
    resetConfig();
    const config = loadConfig();
    expect(config.DNS_CIRCUIT_BREAKER_ENABLED).toBe(false);
    expect(config.DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD).toBe(3);
    expect(config.DNS_CIRCUIT_BREAKER_WINDOW_MS).toBe(30_000);
    expect(config.DNS_CIRCUIT_BREAKER_COOLDOWN_MS).toBe(90_000);
  });

  it('rejects a failure threshold below 1', () => {
    process.env.DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '0';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('rejects a failure threshold above 100', () => {
    process.env.DNS_CIRCUIT_BREAKER_FAILURE_THRESHOLD = '101';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('rejects a window below 1000ms', () => {
    process.env.DNS_CIRCUIT_BREAKER_WINDOW_MS = '500';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('rejects a cooldown below 1000ms', () => {
    process.env.DNS_CIRCUIT_BREAKER_COOLDOWN_MS = '500';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

// Locks the RDAP 2-of-2 consensus gate (ADR-0050) and the shared keep-alive
// agent pool (ADR-0049). The gate is ON by default (ADR-0058): every Available
// verdict from the primary failover is confirmed by a dedicated second RDAP
// provider (rdap.org by default), so a second HTTP query per Available
// doubles RDAP volume. Operators disable it with an explicit flag.
describe('RDAP consensus config defaults (ADR-0050)', () => {
  const ENV_KEYS = [
    'RDAP_MAX_CONNECTIONS',
    'RDAP_MAX_RESPONSE_BYTES',
    'RDAP_CONSENSUS_ENABLED',
    'RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED',
    'RDAP_CONSENSUS_ENDPOINT',
    'RDAP_CONSENSUS_DEGRADED_RATIO',
    'RDAP_CONSENSUS_DEGRADED_MIN',
    'RDAP_CONSENSUS_RATE_LIMIT_TOKENS',
    'RDAP_CONSENSUS_RATE_LIMIT_INTERVAL_MS',
    'RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_TOKENS',
    'RDAP_CONSENSUS_RATE_LIMIT_PER_TENANT_INTERVAL_MS',
    'RDAP_CONSENSUS_BULK_CONCURRENCY',
    'RDAP_CONSENSUS_TIMEOUT_MS',
    'RDAP_BOOTSTRAP_RETRY_BASE_MS',
    'RDAP_BOOTSTRAP_RETRY_MAX_MS',
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

  it('RDAP_MAX_RESPONSE_BYTES defaults to 1048576 (1 MiB response body cap)', () => {
    expect(loadConfig().RDAP_MAX_RESPONSE_BYTES).toBe(1_048_576);
  });

  it('RDAP_MAX_RESPONSE_BYTES accepts an explicit override', () => {
    process.env.RDAP_MAX_RESPONSE_BYTES = '2097152';
    resetConfig();
    expect(loadConfig().RDAP_MAX_RESPONSE_BYTES).toBe(2_097_152);
  });

  it('RDAP_MAX_RESPONSE_BYTES rejects values below the 1024 floor', () => {
    process.env.RDAP_MAX_RESPONSE_BYTES = '512';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('RDAP_CONSENSUS_ENABLED defaults to true (gate on by default, ADR-0058)', () => {
    expect(loadConfig().RDAP_CONSENSUS_ENABLED).toBe(true);
  });

  it('RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED defaults to false (rescue is opt-in, ADR-0051)', () => {
    expect(loadConfig().RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED).toBe(false);
  });

  it('RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED accepts an explicit true', () => {
    process.env.RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED = 'true';
    resetConfig();
    expect(loadConfig().RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED).toBe(true);
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

  it('RDAP_CONSENSUS_ENDPOINT defaults to the rdap.org universal router (ADR-0058)', () => {
    expect(loadConfig().RDAP_CONSENSUS_ENDPOINT).toBe('https://rdap.org/');
  });

  it('RDAP_CONSENSUS_ENDPOINT requires an https URL when set', () => {
    process.env.RDAP_CONSENSUS_ENDPOINT = 'http://consensus.example.com';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('RDAP_BOOTSTRAP_RETRY_BASE_MS defaults to 300000 (5 min exponential base)', () => {
    expect(loadConfig().RDAP_BOOTSTRAP_RETRY_BASE_MS).toBe(300000);
  });

  it('RDAP_BOOTSTRAP_RETRY_MAX_MS defaults to 86400000 (24h backoff cap)', () => {
    expect(loadConfig().RDAP_BOOTSTRAP_RETRY_MAX_MS).toBe(86400000);
  });

  it('RDAP_MAX_CONNECTIONS rejects values above 512', () => {
    process.env.RDAP_MAX_CONNECTIONS = '513';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

// Locks the WHOIS distributed fair share (ADR-0052). WHOIS is the most
// restrictive channel in the stack (default 2 tokens / 2000ms), so the
// shared Redis bucket gains an independent per-tenant window before
// multi-replica/multi-tenant deployments can multiply registry traffic.
describe('WHOIS rate limit config defaults (ADR-0052)', () => {
  const ENV_KEYS = [
    'WHOIS_RATE_LIMIT_TOKENS',
    'WHOIS_RATE_LIMIT_INTERVAL_MS',
    'WHOIS_RATE_LIMIT_PER_TENANT_TOKENS',
    'WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS',
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

  it('WHOIS_RATE_LIMIT_TOKENS defaults to 2 (strictest channel in the stack)', () => {
    expect(loadConfig().WHOIS_RATE_LIMIT_TOKENS).toBe(2);
  });

  it('WHOIS_RATE_LIMIT_INTERVAL_MS defaults to 2000', () => {
    expect(loadConfig().WHOIS_RATE_LIMIT_INTERVAL_MS).toBe(2000);
  });

  it('WHOIS_RATE_LIMIT_PER_TENANT_TOKENS defaults to 1 (below the shared 2)', () => {
    expect(loadConfig().WHOIS_RATE_LIMIT_PER_TENANT_TOKENS).toBe(1);
  });

  it('WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS defaults to 2000 (mirrors the shared interval)', () => {
    expect(loadConfig().WHOIS_RATE_LIMIT_PER_TENANT_INTERVAL_MS).toBe(2000);
  });

  it('WHOIS_RATE_LIMIT_PER_TENANT_TOKENS accepts an explicit override', () => {
    process.env.WHOIS_RATE_LIMIT_PER_TENANT_TOKENS = '3';
    resetConfig();
    expect(loadConfig().WHOIS_RATE_LIMIT_PER_TENANT_TOKENS).toBe(3);
  });

  it('WHOIS_RATE_LIMIT_PER_TENANT_TOKENS rejects values below 1', () => {
    process.env.WHOIS_RATE_LIMIT_PER_TENANT_TOKENS = '0';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

describe('OIDC SSO config defaults (ADR-0062)', () => {
  const ENV_KEYS = [
    'AUTH0_CLIENT_ID',
    'AUTH0_CLIENT_SECRET',
    'AUTH0_CALLBACK_URL',
    'AUTH0_SESSION_TTL_HOURS',
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

  it('client credentials default to unset (SSO disabled, fail-closed)', () => {
    const config = loadConfig();
    expect(config.AUTH0_CLIENT_ID).toBeUndefined();
    expect(config.AUTH0_CLIENT_SECRET).toBeUndefined();
    expect(config.AUTH0_CALLBACK_URL).toBeUndefined();
  });

  it('AUTH0_SESSION_TTL_HOURS defaults to 8', () => {
    expect(loadConfig().AUTH0_SESSION_TTL_HOURS).toBe(8);
  });

  it('AUTH0_SESSION_TTL_HOURS honours an explicit override', () => {
    process.env.AUTH0_SESSION_TTL_HOURS = '2';
    resetConfig();
    expect(loadConfig().AUTH0_SESSION_TTL_HOURS).toBe(2);
  });

  it('AUTH0_SESSION_TTL_HOURS rejects values outside 1..168', () => {
    process.env.AUTH0_SESSION_TTL_HOURS = '0';
    resetConfig();
    expect(() => loadConfig()).toThrow();
    process.env.AUTH0_SESSION_TTL_HOURS = '169';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });

  it('AUTH0_CALLBACK_URL must be a valid URL when set', () => {
    process.env.AUTH0_CALLBACK_URL = 'not-a-url';
    resetConfig();
    expect(() => loadConfig()).toThrow();
  });
});

// z.coerce.boolean() turns the literal string "false" into true (Boolean("false")
// is true), so any env key parsed that way can never be switched off from the
// .env. These keys must keep the same preprocess pattern as every other
// boolean in the schema (string === 'true').
describe('boolean env overrides honour the literal "false" string', () => {
  const ENV_KEYS = [
    'ANON_TRADEMARK_BUDGET_ENABLED',
    'PROVIDER_FAIR_SHARE_ENABLED',
    'RDAP_CONSENSUS_ENABLED',
    'RDAP_CONSENSUS_RESCUE_WHOIS_ENABLED',
    'DNS_PRIVACY_MODE',
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

  it.each(ENV_KEYS)('%s=false parses to false', (key) => {
    process.env[key] = 'false';
    resetConfig();
    expect(loadConfig()[key as keyof ReturnType<typeof loadConfig>]).toBe(false);
  });

  it('RDAP_CONSENSUS_ENABLED=true parses to true', () => {
    process.env.RDAP_CONSENSUS_ENABLED = 'true';
    resetConfig();
    expect(loadConfig().RDAP_CONSENSUS_ENABLED).toBe(true);
  });
});

describe('DNS privacy mode config defaults (ADR-0065)', () => {
  const KEY = 'DNS_PRIVACY_MODE';
  const backup = process.env[KEY];

  afterEach(() => {
    if (backup === undefined) delete process.env[KEY];
    else process.env[KEY] = backup;
    resetConfig();
  });

  it('defaults to true when DATABASE_URL not set (community edition)', () => {
    delete process.env[KEY];
    delete process.env.DATABASE_URL;
    resetConfig();
    expect(loadConfig().DNS_PRIVACY_MODE).toBe(true);
  });

  it('defaults to false when DATABASE_URL is set (cloud edition)', () => {
    delete process.env[KEY];
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost/db';
    resetConfig();
    expect(loadConfig().DNS_PRIVACY_MODE).toBe(false);
  });

  it('parses true when set', () => {
    process.env[KEY] = 'true';
    process.env.DNS_NAMESERVERS = '127.0.0.1:5300';
    process.env.DNS_CONSENSUS_NAMESERVERS = '127.0.0.1:5301';
    resetConfig();
    expect(loadConfig().DNS_PRIVACY_MODE).toBe(true);
  });
});
