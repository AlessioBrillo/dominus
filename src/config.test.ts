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
